import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, cookieFrom } from "../helpers";
import { lastMailTo, seedCustomer, seedStaff } from "../fixtures";
import { setNow } from "../../src/worker/lib/clock";
import { sha256Hex } from "../../src/worker/lib/crypto";
import { processOutbox } from "../../src/worker/mail/outbox";
import { Hono } from "hono";
import { errorHandler } from "../../src/worker/lib/http";
import { loadSession, requireStaff } from "../../src/worker/middleware/session";
import { accountIdsForContact, eligibleAccountsForEmail } from "../../src/worker/repos/customers";
import { notifyStaff } from "../../src/worker/repos/staff";

afterEach(() => {
  vi.restoreAllMocks();
  setNow(null);
  delete env.TURNSTILE_SECRET_KEY;
});

const T0 = Date.UTC(2026, 9, 1, 0, 0);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const mailCount = async (email: string) =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM dev_mailbox WHERE to_email = ?").bind(email).first<{ n: number }>())!.n;

const requestCustomer = (email: string, extra: Record<string, unknown> = {}, headers?: Record<string, string>) =>
  api("POST", "/api/auth/customer/request", { body: { email, ...extra }, headers });
const requestStaff = (email: string, extra: Record<string, unknown> = {}) => api("POST", "/api/auth/staff/request", { body: { email, ...extra } });
const redeem = (token: string, headers?: Record<string, string>) => api("POST", "/api/auth/redeem", { body: { token }, headers });

async function customerSession(email = "pat@example.test") {
  await seedCustomer({ email });
  await requestCustomer(email);
  const token = (await lastMailTo(email))!;
  const res = await redeem(token);
  return { cookie: cookieFrom(res.setCookie), res };
}

async function staffSession(email = "tom@example.test", role: "admin" | "technician" = "technician") {
  const id = await seedStaff(email, role);
  await requestStaff(email);
  const token = (await lastMailTo(email))!;
  const res = await redeem(token);
  return { id, cookie: cookieFrom(res.setCookie), res };
}

