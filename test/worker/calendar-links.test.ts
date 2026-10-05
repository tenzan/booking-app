import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/worker/index";
import { api } from "../helpers";
import { loginCustomer, loginStaff, seedCustomer, seedTeam, seedWeekly, TZ } from "../fixtures";
import { clock, setNow } from "../../src/worker/lib/clock";
import { sha256Hex } from "../../src/worker/lib/crypto";
import { wallToUtc } from "../../src/domain/time";
import { mintCalendarToken } from "../../src/worker/reservations/ics";

afterEach(() => setNow(null));

const THU = "2026-10-01";
const FRI = "2026-10-02";
const HOUR = 3_600_000;
const at = (date: string, h: number, m = 0) => wallToUtc(date, h * 60 + m, TZ);
const utc = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
const TECH_NAMES = ["Ada Admin", "Tim Tech", "Una Tech"];

let team: Awaited<ReturnType<typeof seedTeam>>;
let pat: { id: number; cookie: string };
let sam: { id: number; cookie: string };
let adminCookie: string;

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
  await seedWeekly(5, 600, 720, [team.admin, team.a, team.b]);
  for (const [k, v] of Object.entries({ orgName: "Acme Support", remoteToolName: "AnyDesk", maxActivePerAccount: 5 })) {
    await env.DB.prepare("INSERT INTO settings(key, value) VALUES (?, ?)").bind(k, JSON.stringify(v)).run();
  }
});

