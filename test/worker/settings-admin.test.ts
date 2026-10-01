import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../helpers";
import { loginCustomer, loginStaff, seedCustomer, seedTeam, seedWeekly, TZ, withBatchHook } from "../fixtures";
import { setNow } from "../../src/worker/lib/clock";
import { getSettings } from "../../src/worker/repos/settings";
import { applyChange, previewChange } from "../../src/worker/scheduling/roster";
import { DEFAULT_SETTINGS } from "../../src/domain/settings";
import { MIN, wallToUtc } from "../../src/domain/time";
import type { StaffPrincipal } from "../../src/worker/env";

afterEach(() => {
  vi.restoreAllMocks();
  setNow(null);
});

const THU = "2026-10-01";
const FRI = "2026-10-02";
const at = (date: string, h: number, m = 0) => wallToUtc(date, h * 60 + m, TZ);

let team: Awaited<ReturnType<typeof seedTeam>>;
let adminCookie: string;
let techCookie: string;
let customerId: number;
let customerCookie: string;
let admin: StaffPrincipal;

beforeEach(async () => {
  setNow(at(THU, 8));
  team = await seedTeam();
  admin = { id: team.admin, email: "admin@example.test", name: "Test Person", role: "admin" };
  await seedWeekly(5, 600, 660, [team.a, team.b]);
  customerId = await seedCustomer({ email: "pat@example.test", name: "Pat Co" });
  customerCookie = await loginCustomer("pat@example.test");
  adminCookie = await loginStaff("admin@example.test");
  techCookie = await loginStaff("tech-a@example.test");
});

const count = async (sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;
const version = async () => (await env.DB.prepare("SELECT version FROM schedule_state").first<{ version: number }>())!.version;
const storedKeys = async () => (await env.DB.prepare("SELECT key FROM settings ORDER BY key").all<{ key: string }>()).results.map((r) => r.key);
const audits = async (like: string) =>
  (await env.DB.prepare("SELECT actor_kind, actor, action, details FROM audit_log WHERE action LIKE ? ORDER BY id").bind(like).all<any>()).results.map((a) => ({ ...a, details: JSON.parse(a.details) }));

const previewSettings = (cookie: string, patch: unknown) => api("POST", "/api/staff/settings/preview", { cookie, body: { patch } });
const applySettings = (cookie: string, patch: unknown, version: number) => api("POST", "/api/staff/settings/apply", { cookie, body: { patch, version } });
const saveSettings = async (patch: unknown, cookie = adminCookie) => {
  const p = await previewSettings(cookie, patch);
  expect(p.status, JSON.stringify(p.json)).toBe(200);
  return applySettings(cookie, patch, p.json.version);
};

const sched = (cookie: string, kind: "preview" | "apply", change: unknown, version = 0) =>
  api("POST", `/api/staff/schedule/${kind}`, { cookie, body: kind === "preview" ? { change } : { change, version } });
const saveSchedule = async (change: unknown) => {
  const p = await sched(adminCookie, "preview", change);
  expect(p.status, JSON.stringify(p.json)).toBe(200);
  return sched(adminCookie, "apply", change, p.json.version);
};

const submit = async (startAt: number) => {
  const res = await api("POST", "/api/customer/reservations", {
    cookie: customerCookie,
    body: { customerId, startAt, contactName: "Pat Example", phone: "+81 3-1234-5678", issue: "Printer is offline", idempotencyKey: crypto.randomUUID() },
  });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json.reservation as { id: string; ref: string };
};
const approve = async (id: string, staffId: number) => {
  const res = await api("POST", `/api/staff/reservations/${id}/approve`, { cookie: adminCookie, body: { staffId, version: 1 } });
  expect(res.status).toBe(200);
};
const row = (id: string) => env.DB.prepare("SELECT * FROM reservations WHERE id = ?").bind(id).first<any>();

describe("GET /api/staff/settings", () => {
  it("returns the effective settings and the time zone to any staff member", async () => {
    for (const cookie of [techCookie, adminCookie]) {
      const res = await api("GET", "/api/staff/settings", { cookie });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ settings: { ...DEFAULT_SETTINGS, orgName: env.ORG_NAME || DEFAULT_SETTINGS.orgName }, timezone: TZ });
    }
  });

  it("answers 401 without a staff session, including with only a customer cookie", async () => {
    expect((await api("GET", "/api/staff/settings")).status).toBe(401);
    expect((await api("GET", "/api/staff/settings", { cookie: customerCookie })).status).toBe(401);
  });
});

