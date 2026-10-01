import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../helpers";
import { loginCustomer, loginStaff, seedCustomer, seedTeam, seedWeekly, TZ, withBatchHook } from "../fixtures";
import { setNow } from "../../src/worker/lib/clock";
import { applyChange, previewChange } from "../../src/worker/scheduling/roster";
import { rangeBlocks } from "../../src/domain/slots";
import { wallToUtc } from "../../src/domain/time";
import type { StaffPrincipal } from "../../src/worker/env";
import type { ScheduleChange, WindowInput } from "../../src/shared/types";

// Conflicts answered together with the schedule change ("staged resolutions"): the chosen technician is judged under
// the PROPOSED schedule, and the reassignment commits in the same batch as the change.

afterEach(() => setNow(null));

const THU = "2026-10-01";
const FRI = "2026-10-02";
const at = (date: string, h: number, m = 0) => wallToUtc(date, h * 60 + m, TZ);

let team: Awaited<ReturnType<typeof seedTeam>>;
let fri: number;
let pat: { id: number; cookie: string };
let sam: { id: number; cookie: string };
let adminCookie: string;
let admin: StaffPrincipal;

beforeEach(async () => {
  setNow(at(THU, 8));
  team = await seedTeam();
  for (const [id, name] of [[team.admin, "Ada Admin"], [team.a, "Tim Tech"], [team.b, "Una Tech"], [team.c, "Cy Tech"], [team.d, "Dee Tech"]] as const) {
    await env.DB.prepare("UPDATE staff SET name = ? WHERE id = ?").bind(name, id).run();
  }
  admin = { id: team.admin, email: "admin@example.test", name: "Ada Admin", role: "admin" };
  fri = await seedWeekly(5, 600, 660, [team.a, team.b]);
  pat = { id: await seedCustomer({ email: "pat@example.test", name: "Pat Co" }), cookie: "" };
  sam = { id: await seedCustomer({ email: "sam@example.test", name: "Sam Co" }), cookie: "" };
  pat.cookie = await loginCustomer("pat@example.test");
  sam.cookie = await loginCustomer("sam@example.test");
  adminCookie = await loginStaff("admin@example.test");
});

const weekly = (staffIds: number[]): WindowInput => ({ kind: "weekly", weekday: 5, date: null, startMin: 600, endMin: 660, staffIds });
const dated = (staffIds: number[]): WindowInput => ({ kind: "date", weekday: null, date: FRI, startMin: 600, endMin: 660, staffIds });

const preview = (change: unknown, resolutions?: unknown) => api("POST", "/api/staff/schedule/preview", { cookie: adminCookie, body: { change, resolutions } });
const apply = (change: unknown, version: number, resolutions?: unknown) =>
  api("POST", "/api/staff/schedule/apply", { cookie: adminCookie, body: { change, version, resolutions } });

