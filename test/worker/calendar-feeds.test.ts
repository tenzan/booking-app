import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/worker/index";
import { api } from "../helpers";
import { loginCustomer, loginStaff, seedCustomer, seedTeam, seedWeekly, TZ } from "../fixtures";
import { setNow } from "../../src/worker/lib/clock";
import { wallToUtc } from "../../src/domain/time";
import { ensureFeedToken, firstName } from "../../src/worker/calendar-feeds";
import { HttpError } from "../../src/worker/lib/http";

afterEach(() => setNow(null));

const THU = "2026-10-01";
const FRI = "2026-10-02";
const DAY = 86_400_000;
const at = (date: string, h: number, m = 0) => wallToUtc(date, h * 60 + m, TZ);

let team: Awaited<ReturnType<typeof seedTeam>>;
let pat: { id: number; cookie: string };
let adminCookie: string;
let techA: string;

beforeEach(async () => {
  setNow(at(THU, 8));
  team = await seedTeam();
  for (const [id, name] of [[team.admin, "Ada Admin"], [team.a, "Tim Tech"], [team.b, "Una Tech"]] as const) {
    await env.DB.prepare("UPDATE staff SET name = ? WHERE id = ?").bind(name, id).run();
  }
  await env.DB.prepare("INSERT INTO settings(key, value) VALUES ('orgName', '\"Acme Support\"'), ('maxActivePerAccount', '9')").run();
  pat = { id: await seedCustomer({ email: "pat@example.test", name: "Pat, Co; Ltd" }), cookie: "" };
  pat.cookie = await loginCustomer("pat@example.test");
  adminCookie = await loginStaff("admin@example.test");
  techA = await loginStaff("tech-a@example.test");
  await seedWeekly(5, 600, 720, [team.admin, team.a, team.b]);
});

const submit = async (startAt: number, issue = "Printer offline") => {
  const res = await api("POST", "/api/customer/reservations", {
    cookie: pat.cookie,
    body: { customerId: pat.id, startAt, contactName: "Pat Example", phone: "+81 3-1234-5678", issue, idempotencyKey: crypto.randomUUID() },
  });
  expect(res.status).toBe(201);
  return { id: res.json.reservation.id as string, ref: res.json.reservation.ref as string };
};
const confirmed = async (startAt: number, staffId: number, issue?: string) => {
  const r = await submit(startAt, issue);
  expect((await api("POST", `/api/staff/reservations/${r.id}/approve`, { cookie: adminCookie, body: { staffId, version: 1 } })).status).toBe(200);
  return r;
};
const urls = async (cookie: string) => {
  const res = await api("POST", "/api/staff/calendar-feed", { cookie, body: {} });
  expect(res.status).toBe(200);
  return res.json as { mine: string; team: string };
};
const raw = async (url: string, method = "GET", ip?: string) => {
  const ctx = createExecutionContext();
  const headers = new Headers();
  if (ip) headers.set("cf-connecting-ip", ip);
  const res = await worker.fetch!(new Request(url, { method, headers }) as any, env as any, ctx);
  await waitOnExecutionContext(ctx);
  const body = await res.text();
  // `body` as served (folded); `text` unfolded, for matching.
  return { status: res.status, headers: res.headers, body, text: body.replace(/\r\n /g, "") };
};
const summaries = (ics: string) => ics.split("\r\n").filter((l) => l.startsWith("SUMMARY:")).map((l) => l.slice(8).replace(/\\([,;\\])/g, "$1"));