const submit = async (who: { id: number; cookie: string }, startAt: number) => {
  const res = await api("POST", "/api/customer/reservations", {
    cookie: who.cookie,
    body: { customerId: who.id, startAt, contactName: "Pat Example", phone: "+81 3-1234-5678", issue: "Printer offline", idempotencyKey: crypto.randomUUID() },
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
const mintAccess = async (reservationId: string) => {
  const token = `tok-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  await env.DB.prepare("INSERT INTO access_tokens(token_hash, reservation_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), reservationId, clock.now(), clock.now() + 30 * 86_400_000)
    .run();
  return token;
};

const rawGet = async (path: string, opts: { ip?: string } = {}) => {
  const headers = new Headers();
  if (opts.ip) headers.set("cf-connecting-ip", opts.ip);
  const ctx = createExecutionContext();
  const res = await worker.fetch!(new Request(`http://localhost:5173${path}`, { headers }) as any, env as any, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, headers: res.headers, text: await res.text() };
};
const calPath = (token: string) => `/api/cal/${token}.ics`;
/** Tokens minted so far (the confirmation emails mint their own). */
const tokenCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM calendar_tokens").first<{ n: number }>())!.n;
const tokenOf = (icsUrl: string) => icsUrl.match(/\/api\/cal\/([A-Za-z0-9_-]+)\.ics$/)![1]!;

const unfold = (s: string) => s.replace(/\r\n /g, "");
const prop = (ics: string, name: string) => unfold(ics).split("\r\n").find((l) => l.startsWith(`${name}:`))?.slice(name.length + 1);

describe("GET /api/cal/:token.ics", () => {
  it("serves the customer event for a customer token, with no technician data", async () => {
    const { id, ref } = await confirmed(pat, at(FRI, 10));
    const token = await mintCalendarToken(env.DB, id, "customer", clock.now() + HOUR);
    const res = await rawGet(calPath(token));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${ref}.ics"`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(prop(res.text, "UID")).toBe(`${ref}@localhost`);
    expect(prop(res.text, "STATUS")).toBe("CONFIRMED");
    expect(prop(res.text, "DTSTART")).toBe(utc(at(FRI, 10)));
    expect(prop(res.text, "URL")).toBe("http://localhost:5173/my");
    expect(res.text).not.toContain(token);
    for (const name of TECH_NAMES) expect(res.text).not.toContain(name);
  });

  it("serves the staff event for a staff token", async () => {
    const { id, ref } = await confirmed(pat, at(FRI, 10), team.b);
    const res = await rawGet(calPath(await mintCalendarToken(env.DB, id, "staff", clock.now() + HOUR)));
    expect(res.status).toBe(200);
    expect(prop(res.text, "URL")).toBe(`http://localhost:5173/staff/r/${id}`);
    expect(unfold(res.text)).toContain("Una Tech");
    expect(unfold(res.text)).toContain(ref);
  });

  it("always reflects the reservation now: a cancelled appointment comes back as CANCELLED", async () => {
    const { id } = await confirmed(pat, at(FRI, 10));
    const token = await mintCalendarToken(env.DB, id, "customer", clock.now() + HOUR);
    expect((await api("POST", `/api/customer/reservations/${id}/cancel`, { cookie: pat.cookie, body: { version: 2 } })).status).toBe(200);
    const res = await rawGet(calPath(token));
    expect(res.status).toBe(200);
    expect(prop(res.text, "STATUS")).toBe("CANCELLED");
  });

  it("answers unknown, expired and malformed links with a readable plain-text page", async () => {
    const { id } = await confirmed(pat, at(FRI, 10));
    const expired = await mintCalendarToken(env.DB, id, "customer", clock.now() - 1);
    for (const path of [calPath(expired), calPath("x".repeat(43)), calPath("short"), `/api/cal/${"y".repeat(43)}`, `/api/cal/${"z".repeat(43)}.txt`]) {
      const res = await rawGet(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("content-type")?.toLowerCase()).toBe("text/plain; charset=utf-8");
      expect(res.text).toContain("http://localhost:5173/");
      expect(res.text).not.toContain("BEGIN:VCALENDAR");
    }
  });

  it("does not accept an access token (those live in their own table)", async () => {
    const { id } = await confirmed(pat, at(FRI, 10));
    expect((await rawGet(calPath(await mintAccess(id)))).status).toBe(404);
  });

  it("says in plain text when the appointment is no longer in calendars", async () => {
    const { id } = await confirmed(pat, at(FRI, 10));
    const token = await mintCalendarToken(env.DB, id, "customer", clock.now() + HOUR);
    await env.DB.prepare("UPDATE reservations SET status = 'completed' WHERE id = ?").bind(id).run();
    const res = await rawGet(calPath(token));
    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")?.toLowerCase()).toBe("text/plain; charset=utf-8");
    expect(res.text).not.toContain("BEGIN:VCALENDAR");
  });

  it("is rate limited per IP", async () => {
    const { id } = await confirmed(pat, at(FRI, 10));
    const token = await mintCalendarToken(env.DB, id, "customer", clock.now() + HOUR);
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await rawGet(calPath(token), { ip: "203.0.113.9" })).status;
    expect(last).toBe(429);
    expect((await rawGet(calPath(token), { ip: "203.0.113.10" })).status).toBe(200);
  });

  it("only stores the token's hash", async () => {
    const { id } = await confirmed(pat, at(FRI, 10));
    const token = await mintCalendarToken(env.DB, id, "staff", clock.now() + HOUR);
    const row = await env.DB.prepare("SELECT token_hash, audience FROM calendar_tokens WHERE expires_at = ?").bind(clock.now() + HOUR).first();
    expect(row).toEqual({ token_hash: await sha256Hex(token), audience: "staff" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM calendar_tokens WHERE token_hash = ?").bind(token).first("n")).toBe(0);
  });
});

const expectWebLinks = (links: Record<string, string>, startAt: number) => {
  expect(Object.keys(links).sort()).toEqual(["google", "ics", "office365", "outlook"]);
  const g = new URL(links.google!);
  expect(g.hostname).toBe("calendar.google.com");
  expect(g.searchParams.get("dates")).toBe(`${utc(startAt)}/${utc(startAt + 30 * 60_000)}`);
  expect(new URL(links.outlook!).hostname).toBe("outlook.live.com");
  expect(new URL(links.office365!).hostname).toBe("outlook.office.com");
};

describe("calendar links for the app", () => {
  it("customer session: Google/Outlook links with the customer text and a fresh one-hour .ics link", async () => {
    const { id, ref } = await confirmed(pat, at(FRI, 10));
    const res = await api("POST", `/api/customer/reservations/${id}/calendar`, { cookie: pat.cookie, body: {} });
    expect(res.status).toBe(200);
    const links = res.json.links;
    expectWebLinks(links, at(FRI, 10));
    const g = new URL(links.google);
    expect(g.searchParams.get("text")).toBe("Remote support — Acme Support");
    expect(g.searchParams.get("details")).toContain(ref);
    for (const name of TECH_NAMES) expect(decodeURIComponent(JSON.stringify(links))).not.toContain(name);
    expect(links.ics).toMatch(/^http:\/\/localhost:5173\/api\/cal\/[A-Za-z0-9_-]{43}\.ics$/);
    const row = await env.DB.prepare("SELECT audience, expires_at FROM calendar_tokens WHERE token_hash = ?").bind(await sha256Hex(tokenOf(links.ics))).first();
    expect(row).toEqual({ audience: "customer", expires_at: clock.now() + HOUR });
    expect((await rawGet(new URL(links.ics).pathname)).status).toBe(200);
  });

  it("customer session: ownership as for the file, and only for a confirmed appointment", async () => {
    const { id } = await confirmed(pat, at(FRI, 10));
    const before = await tokenCount();
    expect((await api("POST", `/api/customer/reservations/${id}/calendar`, { cookie: sam.cookie, body: {} })).status).toBe(404);
    expect((await api("POST", `/api/customer/reservations/${id}/calendar`, { body: {} })).status).toBe(401);
    const pending = await submit(pat, at(FRI, 11));
    const p = await api("POST", `/api/customer/reservations/${pending.id}/calendar`, { cookie: pat.cookie, body: {} });
    expect(p.status).toBe(409);
    expect(p.json).toEqual({ error: "not_confirmed" });
    // A cancelled appointment cannot be added anywhere.
    expect((await api("POST", `/api/customer/reservations/${id}/cancel`, { cookie: pat.cookie, body: { version: 2 } })).status).toBe(200);
    expect((await api("POST", `/api/customer/reservations/${id}/calendar`, { cookie: pat.cookie, body: {} })).status).toBe(409);
    expect(await tokenCount()).toBe(before);
  });

  it("emailed link: the access token scopes it to its reservation", async () => {
    const { id, ref } = await confirmed(pat, at(FRI, 10));
    const res = await api("POST", "/api/access/reservation/calendar", { body: { token: await mintAccess(id) } });
    expect(res.status).toBe(200);
    expectWebLinks(res.json.links, at(FRI, 10));
    expect(new URL(res.json.links.google).searchParams.get("details")).toContain(ref);
    expect(res.json.links.ics).toMatch(/\/api\/cal\/[A-Za-z0-9_-]{43}\.ics$/);
    const bad = await api("POST", "/api/access/reservation/calendar", { body: { token: `tok-${crypto.randomUUID()}-${crypto.randomUUID()}` } });
    expect(bad.status).toBe(404);
    expect(bad.json).toEqual({ error: "invalid_link" });
  });

  it("staff: the staff text, and the session download for .ics (no token minted)", async () => {
    const { id, ref } = await confirmed(pat, at(FRI, 10), team.b);
    const before = await tokenCount();
    const res = await api("GET", `/api/staff/reservations/${id}/calendar`, { cookie: adminCookie });
    expect(res.status).toBe(200);
    expectWebLinks(res.json.links, at(FRI, 10));
    const g = new URL(res.json.links.google);
    expect(g.searchParams.get("text")).toBe(`Remote support — Pat Co (${ref})`);
    expect(g.searchParams.get("details")).toContain("Una Tech");
    expect(res.json.links.ics).toBe(`http://localhost:5173/api/staff/reservations/${id}/ics`);
    expect(await tokenCount()).toBe(before);
    expect((await api("GET", `/api/staff/reservations/${id}/calendar`, { cookie: pat.cookie })).status).toBe(401);
    const pending = await submit(sam, at(FRI, 11));
    expect((await api("GET", `/api/staff/reservations/${pending.id}/calendar`, { cookie: adminCookie })).status).toBe(409);
  });
});