describe("validation", () => {
  const bad: Array<[string, unknown]> = [
    ["orgName", ""],
    ["orgName", "   "],
    ["orgName", "x".repeat(101)],
    ["supportPhone", "call me"],
    ["supportPhone", "1".repeat(41)],
    ["remoteToolName", ""],
    ["remoteToolName", "x".repeat(61)],
    ["customerInstructions", "x".repeat(501)],
    ["durationMin", 0],
    ["durationMin", 32],
    ["durationMin", 485],
    ["durationMin", "30"],
    ["bufferBeforeMin", -5],
    ["bufferBeforeMin", 7],
    ["bufferAfterMin", 125],
    ["slotStepMin", 0],
    ["slotStepMin", 3],
    ["minNoticeBh", 73],
    ["minNoticeBh", 1.5],
    ["bookingHorizonDays", 0],
    ["bookingHorizonDays", 181],
    ["cancelCutoffMin", 2881],
    ["maxActivePerAccount", 0],
    ["maxActivePerAccount", 11],
    ["businessHours", []],
    ["businessHours", [null, null, null, null, null, null]],
    ["businessHours", [null, { start: 600, end: 600 }, null, null, null, null, null]],
    ["businessHours", [null, { start: 601, end: 700 }, null, null, null, null, null]],
    ["businessHours", [null, { start: 600, end: 1445 }, null, null, null, null, null]],
    ["businessHours", [null, { start: -5, end: 600 }, null, null, null, null, null]],
    ["customerReminderOffsetsMin", [1, 60]],
    ["customerReminderOffsetsMin", [60, 120, 180, 240]],
    ["customerReminderOffsetsMin", [10081]],
    ["notifyCustomerOnReassign", "yes"],
    ["bookingEnabled", 1],
  ];
  it.each(bad)("rejects invalid %s (case %#) with 400 naming the field, on preview and apply", async (key, value) => {
    for (const res of [await previewSettings(adminCookie, { [key]: value }), await applySettings(adminCookie, { [key]: value }, 0)]) {
      expect(res.status, JSON.stringify(res.json)).toBe(400);
      expect(res.json.error).toBe("invalid");
      expect(res.json.details.some((i: any) => i.path[0] === "patch" && i.path[1] === key), JSON.stringify(res.json.details)).toBe(true);
    }
    expect(await count("SELECT COUNT(*) AS n FROM settings")).toBe(0);
  });

  it("points at the weekday of a bad business-hours entry", async () => {
    const res = await previewSettings(adminCookie, { businessHours: [null, null, { start: 700, end: 600 }, null, null, null, null] });
    expect(res.json.details).toEqual([expect.objectContaining({ path: ["patch", "businessHours", 2, "end"] })]);
  });

  it("rejects unknown keys, an empty patch and a missing patch", async () => {
    for (const patch of [{ nope: 1 }, { orgName: "Ok", nope: 1 }, {}, undefined, null, []]) {
      expect((await previewSettings(adminCookie, patch)).status, JSON.stringify(patch)).toBe(400);
    }
    expect((await api("POST", "/api/staff/settings/apply", { cookie: adminCookie, body: { patch: { orgName: "Ok" } } })).status).toBe(400); // no version
  });

  it("checks the approval ordering on the merged settings, across fields and against what is stored", async () => {
    // Defaults 2 <= 4 <= 8.
    let res = await previewSettings(adminCookie, { approvalReminderBh: 5 });
    expect([res.status, res.json.details.map((i: any) => i.path.join("."))]).toEqual([400, ["patch.approvalReminderBh"]]);
    res = await previewSettings(adminCookie, { approvalExpiryBh: 3 });
    expect([res.status, res.json.details.map((i: any) => i.path.join("."))]).toEqual([400, ["patch.approvalEscalationBh"]]);
    res = await previewSettings(adminCookie, { approvalReminderBh: 6, approvalEscalationBh: 6, approvalExpiryBh: 6 });
    expect(res.status).toBe(200);
    res = await previewSettings(adminCookie, { approvalReminderBh: 6, approvalEscalationBh: 5 });
    expect(res.status).toBe(400);

    // A stored ordering that is already inconsistent does not block unrelated edits.
    await env.DB.prepare("INSERT INTO settings(key, value) VALUES ('approvalReminderBh', '20')").run();
    expect((await previewSettings(adminCookie, { orgName: "Unrelated Change" })).status).toBe(200);
    expect((await previewSettings(adminCookie, { supportPhone: "+81 3 1234 5678" })).status).toBe(200);
    expect((await previewSettings(adminCookie, { approvalExpiryBh: 30 })).status).toBe(400); // escalation (4) < reminder (20)
  });

  it("accepts the boundaries", async () => {
    const patch = {
      orgName: "x".repeat(100),
      supportPhone: "+81 (3) 1234-5678.",
      remoteToolName: "x".repeat(60),
      customerInstructions: "x".repeat(500),
      durationMin: 480,
      bufferBeforeMin: 120,
      bufferAfterMin: 0,
      slotStepMin: 5,
      minNoticeBh: 72,
      bookingHorizonDays: 180,
      cancelCutoffMin: 2880,
      maxActivePerAccount: 10,
      businessHours: [{ start: 0, end: 1440 }, null, null, null, null, null, { start: 5, end: 10 }],
      customerReminderOffsetsMin: [5, 10080, 60],
    };
    const res = await saveSettings(patch);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(await getSettings(env.DB, env)).toMatchObject(patch);
    expect((await saveSettings({ customerReminderOffsetsMin: [] })).status).toBe(200);
  });

  it("trims names and keeps the trimmed value", async () => {
    expect((await saveSettings({ orgName: "  Example Desk  ", remoteToolName: " AnyDesk " })).status).toBe(200);
    expect(await getSettings(env.DB, env)).toMatchObject({ orgName: "Example Desk", remoteToolName: "AnyDesk" });
  });
});