const submit = async (who: { id: number; cookie: string }, startAt: number) => {
  const res = await api("POST", "/api/customer/reservations", {
    cookie: who.cookie,
    body: { customerId: who.id, startAt, contactName: "Pat Example", phone: "+81 3-1234-5678", issue: "Printer is offline", idempotencyKey: crypto.randomUUID() },
  });
  expect(res.status).toBe(201);
  return res.json.reservation as { id: string; ref: string };
};
const confirmed = async (who: { id: number; cookie: string }, staffId: number) => {
  const r = await submit(who, at(FRI, 10));
  const res = await api("POST", `/api/staff/reservations/${r.id}/approve`, { cookie: adminCookie, body: { staffId, version: 1 } });
  expect(res.status).toBe(200);
  return r;
};
const count = async (sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;
const row = (id: string) => env.DB.prepare("SELECT * FROM reservations WHERE id = ?").bind(id).first<any>();
const blockStaff = async (id: string) =>
  [...new Set((await env.DB.prepare("SELECT staff_id FROM tech_blocks WHERE owner_id = ?").bind(id).all<{ staff_id: number }>()).results.map((b) => b.staff_id))];
const blockCount = (id: string) => count("SELECT COUNT(*) AS n FROM tech_blocks WHERE owner_id = ?", id);
const windowStaff = async (windowId: number) =>
  (await env.DB.prepare("SELECT staff_id FROM availability_window_staff WHERE window_id = ? ORDER BY staff_id").bind(windowId).all<{ staff_id: number }>()).results.map((r) => r.staff_id);
const reassignAudits = async () =>
  (await env.DB.prepare("SELECT actor, reservation_id, customer_id, details FROM audit_log WHERE action = 'reservation.reassigned' ORDER BY id").all<any>()).results.map((a) => ({
    ...a,
    details: JSON.parse(a.details),
  }));
const scheduleVersion = async () => (await env.DB.prepare("SELECT version FROM schedule_state").first<{ version: number }>())!.version;

describe("staged resolutions", () => {
  it("swap: replacing the only technicians of a window reassigns the appointment to the new one in the same commit", async () => {
    const r = await confirmed(pat, team.a); // version 2, on a
    const change = { type: "window.update", id: fri, window: weekly([team.c]) };

    // The dead end this fixes: under the CURRENT roster c has no window at 10:00, so a direct reassignment is refused.
    const direct = await api("POST", `/api/staff/reservations/${r.id}/reassign`, { cookie: adminCookie, body: { staffId: team.c, version: 2 } });
    expect([direct.status, direct.json.error]).toEqual([409, "tech_unavailable"]);

    const plain = await preview(change);
    expect(plain.json.impact.conflicts).toEqual([expect.objectContaining({ id: r.id, reason: "tech_removed", alternatives: [{ id: team.c, name: "Cy Tech", displaces: [] }] })]);

    const staged = await preview(change, [{ reservationId: r.id, staffId: team.c }]);
    expect(staged.status).toBe(200);
    expect(staged.json.impact).toEqual({ moved: [], conflicts: [], warnings: [] });
    expect((await row(r.id)).assigned_staff_id).toBe(team.a); // preview never writes

    const v0 = await scheduleVersion();
    const res = await apply(change, staged.json.version, [{ reservationId: r.id, staffId: team.c }]);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toEqual({ version: v0 + 1, impact: { moved: [], conflicts: [], warnings: [] } });
    expect(await scheduleVersion()).toBe(v0 + 1);

    expect(await windowStaff(fri)).toEqual([team.c]);
    const after = await row(r.id);
    expect([after.status, after.assigned_staff_id, after.version]).toEqual(["confirmed", team.c, 3]);
    expect(await blockStaff(r.id)).toEqual([team.c]);
    expect(await blockCount(r.id)).toBe(rangeBlocks(after.occ_start, after.occ_end).length);

    // Task 6 notice rules: every notified team member but the actor, keyed on the new version; no customer mail by default.
    expect(await count("SELECT COUNT(*) AS n FROM email_jobs WHERE template = 'reassigned'")).toBe(4);
    for (const s of [team.a, team.b, team.c, team.d]) {
      expect(await count("SELECT COUNT(*) AS n FROM email_jobs WHERE dedupe_key = ?", `reassigned:${r.id}:v3:${s}`)).toBe(1);
    }
    expect(await count("SELECT COUNT(*) AS n FROM email_jobs WHERE template = 'reassigned' AND to_email IN ('admin@example.test', 'pat@example.test')")).toBe(0);

    expect(await reassignAudits()).toEqual([{ actor: String(team.admin), reservation_id: r.id, customer_id: pat.id, details: { from: team.a, to: team.c, via: "schedule" } }]);
    const sched = await env.DB.prepare("SELECT details FROM audit_log WHERE action = 'schedule.window.update'").first<{ details: string }>();
    expect(JSON.parse(sched!.details)).toMatchObject({ id: fri, moved: [], resolved: [{ id: r.id, ref: r.ref, from: team.a, to: team.c }] });
  });

  it("tells both technicians involved even with notify off, and the apply route delivers the mail itself", async () => {
    await env.DB.prepare("UPDATE staff SET notify = 0 WHERE id IN (?, ?)").bind(team.a, team.c).run();
    const r = await confirmed(pat, team.a);
    const change = { type: "window.update", id: fri, window: weekly([team.c]) };
    const { version } = await previewChange(env, change as ScheduleChange, [{ reservationId: r.id, staffId: team.c }]);
    const res = await apply(change, version, [{ reservationId: r.id, staffId: team.c }]);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const to = (email: string) => count("SELECT COUNT(*) AS n FROM email_jobs WHERE template = 'reassigned' AND to_email = ?", email);
    // from (a) and to (c) despite notify off; b and d follow requests; the acting admin is not told.
    expect([await to("tech-a@example.test"), await to("tech-c@example.test"), await to("tech-b@example.test"), await to("tech-d@example.test")]).toEqual([1, 1, 1, 1]);
    expect(await to("admin@example.test")).toBe(0);
    // Sent by the route's own outbox kick, not by a later sweep.
    expect(await count("SELECT COUNT(*) AS n FROM email_jobs WHERE template = 'reassigned' AND status = 'sent'")).toBe(4);
    expect(await count("SELECT COUNT(*) AS n FROM dev_mailbox WHERE to_email = 'tech-c@example.test' AND subject LIKE '%reassigned%'")).toBe(1);
  });

  it("the customer is told too when the setting asks for it", async () => {
    await env.DB.prepare("INSERT INTO settings(key, value) VALUES ('notifyCustomerOnReassign', 'true')").run();
    const r = await confirmed(pat, team.a);
    const change: ScheduleChange = { type: "window.update", id: fri, window: weekly([team.c]) };
    const { version } = await previewChange(env, change, [{ reservationId: r.id, staffId: team.c }]);
    await applyChange(env, admin, change, version, [{ reservationId: r.id, staffId: team.c }]);
    expect(await count("SELECT COUNT(*) AS n FROM email_jobs WHERE dedupe_key = ?", `reassigned-customer:${r.id}:v3`)).toBe(1);
  });

  it("reports resolutions that cannot hold, with the reason, and evaluates their holds as if they were not sent", async () => {
    const r = await confirmed(pat, team.a);
    const s = await confirmed(sam, team.b);
    await env.DB.prepare("INSERT INTO staff_unavailability(staff_id, start_at, end_at, reason) VALUES (?, ?, ?, 'Leave')").bind(team.d, at(FRI, 9), at(FRI, 12)).run();
    const change = { type: "window.update", id: fri, window: weekly([team.c, team.d]) };

    // d is on leave; c can take only one of the two appointments; nothing else qualifies.
    const p = await preview(change, [
      { reservationId: r.id, staffId: team.d },
      { reservationId: s.id, staffId: team.c },
      { reservationId: r.id.replace(/.$/, "x"), staffId: team.c },
    ]);
    expect(p.status).toBe(200);
    expect(p.json.impact.conflicts.map((c: any) => [c.id, c.reason, c.alternatives.map((a: any) => a.id)])).toEqual([[r.id, "tech_removed", []]]);
    expect(p.json.impact.invalidResolutions).toEqual([
      { reservationId: r.id, staffId: team.d, reason: "tech_unavailable" },
      { reservationId: r.id.replace(/.$/, "x"), staffId: team.c, reason: "not_found" },
    ]);

    const clash = await preview(change, [
      { reservationId: s.id, staffId: team.c },
      { reservationId: r.id, staffId: team.c },
    ]);
    expect(clash.json.impact.invalidResolutions).toEqual([{ reservationId: r.id, staffId: team.c, reason: "clash" }]);

    const same = await preview({ type: "window.update", id: fri, window: weekly([team.a, team.b, team.c]) }, [{ reservationId: r.id, staffId: team.a }]);
    expect(same.json.impact).toEqual({ moved: [], conflicts: [], warnings: [], invalidResolutions: [{ reservationId: r.id, staffId: team.a, reason: "same_tech" }] });

    // An invalid resolution refuses the apply even when no conflict is left; nothing is written.
    const refused = await apply({ type: "window.update", id: fri, window: weekly([team.a, team.b, team.c]) }, same.json.version, [{ reservationId: r.id, staffId: team.a }]);
    expect([refused.status, refused.json.error]).toEqual([409, "conflicts"]);
    expect(refused.json.details.impact.invalidResolutions).toHaveLength(1);
    expect(await windowStaff(fri)).toEqual([team.a, team.b]);
    expect(await scheduleVersion()).toBe(same.json.version);
  });

  it("validates the resolutions list (shape, one per reservation, at most 50)", async () => {
    const change = { type: "window.update", id: fri, window: weekly([team.c]) };
    const bad = [
      [{ reservationId: "r1", staffId: 0 }],
      [{ reservationId: "", staffId: team.c }],
      [{ reservationId: "r1", staffId: team.c }, { reservationId: "r1", staffId: team.d }],
      Array.from({ length: 51 }, (_, i) => ({ reservationId: `r${i}`, staffId: team.c })),
    ];
    for (const resolutions of bad) {
      expect((await preview(change, resolutions)).status).toBe(400);
      expect((await apply(change, 0, resolutions)).status).toBe(400);
    }
    expect((await preview(change, Array.from({ length: 50 }, (_, i) => ({ reservationId: `r${i}`, staffId: team.c })))).status).toBe(200);
  });

  it("a resolved reservation changed between the attempt's read and its commit rolls the whole apply back", async () => {
    const r = await confirmed(pat, team.a);
    const change: ScheduleChange = { type: "window.update", id: fri, window: weekly([team.c]) };
    const resolutions = [{ reservationId: r.id, staffId: team.c }];
    const { version } = await previewChange(env, change, resolutions);
    const w = withBatchHook(async () => {
      // Someone moves it to d (no schedule version bump: only the in-batch assertion can notice).
      const cur = await row(r.id);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM tech_blocks WHERE owner_id = ?").bind(r.id),
        env.DB.prepare("UPDATE reservations SET assigned_staff_id = ?, version = version + 1 WHERE id = ?").bind(team.d, r.id),
        env.DB.prepare("INSERT INTO tech_blocks(staff_id, block_start, owner_kind, owner_id) SELECT ?, value, 'reservation', ? FROM json_each(?)").bind(
          team.d, r.id, JSON.stringify(rangeBlocks(cur.occ_start, cur.occ_end)),
        ),
      ]);
    });
    await expect(applyChange(w.env, admin, change, version, resolutions)).rejects.toMatchObject({
      status: 409,
      code: "conflicts",
      details: { impact: expect.objectContaining({ invalidResolutions: [{ reservationId: r.id, staffId: team.c, reason: "changed" }] }) },
    });
    expect(w.calls.batches).toBe(1);
    expect(await windowStaff(fri)).toEqual([team.a, team.b]);
    const after = await row(r.id);
    expect([after.assigned_staff_id, after.version]).toEqual([team.d, 3]);
    expect(await blockStaff(r.id)).toEqual([team.d]);
    expect(await scheduleVersion()).toBe(version);
    expect(await count("SELECT COUNT(*) AS n FROM email_jobs WHERE template = 'reassigned'")).toBe(0);
    expect(await reassignAudits()).toEqual([]);
  });

  it("override.set: a date's replacement technician takes the appointment", async () => {
    const r = await confirmed(pat, team.a);
    const change = { type: "override.set", date: FRI, windows: [dated([team.c])], note: "Swap" };
    const plain = await preview(change);
    expect(plain.json.impact.conflicts).toEqual([expect.objectContaining({ id: r.id, alternatives: [{ id: team.c, name: "Cy Tech", displaces: [] }] })]);
    const staged = await preview(change, [{ reservationId: r.id, staffId: team.c }]);
    expect(staged.json.impact).toEqual({ moved: [], conflicts: [], warnings: [] });
    const res = await apply(change, staged.json.version, [{ reservationId: r.id, staffId: team.c }]);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(await env.DB.prepare("SELECT note FROM date_overrides WHERE date = ?").bind(FRI).first("note")).toBe("Swap");
    expect((await row(r.id)).assigned_staff_id).toBe(team.c);
    expect(await blockStaff(r.id)).toEqual([team.c]);
    expect(await reassignAudits()).toEqual([expect.objectContaining({ details: { from: team.a, to: team.c, via: "schedule" } })]);
  });

  it("a pending request's resolution moves its provisional technician (no version bump, no mail)", async () => {
    const s = await submit(sam, at(FRI, 10)); // provisional a
    expect((await row(s.id)).provisional_staff_id).toBe(team.a);
    const change = { type: "window.update", id: fri, window: weekly([team.b, team.c]) };
    const staged = await preview(change, [{ reservationId: s.id, staffId: team.c }]);
    expect(staged.json.impact).toEqual({ moved: [], conflicts: [], warnings: [] }); // pinned by the resolution: not "moved"
    const res = await apply(change, staged.json.version, [{ reservationId: s.id, staffId: team.c }]);
    expect(res.status).toBe(200);
    const after = await row(s.id);
    expect([after.status, after.provisional_staff_id, after.assigned_staff_id, after.version]).toEqual(["pending", team.c, null, 1]);
    expect(await blockStaff(s.id)).toEqual([team.c]);
    expect(await count("SELECT COUNT(*) AS n FROM email_jobs WHERE template = 'reassigned'")).toBe(0);
    expect(await reassignAudits()).toEqual([{ actor: String(team.admin), reservation_id: s.id, customer_id: sam.id, details: { from: team.a, to: team.c, via: "schedule" } }]);
  });

  it("a resolution may displace a pending request, which then is a conflict of its own", async () => {
    const r = await confirmed(pat, team.a);
    const s = await submit(sam, at(FRI, 10)); // provisional b
    const change = { type: "window.update", id: fri, window: weekly([team.b]) };
    const p = await preview(change, [{ reservationId: r.id, staffId: team.b }]);
    expect(p.json.impact.conflicts.map((c: any) => [c.id, c.reason])).toEqual([[s.id, "no_capacity"]]);
    expect(p.json.impact.invalidResolutions).toBeUndefined();
  });

  it("the team and settings routes forward resolutions too", async () => {
    const r = await confirmed(pat, team.a);
    const off = await api("POST", `/api/staff/team/${team.a}/preview`, { cookie: adminCookie, body: { active: false } });
    expect(off.json.impact.conflicts).toHaveLength(1);
    const staged = await api("POST", `/api/staff/team/${team.a}/preview`, { cookie: adminCookie, body: { active: false, resolutions: [{ reservationId: r.id, staffId: team.b }] } });
    expect(staged.json.impact).toEqual({ moved: [], conflicts: [], warnings: [] });
    const res = await api("POST", `/api/staff/team/${team.a}/apply`, {
      cookie: adminCookie,
      body: { active: false, version: staged.json.version, resolutions: [{ reservationId: r.id, staffId: team.b }] },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect((await row(r.id)).assigned_staff_id).toBe(team.b);
    // The apply route delivers the reassignment notices itself.
    expect(await count("SELECT COUNT(*) AS n FROM email_jobs WHERE template = 'reassigned' AND status = 'queued'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM email_jobs WHERE template = 'reassigned' AND status = 'sent'")).toBeGreaterThan(0);

    const settings = await api("POST", "/api/staff/settings/preview", { cookie: adminCookie, body: { patch: { durationMin: 45 }, resolutions: [{ reservationId: r.id, staffId: team.b }] } });
    expect(settings.json.impact.invalidResolutions).toEqual([{ reservationId: r.id, staffId: team.b, reason: "same_tech" }]);
    const bad = await api("POST", "/api/staff/settings/apply", { cookie: adminCookie, body: { patch: { durationMin: 45 }, version: 0, resolutions: [{ reservationId: r.id }] } });
    expect(bad.status).toBe(400);
  });
});