describe("customer magic link", () => {
  it("returns a neutral 200 and sends nothing for an unknown email", async () => {
    const res = await requestCustomer("nobody@example.test");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
    expect(await lastMailTo("nobody@example.test")).toBeNull();
    expect(await mailCount("nobody@example.test")).toBe(0);
  });

  it("emails an eligible contact a link; redeeming it signs in and sets a hardened cookie", async () => {
    await seedCustomer({ email: "pat@example.test" });
    const res = await requestCustomer("PAT@example.test");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
    const row = await env.DB.prepare("SELECT text FROM dev_mailbox WHERE to_email = 'pat@example.test'").first<{ text: string }>();
    expect(row!.text).toContain("/auth/verify#t=");
    const token = (await lastMailTo("pat@example.test"))!;

    const out = await redeem(token);
    expect(out.status).toBe(200);
    expect(out.json).toEqual({ kind: "customer", redirectPath: null });
    const sc = out.setCookie.find((c) => c.startsWith("__Host-cust="))!;
    expect(sc).toBeTruthy();
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/Secure/i);
    expect(sc).toMatch(/SameSite=Lax/i);
    expect(sc).toMatch(/Path=\//);
    expect(sc).toMatch(/Max-Age=86400/);
    expect(sc).not.toMatch(/Domain=/i);

    const raw = /^__Host-cust=([^;]+)/.exec(sc)![1]!;
    const sess = await env.DB.prepare("SELECT * FROM sessions").all<any>();
    expect(sess.results).toHaveLength(1);
    expect(sess.results[0]).toMatchObject({ id_hash: await sha256Hex(raw), kind: "customer", email: "pat@example.test", staff_id: null });
    expect(JSON.stringify(sess.results)).not.toContain(raw);
    const aud = await env.DB.prepare("SELECT actor_kind, actor, action FROM audit_log").all<any>();
    expect(aud.results).toEqual([{ actor_kind: "customer", actor: "pat@example.test", action: "auth.customer_signin" }]);

    const me = await api("GET", "/api/auth/me", { cookie: cookieFrom(out.setCookie) });
    expect(me.json).toMatchObject({ customer: { email: "pat@example.test" }, staff: null });
  });

  it("rejects reuse of the same token with 410 expired_link", async () => {
    await seedCustomer({ email: "pat@example.test" });
    await requestCustomer("pat@example.test");
    const token = (await lastMailTo("pat@example.test"))!;
    expect((await redeem(token)).status).toBe(200);
    const again = await redeem(token);
    expect(again.status).toBe(410);
    expect(again.json).toMatchObject({ error: "expired_link", kind: "customer" });
    expect(again.setCookie).toEqual([]);
  });

  it("only one of two concurrent redemptions wins", async () => {
    await seedCustomer({ email: "pat@example.test" });
    await requestCustomer("pat@example.test");
    const token = (await lastMailTo("pat@example.test"))!;
    const [a, b] = await Promise.all([redeem(token), redeem(token)]);
    expect([a.status, b.status].sort()).toEqual([200, 410]);
  });

  it("rejects an unknown token with 400 invalid_link", async () => {
    const res = await redeem("not-a-real-token");
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: "invalid_link" });
  });

  it("expires after 15 minutes; resend emails a fresh working link", async () => {
    setNow(T0);
    await seedCustomer({ email: "pat@example.test" });
    await requestCustomer("pat@example.test", { redirectPath: "/book" });
    const token = (await lastMailTo("pat@example.test"))!;
    setNow(T0 + 16 * MIN);
    const late = await redeem(token);
    expect(late.status).toBe(410);
    expect(late.json).toMatchObject({ error: "expired_link", kind: "customer" });

    const re = await api("POST", "/api/auth/resend", { body: { token } });
    expect(re.status).toBe(200);
    expect(re.json).toEqual({ ok: true });
    expect(await mailCount("pat@example.test")).toBe(2);
    const fresh = (await lastMailTo("pat@example.test"))!;
    expect(fresh).not.toBe(token);
    const ok = await redeem(fresh);
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ kind: "customer", redirectPath: "/book" });
  });

  it("resend with an unknown token is neutral and sends nothing", async () => {
    const re = await api("POST", "/api/auth/resend", { body: { token: "nope" } });
    expect(re.status).toBe(200);
    expect(re.json).toEqual({ ok: true });
    await processOutbox(env, 50);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM dev_mailbox").first<{ n: number }>())!.n).toBe(0);
  });

  it("keeps only same-origin redirect paths", async () => {
    await seedCustomer({ email: "pat@example.test" });
    for (const bad of ["//evil.example.test", "https://evil.example.test", "/\\evil", "book", "/a\nb"]) {
      await env.DB.prepare("DELETE FROM rate_limits").run();
      await requestCustomer("pat@example.test", { redirectPath: bad });
      const t = (await lastMailTo("pat@example.test"))!;
      expect((await redeem(t)).json).toEqual({ kind: "customer", redirectPath: null });
    }
    await env.DB.prepare("DELETE FROM rate_limits").run();
    await requestCustomer("pat@example.test", { redirectPath: "/book?x=1" });
    expect((await redeem((await lastMailTo("pat@example.test"))!)).json.redirectPath).toBe("/book?x=1");
  });

  it("does not send to a staff-only email", async () => {
    await seedStaff("tom@example.test");
    const res = await requestCustomer("tom@example.test");
    expect(res.status).toBe(200);
    expect(await lastMailTo("tom@example.test")).toBeNull();
  });

  it("does not send for an inactive customer or inactive contact", async () => {
    await seedCustomer({ email: "off@example.test", active: false });
    await seedCustomer({ email: "gone@example.test", contactActive: false });
    for (const e of ["off@example.test", "gone@example.test"]) {
      expect((await requestCustomer(e)).status).toBe(200);
      expect(await lastMailTo(e)).toBeNull();
    }
  });

  it("refuses redemption (403) when the customer was deactivated after the link was sent", async () => {
    const id = await seedCustomer({ email: "pat@example.test" });
    await requestCustomer("pat@example.test");
    const token = (await lastMailTo("pat@example.test"))!;
    await env.DB.prepare("UPDATE customers SET active = 0 WHERE id = ?").bind(id).run();
    const res = await redeem(token);
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ error: "not_eligible" });
    expect(res.setCookie).toEqual([]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())!.n).toBe(0);
  });

  it("rate-limits per email: the 4th request in 15 minutes sends nothing but still returns 200", async () => {
    setNow(T0);
    await seedCustomer({ email: "pat@example.test" });
    for (let i = 0; i < 4; i++) {
      const res = await requestCustomer("pat@example.test");
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ ok: true });
    }
    expect(await mailCount("pat@example.test")).toBe(3);
    setNow(T0 + 16 * MIN);
    await requestCustomer("pat@example.test");
    expect(await mailCount("pat@example.test")).toBe(4);
  });

  it("rate-limits per IP across emails when cf-connecting-ip is present", async () => {
    setNow(T0);
    await seedCustomer({ email: "pat@example.test" });
    const h = { "cf-connecting-ip": "203.0.113.9" };
    for (let i = 0; i < 20; i++) await requestCustomer(`user${i}@example.test`, {}, h);
    await env.DB.prepare("DELETE FROM rate_limits WHERE key LIKE 'login:email:%'").run();
    const res = await requestCustomer("pat@example.test", {}, h);
    expect(res.status).toBe(200);
    expect(await mailCount("pat@example.test")).toBe(0);
    // same email from another IP still works
    await requestCustomer("pat@example.test", {}, { "cf-connecting-ip": "203.0.113.10" });
    expect(await mailCount("pat@example.test")).toBe(1);
  });

  it("limits redemption attempts per IP with 429", async () => {
    const h = { "cf-connecting-ip": "203.0.113.9" };
    for (let i = 0; i < 30; i++) expect((await redeem("bogus", h)).status).toBe(400);
    const res = await redeem("bogus", h);
    expect(res.status).toBe(429);
    expect(res.json).toMatchObject({ error: "rate_limited" });
  });

  it("is neutral (200, no mail) when Turnstile verification fails", async () => {
    env.TURNSTILE_SECRET_KEY = "test-secret";
    await seedCustomer({ email: "pat@example.test" });
    const res = await requestCustomer("pat@example.test");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
    expect(await mailCount("pat@example.test")).toBe(0);
  });

  it("failed Turnstile checks do not consume the rate-limit buckets", async () => {
    env.TURNSTILE_SECRET_KEY = "test-secret";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const form = (init as RequestInit).body as FormData;
      return Response.json({ success: form.get("response") === "good" });
    });
    await seedCustomer({ email: "pat@example.test" });
    const h = { "cf-connecting-ip": "203.0.113.9" };
    for (let i = 0; i < 25; i++) {
      const res = await requestCustomer("pat@example.test", { turnstileToken: "bad" }, h);
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ ok: true });
    }
    expect(await mailCount("pat@example.test")).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM rate_limits").first<{ n: number }>())!.n).toBe(0);
    await requestCustomer("pat@example.test", { turnstileToken: "good" }, h);
    expect(await mailCount("pat@example.test")).toBe(1);

    await seedStaff("tom@example.test");
    for (let i = 0; i < 5; i++) await requestStaff("tom@example.test", { turnstileToken: "bad" });
    await requestStaff("tom@example.test", { turnstileToken: "good" });
    expect(await mailCount("tom@example.test")).toBe(1);
  });

  it("rejects malformed requests with 400", async () => {
    expect((await api("POST", "/api/auth/customer/request", { body: { email: "not-an-email" } })).status).toBe(400);
    expect((await api("POST", "/api/auth/redeem", { body: {} })).status).toBe(400);
  });
});