describe("feed content", () => {
  it("Mine holds my confirmed appointments; Team holds everyone else's, titled with the technician's first name", async () => {
    const mine = await confirmed(at(FRI, 10), team.a);
    const theirs = await confirmed(at(FRI, 11), team.b);
    await submit(at(FRI, 10, 30)); // pending: in neither
    const { mine: mineUrl, team: teamUrl } = await urls(techA);
    const m = await raw(mineUrl);
    expect(m.status).toBe(200);
    expect(m.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(m.headers.get("content-disposition")).toBe('inline; filename="mine.ics"');
    expect(m.text).toContain("X-WR-CALNAME:Acme Support — my appointments");
    expect(summaries(m.text)).toEqual([`Pat, Co; Ltd (${mine.ref})`]);
    expect(m.text).toContain(`UID:${mine.ref}@localhost`);
    const tm = await raw(teamUrl);
    expect(tm.text).toContain("X-WR-CALNAME:Acme Support — team");
    expect(summaries(tm.text)).toEqual([`Una: Pat, Co; Ltd (${theirs.ref})`]);
    expect(tm.text).not.toContain(mine.ref);
  });

  it("leaves out cancelled appointments and those that ended more than 30 days ago", async () => {
    const gone = await confirmed(at(FRI, 10), team.a);
    expect((await api("POST", `/api/staff/reservations/${gone.id}/cancel`, { cookie: adminCookie, body: { reason: "x", version: 2 } })).status).toBe(200);
    const old = await confirmed(at(FRI, 11), team.a);
    const { mine } = await urls(techA);
    expect((await raw(mine)).text).toContain(old.ref);
    setNow(at(FRI, 11, 30) + 30 * DAY + 1);
    const later = (await raw(mine)).text;
    expect(later).not.toContain(old.ref);
    expect(later).not.toContain(gone.ref);
  });

  it("moves an appointment from Team to Mine when it is reassigned to me", async () => {
    const r = await confirmed(at(FRI, 10), team.b);
    const { mine, team: teamUrl } = await urls(techA);
    expect((await raw(teamUrl)).text).toContain(r.ref);
    expect((await api("POST", `/api/staff/reservations/${r.id}/reassign`, { cookie: adminCookie, body: { staffId: team.a, version: 2 } })).status).toBe(200);
    expect((await raw(mine)).text).toContain(r.ref);
    expect((await raw(teamUrl)).text).not.toContain(r.ref);
  });

  it("is a well-formed empty calendar when there is nothing to show", async () => {
    const { mine } = await urls(techA);
    const res = await raw(mine);
    expect(res.status).toBe(200);
    expect(res.text.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(res.text.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(res.text).not.toContain("BEGIN:VEVENT");
  });

  it("escapes and folds awkward customer text", async () => {
    const issue = `Line one; with, commas\nLine two 😀 ${"x".repeat(950)}`;
    await confirmed(at(FRI, 10), team.a, issue);
    const res = await raw((await urls(techA)).mine);
    for (const line of res.body.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(res.text).toContain("Line one\\; with\\, commas\\nLine two 😀");
  });

  it("answers HEAD and ignores a query string", async () => {
    const { mine } = await urls(techA);
    expect((await raw(mine, "HEAD")).status).toBe(200);
    expect((await raw(`${mine}?refresh=1`)).status).toBe(200);
  });
});

describe("feed access", () => {
  it("answers an unknown token or kind with a plain-text 404", async () => {
    const { mine } = await urls(techA);
    for (const url of [mine.replace(/\/feed\/[^/]+\//, `/feed/${"x".repeat(43)}/`), mine.replace("mine.ics", "all.ics"), mine.replace("mine.ics", "mine.txt")]) {
      const res = await raw(url);
      expect(res.status, url).toBe(404);
      expect(res.headers.get("content-type")?.toLowerCase()).toBe("text/plain; charset=utf-8");
      expect(res.text).toContain("http://localhost:5173/");
    }
  });

  it("stops serving a deactivated staff member's feeds", async () => {
    const { mine } = await urls(techA);
    await env.DB.prepare("UPDATE staff SET active = 0 WHERE id = ?").bind(team.a).run();
    expect((await raw(mine)).status).toBe(404);
  });

  it("is rate limited per IP", async () => {
    const { mine } = await urls(techA);
    let last = 0;
    for (let i = 0; i < 121; i++) last = (await raw(mine, "GET", "203.0.113.7")).status;
    expect(last).toBe(429);
    expect((await raw(mine, "GET", "203.0.113.8")).status).toBe(200);
  });
});

describe("firstName", () => {
  it("takes the first word, trimmed, and copes with one word or none", () => {
    expect(firstName("Tim Tech")).toBe("Tim");
    expect(firstName("  Una   Tech ")).toBe("Una");
    expect(firstName("Madonna")).toBe("Madonna");
    expect(firstName("")).toBe("—");
    expect(firstName(null)).toBe("—");
  });
});

describe("subscription links for staff", () => {
  it("are created once and then stay the same, even when two tabs ask at once", async () => {
    const [a, b] = await Promise.all([urls(techA), urls(techA)]);
    expect(a).toEqual(b);
    expect(await urls(techA)).toEqual(a);
    expect(a.mine).toMatch(/^http:\/\/localhost:5173\/api\/feed\/[A-Za-z0-9_-]{43}\/mine\.ics$/);
    expect(a.team).toBe(a.mine.replace("mine.ics", "team.ics"));
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM calendar_feeds").first("n")).toBe(1);
  });

  it("differ per staff member", async () => {
    expect((await urls(techA)).mine).not.toBe((await urls(adminCookie)).mine);
  });

  it("reset gives new links, the old ones stop, and the reset is in the activity log", async () => {
    const before = await urls(techA);
    const res = await api("POST", "/api/staff/calendar-feed/reset", { cookie: techA, body: {} });
    expect(res.status).toBe(200);
    expect(res.json.mine).not.toBe(before.mine);
    expect((await raw(before.mine)).status).toBe(404);
    expect((await raw(res.json.mine)).status).toBe(200);
    expect(await urls(techA)).toEqual(res.json);
    const a = await env.DB.prepare("SELECT actor_kind, actor, action FROM audit_log WHERE action = 'calendar_feed.reset'").first();
    expect(a).toEqual({ actor_kind: "staff", actor: String(team.a), action: "calendar_feed.reset" });
  });

  it("reset works before any link was made", async () => {
    const res = await api("POST", "/api/staff/calendar-feed/reset", { cookie: techA, body: {} });
    expect(res.status).toBe(200);
    expect((await raw(res.json.mine)).status).toBe(200);
  });

  it("need a staff session and the CSRF header", async () => {
    expect((await api("POST", "/api/staff/calendar-feed", { body: {} })).status).toBe(401);
    expect((await api("POST", "/api/staff/calendar-feed", { cookie: pat.cookie, body: {} })).status).toBe(401);
    expect((await api("POST", "/api/staff/calendar-feed", { cookie: techA, body: {}, xrw: false })).status).toBe(403);
    expect((await api("POST", "/api/staff/calendar-feed/reset", { body: {} })).status).toBe(401);
  });
});

describe("ensureFeedToken", () => {
  it("fails with a clear error, not a crash, if the token can't be stored (e.g. a random token colliding)", async () => {
    // The insert is ignored, as INSERT OR IGNORE does on a UNIQUE clash; the read-back then finds nothing.
    const real = env.DB;
    const db = {
      prepare: (q: string) => (q.startsWith("INSERT OR IGNORE INTO calendar_feeds") ? { bind: () => ({ run: async () => ({}) }) } : real.prepare(q)),
    } as unknown as D1Database;
    const err = await ensureFeedToken(db, team.a).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 503, code: "calendar_feed_unavailable" });
  });
});
