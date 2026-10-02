import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/worker/index";
import { api } from "../helpers";
import { loginCustomer, loginStaff, seedCustomer, seedTeam, seedWeekly, TZ } from "../fixtures";
import { clock, setNow } from "../../src/worker/lib/clock";
import { sha256Hex } from "../../src/worker/lib/crypto";
import { wallToUtc } from "../../src/domain/time";

afterEach(() => setNow(null));

const THU = "2026-10-01";
const FRI = "2026-10-02";
const at = (date: string, h: number, m = 0) => wallToUtc(date, h * 60 + m, TZ);
const utc = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
const TECH_NAMES = ["Ada Admin", "Tim Tech", "Una Tech"];

let team: Awaited<ReturnType<typeof seedTeam>>;
let pat: { id: number; cookie: string };
let sam: { id: number; cookie: string };
let adminCookie: string;
let techCookie: string;

beforeEach(async () => {
  setNow(at(THU, 8));
  team = await seedTeam();
  for (const [id, name] of [
    [team.admin, "Ada Admin"],
    [team.a, "Tim Tech"],
    [team.b, "Una Tech"],
  ] as const) {
    await env.DB.prepare("UPDATE staff SET name = ? WHERE id = ?").bind(name, id).run();
  }
  pat = { id: await seedCustomer({ email: "pat@example.test", name: "Pat Co" }), cookie: "" };
  sam = { id: await seedCustomer({ email: "sam@example.test", name: "Sam Co" }), cookie: "" };
  pat.cookie = await loginCustomer("pat@example.test");
  sam.cookie = await loginCustomer("sam@example.test");
  adminCookie = await loginStaff("admin@example.test");
  techCookie = await loginStaff("tech-a@example.test");
  await seedWeekly(5, 600, 720, [team.admin, team.a, team.b]);
  const settings: Record<string, unknown> = {
    orgName: "Acme, Support; Desk",
    remoteToolName: "AnyDesk",
    customerInstructions: "Close other apps.\nHave your ID ready, please.",
    supportPhone: "+81 3-0000-0000",
    maxActivePerAccount: 5,
  };
  for (const [k, v] of Object.entries(settings)) {
    await env.DB.prepare("INSERT INTO settings(key, value) VALUES (?, ?)").bind(k, JSON.stringify(v)).run();
  }
});

const submit = async (who: { id: number; cookie: string }, startAt: number, issue = "Printer is offline, again; help") => {
  const res = await api("POST", "/api/customer/reservations", {
    cookie: who.cookie,
    body: { customerId: who.id, startAt, contactName: "Pat Example", phone: "+81 3-1234-5678", issue, idempotencyKey: crypto.randomUUID() },
  });
  expect(res.status).toBe(201);
  return { id: res.json.reservation.id as string, ref: res.json.reservation.ref as string };
};
const confirmed = async (who: { id: number; cookie: string }, startAt: number, staffId = team.a) => {
  const r = await submit(who, startAt);
  const res = await api("POST", `/api/staff/reservations/${r.id}/approve`, { cookie: adminCookie, body: { staffId, version: 1 } });
  expect(res.status).toBe(200);
  return r;
};
const mintToken = async (reservationId: string, expiresAt = at(FRI, 11) + 14 * 86_400_000) => {
  const token = `tok-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  await env.DB.prepare("INSERT INTO access_tokens(token_hash, reservation_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), reservationId, clock.now(), expiresAt)
    .run();
  return token;
};

/** Raw request: the ICS body is not JSON. */
const rawApi = async (method: string, path: string, opts: { cookie?: string; body?: unknown; xrw?: boolean } = {}) => {
  const headers = new Headers({ "content-type": "application/json", origin: "http://localhost:5173" });
  if (opts.xrw !== false) headers.set("x-requested-with", "fetch");
  if (opts.cookie) headers.set("cookie", opts.cookie);
  const ctx = createExecutionContext();
  const res = await worker.fetch!(
    new Request(`http://localhost:5173${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }) as any,
    env as any,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { status: res.status, headers: res.headers, text: await res.text() };
};
const customerIcs = (who: { cookie: string }, id: string) => rawApi("POST", `/api/customer/reservations/${id}/ics`, { cookie: who.cookie });
const accessIcs = (token: unknown) => rawApi("POST", "/api/access/reservation/ics", { body: { token } });
const staffIcs = (cookie: string, id: string) => rawApi("GET", `/api/staff/reservations/${id}/ics`, { cookie });