describe("sessions", () => {
  it("a customer cookie cannot open staff routes", async () => {
    const { cookie } = await customerSession();
    const res = await api("GET", "/api/staff/me", { cookie });
    expect(res.status).toBe(401);
    expect(res.json).toMatchObject({ error: "auth_required" });
  });

  it("a session token is only valid for its own kind of cookie", async () => {
    const { cookie } = await customerSession();
    const raw = /__Host-cust=([^;]+)/.exec(cookie)![1]!;
    const asStaff = await api("GET", "/api/staff/me", { cookie: `__Host-staff=${raw}` });
    expect(asStaff.status).toBe(401);
    const me = await api("GET", "/api/auth/me", { cookie: `__Host-staff=${raw}` });
    expect(me.json).toMatchObject({ customer: null, staff: null });

    const { cookie: sc } = await staffSession();
    const sraw = /__Host-staff=([^;]+)/.exec(sc)![1]!;
    const me2 = await api("GET", "/api/auth/me", { cookie: `__Host-cust=${sraw}` });
    expect(me2.json).toMatchObject({ customer: null, staff: null });
  });

  it("customer sessions expire after 24 hours", async () => {
    setNow(T0);
    const { cookie } = await customerSession();
    setNow(T0 + DAY - MIN);
    expect((await api("GET", "/api/auth/me", { cookie })).json.customer).not.toBeNull();
    setNow(T0 + DAY + MIN);
    expect((await api("GET", "/api/auth/me", { cookie })).json.customer).toBeNull();
  });

  it("logout revokes the session and clears the cookie", async () => {
    const { cookie } = await customerSession();
    expect((await api("GET", "/api/auth/me", { cookie })).json.customer).toMatchObject({ email: "pat@example.test" });
    const out = await api("POST", "/api/auth/logout", { body: { kind: "customer" }, cookie });
    expect(out.status).toBe(200);
    const cleared = out.setCookie.find((c) => c.startsWith("__Host-cust="))!;
    expect(cleared).toMatch(/Max-Age=0/);
    expect(cleared).toMatch(/HttpOnly/i);
    expect(cleared).toMatch(/Secure/i);
    expect(cleared).toMatch(/Path=\//);
    const me = await api("GET", "/api/auth/me", { cookie });
    expect(me.json.customer).toBeNull();
    expect((await env.DB.prepare("SELECT revoked_at FROM sessions").first<{ revoked_at: number | null }>())!.revoked_at).not.toBeNull();
  });

  it("logging out of one kind leaves the other session intact", async () => {
    await seedCustomer({ email: "tom@example.test" });
    const { cookie: sCookie } = await staffSession("tom@example.test");
    await requestCustomer("tom@example.test");
    const cRes = await redeem((await lastMailTo("tom@example.test"))!);
    const both = `${sCookie}; ${cookieFrom(cRes.setCookie)}`;
    await api("POST", "/api/auth/logout", { body: { kind: "customer" }, cookie: both });
    const me = await api("GET", "/api/auth/me", { cookie: both });
    expect(me.json.customer).toBeNull();
    expect(me.json.staff).toMatchObject({ email: "tom@example.test" });
  });

  it("GET /api/auth/me reports site config for anonymous visitors", async () => {
    await env.DB.prepare("INSERT INTO settings(key, value) VALUES ('orgName', ?)").bind(JSON.stringify("Edited Org")).run();
    const me = await api("GET", "/api/auth/me");
    expect(me.json).toEqual({ customer: null, staff: null, turnstileSiteKey: null, orgName: "Edited Org", timezone: "Asia/Tokyo", bookingEnabled: true, supportPhone: "" });
  });
});

describe("staff magic link", () => {
  it("signs in an active staff member with a 14-day cookie and exposes the principal", async () => {
    setNow(T0);
    const { id, cookie, res } = await staffSession("tom@example.test", "technician");
    expect(res.json).toEqual({ kind: "staff", redirectPath: null });
    const sc = res.setCookie.find((c) => c.startsWith("__Host-staff="))!;
    expect(sc).toMatch(/Max-Age=1209600/);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Lax/i);
    const me = await api("GET", "/api/staff/me", { cookie });
    expect(me.status).toBe(200);
    expect(me.json).toEqual({ id, email: "tom@example.test", name: "Test Person", role: "technician" });
    const aud = await env.DB.prepare("SELECT actor_kind, actor, action FROM audit_log").all<any>();
    expect(aud.results).toEqual([{ actor_kind: "staff", actor: "tom@example.test", action: "auth.staff_signin" }]);
    const mail = await env.DB.prepare("SELECT text FROM dev_mailbox WHERE to_email = 'tom@example.test'").first<{ text: string }>();
    expect(mail!.text).toContain("/staff/auth/verify#t=");
  });

  it("does not email unknown or deactivated staff", async () => {
    await seedStaff("off@example.test", "technician", false);
    for (const e of ["stranger@example.test", "off@example.test"]) {
      expect((await requestStaff(e)).status).toBe(200);
      expect(await lastMailTo(e)).toBeNull();
    }
  });

  it("requireStaff('admin') returns 403 forbidden for technicians", async () => {
    const app = new Hono<any>();
    app.use("*", loadSession);
    app.onError(errorHandler);
    app.get("/admin-only", requireStaff("admin"), (c) => c.json({ ok: true }));
    const { cookie: tech } = await staffSession("tom@example.test", "technician");
    const { cookie: adm } = await staffSession("ada@example.test", "admin");
    const call = (cookie?: string) => app.request("/admin-only", { headers: cookie ? { cookie } : {} }, env);
    expect((await call()).status).toBe(401);
    const forbidden = await call(tech);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: "forbidden" });
    expect((await call(adm)).status).toBe(200);
  });

  it("deactivated staff lose access immediately", async () => {
    const { id, cookie } = await staffSession();
    expect((await api("GET", "/api/staff/me", { cookie })).status).toBe(200);
    await env.DB.prepare("UPDATE staff SET active = 0 WHERE id = ?").bind(id).run();
    expect((await api("GET", "/api/staff/me", { cookie })).status).toBe(401);
    expect((await api("GET", "/api/auth/me", { cookie })).json.staff).toBeNull();
  });

  it("refuses redemption when staff was deactivated after the link was sent", async () => {
    const id = await seedStaff("tom@example.test");
    await requestStaff("tom@example.test");
    const token = (await lastMailTo("tom@example.test"))!;
    await env.DB.prepare("UPDATE staff SET active = 0 WHERE id = ?").bind(id).run();
    expect((await redeem(token)).status).toBe(403);
  });

  it("extends the sliding expiry once fewer than 7 days remain", async () => {
    setNow(T0);
    const { cookie } = await staffSession();
    const exp = () => env.DB.prepare("SELECT expires_at FROM sessions").first<{ expires_at: number }>().then((r) => r!.expires_at);
    expect(await exp()).toBe(T0 + 14 * DAY);

    setNow(T0 + 3 * DAY); // 11 days remain: untouched, no new cookie
    const early = await api("GET", "/api/staff/me", { cookie });
    expect(early.setCookie).toEqual([]);
    expect(await exp()).toBe(T0 + 14 * DAY);

    setNow(T0 + 8 * DAY); // 6 days remain: refresh
    const late = await api("GET", "/api/staff/me", { cookie });
    expect(late.status).toBe(200);
    expect(await exp()).toBe(T0 + 22 * DAY);
    const sc = late.setCookie.find((c) => c.startsWith("__Host-staff="))!;
    expect(sc).toMatch(/Max-Age=1209600/);
    expect(sc.split(";")[0]).toBe(cookie.split(";")[0]);

    setNow(T0 + 23 * DAY);
    expect((await api("GET", "/api/staff/me", { cookie })).status).toBe(401);
  });

  it("an expired staff session is not usable", async () => {
    setNow(T0);
    const { cookie } = await staffSession();
    setNow(T0 + 15 * DAY);
    expect((await api("GET", "/api/staff/me", { cookie })).status).toBe(401);
  });
});