describe("preview and apply", () => {
  it("previews without writing, then applies only the keys in the patch, bumps the version and audits", async () => {
    const v0 = await version();
    const patch = { orgName: "Example Desk", supportPhone: "+81 3 1234 5678" };
    const p = await previewSettings(adminCookie, patch);
    expect(p.json).toEqual({ version: v0, impact: { moved: [], conflicts: [], warnings: [] } });
    expect(await storedKeys()).toEqual([]);
    expect(await version()).toBe(v0);

    const res = await applySettings(adminCookie, patch, v0);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ version: v0 + 1, impact: { moved: [], conflicts: [], warnings: [] } });
    expect(await storedKeys()).toEqual(["orgName", "supportPhone"]);
    expect(await getSettings(env.DB, env)).toMatchObject({ orgName: "Example Desk", supportPhone: "+81 3 1234 5678", durationMin: 30 });
    expect((await api("GET", "/api/staff/settings", { cookie: techCookie })).json.settings.orgName).toBe("Example Desk");

    expect(await audits("schedule.settings.%")).toEqual([
      { actor_kind: "staff", actor: String(team.admin), action: "schedule.settings.update", details: { patch, moved: [] } },
    ]);

    // A later patch leaves earlier keys alone.
    await saveSettings({ remoteToolName: "AnyDesk" });
    expect(await storedKeys()).toEqual(["orgName", "remoteToolName", "supportPhone"]);
  });

  it("refuses a stale version with 409 and writes nothing", async () => {
    const v0 = await version();
    const res = await applySettings(adminCookie, { orgName: "Stale Desk" }, v0 + 1);
    expect([res.status, res.json.error]).toEqual([409, "stale_preview"]);
    const p = await previewSettings(adminCookie, { orgName: "Fresh Desk" });
    await saveSettings({ supportPhone: "123" });
    const late = await applySettings(adminCookie, { orgName: "Fresh Desk" }, p.json.version);
    expect([late.status, late.json.error]).toEqual([409, "stale_preview"]);
    expect(await storedKeys()).toEqual(["supportPhone"]);
  });

  it("applies a capacity change that conflicts with nothing; existing appointments keep their stored ranges", async () => {
    const r = await submit(at(FRI, 10)); // occupies 10:00-10:40 (30 min + 10 min buffer after)
    await approve(r.id, team.a);
    const before = await row(r.id);
    expect([before.occ_start, before.occ_end]).toEqual([at(FRI, 10), at(FRI, 10) + 40 * MIN]);

    const patch = { durationMin: 60, bufferBeforeMin: 15, bufferAfterMin: 20, slotStepMin: 15 };
    const p = await previewSettings(adminCookie, patch);
    expect(p.json.impact).toEqual({ moved: [], conflicts: [], warnings: [] });
    const res = await applySettings(adminCookie, patch, p.json.version);
    expect(res.status, JSON.stringify(res.json)).toBe(200);

    const after = await row(r.id);
    expect([after.start_at, after.end_at, after.occ_start, after.occ_end, after.status, after.assigned_staff_id]).toEqual([
      before.start_at, before.end_at, before.occ_start, before.occ_end, "confirmed", team.a,
    ]);
    expect(await getSettings(env.DB, env)).toMatchObject(patch);
    // New requests use the new duration (60 min) and step (15): 10:00 fits, 10:15 does not (window ends 11:00).
    const av = await api("GET", `/api/customer/availability?from=${FRI}&to=${FRI}`, { cookie: customerCookie });
    expect(av.json.days.find((d: any) => d.date === FRI).slots.map((s: any) => [s.startAt, s.endAt])).toEqual([[at(FRI, 10), at(FRI, 11)]]);
  });

  it("changes business hours and notice settings", async () => {
    const businessHours = [null, null, null, null, null, { start: 600, end: 720 }, null];
    expect((await saveSettings({ businessHours, minNoticeBh: 0, bookingHorizonDays: 60, maxActivePerAccount: 3 })).status).toBe(200);
    expect(await getSettings(env.DB, env)).toMatchObject({ businessHours, minNoticeBh: 0, bookingHorizonDays: 60, maxActivePerAccount: 3 });
  });

  it("lets an admin switch bookingEnabled like any other setting, next to the dedicated switch", async () => {
    expect((await saveSettings({ bookingEnabled: false })).status).toBe(200);
    expect((await getSettings(env.DB, env)).bookingEnabled).toBe(false);
    expect((await api("GET", `/api/customer/availability?from=${FRI}&to=${FRI}`, { cookie: customerCookie })).status).toBe(409);

    const on = await api("POST", "/api/staff/settings/booking", { cookie: adminCookie, body: { enabled: true } });
    expect([on.status, on.json]).toEqual([200, { bookingEnabled: true }]);
    expect((await getSettings(env.DB, env)).bookingEnabled).toBe(true);
    expect((await api("GET", "/api/staff/settings", { cookie: techCookie })).json.settings.bookingEnabled).toBe(true);
    expect((await saveSettings({ bookingEnabled: false, orgName: "Both Fields" })).status).toBe(200);
    expect(await getSettings(env.DB, env)).toMatchObject({ bookingEnabled: false, orgName: "Both Fields" });
    expect((await audits("settings.booking")).length).toBe(1); // the dedicated switch keeps its own audit action
  });

  it("serializes with a concurrent capacity change: the loser retries or is refused as stale", async () => {
    const patch = { durationMin: 45 };
    const p = await previewChange(env, { type: "settings.update", patch });
    const w = withBatchHook(async () => {
      await env.DB.prepare("UPDATE schedule_state SET version = version + 1").run();
    });
    await expect(applyChange(w.env, admin, { type: "settings.update", patch }, p.version)).rejects.toMatchObject({ status: 409, code: "stale_preview" });
    expect(await storedKeys()).toEqual([]);
  });
});

