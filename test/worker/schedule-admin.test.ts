import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../helpers";
import { loginCustomer, loginStaff, seedCustomer, seedTeam, seedWeekly, TZ, withBatchHook } from "../fixtures";
import { setNow } from "../../src/worker/lib/clock";
import { applyChange, previewChange } from "../../src/worker/scheduling/roster";
import { submitReservation } from "../../src/worker/reservations/submit";
import { rangeBlocks } from "../../src/domain/slots";
import { MIN, wallToUtc } from "../../src/domain/time";
import type { StaffPrincipal } from "../../src/worker/env";
import type { ScheduleChange, WindowInput } from "../../src/shared/types";

afterEach(() => setNow(null));

const THU = "2026-10-01";
const FRI = "2026-10-02";
const DAY = 24 * 60 * MIN;
const at = (date: string, h: number, m = 0) => wallToUtc(date, h * 60 + m, TZ);

let team: Awaited<ReturnType<typeof seedTeam>>;
let fri: number;
let pat: { id: number; cookie: string };
let sam: { id: number; cookie: string };
let adminCookie: string;
let techCookie: string;
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
  techCookie = await loginStaff("tech-a@example.test");
});

const weekly = (weekday: number, startMin: number, endMin: number, staffIds: number[]): WindowInput => ({ kind: "weekly", weekday, date: null, startMin, endMin, staffIds });
const dated = (date: string, startMin: number, endMin: number, staffIds: number[]): WindowInput => ({ kind: "date", weekday: null, date, startMin, endMin, staffIds });

const preview = (cookie: string, change: unknown) => api("POST", "/api/staff/schedule/preview", { cookie, body: { change } });
const apply = (cookie: string, change: unknown, version: number) => api("POST", "/api/staff/schedule/apply", { cookie, body: { change, version } });
/** Preview, then apply with the previewed version. */
const save = async (cookie: string, change: unknown) => {
  const p = await preview(cookie, change);
  expect(p.status, JSON.stringify(p.json)).toBe(200);
  return apply(cookie, change, p.json.version);
};