describe("bootstrap admin", () => {
  it("creates the admin on first staff request from a bootstrap address, and mails a link", async () => {
    const res = await requestStaff("Boot-Admin@example.test");
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT * FROM staff").all<any>();
    expect(row.results).toHaveLength(1);
    expect(row.results[0]).toMatchObject({ email: "boot-admin@example.test", name: "boot-admin", role: "admin", bookable: 1, notify: 1, active: 1 });
    const aud = await env.DB.prepare("SELECT action FROM audit_log WHERE action = 'staff.bootstrap_admin'").all<any>();
    expect(aud.results).toHaveLength(1);
    const token = await lastMailTo("boot-admin@example.test");
    expect(token).toBeTruthy();
    const out = await redeem(token!);
    expect(out.status).toBe(200);
    expect((await api("GET", "/api/staff/me", { cookie: cookieFrom(out.setCookie) })).json).toMatchObject({ role: "admin" });
  });

  it("does not create a second admin once an active admin exists", async () => {
    await seedStaff("other-admin@example.test", "admin");
    const res = await requestStaff("boot-admin@example.test");
    expect(res.status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM staff").first<{ n: number }>())!.n).toBe(1);
    expect(await lastMailTo("boot-admin@example.test")).toBeNull();
  });

  it("recreates a lost admin when every admin is deactivated", async () => {
    await seedStaff("boot-admin@example.test", "admin", false);
    await requestStaff("boot-admin@example.test");
    const row = await env.DB.prepare("SELECT role, active FROM staff").first<any>();
    expect(row).toEqual({ role: "admin", active: 1 });
    expect(await lastMailTo("boot-admin@example.test")).toBeTruthy();
  });

  it("ignores addresses not on the bootstrap list", async () => {
    await requestStaff("stranger@example.test");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM staff").first<{ n: number }>())!.n).toBe(0);
  });
});

describe("repos", () => {
  it("eligibleAccountsForEmail needs an active contact on an active customer; accountIdsForContact needs only an active contact", async () => {
    const a = await seedCustomer({ email: "Pat@example.test" });
    const b = await seedCustomer({ email: "pat@example.test", active: false });
    const c = await seedCustomer({ email: "pat@example.test", contactActive: false });
    const eligible = await eligibleAccountsForEmail(env.DB, "pat@EXAMPLE.test");
    expect(eligible.map((x) => x.id)).toEqual([a]);
    expect(eligible[0]).toMatchObject({ name: "Acme Test Co", contactName: null, contactPhone: null, customerPhone: null });
    expect((await accountIdsForContact(env.DB, "pat@example.test")).sort()).toEqual([a, b].sort());
  });

  it("notifyStaff lists active staff with notify on", async () => {
    await seedStaff("a@example.test", "admin");
    await seedStaff("b@example.test", "technician", false);
    const c = await seedStaff("c@example.test");
    await env.DB.prepare("UPDATE staff SET notify = 0 WHERE id = ?").bind(c).run();
    expect((await notifyStaff(env.DB)).map((s) => s.email)).toEqual(["a@example.test"]);
  });
});