describe("permissions", () => {
  it("technicians get 403 on preview and apply and nothing changes; anonymous and customers get 401", async () => {
    const v0 = await version();
    expect((await previewSettings(techCookie, { orgName: "Nope" })).status).toBe(403);
    expect((await applySettings(techCookie, { orgName: "Nope" }, v0)).status).toBe(403);
    expect((await previewSettings("", { orgName: "Nope" })).status).toBe(401);
    expect((await applySettings(customerCookie, { orgName: "Nope" }, v0)).status).toBe(401);
    expect(await storedKeys()).toEqual([]);
    expect(await version()).toBe(v0);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'schedule.%'")).toBe(0);
  });

  it("requires the Origin and X-Requested-With headers on writes", async () => {
    const res = await api("POST", "/api/staff/settings/apply", { cookie: adminCookie, xrw: false, body: { patch: { orgName: "Nope" }, version: 0 } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await storedKeys()).toEqual([]);
  });
});

describe("getSettings validates stored values per key", () => {
  it("falls back to the default for each invalid or unparseable row and warns with the key, never the value", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows: Array<[string, string]> = [
      ["durationMin", "37"], // off the grid
      ["bufferAfterMin", '"secret-text"'],
      ["slotStepMin", "not json"],
      ["businessHours", "[1,2,3]"],
      ["supportPhone", '"call me maybe"'],
      ["orgName", '""'],
      ["customerReminderOffsetsMin", "[1,2,3,4]"],
      ["bookingEnabled", '"false"'],
      ["notifyCustomerOnReassign", "1"],
      ["minNoticeBh", "-4"],
      ["unknownKey", "5"],
    ];
    for (const [key, value] of rows) await env.DB.prepare("INSERT INTO settings(key, value) VALUES (?, ?)").bind(key, value).run();
    await env.DB.prepare("INSERT INTO settings(key, value) VALUES ('remoteToolName', '\"AnyDesk\"')").run(); // valid rows still apply
    await env.DB.prepare("INSERT INTO settings(key, value) VALUES ('bookingHorizonDays', '90')").run();

    const s = await getSettings(env.DB, env);
    expect(s).toEqual({ ...DEFAULT_SETTINGS, orgName: env.ORG_NAME || DEFAULT_SETTINGS.orgName, remoteToolName: "AnyDesk", bookingHorizonDays: 90 });

    const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    for (const [key] of rows.filter(([k]) => k !== "unknownKey")) expect(logged).toContain(`"${key}"`);
    for (const secret of ["secret-text", "call me maybe", "not json", "[1,2,3]"]) expect(logged).not.toContain(secret);
  });
});