const submit = async (who: { id: number; cookie: string }, startAt: number) => {
  const res = await api("POST", "/api/customer/reservations", {
    cookie: who.cookie,
    body: { customerId: who.id, startAt, contactName: "Pat Example", phone: "+81 3-1234-5678", issue: "Printer is offline", idempotencyKey: crypto.randomUUID() },
  });
  expect(res.status).toBe(201);
  return res.json.reservation as { id: string; ref: string };
};
const approve = async (id: string, staffId: number) => {
  const res = await api("POST", `/api/staff/reservations/${id}/approve`, { cookie: adminCookie, body: { staffId, version: 1 } });
  expect(res.status).toBe(200);
};
const count = async (sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;
const row = (id: string) => env.DB.prepare("SELECT * FROM reservations WHERE id = ?").bind(id).first<any>();
const blocksOf = async (id: string) =>
  (await env.DB.prepare("SELECT staff_id, block_start FROM tech_blocks WHERE owner_id = ? ORDER BY block_start").bind(id).all<{ staff_id: number; block_start: number }>()).results;
const windowStaff = async (windowId: number) =>
  (await env.DB.prepare("SELECT staff_id FROM availability_window_staff WHERE window_id = ? ORDER BY staff_id").bind(windowId).all<{ staff_id: number }>()).results.map((r) => r.staff_id);
const audits = async () =>
  (await env.DB.prepare("SELECT actor_kind, actor, action, details FROM audit_log WHERE action LIKE 'schedule.%' ORDER BY id").all<any>()).results.map((a) => ({ ...a, details: JSON.parse(a.details) }));
const version = async () => (await env.DB.prepare("SELECT version FROM schedule_state").first<{ version: number }>())!.version;

describe("weekly windows", () => {
  it("creates, updates and deletes a window, each previewed, versioned and audited", async () => {
    const v0 = await version();
    const create = { type: "window.create", window: weekly(1, 540, 720, [team.a]) };
    const p = await preview(adminCookie, create);
    expect(p.status).toBe(200);
    expect(p.json).toEqual({ version: v0, impact: { moved: [], conflicts: [], warnings: [] } });
    expect(await count("SELECT COUNT(*) AS n FROM availability_windows")).toBe(1); // preview never writes

    const created = await apply(adminCookie, create, v0);
    expect(created.status).toBe(200);
    expect(created.json).toEqual({ version: v0 + 1, impact: { moved: [], conflicts: [], warnings: [] } });
    expect(await version()).toBe(v0 + 1);

    const list = await api("GET", "/api/staff/schedule/windows", { cookie: techCookie });
    expect(list.status).toBe(200);
    const mon = list.json.weekly.find((w: any) => w.weekday === 1);
    expect(mon).toEqual({ id: expect.any(Number), kind: "weekly", weekday: 1, date: null, startMin: 540, endMin: 720, staffIds: [team.a] });
    expect(list.json.weekly.find((w: any) => w.id === fri)).toMatchObject({ weekday: 5, startMin: 600, endMin: 660, staffIds: [team.a, team.b] });
    expect(list.json.overrides).toEqual([]);
    expect(list.json.staff).toContainEqual({ id: team.b, name: "Una Tech", bookable: true, active: true });

    const updated = await save(adminCookie, { type: "window.update", id: mon.id, window: weekly(2, 600, 720, [team.b, team.a]) });
    expect(updated.status).toBe(200);
    expect(await env.DB.prepare("SELECT kind, weekday, start_min, end_min FROM availability_windows WHERE id = ?").bind(mon.id).first()).toEqual({
      kind: "weekly", weekday: 2, start_min: 600, end_min: 720,
    });
    expect(await windowStaff(mon.id)).toEqual([team.a, team.b]);

    expect((await save(adminCookie, { type: "window.delete", id: mon.id })).status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM availability_windows WHERE id = ?", mon.id)).toBe(0);
    expect(await windowStaff(mon.id)).toEqual([]);
    expect(await version()).toBe(v0 + 3);

    expect(await audits()).toEqual([
      { actor_kind: "staff", actor: String(team.admin), action: "schedule.window.create", details: { window: { weekday: 1, startMin: 540, endMin: 720, staffIds: [team.a] }, moved: [] } },
      { actor_kind: "staff", actor: String(team.admin), action: "schedule.window.update", details: { id: mon.id, window: { weekday: 2, startMin: 600, endMin: 720, staffIds: [team.a, team.b] }, moved: [] } },
      { actor_kind: "staff", actor: String(team.admin), action: "schedule.window.delete", details: { id: mon.id, moved: [] } },
    ]);
  });

  it("rejects invalid windows with 400 and unknown windows with 404", async () => {
    await env.DB.prepare("UPDATE staff SET active = 0 WHERE id = ?").bind(team.d).run();
    const bad: Array<[string, unknown]> = [
      ["off the 5-minute grid", weekly(1, 541, 720, [team.a])],
      ["end before start", weekly(1, 720, 720, [team.a])],
      ["end past midnight", weekly(1, 600, 1445, [team.a])],
      ["weekday out of range", weekly(7, 600, 720, [team.a])],
      ["weekday and date", { ...weekly(1, 600, 720, [team.a]), date: FRI }],
      ["date window via window.create", dated(FRI, 600, 720, [team.a])],
      ["no staff", weekly(1, 600, 720, [])],
      ["duplicate staff", weekly(1, 600, 720, [team.a, team.a])],
    ];
    for (const [label, window] of bad) {
      for (const res of [await preview(adminCookie, { type: "window.create", window }), await apply(adminCookie, { type: "window.create", window }, 0)]) {
        expect([res.status, res.json.error], label).toEqual([400, "invalid"]);
      }
    }
    for (const staffIds of [[team.a, 9999], [team.d]]) {
      const res = await preview(adminCookie, { type: "window.create", window: weekly(1, 600, 720, staffIds) });
      expect([res.status, res.json.error, res.json.details]).toEqual([400, "invalid_staff", { staffIds: staffIds.filter((s) => s !== team.a) }]);
    }
    expect((await preview(adminCookie, { type: "window.update", id: 9999, window: weekly(1, 600, 720, [team.a]) })).status).toBe(404);
    expect((await preview(adminCookie, { type: "window.delete", id: 9999 })).status).toBe(404);
    expect((await preview(adminCookie, { type: "nope" })).status).toBe(400);
    expect(await count("SELECT COUNT(*) AS n FROM availability_windows")).toBe(1);
    expect(await audits()).toEqual([]);
  });
});

describe("conflicts", () => {
  it("removing a technician with a confirmed appointment: preview lists the conflict, apply is refused until it is reassigned", async () => {
    const r = await submit(pat, at(FRI, 10));
    await approve(r.id, team.a);
    const change = { type: "window.update", id: fri, window: weekly(5, 600, 660, [team.b]) };

    const p = await preview(adminCookie, change);
    expect(p.json.impact).toEqual({
      moved: [],
      conflicts: [
        {
          id: r.id, kind: "reservation", status: "confirmed", reservationId: r.id, ref: r.ref, startAt: at(FRI, 10),
          staffName: "Tim Tech", reason: "tech_removed", alternatives: [{ id: team.b, name: "Una Tech", displaces: [] }], customerName: "Pat Co",
        },
      ],
      warnings: [],
    });
    const refused = await apply(adminCookie, change, p.json.version);
    expect([refused.status, refused.json.error]).toEqual([409, "conflicts"]);
    expect(refused.json.details.impact).toEqual(p.json.impact);
    expect(await windowStaff(fri)).toEqual([team.a, team.b]);
    expect(await version()).toBe(p.json.version);

    // Resolved elsewhere (reassignment is a later endpoint): the appointment now sits with b.
    await env.DB.batch([
      env.DB.prepare("UPDATE reservations SET assigned_staff_id = ? WHERE id = ?").bind(team.b, r.id),
      env.DB.prepare("UPDATE tech_blocks SET staff_id = ? WHERE owner_id = ?").bind(team.b, r.id),
    ]);
    const again = await preview(adminCookie, change);
    expect(again.json.impact).toEqual({ moved: [], conflicts: [], warnings: [] });
    expect((await apply(adminCookie, change, again.json.version)).status).toBe(200);
    expect(await windowStaff(fri)).toEqual([team.b]);
  });

  it("names the pending requests an alternative would displace", async () => {
    const p1 = await submit(pat, at(FRI, 10));
    await approve(p1.id, team.a);
    const s1 = await submit(sam, at(FRI, 10));
    expect((await row(s1.id)).provisional_staff_id).toBe(team.b);
    const res = await preview(adminCookie, { type: "window.update", id: fri, window: weekly(5, 600, 660, [team.b]) });
    expect(res.json.impact.conflicts).toHaveLength(1);
    expect(res.json.impact.conflicts[0]).toMatchObject({ id: p1.id, alternatives: [{ id: team.b, name: "Una Tech", displaces: [{ id: s1.id, ref: s1.ref }] }] });
  });

  it("time off overlapping a confirmed appointment, even only its stored buffer, is a conflict", async () => {
    const r = await submit(pat, at(FRI, 10)); // occupies 10:00–10:40 (10-minute buffer after)
    await approve(r.id, team.a);
    const change = { type: "unavailability.create", staffId: team.a, startAt: at(FRI, 10, 35), endAt: at(FRI, 12), reason: "Dentist" };
    const p = await preview(adminCookie, change);
    expect(p.json.impact.conflicts).toEqual([
      expect.objectContaining({ id: r.id, status: "confirmed", reason: "tech_removed", staffName: "Tim Tech", alternatives: [{ id: team.b, name: "Una Tech", displaces: [] }] }),
    ]);
    const refused = await apply(adminCookie, change, p.json.version);
    expect([refused.status, refused.json.error]).toEqual([409, "conflicts"]);
    expect(await count("SELECT COUNT(*) AS n FROM staff_unavailability")).toBe(0);

    // Ending right at the stored range is fine.
    const ok = await save(adminCookie, { ...change, startAt: at(FRI, 10, 40) });
    expect([ok.status, ok.json.impact]).toEqual([200, { moved: [], conflicts: [], warnings: [] }]);
  });

  it("evaluates appointments weeks ahead, beyond the booking horizon", async () => {
    await env.DB.prepare("INSERT INTO settings(key, value) VALUES ('bookingHorizonDays', '90')").run();
    const r = await submit(pat, at("2026-12-04", 10));
    await approve(r.id, team.a);
    await env.DB.prepare("DELETE FROM settings WHERE key = 'bookingHorizonDays'").run(); // back to 30 days
    const res = await preview(adminCookie, { type: "window.update", id: fri, window: weekly(5, 600, 660, [team.b]) });
    expect(res.json.impact.conflicts.map((c: any) => [c.id, c.startAt, c.reason])).toEqual([[r.id, at("2026-12-04", 10), "tech_removed"]]);
  });

  it("ignores holds that have already ended", async () => {
    const r = await submit(pat, at(FRI, 10));
    await approve(r.id, team.a);
    setNow(at(FRI, 10, 40));
    const res = await preview(adminCookie, { type: "window.delete", id: fri });
    expect(res.json.impact).toEqual({ moved: [], conflicts: [], warnings: [] });
  });

  it("treats open proposal options as fixed holds", async () => {
    const r = await submit(pat, at(FRI, 10));
    await env.DB.batch([
      env.DB.prepare("INSERT INTO proposals(id, reservation_id, status, created_at, expires_at) VALUES ('p1', ?, 'open', 0, ?)").bind(r.id, at(FRI, 8)),
      env.DB.prepare("INSERT INTO proposal_options(id, proposal_id, start_at, end_at, occ_start, occ_end, staff_id) VALUES ('o1', 'p1', ?, ?, ?, ?, ?)").bind(
        at(FRI, 10, 30), at(FRI, 11), at(FRI, 10, 30), at(FRI, 11, 10), team.b,
      ),
    ]);
    const res = await preview(adminCookie, { type: "unavailability.create", staffId: team.b, startAt: at(FRI, 9), endAt: at(FRI, 18) });
    expect(res.json.impact.conflicts).toEqual([
      {
        id: "o1", kind: "option", status: "option", reservationId: r.id, ref: r.ref, startAt: at(FRI, 10, 30), staffName: "Una Tech",
        reason: "tech_removed", alternatives: [{ id: team.a, name: "Tim Tech", displaces: [{ id: r.id, ref: r.ref }] }], customerName: "Pat Co",
      },
    ]);
  });
});

describe("pre-existing conflicts", () => {
  it("are warnings: they never block an unrelated change, and disappear once fixed", async () => {
    const r = await submit(pat, at(FRI, 10));
    await approve(r.id, team.a);
    // Written outside the schedule API: a's leave now overlaps the confirmed appointment.
    await env.DB.prepare("INSERT INTO staff_unavailability(staff_id, start_at, end_at) VALUES (?, ?, ?)").bind(team.a, at(FRI, 10), at(FRI, 11)).run();
    const leave = (await env.DB.prepare("SELECT id FROM staff_unavailability").first<{ id: number }>())!.id;

    const change = { type: "window.create", window: weekly(1, 540, 720, [team.a]) };
    const p = await preview(adminCookie, change);
    expect(p.json.impact).toEqual({
      moved: [],
      conflicts: [],
      warnings: [
        {
          id: r.id, kind: "reservation", status: "confirmed", reservationId: r.id, ref: r.ref, startAt: at(FRI, 10),
          staffName: "Tim Tech", reason: "tech_removed", alternatives: [{ id: team.b, name: "Una Tech", displaces: [] }], customerName: "Pat Co",
        },
      ],
    });
    const res = await apply(adminCookie, change, p.json.version);
    expect([res.status, res.json.impact]).toEqual([200, p.json.impact]);

    const fixed = await preview(adminCookie, { type: "unavailability.delete", id: leave });
    expect(fixed.json.impact).toEqual({ moved: [], conflicts: [], warnings: [] });
  });

  it("keep their technician pinned: no pending is moved onto it, so that pending becomes a (new) conflict", async () => {
    const x = await submit(pat, at(FRI, 10, 30)); // a
    await approve(x.id, team.a); // occupies a 10:30–11:10
    const y = await submit(sam, at(FRI, 10)); // 10:00–10:40 overlaps x on a → b
    expect((await row(y.id)).provisional_staff_id).toBe(team.b);
    // Written outside the schedule API: the window now ends at 10:30, so x has lost its slot (still holding a's blocks).
    await env.DB.prepare("UPDATE availability_windows SET end_min = 630 WHERE id = ?").bind(fri).run();

    const change = { type: "unavailability.create", staffId: team.b, startAt: at(FRI, 9), endAt: at(FRI, 12) };
    const p = await preview(adminCookie, change);
    expect(p.json.impact.moved).toEqual([]); // not onto a, whose blocks x still owns
    expect(p.json.impact.conflicts.map((c: any) => [c.id, c.reason])).toEqual([[y.id, "no_capacity"]]);
    expect(p.json.impact.warnings.map((c: any) => [c.id, c.reason])).toEqual([[x.id, "slot_removed"]]);
    const res = await apply(adminCookie, change, p.json.version);
    expect([res.status, res.json.error]).toEqual([409, "conflicts"]);
    expect((await row(y.id)).provisional_staff_id).toBe(team.b);

    // A change that worsens nothing still applies, warning included.
    const ok = await save(adminCookie, { type: "window.create", window: weekly(1, 540, 720, [team.a]) });
    expect(ok.status).toBe(200);
    expect(ok.json.impact.warnings.map((c: any) => c.id)).toEqual([x.id]);
  });
});

describe("moved pending requests", () => {
  it("are re-blocked in the same batch as the change (B → A)", async () => {
    const p1 = await submit(pat, at(FRI, 10)); // a (first candidate)
    const s1 = await submit(sam, at(FRI, 10)); // b
    expect((await row(s1.id)).provisional_staff_id).toBe(team.b);
    await api("POST", `/api/staff/reservations/${p1.id}/decline`, { cookie: adminCookie, body: { reason: "Duplicate", version: 1 } });

    const change = { type: "unavailability.create", staffId: team.b, startAt: at(FRI, 9), endAt: at(FRI, 12) };
    const p = await preview(adminCookie, change);
    expect(p.json.impact).toEqual({ moved: [{ id: s1.id, ref: s1.ref, startAt: at(FRI, 10), from: "Una Tech", fromId: team.b, to: "Tim Tech", toId: team.a }], conflicts: [], warnings: [] });
    expect((await row(s1.id)).provisional_staff_id).toBe(team.b); // preview wrote nothing

    const res = await apply(adminCookie, change, p.json.version);
    expect(res.status).toBe(200);
    expect(res.json.impact).toEqual(p.json.impact);
    expect((await row(s1.id)).provisional_staff_id).toBe(team.a);
    const s1Row = await row(s1.id);
    expect(await blocksOf(s1.id)).toEqual(rangeBlocks(s1Row.occ_start, s1Row.occ_end).map((m) => ({ staff_id: team.a, block_start: m })));
    expect(await count("SELECT COUNT(*) AS n FROM staff_unavailability WHERE staff_id = ?", team.b)).toBe(1);
    const [a] = await audits();
    expect(a).toEqual({
      actor_kind: "staff", actor: String(team.admin), action: "schedule.unavailability.create",
      details: { staffId: team.b, startAt: at(FRI, 9), endAt: at(FRI, 12), moved: [{ id: s1.id, ref: s1.ref, from: team.b, to: team.a }] },
    });
  });

  it("a request that can no longer be placed is a conflict (no_capacity)", async () => {
    await submit(pat, at(FRI, 10));
    const s1 = await submit(sam, at(FRI, 10));
    const res = await preview(adminCookie, { type: "unavailability.create", staffId: team.b, startAt: at(FRI, 9), endAt: at(FRI, 12) });
    expect(res.json.impact.conflicts).toEqual([expect.objectContaining({ id: s1.id, status: "pending", reason: "no_capacity", staffName: "Una Tech", alternatives: [], customerName: "Sam Co" })]);
  });
});

describe("date overrides", () => {
  it("closing a date conflicts; replacing its windows moves requests; clearing restores the weekly pattern", async () => {
    const r = await submit(pat, at(FRI, 10)); // a
    const closed = await preview(adminCookie, { type: "override.set", date: FRI, windows: [] });
    expect(closed.json.impact.conflicts).toEqual([expect.objectContaining({ id: r.id, reason: "slot_removed", alternatives: [] })]);

    const set = await save(adminCookie, { type: "override.set", date: FRI, note: "Team offsite", windows: [dated(FRI, 600, 720, [team.b])] });
    expect(set.status).toBe(200);
    expect(set.json.impact.moved).toEqual([{ id: r.id, ref: r.ref, startAt: at(FRI, 10), from: "Tim Tech", fromId: team.a, to: "Una Tech", toId: team.b }]);
    expect((await row(r.id)).provisional_staff_id).toBe(team.b);
    expect(new Set((await blocksOf(r.id)).map((b) => b.staff_id))).toEqual(new Set([team.b]));

    const list = await api("GET", "/api/staff/schedule/windows", { cookie: techCookie });
    expect(list.json.overrides).toEqual([{ date: FRI, note: "Team offsite", windows: [{ id: expect.any(Number), ...dated(FRI, 600, 720, [team.b]) }] }]);
    expect(list.json.weekly.map((w: any) => w.id)).toEqual([fri]);

    // Replacing again swaps the windows (no duplicates), and the request stays where it is.
    const again = await save(adminCookie, { type: "override.set", date: FRI, windows: [dated(FRI, 540, 720, [team.a, team.b])] });
    expect(again.json.impact).toEqual({ moved: [], conflicts: [], warnings: [] });
    expect(await count("SELECT COUNT(*) AS n FROM availability_windows WHERE kind = 'date'")).toBe(1);
    expect(await env.DB.prepare("SELECT note FROM date_overrides WHERE date = ?").bind(FRI).first("note")).toBeNull();

    expect((await save(adminCookie, { type: "override.clear", date: FRI })).status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM availability_windows WHERE kind = 'date'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM availability_window_staff WHERE window_id NOT IN (SELECT id FROM availability_windows)")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM date_overrides")).toBe(0);
    expect((await preview(adminCookie, { type: "override.clear", date: FRI })).status).toBe(404);
    expect((await audits()).map((a) => a.action)).toEqual(["schedule.override.set", "schedule.override.set", "schedule.override.clear"]);
  });

  it("validates override windows", async () => {
    for (const change of [
      { type: "override.set", date: "2026-02-30", windows: [] },
      { type: "override.set", date: FRI, windows: [dated("2026-10-03", 600, 720, [team.a])] },
      { type: "override.set", date: FRI, windows: [weekly(5, 600, 720, [team.a])] },
      { type: "override.set", date: FRI, windows: [], note: "x".repeat(201) },
    ]) {
      expect((await preview(adminCookie, change)).status, JSON.stringify(change)).toBe(400);
    }
    const res = await preview(adminCookie, { type: "override.set", date: FRI, windows: [dated(FRI, 600, 720, [9999])] });
    expect([res.status, res.json.error]).toEqual([400, "invalid_staff"]);
  });
});

describe("unavailability", () => {
  it("validates span, order, reason and staff", async () => {
    const base = { type: "unavailability.create", staffId: team.a, startAt: at(FRI, 9), endAt: at(FRI, 12) };
    for (const change of [
      { ...base, endAt: base.startAt },
      { ...base, endAt: base.startAt + 367 * DAY },
      { ...base, reason: "x".repeat(201) },
    ]) {
      expect((await preview(adminCookie, change)).status).toBe(400);
    }
    expect((await preview(adminCookie, { ...base, endAt: base.startAt + 366 * DAY })).status).toBe(200);
    const unknown = await preview(adminCookie, { ...base, staffId: 9999 });
    expect([unknown.status, unknown.json.error]).toEqual([400, "invalid_staff"]);
    expect((await preview(adminCookie, { type: "unavailability.delete", id: 9999 })).status).toBe(404);
  });

  it("technicians manage only their own time off and cannot edit windows", async () => {
    const own = { type: "unavailability.create", staffId: team.a, startAt: at(FRI, 13), endAt: at(FRI, 15), reason: "Training" };
    const created = await save(techCookie, own);
    expect(created.status).toBe(200);
    const mine = await env.DB.prepare("SELECT id, staff_id, reason FROM staff_unavailability").first<any>();
    expect(mine).toMatchObject({ staff_id: team.a, reason: "Training" });
    expect((await audits())[0]).toMatchObject({ actor: String(team.a), action: "schedule.unavailability.create" });

    const v = await version();
    const forbidden: unknown[] = [
      { ...own, staffId: team.b },
      { type: "window.create", window: weekly(1, 600, 720, [team.a]) },
      { type: "window.update", id: fri, window: weekly(5, 600, 660, [team.a]) },
      { type: "window.delete", id: fri },
      { type: "override.set", date: FRI, windows: [] },
      { type: "override.clear", date: FRI },
    ];
    // b's time off, created by the admin.
    expect((await save(adminCookie, { ...own, staffId: team.b })).status).toBe(200);
    const theirs = (await env.DB.prepare("SELECT id FROM staff_unavailability WHERE staff_id = ?").bind(team.b).first<{ id: number }>())!.id;
    forbidden.push({ type: "unavailability.delete", id: theirs });
    for (const change of forbidden) {
      expect([(await preview(techCookie, change)).status, (await apply(techCookie, change, v + 1)).status], JSON.stringify(change)).toEqual([403, 403]);
    }

    const list = await api("GET", `/api/staff/schedule/unavailability?from=${at(FRI, 0)}&to=${at(FRI, 23)}`, { cookie: techCookie });
    expect(list.json.unavailability).toEqual([
      { id: mine.id, staffId: team.a, staffName: "Tim Tech", startAt: at(FRI, 13), endAt: at(FRI, 15), reason: "Training" },
      // Someone else's reason is theirs: another technician sees only the period.
      { id: theirs, staffId: team.b, staffName: "Una Tech", startAt: at(FRI, 13), endAt: at(FRI, 15), reason: null },
    ]);
    const asAdmin = await api("GET", `/api/staff/schedule/unavailability?from=${at(FRI, 0)}&to=${at(FRI, 23)}`, { cookie: adminCookie });
    expect(asAdmin.json.unavailability.map((u: any) => u.reason)).toEqual(["Training", "Training"]);
    const asB = await api("GET", `/api/staff/schedule/unavailability?from=${at(FRI, 0)}&to=${at(FRI, 23)}`, { cookie: await loginStaff("tech-b@example.test") });
    expect(asB.json.unavailability.map((u: any) => [u.staffId, u.reason])).toEqual([[team.a, null], [team.b, "Training"]]);
    const onlyB = await api("GET", `/api/staff/schedule/unavailability?staffId=${team.b}`, { cookie: techCookie });
    expect(onlyB.json.unavailability.map((u: any) => u.id)).toEqual([theirs]);
    const later = await api("GET", `/api/staff/schedule/unavailability?from=${at(FRI, 15)}`, { cookie: techCookie });
    expect(later.json.unavailability).toEqual([]);

    expect((await save(techCookie, { type: "unavailability.delete", id: mine.id })).status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM staff_unavailability")).toBe(1);
  });

  it("lists the next 90 days by default, at most 500 rows", async () => {
    const add = (startAt: number) =>
      env.DB.prepare("INSERT INTO staff_unavailability(staff_id, start_at, end_at) VALUES (?, ?, ?)").bind(team.a, startAt, startAt + 60 * MIN).run();
    await add(at(FRI, 9));
    await add(at(THU, 8) + 100 * DAY);
    const list = (q: string) => api("GET", `/api/staff/schedule/unavailability${q}`, { cookie: techCookie });
    expect((await list("")).json.unavailability.map((u: any) => u.startAt)).toEqual([at(FRI, 9)]);
    expect((await list(`?to=${at(THU, 8) + 101 * DAY}`)).json.unavailability).toHaveLength(2);
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 510)
       INSERT INTO staff_unavailability(staff_id, start_at, end_at) SELECT ?, ? + i * 60000, ? + i * 60000 + 30000 FROM n`,
    ).bind(team.b, at(FRI, 12), at(FRI, 12)).run();
    expect((await list("")).json.unavailability).toHaveLength(500);
  });

  it("anonymous callers and customers get 401", async () => {
    for (const cookie of [undefined, pat.cookie]) {
      expect((await api("GET", "/api/staff/schedule/windows", { cookie })).status).toBe(401);
      expect((await api("POST", "/api/staff/schedule/preview", { cookie, body: { change: { type: "window.delete", id: fri } } })).status).toBe(401);
    }
  });
});

describe("versioning and concurrency", () => {
  it("a stale version is refused with stale_preview and writes nothing", async () => {
    const change = { type: "window.create", window: weekly(1, 540, 720, [team.a]) };
    const p = await preview(adminCookie, change);
    await submit(pat, at(FRI, 10)); // any capacity write moves the version
    const res = await apply(adminCookie, change, p.json.version);
    expect([res.status, res.json.error]).toEqual([409, "stale_preview"]);
    expect(await count("SELECT COUNT(*) AS n FROM availability_windows")).toBe(1);
    expect(await audits()).toEqual([]);
  });

  it("a submit landing during an apply sends the apply back to preview", async () => {
    const change: ScheduleChange = { type: "unavailability.create", staffId: team.a, startAt: at(FRI, 9), endAt: at(FRI, 12) };
    const { version: v } = await previewChange(env, change);
    const w = withBatchHook(async () => {
      await submitReservation(env, "pat@example.test", {
        customerId: pat.id, startAt: at(FRI, 10), contactName: "Pat", phone: "000", issue: "x", idempotencyKey: "k1",
      });
    });
    await expect(applyChange(w.env, admin, change, v)).rejects.toMatchObject({ status: 409, code: "stale_preview" });
    expect(w.calls.batches).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM staff_unavailability")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM reservations")).toBe(1);
  });

  it("a moved request whose technician changed behind our back fails the in-batch assertion and is replanned", async () => {
    const p1 = await submit(pat, at(FRI, 10)); // a
    const s1 = await submit(sam, at(FRI, 10)); // b
    await api("POST", `/api/staff/reservations/${p1.id}/decline`, { cookie: adminCookie, body: { reason: "Duplicate", version: 1 } });
    const change: ScheduleChange = { type: "unavailability.create", staffId: team.b, startAt: at(FRI, 9), endAt: at(FRI, 12) };
    const { version: v, impact } = await previewChange(env, change);
    expect(impact.moved.map((m) => m.id)).toEqual([s1.id]);
    const w = withBatchHook(async () => {
      // s1 moves to a without a schedule version bump: only the moved-hold assertion can notice.
      await env.DB.batch([
        env.DB.prepare("DELETE FROM tech_blocks WHERE owner_id = ?").bind(s1.id),
        env.DB.prepare("UPDATE reservations SET provisional_staff_id = ? WHERE id = ?").bind(team.a, s1.id),
      ]);
      const r = await row(s1.id);
      for (const m of rangeBlocks(r.occ_start, r.occ_end)) {
        await env.DB.prepare("INSERT INTO tech_blocks(staff_id, block_start, owner_kind, owner_id) VALUES (?, ?, 'reservation', ?)").bind(team.a, m, s1.id).run();
      }
    });
    const res = await applyChange(w.env, admin, change, v);
    expect(w.calls.batches).toBe(2);
    expect(res.impact.moved).toEqual([]); // nothing left to move on the retry
    expect((await row(s1.id)).provisional_staff_id).toBe(team.a);
    expect(await blocksOf(s1.id)).toHaveLength(8);
    expect(await count("SELECT COUNT(*) AS n FROM staff_unavailability")).toBe(1);
  });

  it("rows deleted behind our back (no version bump) fail the in-batch existence asserts", async () => {
    await save(adminCookie, { type: "unavailability.create", staffId: team.a, startAt: at(FRI, 13), endAt: at(FRI, 15) });
    const leave = (await env.DB.prepare("SELECT id FROM staff_unavailability").first<{ id: number }>())!.id;
    const cases: Array<[ScheduleChange, string]> = [
      [{ type: "window.update", id: fri, window: weekly(5, 600, 720, [team.a]) }, `DELETE FROM availability_windows WHERE id = ${fri}`],
      [{ type: "unavailability.delete", id: leave }, `DELETE FROM staff_unavailability WHERE id = ${leave}`],
    ];
    await env.DB.prepare("DELETE FROM availability_window_staff WHERE window_id = ?").bind(fri).run();
    await env.DB.prepare("INSERT INTO availability_window_staff(window_id, staff_id) VALUES (?, ?)").bind(fri, team.a).run();
    for (const [change, sql] of cases) {
      const { version: v } = await previewChange(env, change);
      const w = withBatchHook(async () => {
        await env.DB.prepare(sql).run();
      });
      await expect(applyChange(w.env, admin, change, v)).rejects.toMatchObject({ status: 404 });
      expect(w.calls.batches).toBe(1);
    }
    expect(await audits()).toHaveLength(1); // only the setup
  });

  it("an apply landing during a submit makes the submit retry against the new schedule", async () => {
    const w = withBatchHook(async () => {
      const change: ScheduleChange = { type: "unavailability.create", staffId: team.a, startAt: at(FRI, 9), endAt: at(FRI, 12) };
      const { version: v } = await previewChange(env, change);
      await applyChange(env, admin, change, v);
    });
    const res = await submitReservation(w.env, "pat@example.test", {
      customerId: pat.id, startAt: at(FRI, 10), contactName: "Pat", phone: "000", issue: "x", idempotencyKey: "k1",
    });
    expect(w.calls.batches).toBe(2);
    expect((await row(res.id)).provisional_staff_id).toBe(team.b); // a went on leave first
    expect(new Set((await blocksOf(res.id)).map((b) => b.staff_id))).toEqual(new Set([team.b]));
  });
});

describe("change types outside this API", () => {
  it("staff.update and holiday.bulk are not accepted by the schedule routes (400), for technicians and admins", async () => {
    for (const cookie of [techCookie, adminCookie]) {
      for (const change of [{ type: "staff.update", id: team.a, active: false }, { type: "holiday.bulk", set: [{ date: FRI, name: "Day off" }] }]) {
        expect([(await preview(cookie, change)).status, (await apply(cookie, change, 0)).status], JSON.stringify(change)).toEqual([400, 400]);
      }
    }
    expect(await count("SELECT COUNT(*) AS n FROM holidays")).toBe(0);
  });

  it("resolveChange re-checks window rules for direct callers", async () => {
    const bad: ScheduleChange[] = [
      { type: "override.set", date: FRI, windows: [dated("2026-10-03", 600, 720, [team.a])] },
      { type: "override.set", date: FRI, windows: [weekly(5, 600, 720, [team.a])] },
      { type: "override.set", date: FRI, windows: [dated(FRI, 600, 720, [team.a, team.a])] },
      { type: "window.create", window: weekly(1, 600, 720, [team.b, team.b]) },
      { type: "window.create", window: dated(FRI, 600, 720, [team.a]) },
      { type: "window.update", id: fri, window: weekly(5, 601, 720, [team.a]) },
    ];
    for (const change of bad) {
      await expect(previewChange(env, change), JSON.stringify(change)).rejects.toMatchObject({ status: 400, code: "invalid" });
    }
  });
});

describe("other change types through the same bridge", () => {
  it("holiday.set closes the weekly pattern; holiday.delete reopens it", async () => {
    const r = await submit(pat, at(FRI, 10));
    const set: ScheduleChange = { type: "holiday.set", date: FRI, name: "Foundation Day" };
    const p = await previewChange(env, set);
    expect(p.impact.conflicts).toEqual([expect.objectContaining({ id: r.id, reason: "slot_removed" })]);
    await expect(applyChange(env, admin, set, p.version)).rejects.toMatchObject({ status: 409, code: "conflicts" });

    await env.DB.prepare("UPDATE reservations SET status = 'declined' WHERE id = ?").bind(r.id).run();
    await env.DB.prepare("DELETE FROM tech_blocks").run();
    const ok = await applyChange(env, admin, set, (await previewChange(env, set)).version);
    expect(ok.impact).toEqual({ moved: [], conflicts: [], warnings: [] });
    expect(await env.DB.prepare("SELECT name FROM holidays WHERE date = ?").bind(FRI).first("name")).toBe("Foundation Day");
    const del: ScheduleChange = { type: "holiday.delete", date: FRI };
    await applyChange(env, admin, del, (await previewChange(env, del)).version);
    expect(await count("SELECT COUNT(*) AS n FROM holidays")).toBe(0);
    await expect(previewChange(env, del)).rejects.toMatchObject({ status: 404 });
    expect((await audits()).map((a) => a.action)).toEqual(["schedule.holiday.set", "schedule.holiday.delete"]);
  });

  it("staff.update: an unbookable technician loses their appointments (conflict), pendings move", async () => {
    const r = await submit(pat, at(FRI, 10)); // a
    const s1 = await submit(sam, at(FRI, 10)); // b
    await approve(r.id, team.a);
    const off: ScheduleChange = { type: "staff.update", id: team.b, bookable: false };
    expect((await previewChange(env, off)).impact.conflicts).toEqual([expect.objectContaining({ id: s1.id, status: "pending", reason: "no_capacity" })]);

    const offA: ScheduleChange = { type: "staff.update", id: team.a, active: false };
    expect((await previewChange(env, offA)).impact.conflicts).toEqual([
      expect.objectContaining({ id: r.id, reason: "tech_removed", alternatives: [{ id: team.b, name: "Una Tech", displaces: [{ id: s1.id, ref: s1.ref }] }] }),
    ]);

    await env.DB.prepare("UPDATE reservations SET status = 'declined' WHERE id = ?").bind(r.id).run();
    await env.DB.prepare("DELETE FROM tech_blocks WHERE owner_id = ?").bind(r.id).run();
    const offB: ScheduleChange = { type: "staff.update", id: team.b, bookable: false };
    const res = await applyChange(env, admin, offB, (await previewChange(env, offB)).version);
    expect(res.impact.moved).toEqual([{ id: s1.id, ref: s1.ref, startAt: at(FRI, 10), from: "Una Tech", fromId: team.b, to: "Tim Tech", toId: team.a }]);
    expect(await env.DB.prepare("SELECT active, bookable FROM staff WHERE id = ?").bind(team.b).first()).toEqual({ active: 1, bookable: 0 });
    expect((await row(s1.id)).provisional_staff_id).toBe(team.a);
    await expect(previewChange(env, { type: "staff.update", id: 9999, active: false })).rejects.toMatchObject({ status: 404 });
  });

  it("settings.update changes slot generation for new requests only: existing holds keep their place", async () => {
    const r = await submit(pat, at(FRI, 10));
    await approve(r.id, team.a);
    const change: ScheduleChange = { type: "settings.update", patch: { durationMin: 60, bufferAfterMin: 30 } };
    const p = await previewChange(env, change);
    expect(p.impact).toEqual({ moved: [], conflicts: [], warnings: [] });
    const res = await applyChange(env, admin, change, p.version);
    expect(res.version).toBe(p.version + 1);
    expect(await env.DB.prepare("SELECT value FROM settings WHERE key = 'durationMin'").first("value")).toBe("60");
    expect(await env.DB.prepare("SELECT value FROM settings WHERE key = 'bufferAfterMin'").first("value")).toBe("30");
    expect(await blocksOf(r.id)).toHaveLength(8);
    expect((await audits()).at(-1)).toMatchObject({ action: "schedule.settings.update", details: { patch: { durationMin: 60, bufferAfterMin: 30 }, moved: [] } });
  });
});