const unfold = (s: string) => s.replace(/\r\n /g, "");
const prop = (ics: string, name: string) => unfold(ics).split("\r\n").find((l) => l.startsWith(`${name}:`))?.slice(name.length + 1);
/** TEXT value with escapes undone. */
const textProp = (ics: string, name: string) => prop(ics, name)?.replace(/\\n/g, "\n").replace(/\\([\;,])/g, "$1");

const expectCalendarHeaders = (res: { headers: Headers }, ref: string) => {
  expect(res.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
  expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${ref}.ics"`);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
};

describe("POST /api/customer/reservations/:id/ics", () => {
  it("serves a confirmed appointment as a calendar attachment without any technician data", async () => {
    const { id, ref } = await confirmed(pat, at(FRI, 10));
    const res = await customerIcs(pat, id);
    expect(res.status).toBe(200);
    expectCalendarHeaders(res, ref);
    const ics = res.text;
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(prop(ics, "METHOD")).toBe("PUBLISH");
    expect(prop(ics, "STATUS")).toBe("CONFIRMED");
    expect(prop(ics, "UID")).toBe(`${ref}@localhost`);
    expect(prop(ics, "SEQUENCE")).toBe("2");
    expect(prop(ics, "DTSTART")).toBe(utc(at(FRI, 10)));
    expect(prop(ics, "DTEND")).toBe(utc(at(FRI, 10, 30)));
    expect(prop(ics, "DTSTAMP")).toBe(utc(clock.now()));
    expect(prop(ics, "URL")).toBe("http://localhost:5173/r");
    expect(textProp(ics, "SUMMARY")).toBe("Remote support — Acme, Support; Desk");
    const description = textProp(ics, "DESCRIPTION")!;
    expect(description).toContain(ref);
    expect(description).toContain("A technician will call you at +81 3-1234-5678");
    expect(description).toContain("AnyDesk");
    expect(description).toContain("Close other apps.\nHave your ID ready, please.");
    expect(description).toContain("http://localhost:5173/r");
    expect(ics).not.toContain("VALARM");
    for (const name of TECH_NAMES) expect(ics).not.toContain(name);
    expect(ics).not.toMatch(/staff|tech-a@/i);
    for (const line of ics.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
  });

  it("turns a cancelled-after-confirmation appointment into a CANCELLED event with a higher sequence", async () => {
    const { id, ref } = await confirmed(pat, at(FRI, 10));
    const before = await customerIcs(pat, id);
    const cancelled = await api("POST", `/api/customer/reservations/${id}/cancel`, { cookie: pat.cookie, body: { version: 2 } });
    expect(cancelled.status).toBe(200);
    const res = await customerIcs(pat, id);
    expect(res.status).toBe(200);
    expectCalendarHeaders(res, ref);
    expect(prop(res.text, "STATUS")).toBe("CANCELLED");
    expect(prop(res.text, "UID")).toBe(prop(before.text, "UID"));
    expect(Number(prop(res.text, "SEQUENCE"))).toBeGreaterThan(Number(prop(before.text, "SEQUENCE")));
    expect(prop(res.text, "DTSTART")).toBe(utc(at(FRI, 10)));
    for (const name of TECH_NAMES) expect(res.text).not.toContain(name);
  });

  it("also covers an appointment our team cancelled", async () => {
    const { id } = await confirmed(pat, at(FRI, 10));
    const c = await api("POST", `/api/staff/reservations/${id}/cancel`, { cookie: adminCookie, body: { reason: "Out sick", version: 2 } });
    expect(c.status).toBe(200);
    const res = await customerIcs(pat, id);
    expect(res.status).toBe(200);
    expect(prop(res.text, "STATUS")).toBe("CANCELLED");
    expect(res.text).not.toContain("Out sick");
  });

  it("refuses everything that was never confirmed with 409 not_confirmed", async () => {
    const pending = await submit(pat, at(FRI, 10));
    let res = await customerIcs(pat, pending.id);
    expect(res.status).toBe(409);
    expect(JSON.parse(res.text)).toEqual({ error: "not_confirmed" });
    expect(res.headers.get("content-type")).not.toContain("calendar");
    expect(res.headers.get("content-disposition")).toBeNull();

    // Cancelled while still pending: it never appeared in a calendar.
    const withdrawn = await submit(pat, at(FRI, 11));
    expect((await api("POST", `/api/customer/reservations/${withdrawn.id}/cancel`, { cookie: pat.cookie, body: { version: 1 } })).status).toBe(200);
    res = await customerIcs(pat, withdrawn.id);
    expect(res.status).toBe(409);

    const declined = await submit(sam, at(FRI, 10, 30));
    expect((await api("POST", `/api/staff/reservations/${declined.id}/decline`, { cookie: adminCookie, body: { reason: "No", version: 1 } })).status).toBe(200);
    expect((await customerIcs(sam, declined.id)).status).toBe(409);

    const expired = await submit(sam, at(FRI, 11, 30));
    await env.DB.prepare("UPDATE reservations SET status = 'expired' WHERE id = ?").bind(expired.id).run();
    expect((await customerIcs(sam, expired.id)).status).toBe(409);
  });

  it("refuses a completed appointment: only confirmed or cancelled-after-confirmation qualify", async () => {
    const { id } = await confirmed(pat, at(FRI, 10));
    await env.DB.prepare("UPDATE reservations SET status = 'completed' WHERE id = ?").bind(id).run();
    expect((await customerIcs(pat, id)).status).toBe(409);
  });

  it("requires a customer session, the CSRF header, and ownership", async () => {
    const { id } = await confirmed(pat, at(FRI, 10));
    expect((await rawApi("POST", `/api/customer/reservations/${id}/ics`)).status).toBe(401);
    expect((await rawApi("POST", `/api/customer/reservations/${id}/ics`, { cookie: pat.cookie, xrw: false })).status).toBe(403);
    // Another account's contact, staff cookies, and unknown ids are all just "not found".
    const other = await customerIcs(sam, id);
    expect(other.status).toBe(404);
    expect(other.text).not.toContain("BEGIN:VCALENDAR");
    expect((await customerIcs({ cookie: adminCookie }, id)).status).toBe(401);
    expect((await customerIcs(pat, "no-such-id")).status).toBe(404);
  });

  it("denies a deactivated contact but still serves after the account lost eligibility", async () => {
    const { id } = await confirmed(pat, at(FRI, 10));
    await env.DB.prepare("UPDATE customers SET active = 0 WHERE id = ?").bind(pat.id).run();
    expect((await customerIcs(pat, id)).status).toBe(200);
    await env.DB.prepare("UPDATE customer_contacts SET active = 0 WHERE customer_id = ?").bind(pat.id).run();
    expect((await customerIcs(pat, id)).status).toBe(404);
  });
});

describe("POST /api/access/reservation/ics", () => {
  it("serves the token's reservation and never embeds the token", async () => {
    const { id, ref } = await confirmed(pat, at(FRI, 10));
    const token = await mintToken(id);
    const res = await accessIcs(token);
    expect(res.status).toBe(200);
    expectCalendarHeaders(res, ref);
    expect(prop(res.text, "STATUS")).toBe("CONFIRMED");
    expect(prop(res.text, "UID")).toBe(`${ref}@localhost`);
    expect(prop(res.text, "SEQUENCE")).toBe("2");
    expect(prop(res.text, "URL")).toBe("http://localhost:5173/r");
    expect(res.text).not.toContain(token);
    expect(res.text).not.toContain(token.slice(4, 30));
    expect(unfold(res.text)).not.toMatch(/#t=|token/i);
    for (const name of TECH_NAMES) expect(res.text).not.toContain(name);
  });

  it("is scoped to the one reservation the token names", async () => {
    const mine = await confirmed(pat, at(FRI, 10));
    const theirs = await confirmed(sam, at(FRI, 11), team.b);
    const res = await accessIcs(await mintToken(mine.id));
    expect(res.text).toContain(mine.ref);
    expect(res.text).not.toContain(theirs.ref);
    expect(prop(res.text, "DTSTART")).toBe(utc(at(FRI, 10)));
  });

  it("gives CANCELLED after a confirmed appointment is cancelled, and 409 for a never-confirmed one", async () => {
    const c = await confirmed(pat, at(FRI, 10));
    const tc = await mintToken(c.id);
    const first = await accessIcs(tc);
    expect((await api("POST", "/api/access/reservation/cancel", { body: { token: tc, version: 2 } })).status).toBe(200);
    const res = await accessIcs(tc);
    expect(res.status).toBe(200);
    expect(prop(res.text, "STATUS")).toBe("CANCELLED");
    expect(Number(prop(res.text, "SEQUENCE"))).toBeGreaterThan(Number(prop(first.text, "SEQUENCE")));

    const p = await submit(sam, at(FRI, 11));
    const pending = await accessIcs(await mintToken(p.id));
    expect(pending.status).toBe(409);
    expect(JSON.parse(pending.text)).toEqual({ error: "not_confirmed" });
  });

  it("answers unknown, expired and malformed tokens alike", async () => {
    const { id } = await confirmed(pat, at(FRI, 10));
    const expired = await mintToken(id, clock.now() - 1);
    for (const token of [`tok-${crypto.randomUUID()}-${crypto.randomUUID()}`, expired]) {
      const res = await accessIcs(token);
      expect(res.status).toBe(404);
      expect(JSON.parse(res.text)).toEqual({ error: "invalid_link" });
    }
    expect((await accessIcs("short")).status).toBe(400);
    expect((await accessIcs(undefined)).status).toBe(400);
    expect((await rawApi("POST", "/api/access/reservation/ics", { body: { token: await mintToken(id) }, xrw: false })).status).toBe(403);
  });
});

describe("GET /api/staff/reservations/:id/ics", () => {
  it("serves a confirmed appointment for staff with the customer, contact, phone, issue and technician", async () => {
    const { id, ref } = await confirmed(pat, at(FRI, 10), team.b);
    for (const cookie of [adminCookie, techCookie]) {
      const res = await staffIcs(cookie, id);
      expect(res.status).toBe(200);
      expectCalendarHeaders(res, ref);
      expect(prop(res.text, "STATUS")).toBe("CONFIRMED");
      expect(prop(res.text, "UID")).toBe(`${ref}@localhost`);
      expect(prop(res.text, "SEQUENCE")).toBe("2");
      expect(prop(res.text, "DTSTART")).toBe(utc(at(FRI, 10)));
      expect(prop(res.text, "URL")).toBe(`http://localhost:5173/staff/r/${id}`);
      expect(textProp(res.text, "SUMMARY")).toBe(`Remote support — Pat Co (${ref})`);
      const description = textProp(res.text, "DESCRIPTION")!;
      expect(description).toContain(ref);
      expect(description).toContain("Pat Example");
      expect(description).toContain("pat@example.test");
      expect(description).toContain("+81 3-1234-5678");
      expect(description).toContain("Printer is offline, again; help");
      expect(description).toContain("Una Tech");
      expect(description).toContain(`http://localhost:5173/staff/r/${id}`);
      expect(res.text).not.toContain("VALARM");
    }
  });

  it("gives CANCELLED for cancelled-after-confirmation and 409 for never-confirmed", async () => {
    const { id } = await confirmed(pat, at(FRI, 10));
    expect((await api("POST", `/api/staff/reservations/${id}/cancel`, { cookie: adminCookie, body: { reason: "Out sick", version: 2 } })).status).toBe(200);
    const res = await staffIcs(adminCookie, id);
    expect(res.status).toBe(200);
    expect(prop(res.text, "STATUS")).toBe("CANCELLED");
    expect(prop(res.text, "SEQUENCE")).toBe("3");

    const pending = await submit(sam, at(FRI, 11));
    const p = await staffIcs(adminCookie, pending.id);
    expect(p.status).toBe(409);
    expect(JSON.parse(p.text)).toEqual({ error: "not_confirmed" });
  });

  it("requires staff, 404s unknown ids, and changes nothing", async () => {
    const { id } = await confirmed(pat, at(FRI, 10));
    expect((await rawApi("GET", `/api/staff/reservations/${id}/ics`)).status).toBe(401);
    expect((await staffIcs(pat.cookie, id)).status).toBe(401);
    expect((await staffIcs(adminCookie, "no-such-id")).status).toBe(404);
    const snapshot = async () => ({
      // Rows only: the result meta carries a timing (duration) that differs between runs.
      r: (await env.DB.prepare("SELECT * FROM reservations").all()).results,
      a: await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log").first(),
      j: await env.DB.prepare("SELECT COUNT(*) AS n FROM email_jobs").first(),
    });
    const before = await snapshot();
    expect((await staffIcs(adminCookie, id)).status).toBe(200);
    expect(await snapshot()).toEqual(before);
  });
});