describe("holidays", () => {
  const holiday = (cookie: string, kind: "preview" | "apply", change: unknown, version = 0) => sched(cookie, kind, change, version);

  it("lists a calendar year's holidays by date for any staff member", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO holidays(date, name) VALUES ('2026-12-23', 'Emperor''s Birthday'), ('2026-01-01', 'New Year'), ('2027-01-01', 'Next Year'), ('2025-12-31', 'Last Year'), ('2026-05-03', 'Constitution Day')"),
    ]);
    for (const cookie of [techCookie, adminCookie]) {
      const res = await api("GET", "/api/staff/holidays?year=2026", { cookie });
      expect(res.status).toBe(200);
      expect(res.json).toEqual([
        { date: "2026-01-01", name: "New Year" },
        { date: "2026-05-03", name: "Constitution Day" },
        { date: "2026-12-23", name: "Emperor's Birthday" },
      ]);
    }
    expect((await api("GET", "/api/staff/holidays", { cookie: techCookie })).json).toHaveLength(3); // current year (2026) by default
    expect((await api("GET", "/api/staff/holidays?year=1999", { cookie: techCookie })).json).toEqual([]);
    for (const year of ["abc", "20", "2026.5", "99999"]) expect((await api("GET", `/api/staff/holidays?year=${year}`, { cookie: techCookie })).status, year).toBe(400);
    expect((await api("GET", "/api/staff/holidays?year=2026")).status).toBe(401);
    expect((await api("GET", "/api/staff/holidays?year=2026", { cookie: customerCookie })).status).toBe(401);
  });

  it("sets and deletes a holiday through the generic preview/apply endpoints, versioned and audited", async () => {
    const v0 = await version();
    const set = { type: "holiday.set", date: FRI, name: "  Foundation Day " };
    const p = await holiday(adminCookie, "preview", set);
    expect(p.json).toEqual({ version: v0, impact: { moved: [], conflicts: [], warnings: [] } });
    expect(await count("SELECT COUNT(*) AS n FROM holidays")).toBe(0);
    expect((await holiday(adminCookie, "apply", set, v0)).status).toBe(200);
    expect((await api("GET", "/api/staff/holidays?year=2026", { cookie: techCookie })).json).toEqual([{ date: FRI, name: "Foundation Day" }]);
    expect(await version()).toBe(v0 + 1);

    // Renaming is a set on the same date.
    expect((await saveSchedule({ type: "holiday.set", date: FRI, name: "Renamed" })).status).toBe(200);
    expect(await env.DB.prepare("SELECT name FROM holidays").first("name")).toBe("Renamed");

    expect((await saveSchedule({ type: "holiday.delete", date: FRI })).status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM holidays")).toBe(0);
    expect((await holiday(adminCookie, "preview", { type: "holiday.delete", date: FRI })).status).toBe(404);
    expect((await audits("schedule.holiday.%")).map((a) => [a.action, a.details])).toEqual([
      ["schedule.holiday.set", { date: FRI, name: "Foundation Day", moved: [] }],
      ["schedule.holiday.set", { date: FRI, name: "Renamed", moved: [] }],
      ["schedule.holiday.delete", { date: FRI, moved: [] }],
    ]);
  });

  it("validates holiday changes", async () => {
    for (const change of [
      { type: "holiday.set", date: "2026-02-30", name: "Nope" },
      { type: "holiday.set", date: "2026-2-3", name: "Nope" },
      { type: "holiday.set", date: FRI, name: "" },
      { type: "holiday.set", date: FRI, name: "   " },
      { type: "holiday.set", date: FRI, name: "x".repeat(101) },
      { type: "holiday.set", date: FRI },
      { type: "holiday.delete", date: "nope" },
    ]) {
      expect([(await holiday(adminCookie, "preview", change)).status, (await holiday(adminCookie, "apply", change)).status], JSON.stringify(change)).toEqual([400, 400]);
    }
    expect(await count("SELECT COUNT(*) AS n FROM holidays")).toBe(0);
  });

  it("is admin only: technicians get 403 on both endpoints", async () => {
    for (const change of [{ type: "holiday.set", date: FRI, name: "Nope" }, { type: "holiday.delete", date: FRI }]) {
      expect([(await holiday(techCookie, "preview", change)).status, (await holiday(techCookie, "apply", change)).status]).toEqual([403, 403]);
    }
    expect(await count("SELECT COUNT(*) AS n FROM holidays")).toBe(0);
  });

  it("a holiday on a date with a confirmed appointment is a conflict and is not saved", async () => {
    const r = await submit(at(FRI, 10));
    await approve(r.id, team.a);
    const change = { type: "holiday.set", date: FRI, name: "Foundation Day" };
    const p = await holiday(adminCookie, "preview", change);
    expect(p.json.impact.conflicts).toEqual([expect.objectContaining({ id: r.id, status: "confirmed", reason: "slot_removed", startAt: at(FRI, 10), customerName: "Pat Co" })]);
    const refused = await holiday(adminCookie, "apply", change, p.json.version);
    expect([refused.status, refused.json.error]).toEqual([409, "conflicts"]);
    expect(refused.json.details.impact).toEqual(p.json.impact);
    expect(await count("SELECT COUNT(*) AS n FROM holidays")).toBe(0);
    expect((await row(r.id)).status).toBe("confirmed");
  });

  it("a date override wins over a holiday: the appointment stays and customers can still book that day", async () => {
    const r = await submit(at(FRI, 10));
    await approve(r.id, team.a);
    // Open FRI explicitly (same hours), then declare it a holiday.
    expect((await saveSchedule({
      type: "override.set", date: FRI,
      windows: [{ kind: "date", weekday: null, date: FRI, startMin: 600, endMin: 660, staffIds: [team.a, team.b] }],
    })).status).toBe(200);
    const set = await saveSchedule({ type: "holiday.set", date: FRI, name: "Foundation Day" });
    expect([set.status, set.json.impact]).toEqual([200, { moved: [], conflicts: [], warnings: [] }]);
    expect(await count("SELECT COUNT(*) AS n FROM holidays")).toBe(1);

    const av = await api("GET", `/api/customer/availability?from=${FRI}&to=${FRI}`, { cookie: customerCookie });
    expect(av.json.days.find((d: any) => d.date === FRI).slots.length).toBeGreaterThan(0);
    expect((await row(r.id)).status).toBe("confirmed");

    // Without the override the same holiday closes the day.
    expect((await saveSchedule({ type: "override.clear", date: FRI })).status).toBe(409);
  });
});

describe("holiday CSV import", () => {
  const importPreview = (csv: unknown, cookie = adminCookie) => api("POST", "/api/staff/holidays/import/preview", { cookie, body: { csv } });
  const importApply = (csv: unknown, version: number, cookie = adminCookie) => api("POST", "/api/staff/holidays/import/apply", { cookie, body: { csv, version } });
  const holidays = async () => (await env.DB.prepare("SELECT date, name FROM holidays ORDER BY date").all<{ date: string; name: string }>()).results;

  it("plans rows as new, changed, unchanged and error, without writing", async () => {
    await env.DB.prepare("INSERT INTO holidays(date, name) VALUES ('2026-11-03', 'Culture Day'), ('2026-11-23', 'Old Name')").run();
    const csv = ["date,name", "2026-11-03,Culture Day", "2026-11-23,Labour Thanksgiving Day", '2026-12-23,"Emperor\'s, Birthday"', "2026-13-01,Bad Month", "2026-12-24,", "2026-12-25"].join("\r\n");
    const res = await importPreview(csv);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.version).toBe(await version());
    expect(res.json.rows).toEqual([
      { line: 2, date: "2026-11-03", name: "Culture Day", status: "unchanged", conflicts: 0 },
      { line: 3, date: "2026-11-23", name: "Labour Thanksgiving Day", status: "changed", previousName: "Old Name", conflicts: 0 },
      { line: 4, date: "2026-12-23", name: "Emperor's, Birthday", status: "new", conflicts: 0 },
      { line: 5, date: "2026-13-01", name: "Bad Month", status: "error", error: "invalid_date", conflicts: 0 },
      { line: 6, date: "2026-12-24", name: "", status: "error", error: "missing_name", conflicts: 0 },
      { line: 7, date: "2026-12-25", name: "", status: "error", error: "missing_name", conflicts: 0 },
    ]);
    expect(res.json.impact).toEqual({ moved: [], conflicts: [], warnings: [] });
    expect(await holidays()).toEqual([{ date: "2026-11-03", name: "Culture Day" }, { date: "2026-11-23", name: "Old Name" }]);
  });

  it("treats the header as optional, tolerates BOM, blank lines, LF endings and whitespace", async () => {
    const res = await importPreview("﻿ 2026-11-03 , Culture Day \n\n2026-11-23,Labour Thanksgiving Day\n");
    expect(res.json.rows.map((r: any) => [r.date, r.name, r.status])).toEqual([
      ["2026-11-03", "Culture Day", "new"],
      ["2026-11-23", "Labour Thanksgiving Day", "new"],
    ]);
    const withHeader = await importPreview("Date,Name\n2026-11-03,Culture Day");
    expect(withHeader.json.rows).toHaveLength(1);
  });

  it("flags row problems: extra columns, long names, bad dates, a date listed twice (every occurrence)", async () => {
    const csv = [
      "2026-11-03,Culture Day,extra",
      `2026-11-04,${"x".repeat(101)}`,
      "2026/11/05,Slash Date",
      "2026-02-30,Impossible Date",
      "2026-11-06,First",
      "2026-11-06,Second",
      "2026-11-07,Fine",
    ].join("\n");
    const rows = (await importPreview(csv)).json.rows as any[];
    expect(rows.map((r) => [r.date, r.status, r.error])).toEqual([
      ["2026-11-03", "error", "too_many_columns"],
      ["2026-11-04", "error", "name_too_long"],
      ["2026/11/05", "error", "invalid_date"],
      ["2026-02-30", "error", "invalid_date"],
      ["2026-11-06", "error", "duplicate_date"],
      ["2026-11-06", "error", "duplicate_date"],
      ["2026-11-07", "new", undefined],
    ]);
  });

  it("rejects malformed CSV, more than 400 rows and non-string bodies with 400", async () => {
    const quote = await importPreview('2026-11-03,"open');
    expect([quote.status, quote.json.error, quote.json.details.line]).toEqual([400, "invalid_csv", 1]);
    const many = Array.from({ length: 401 }, (_, i) => `${new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)},Day ${i}`).join("\n");
    expect([(await importPreview(many)).status, (await importPreview(many)).json.error]).toEqual([400, "too_many_rows"]);
    expect((await importApply(many, 0)).json.error).toBe("too_many_rows");
    expect((await importPreview(many.split("\n").slice(0, 400).join("\n"))).status).toBe(200);
    expect((await importPreview(5)).status).toBe(400);
    expect((await api("POST", "/api/staff/holidays/import/preview", { cookie: adminCookie, body: {} })).status).toBe(400);
    expect((await importPreview("x".repeat(100_001))).status).toBe(400);
  });

  it("applies every new and changed row in one batch: one version bump, one audit row", async () => {
    await env.DB.prepare("INSERT INTO holidays(date, name) VALUES ('2026-11-03', 'Culture Day'), ('2026-11-23', 'Old Name')").run();
    const csv = "date,name\n2026-11-03,Culture Day\n2026-11-23,Labour Thanksgiving Day\n2026-12-23,Emperor's Birthday\n2027-01-01,New Year";
    const v0 = await version();
    const p = await importPreview(csv);
    const res = await importApply(csv, p.json.version);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toEqual({ version: v0 + 1, impact: { moved: [], conflicts: [], warnings: [] }, applied: 3 });
    expect(await version()).toBe(v0 + 1);
    expect(await holidays()).toEqual([
      { date: "2026-11-03", name: "Culture Day" },
      { date: "2026-11-23", name: "Labour Thanksgiving Day" },
      { date: "2026-12-23", name: "Emperor's Birthday" },
      { date: "2027-01-01", name: "New Year" },
    ]);
    expect(await audits("schedule.holiday.%")).toEqual([
      {
        actor_kind: "staff", actor: String(team.admin), action: "schedule.holiday.bulk",
        details: { set: [{ date: "2026-11-23", name: "Labour Thanksgiving Day" }, { date: "2026-12-23", name: "Emperor's Birthday" }, { date: "2027-01-01", name: "New Year" }], moved: [] },
      },
    ]);
  });

  it("evaluates the combined impact once: conflicts per date block the whole import", async () => {
    const r = await submit(at(FRI, 10));
    await approve(r.id, team.a);
    const csv = `date,name\n2026-11-03,Culture Day\n${FRI},Foundation Day\n2026-11-23,Labour Thanksgiving Day`;
    const p = await importPreview(csv);
    expect(p.status).toBe(200);
    expect(p.json.rows.map((x: any) => [x.date, x.status, x.conflicts])).toEqual([["2026-11-03", "new", 0], [FRI, "new", 1], ["2026-11-23", "new", 0]]);
    expect(p.json.impact.conflicts).toEqual([expect.objectContaining({ id: r.id, reason: "slot_removed", startAt: at(FRI, 10) })]);

    const refused = await importApply(csv, p.json.version);
    expect([refused.status, refused.json.error]).toEqual([409, "conflicts"]);
    expect(refused.json.details.impact.conflicts).toHaveLength(1);
    expect(await holidays()).toEqual([]); // all or nothing
    expect(await version()).toBe(p.json.version);
  });

  it("refuses to apply while any row has an error, and when there is nothing to change", async () => {
    const v0 = await version();
    const bad = await importApply("2026-11-03,Culture Day\nnot-a-date,Oops", v0);
    expect([bad.status, bad.json.error]).toEqual([400, "invalid_rows"]);
    expect(bad.json.details.rows).toEqual([expect.objectContaining({ line: 2, status: "error", error: "invalid_date" })]);
    expect(await holidays()).toEqual([]);

    await env.DB.prepare("INSERT INTO holidays(date, name) VALUES ('2026-11-03', 'Culture Day')").run();
    const same = await importApply("2026-11-03,Culture Day", v0);
    expect([same.status, same.json.error]).toEqual([400, "nothing_to_import"]);
    const preview = await importPreview("2026-11-03,Culture Day");
    expect([preview.status, preview.json.impact]).toEqual([200, { moved: [], conflicts: [], warnings: [] }]);
    expect(await audits("schedule.holiday.%")).toEqual([]);
  });

  it("refuses a stale version", async () => {
    const csv = "2026-11-03,Culture Day";
    const p = await importPreview(csv);
    await saveSettings({ orgName: "Moved On" });
    const res = await importApply(csv, p.json.version);
    expect([res.status, res.json.error]).toEqual([409, "stale_preview"]);
    expect(await holidays()).toEqual([]);
  });

  it("is admin only", async () => {
    expect((await importPreview("2026-11-03,Culture Day", techCookie)).status).toBe(403);
    expect((await importApply("2026-11-03,Culture Day", 0, techCookie)).status).toBe(403);
    expect((await importPreview("2026-11-03,Culture Day", "")).status).toBe(401);
    expect(await holidays()).toEqual([]);
  });
});
