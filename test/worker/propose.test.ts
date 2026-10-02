import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../helpers";
import { loginCustomer, loginStaff, seedCustomer, seedTeam, seedWeekly, TZ, withBatchHook } from "../fixtures";
import { clock, setNow } from "../../src/worker/lib/clock";
import { sha256Hex } from "../../src/worker/lib/crypto";
import { processOutbox } from "../../src/worker/mail/outbox";
import { approveReservation } from "../../src/worker/reservations/approve";
import { cancelReservation } from "../../src/worker/reservations/cancel";
import { proposeReservation } from "../../src/worker/reservations/propose";
import { addDays, MIN, wallToUtc } from "../../src/domain/time";
import type { StaffPrincipal } from "../../src/worker/env";

afterEach(() => setNow(null));

const THU = "2026-10-01";
const FRI = "2026-10-02";
const SAT = "2026-10-03";
const at = (date: string, h: number, m = 0) => wallToUtc(date, h * 60 + m, TZ);
const TZ_LABEL = "Asia/Tokyo (GMT+9)";
const DAY = 24 * 60 * MIN;

let team: Awaited<ReturnType<typeof seedTeam>>;
let pat: { id: number; cookie: string };
let sam: { id: number; cookie: string };
let adminCookie: string;
let techCookie: string;

const principal = (id: number, name: string, role: StaffPrincipal["role"] = "technician"): StaffPrincipal => ({ id, email: "x@example.test", name, role });

beforeEach(async () => {
  setNow(at(THU, 8));
  team = await seedTeam();
  await env.DB.prepare("UPDATE staff SET name = 'Ada Admin' WHERE id = ?").bind(team.admin).run();
  await env.DB.prepare("UPDATE staff SET name = 'Tim Tech' WHERE id = ?").bind(team.a).run();
  await env.DB.prepare("UPDATE staff SET name = 'Una Tech' WHERE id = ?").bind(team.b).run();
  await env.DB.prepare("UPDATE staff SET name = 'Cy Tech' WHERE id = ?").bind(team.c).run();
  await env.DB.prepare("UPDATE staff SET name = 'Dee Tech' WHERE id = ?").bind(team.d).run();
  pat = { id: await seedCustomer({ email: "pat@example.test", name: "Pat Co" }), cookie: "" };
  sam = { id: await seedCustomer({ email: "sam@example.test", name: "Sam Co" }), cookie: "" };
  pat.cookie = await loginCustomer("pat@example.test");
  sam.cookie = await loginCustomer("sam@example.test");
  adminCookie = await loginStaff("admin@example.test");
  techCookie = await loginStaff("tech-a@example.test");
  // Friday 10:00–13:00 with technicians a and b: 30-minute slots every 30 minutes, 10 minutes buffer after.
  await seedWeekly(5, 600, 780, [team.a, team.b]);
  await env.DB.prepare("DELETE FROM email_jobs").run();
  await env.DB.prepare("DELETE FROM dev_mailbox").run();
});

const submit = async (who: { id: number; cookie: string }, startAt: number) => {
  const res = await api("POST", "/api/customer/reservations", {
    cookie: who.cookie,
    body: { customerId: who.id, startAt, contactName: "Pat Example", phone: "+81 3-1234-5678", issue: "Printer is offline", idempotencyKey: crypto.randomUUID() },
  });
  expect(res.status).toBe(201);
  return res.json.reservation.id as string;
};
const approve = async (id: string, staffId: number, version = 1) => {
  const res = await api("POST", `/api/staff/reservations/${id}/approve`, { cookie: adminCookie, body: { staffId, version } });
  expect(res.status).toBe(200);
};
type Opt = { startAt: number; staffId: number };
const propose = (id: string, options: Opt[], version: number, extra: Record<string, unknown> = {}, cookie = adminCookie) =>
  api("POST", `/api/staff/reservations/${id}/propose`, { cookie, body: { options, version, ...extra } });
const withdraw = (id: string, proposalId: string, cookie = adminCookie) =>
  api("POST", `/api/staff/reservations/${id}/proposal/withdraw`, { cookie, body: { proposalId } });
const candidates = (id: string, from: string, to: string, cookie = adminCookie) =>
  api("GET", `/api/staff/reservations/${id}/proposal-candidates?from=${from}&to=${to}`, { cookie });
const detail = (id: string) => api("GET", `/api/staff/reservations/${id}`, { cookie: adminCookie });
const count = async (sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;
const row = (id: string) => env.DB.prepare("SELECT * FROM reservations WHERE id = ?").bind(id).first<any>();
const proposalRow = (id: string) => env.DB.prepare("SELECT * FROM proposals WHERE id = ?").bind(id).first<any>();
const optionBlocks = (optionId?: string) =>
  optionId === undefined
    ? count("SELECT COUNT(*) AS n FROM tech_blocks WHERE owner_kind = 'option'")
    : count("SELECT COUNT(*) AS n FROM tech_blocks WHERE owner_kind = 'option' AND owner_id = ?", optionId);
const blocksOf = (staffId: number, ownerId: string) =>
  count("SELECT COUNT(*) AS n FROM tech_blocks WHERE staff_id = ? AND owner_id = ?", staffId, ownerId);
const mail = (to: string) =>
  env.DB.prepare("SELECT subject, text, html FROM dev_mailbox WHERE to_email = ? ORDER BY id DESC LIMIT 1").bind(to).first<{ subject: string; text: string; html: string }>();
const setSetting = (key: string, value: unknown) =>
  env.DB.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)").bind(key, JSON.stringify(value)).run();

describe("POST /api/staff/reservations/:id/propose", () => {
  it("proposes new times for a pending request: proposal, held options, longer approval clock, mail, audit", async () => {
    const id = await submit(pat, at(FRI, 10));
    const before = await row(id);
    expect(before.expires_at).toBe(at(THU, 17));

    const res = await propose(id, [{ startAt: at(FRI, 11), staffId: team.a }, { startAt: at(FRI, 12), staffId: team.b }], 1, { message: "  Sorry, we are fully booked then.  " });
    expect(res.status).toBe(200);
    const r = res.json.reservation;
    expect(r).toMatchObject({ id, status: "pending", version: 2 });
    expect(r.proposal).toEqual({
      id: expect.any(String),
      status: "open",
      message: "Sorry, we are fully booked then.",
      createdAt: at(THU, 8),
      // min(created + 24 BH, start − 120 min, earliest option − 60 min) = Friday 08:00.
      expiresAt: at(FRI, 8),
      resolvedAt: null,
      options: [
        { id: expect.any(String), startAt: at(FRI, 11), endAt: at(FRI, 11, 30), staffId: team.a, staffName: "Tim Tech" },
        { id: expect.any(String), startAt: at(FRI, 12), endAt: at(FRI, 12, 30), staffId: team.b, staffName: "Una Tech" },
      ],
    });
    const pid = r.proposal.id as string;
    expect(await proposalRow(pid)).toMatchObject({ reservation_id: id, status: "open", created_by: team.admin, created_at: at(THU, 8), expires_at: at(FRI, 8), resolved_at: null });

    // Option holds store their occupied range (buffer included) and hold their technician's blocks.
    const opts = (await env.DB.prepare("SELECT * FROM proposal_options WHERE proposal_id = ? ORDER BY start_at").bind(pid).all<any>()).results;
    expect(opts.map((o) => [o.staff_id, o.start_at, o.end_at, o.occ_start, o.occ_end])).toEqual([
      [team.a, at(FRI, 11), at(FRI, 11, 30), at(FRI, 11), at(FRI, 11, 40)],
      [team.b, at(FRI, 12), at(FRI, 12, 30), at(FRI, 12), at(FRI, 12, 40)],
    ]);
    expect(await blocksOf(team.a, opts[0].id)).toBe(8);
    expect(await blocksOf(team.b, opts[1].id)).toBe(8);
    // The original keeps its hold.
    expect(await blocksOf(before.provisional_staff_id, id)).toBe(8);

    // Ruling: the approval deadline moves out to the proposal's expiry, so the request doesn't expire while the customer decides.
    expect(await row(id)).toMatchObject({ version: 2, expires_at: at(FRI, 8), status: "pending" });

    expect(await count("SELECT COUNT(*) AS n FROM email_jobs WHERE template = 'proposal' AND to_email = 'pat@example.test' AND dedupe_key = ?", `proposal:${pid}`)).toBe(1);
    // The team: every notify member (and the option technicians) except the proposer.
    const team_ = (await env.DB.prepare("SELECT to_email, dedupe_key FROM email_jobs WHERE template = 'proposal' AND to_email <> 'pat@example.test' ORDER BY to_email").all<any>()).results;
    expect(team_.map((j) => j.to_email)).toEqual(["tech-a@example.test", "tech-b@example.test", "tech-c@example.test", "tech-d@example.test"]);
    expect(team_.find((j) => j.to_email === "tech-a@example.test").dedupe_key).toBe(`proposal-team:${pid}:${team.a}`);

    const a = await env.DB.prepare("SELECT * FROM audit_log WHERE action = 'reservation.proposed'").first<any>();
    expect(a).toMatchObject({ actor_kind: "staff", actor: String(team.admin), reservation_id: id, customer_id: pat.id });
    expect(JSON.parse(a.details)).toEqual({
      proposalId: pid,
      options: [
        { startAt: at(FRI, 11), staffId: team.a },
        { startAt: at(FRI, 12), staffId: team.b },
      ],
    });
  });

  it("proposes for a confirmed appointment (technicians may propose too); its approval clock is left alone", async () => {
    const id = await submit(pat, at(FRI, 10));
    await approve(id, team.a);
    const before = await row(id);
    const res = await propose(id, [{ startAt: at(FRI, 11), staffId: team.a }], 2, {}, techCookie);
    expect(res.status).toBe(200);
    expect(res.json.reservation).toMatchObject({ status: "confirmed", version: 3, assignedStaff: { id: team.a }, proposal: { status: "open", message: null } });
    expect((await row(id)).expires_at).toBe(before.expires_at);
    // Original appointment still held on a, plus the option on a.
    expect(await blocksOf(team.a, id)).toBe(8);
    expect(await optionBlocks()).toBe(8);
    // tech-a proposed: everyone else hears about it.
    const to = (await env.DB.prepare("SELECT to_email FROM email_jobs WHERE template = 'proposal' ORDER BY to_email").all<any>()).results.map((j) => j.to_email);
    expect(to).toEqual(["admin@example.test", "pat@example.test", "tech-b@example.test", "tech-c@example.test", "tech-d@example.test"]);
  });

  it("caps the expiry at the earliest option minus 60 minutes and at proposalExpiryBh business hours", async () => {
    const id = await submit(pat, at(FRI, 12));
    let res = await propose(id, [{ startAt: at(FRI, 10), staffId: team.b }], 1);
    expect(res.json.reservation.proposal.expiresAt).toBe(at(FRI, 9));

    await setSetting("proposalExpiryBh", 2);
    res = await propose(id, [{ startAt: at(FRI, 11), staffId: team.b }], 2);
    // Business hours start at 09:00 on Thursday: two business hours later is 11:00.
    expect(res.json.reservation.proposal.expiresAt).toBe(at(THU, 11));
    // A deadline earlier than the request's own is never shortened to it.
    expect((await row(id)).expires_at).toBe(at(FRI, 9));
  });

  it("is too late once the appointment is within proposalExpiryBeforeStartMin", async () => {
    const id = await submit(pat, at(FRI, 10));
    await approve(id, team.a);
    setNow(at(FRI, 8));
    const res = await propose(id, [{ startAt: at(FRI, 12), staffId: team.b }], 2);
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("too_late");
  });

  describe("validation", () => {
    let id: string;
    beforeEach(async () => {
      id = await submit(pat, at(FRI, 10));
      await approve(id, team.a);
    });
    const expectError = async (options: Opt[], status: number, error: string, details?: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
      const res = await propose(id, options, 2, extra);
      expect(res.status).toBe(status);
      expect(res.json.error).toBe(error);
      if (details !== undefined) expect(res.json.details).toMatchObject(details);
      expect(await count("SELECT COUNT(*) AS n FROM proposals")).toBe(0);
      expect(await optionBlocks()).toBe(0);
      expect((await row(id)).version).toBe(2);
    };

    it("needs 1 to 3 options and a message of at most 500 characters", async () => {
      await expectError([], 400, "invalid");
      const four = [11, 11.5, 12, 12.5].map((h) => ({ startAt: at(FRI, Math.floor(h), (h % 1) * 60), staffId: team.b }));
      await expectError(four, 400, "invalid");
      await expectError([{ startAt: at(FRI, 11), staffId: team.b }], 400, "invalid", undefined, { message: "x".repeat(501) });
    });

    it("rejects options at the same time as each other or as the current appointment, whatever the technician (customers see times only)", async () => {
      await expectError([{ startAt: at(FRI, 11), staffId: team.b }, { startAt: at(FRI, 11), staffId: team.b }], 400, "option_duplicate_time", { index: 1 });
      await expectError([{ startAt: at(FRI, 11), staffId: team.b }, { startAt: at(FRI, 11), staffId: team.a }], 400, "option_duplicate_time", { index: 1 });
      await expectError([{ startAt: at(FRI, 10), staffId: team.a }], 400, "option_same_as_current", { index: 0 });
      await expectError([{ startAt: at(FRI, 12), staffId: team.a }, { startAt: at(FRI, 10), staffId: team.b }], 400, "option_same_as_current", { index: 1 });
    });

    it("rejects a time that is not a slot under the current settings, too soon, or beyond the horizon", async () => {
      await expectError([{ startAt: at(FRI, 11), staffId: team.b }, { startAt: at(FRI, 11, 15), staffId: team.b }], 409, "option_not_a_slot", { index: 1 });
      await seedWeekly(4, 600, 780, [team.a, team.b]);
      // Minimum notice: 3 business hours from Thursday 08:00 is 12:00.
      await expectError([{ startAt: at(THU, 11), staffId: team.b }], 409, "option_too_soon", { index: 0 });
      // One day of horizon from Thursday: Friday is the last bookable date.
      await setSetting("bookingHorizonDays", 1);
      await seedWeekly(6, 600, 780, [team.a, team.b]);
      await expectError([{ startAt: at(SAT, 11), staffId: team.b }], 409, "option_beyond_horizon", { index: 0 });
    });

    it("rejects a technician who is not working or is off then", async () => {
      await expectError([{ startAt: at(FRI, 11), staffId: team.c }], 409, "option_tech_unavailable", { index: 0 });
      await env.DB.prepare("INSERT INTO staff_unavailability(staff_id, start_at, end_at) VALUES (?, ?, ?)").bind(team.b, at(FRI, 11, 30), at(FRI, 12)).run();
      // The occupied range (buffer included) touches the time off.
      await expectError([{ startAt: at(FRI, 11), staffId: team.b }], 409, "option_tech_unavailable", { index: 0 });
    });

    it("rejects an option on the current technician overlapping the appointment it would replace", async () => {
      await expectError([{ startAt: at(FRI, 12), staffId: team.b }, { startAt: at(FRI, 10, 30), staffId: team.a }], 409, "option_overlaps_current", { index: 1 });
      // Another technician at an overlapping time is fine.
      expect((await propose(id, [{ startAt: at(FRI, 10, 30), staffId: team.b }], 2)).status).toBe(200);
    });

    it("rejects options that clash with each other or with other holds", async () => {
      await expectError([{ startAt: at(FRI, 11), staffId: team.b }, { startAt: at(FRI, 11, 30), staffId: team.b }], 409, "options_conflict");
      const other = await submit(sam, at(FRI, 12));
      await approve(other, team.b);
      await expectError([{ startAt: at(FRI, 12), staffId: team.b }], 409, "options_conflict");
    });

    it("checks the set together with the original, which stays held while the proposal is open", async () => {
      // Sam's request at 10:30 can only go to b while pat's appointment holds a until 10:40: an option on b at 11:00
      // (occupied 11:00–11:40) leaves sam no room. Without the original, sam could move to a, but the database would
      // then refuse the option's blocks on b. No option overlaps the original itself, so no index is named.
      await submit(sam, at(FRI, 10, 30));
      await expectError([{ startAt: at(FRI, 11), staffId: team.b }], 409, "option_overlaps_current", { index: null });
    });

    it("is stale for an old version or a closed reservation, 404 for an unknown one", async () => {
      let res = await propose(id, [{ startAt: at(FRI, 11), staffId: team.b }], 1);
      expect(res.status).toBe(409);
      expect(res.json).toMatchObject({ error: "stale", details: { current: { id, version: 2 } } });
      await cancelReservation(env, { kind: "staff", staff: principal(team.admin, "Ada Admin", "admin") }, id, { reason: "Customer asked", version: 2 });
      res = await propose(id, [{ startAt: at(FRI, 11), staffId: team.b }], 3);
      expect(res.status).toBe(409);
      expect(res.json.error).toBe("stale");
      expect((await propose("nope", [{ startAt: at(FRI, 11), staffId: team.b }], 1)).status).toBe(404);
    });

    it("requires a staff session", async () => {
      const res = await api("POST", `/api/staff/reservations/${id}/propose`, { cookie: pat.cookie, body: { options: [{ startAt: at(FRI, 11), staffId: team.b }], version: 2 } });
      expect(res.status).toBe(401);
    });
  });

  it("reports an option overlapping a pending request that can't move away from that technician", async () => {
    // Pat (a) and Sam (b) both at 10:00: pat's request can't make room for an option on a at 10:30.
    const id = await submit(pat, at(FRI, 10));
    await submit(sam, at(FRI, 10));
    expect((await row(id)).provisional_staff_id).toBe(team.a);
    const res = await propose(id, [{ startAt: at(FRI, 10, 30), staffId: team.a }], 1);
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ error: "option_overlaps_current", details: { index: 0 } });
  });

  it("moves pending requests out of an option's way, the original included", async () => {
    // Pat's request is provisionally on a; an option on a at 10:30 overlaps it, b is free: pat's request moves to b.
    const id = await submit(pat, at(FRI, 10));
    expect((await row(id)).provisional_staff_id).toBe(team.a);
    const res = await propose(id, [{ startAt: at(FRI, 10, 30), staffId: team.a }], 1);
    expect(res.status).toBe(200);
    expect((await row(id)).provisional_staff_id).toBe(team.b);
    expect(await blocksOf(team.b, id)).toBe(8);
    expect(await blocksOf(team.a, id)).toBe(0);
    expect(await optionBlocks(res.json.reservation.proposal.options[0].id)).toBe(8);
  });

  it("supersedes the open proposal in the same batch, releasing its holds so its times can be offered again", async () => {
    const id = await submit(pat, at(FRI, 10));
    await approve(id, team.a);
    const first = await propose(id, [{ startAt: at(FRI, 11), staffId: team.b }, { startAt: at(FRI, 12), staffId: team.a }], 2);
    const p1 = first.json.reservation.proposal;
    expect(await optionBlocks()).toBe(16);
    // As if its mail were still waiting to be sent.
    await env.DB.prepare("UPDATE email_jobs SET status = 'queued' WHERE dedupe_key = ?").bind(`proposal:${p1.id}`).run();

    // A failing new proposal leaves the open one untouched.
    const bad = await propose(id, [{ startAt: at(FRI, 11, 15), staffId: team.b }], 3);
    expect(bad.status).toBe(409);
    expect((await proposalRow(p1.id)).status).toBe("open");
    expect(await optionBlocks()).toBe(16);

    const second = await propose(id, [{ startAt: at(FRI, 11), staffId: team.b }], 3);
    expect(second.status).toBe(200);
    const p2 = second.json.reservation.proposal;
    expect(p2.id).not.toBe(p1.id);
    expect(second.json.reservation.version).toBe(4);
    expect(await proposalRow(p1.id)).toMatchObject({ status: "superseded", resolved_at: at(THU, 8) });
    expect(await optionBlocks(p1.options[0].id)).toBe(0);
    expect(await optionBlocks(p1.options[1].id)).toBe(0);
    expect(await optionBlocks(p2.options[0].id)).toBe(8);
    expect(await optionBlocks()).toBe(8);
    // The superseded proposal's mail is not sent.
    expect(await count("SELECT COUNT(*) AS n FROM email_jobs WHERE dedupe_key = ? AND status = 'cancelled'", `proposal:${p1.id}`)).toBe(1);
    expect(JSON.parse((await env.DB.prepare("SELECT details FROM audit_log WHERE action = 'reservation.proposed' ORDER BY id DESC").first<any>()).details)).toMatchObject({
      proposalId: p2.id,
      supersedes: p1.id,
    });
  });

  it("an earlier proposal that is no longer open when the batch runs makes it retry", async () => {
    const id = await submit(pat, at(FRI, 10));
    const first = await propose(id, [{ startAt: at(FRI, 11), staffId: team.b }], 1);
    const p1 = first.json.reservation.proposal.id as string;
    const w = withBatchHook(async () => {
      await api("POST", `/api/staff/reservations/${id}/proposal/withdraw`, { cookie: adminCookie, body: { proposalId: p1 } });
    });
    const r = await proposeReservation(w.env, principal(team.admin, "Ada Admin", "admin"), id, { options: [{ startAt: at(FRI, 12), staffId: team.b }], version: 2 });
    expect(w.calls.batches).toBe(2);
    expect(r.proposal).toMatchObject({ status: "open" });
    expect(await proposalRow(p1)).toMatchObject({ status: "withdrawn" });
    expect(await count("SELECT COUNT(*) AS n FROM proposals WHERE status = 'open'")).toBe(1);
  });

  describe("racing an approval", () => {
    it("approval first: the proposal is stale", async () => {
      const id = await submit(pat, at(FRI, 10));
      const w = withBatchHook(async () => {
        await approveReservation(env, principal(team.a, "Tim Tech"), id, team.a, 1);
      });
      await expect(
        proposeReservation(w.env, principal(team.admin, "Ada Admin", "admin"), id, { options: [{ startAt: at(FRI, 11), staffId: team.b }], version: 1 }),
      ).rejects.toMatchObject({ status: 409, code: "stale", details: { current: { status: "confirmed", version: 2 } } });
      expect(w.calls.batches).toBe(1);
      expect(await count("SELECT COUNT(*) AS n FROM proposals")).toBe(0);
      expect(await optionBlocks()).toBe(0);
    });

    it("proposal first: the approval is stale", async () => {
      const id = await submit(pat, at(FRI, 10));
      const w = withBatchHook(async () => {
        await proposeReservation(env, principal(team.b, "Una Tech"), id, { options: [{ startAt: at(FRI, 11), staffId: team.b }], version: 1 });
      });
      await expect(approveReservation(w.env, principal(team.admin, "Ada Admin", "admin"), id, team.a, 1)).rejects.toMatchObject({
        status: 409,
        code: "stale",
        details: { current: { status: "pending", version: 2 } },
      });
      expect((await row(id)).status).toBe("pending");
      expect(await count("SELECT COUNT(*) AS n FROM proposals WHERE status = 'open'")).toBe(1);
    });
  });

  it("option holds take capacity from other customers", async () => {
    await env.DB.prepare("DELETE FROM availability_window_staff WHERE staff_id = ?").bind(team.b).run();
    const id = await submit(pat, at(FRI, 10));
    const avail = async () => {
      const res = await api("GET", `/api/customer/availability?from=${FRI}&to=${FRI}`, { cookie: sam.cookie });
      return res.json.days[0].slots.map((s: any) => s.startAt);
    };
    expect(await avail()).toEqual([at(FRI, 11), at(FRI, 11, 30), at(FRI, 12), at(FRI, 12, 30)]);
    expect((await propose(id, [{ startAt: at(FRI, 12), staffId: team.a }], 1)).status).toBe(200);
    // 11:30 (occupied to 12:10) and 12:30 (from 12:30; the option is occupied to 12:40) collide with the option.
    expect(await avail()).toEqual([at(FRI, 11)]);
    const res = await api("POST", "/api/customer/reservations", {
      cookie: sam.cookie,
      body: { customerId: sam.id, startAt: at(FRI, 12), contactName: "Sam", phone: "+81 3-1234-5678", issue: "Mail", idempotencyKey: crypto.randomUUID() },
    });
    expect(res.status).toBe(409);
  });
});

describe("POST /api/staff/reservations/:id/proposal/withdraw", () => {
  it("withdraws the open proposal: holds released, customer told, audited; again is proposal_closed", async () => {
    const id = await submit(pat, at(FRI, 10));
    const p = (await propose(id, [{ startAt: at(FRI, 11), staffId: team.b }], 1)).json.reservation.proposal;
    await env.DB.prepare("UPDATE email_jobs SET status = 'queued' WHERE dedupe_key = ?").bind(`proposal:${p.id}`).run();
    const res = await withdraw(id, p.id);
    expect(res.status).toBe(200);
    expect(res.json.reservation).toMatchObject({ id, status: "pending", version: 2, proposal: { id: p.id, status: "withdrawn", resolvedAt: at(THU, 8) } });
    expect(await proposalRow(p.id)).toMatchObject({ status: "withdrawn", resolved_at: at(THU, 8) });
    expect(await optionBlocks()).toBe(0);
    // The longer approval clock is kept; the next expiry sweep handles it at that time.
    expect((await row(id)).expires_at).toBe(at(FRI, 8));
    expect(await count("SELECT COUNT(*) AS n FROM email_jobs WHERE template = 'proposal_outcome' AND to_email = 'pat@example.test' AND dedupe_key = ?", `proposal-outcome:${p.id}`)).toBe(1);
    // The unsent proposal mail is withdrawn with it.
    expect(await count("SELECT COUNT(*) AS n FROM email_jobs WHERE dedupe_key = ? AND status = 'cancelled'", `proposal:${p.id}`)).toBe(1);
    const a = await env.DB.prepare("SELECT * FROM audit_log WHERE action = 'reservation.proposal_withdrawn'").first<any>();
    expect(a).toMatchObject({ actor_kind: "staff", actor: String(team.admin), reservation_id: id });
    expect(JSON.parse(a.details)).toEqual({ proposalId: p.id });

    const again = await withdraw(id, p.id);
    expect(again.status).toBe(409);
    expect(again.json).toMatchObject({ error: "proposal_closed", details: { current: { id, proposal: { status: "withdrawn" } } } });
  });

  it("404 for a proposal of another reservation or an unknown one; 400 without a proposal id", async () => {
    const id = await submit(pat, at(FRI, 10));
    const other = await submit(sam, at(FRI, 11));
    const p = (await propose(id, [{ startAt: at(FRI, 12), staffId: team.b }], 1)).json.reservation.proposal;
    expect((await withdraw(other, p.id)).status).toBe(404);
    expect((await withdraw(id, "nope")).status).toBe(404);
    expect((await api("POST", `/api/staff/reservations/${id}/proposal/withdraw`, { cookie: adminCookie, body: {} })).status).toBe(400);
  });

  it("emails the customer that the original stands (confirmed) or is still pending review", async () => {
    const id = await submit(pat, at(FRI, 10));
    let p = (await propose(id, [{ startAt: at(FRI, 11), staffId: team.b }], 1)).json.reservation.proposal;
    await withdraw(id, p.id);
    await processOutbox(env, 50);
    let m = await mail("pat@example.test");
    expect(m!.text).toContain("still pending review");

    await approve(id, team.a, 2);
    p = (await propose(id, [{ startAt: at(FRI, 11), staffId: team.b }], 3)).json.reservation.proposal;
    await withdraw(id, p.id);
    await processOutbox(env, 50);
    m = await mail("pat@example.test");
    expect(m!.text).toContain("Your original appointment stands");
    expect(m!.text).toContain(`Fri, Oct 2, 2026, 10:00 ${TZ_LABEL}`);
    expect(m!.text).not.toMatch(/Tim Tech|Una Tech/);
  });
});

describe("GET /api/staff/reservations/:id/proposal-candidates", () => {
  it("lists free technicians per slot around the original appointment, ignoring the reservation's own open options", async () => {
    const id = await submit(pat, at(FRI, 10));
    await approve(id, team.a);
    const other = await submit(sam, at(FRI, 12));
    await approve(other, team.b);

    const res = await candidates(id, FRI, FRI);
    expect(res.status).toBe(200);
    const names = (staff: number[]) => staff.map((s) => ({ id: s, name: s === team.a ? "Tim Tech" : "Una Tech" }));
    const expected = [
      // The appointment's own time is no option (customers see times only); the appointment holds a until 10:40.
      { startAt: at(FRI, 10, 30), endAt: at(FRI, 11), staff: names([team.b]) },
      { startAt: at(FRI, 11), endAt: at(FRI, 11, 30), staff: names([team.a, team.b]) },
      // Sam's appointment holds b from 12:00 to 12:40.
      { startAt: at(FRI, 11, 30), endAt: at(FRI, 12), staff: names([team.a]) },
      { startAt: at(FRI, 12), endAt: at(FRI, 12, 30), staff: names([team.a]) },
      { startAt: at(FRI, 12, 30), endAt: at(FRI, 13), staff: names([team.a]) },
    ];
    // lastDate: the booking window's last date (today + 30 days), so a client knows when to stop paging.
    expect(res.json).toEqual({ timezone: TZ, lastDate: addDays(THU, 30), days: [{ date: FRI, slots: expected }] });

    // Its own open proposal would be superseded, so its options don't count.
    expect((await propose(id, [{ startAt: at(FRI, 11), staffId: team.a }], 2)).status).toBe(200);
    expect((await candidates(id, FRI, FRI)).json.days[0].slots).toEqual(expected);
    // Other reservations' holds do: lee's request (12:30, only a is free then) and lee's option on b (10:30–11:10).
    // Slots nobody can take are left out.
    const lee = { id: await seedCustomer({ email: "lee@example.test", name: "Lee Co" }), cookie: await loginCustomer("lee@example.test") };
    const lees = await submit(lee, at(FRI, 12, 30));
    expect((await row(lees)).provisional_staff_id).toBe(team.a);
    expect((await propose(lees, [{ startAt: at(FRI, 10, 30), staffId: team.b }], 1)).status).toBe(200);
    const slots = (await candidates(id, FRI, FRI)).json.days[0].slots;
    expect(slots).toEqual([{ ...expected[1], staff: names([team.a]) }, expected[2]]);
  });

  it("starts at the minimum notice and stops at the horizon", async () => {
    await seedWeekly(4, 600, 780, [team.a, team.b]);
    const id = await submit(pat, at(FRI, 10));
    const res = await candidates(id, "2026-09-30", FRI);
    expect(res.json.days.map((d: any) => d.date)).toEqual([THU, FRI]);
    // Thursday from 12:00 (3 business hours after 08:00).
    expect(res.json.days[0].slots.map((s: any) => s.startAt)).toEqual([at(THU, 12), at(THU, 12, 30)]);
    await setSetting("bookingHorizonDays", 1);
    await seedWeekly(6, 600, 780, [team.a, team.b]);
    expect((await candidates(id, FRI, SAT)).json.days.map((d: any) => d.date)).toEqual([FRI]);
    expect((await candidates(id, SAT, SAT)).json).toEqual({ timezone: TZ, lastDate: FRI, days: [] });
  });

  it("is too late within proposalExpiryBeforeStartMin of the start, and leaves out slots an expiry could not precede", async () => {
    await seedWeekly(4, 600, 780, [team.a, team.b]);
    await setSetting("minNoticeBh", 0);
    const id = await submit(pat, at(FRI, 12));
    // 10:30 now: Thursday's 11:00 and 11:30 would need the proposal to expire before 10:30 (option − 60 min).
    setNow(at(THU, 10, 30));
    const thu = (await candidates(id, THU, THU)).json.days[0].slots.map((s: any) => s.startAt);
    expect(thu[0]).toBe(at(THU, 12));
    setNow(at(FRI, 10));
    const res = await candidates(id, FRI, FRI);
    expect([res.status, res.json.error]).toEqual([409, "too_late"]);
  });

  it("validates the range and the reservation", async () => {
    const id = await submit(pat, at(FRI, 10));
    expect((await candidates(id, FRI, addDays(FRI, 13))).status).toBe(200);
    expect((await candidates(id, FRI, addDays(FRI, 14))).status).toBe(400);
    expect((await candidates(id, FRI, THU)).status).toBe(400);
    expect((await candidates(id, "2026-02-30", FRI)).status).toBe(400);
    expect((await candidates("nope", FRI, FRI)).status).toBe(404);
    expect((await api("GET", `/api/staff/reservations/${id}/proposal-candidates?from=${FRI}&to=${FRI}`, { cookie: pat.cookie })).status).toBe(401);
    await cancelReservation(env, { kind: "staff", staff: principal(team.admin, "Ada Admin", "admin") }, id, { reason: "x", version: 1 });
    expect((await candidates(id, FRI, FRI)).status).toBe(409);
  });
});

describe("proposal in the reservation views", () => {
  it("staff list and detail carry the proposal with technician names", async () => {
    const id = await submit(pat, at(FRI, 10));
    expect((await detail(id)).json.reservation.proposal).toBeNull();
    await propose(id, [{ startAt: at(FRI, 11), staffId: team.b }], 1);
    const d = await detail(id);
    expect(d.json.reservation.proposal.options).toEqual([{ id: expect.any(String), startAt: at(FRI, 11), endAt: at(FRI, 11, 30), staffId: team.b, staffName: "Una Tech" }]);
    const list = await api("GET", "/api/staff/reservations?status=pending", { cookie: adminCookie });
    expect(list.json.reservations[0].proposal).toEqual(d.json.reservation.proposal);
  });

  it("customers see the proposal without any technician data", async () => {
    const id = await submit(pat, at(FRI, 10));
    const p = (await propose(id, [{ startAt: at(FRI, 11), staffId: team.b }], 1, { message: "Busy then" })).json.reservation.proposal;
    const expected = {
      id: p.id,
      status: "open",
      message: "Busy then",
      expiresAt: at(FRI, 8),
      options: [{ id: p.options[0].id, startAt: at(FRI, 11), endAt: at(FRI, 11, 30) }],
    };
    const one = await api("GET", `/api/customer/reservations/${id}`, { cookie: pat.cookie });
    expect(one.json.reservation.proposal).toEqual(expected);
    const list = await api("GET", "/api/customer/reservations", { cookie: pat.cookie });
    expect(list.json.reservations[0].proposal).toEqual(expected);

    const token = `tok-${crypto.randomUUID()}-${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO access_tokens(token_hash, reservation_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(token), id, clock.now(), at(FRI, 23))
      .run();
    const viaLink = await api("POST", "/api/access/reservation", { body: { token } });
    expect(viaLink.json.reservation.proposal).toEqual(expected);
    for (const body of [one.json, list.json, viaLink.json]) expect(JSON.stringify(body)).not.toMatch(/staff|Una Tech|Tim Tech/i);
  });

  it("shows the latest closed proposal for 7 days, a superseded one never", async () => {
    const id = await submit(pat, at(FRI, 10));
    const p1 = (await propose(id, [{ startAt: at(FRI, 11), staffId: team.b }], 1)).json.reservation.proposal;
    const p2 = (await propose(id, [{ startAt: at(FRI, 12), staffId: team.b }], 2)).json.reservation.proposal;
    expect((await detail(id)).json.reservation.proposal.id).toBe(p2.id);
    await withdraw(id, p2.id);
    expect((await detail(id)).json.reservation.proposal).toMatchObject({ id: p2.id, status: "withdrawn" });
    expect(p1.id).not.toBe(p2.id);
    setNow(at(THU, 8) + 7 * DAY - MIN);
    expect((await detail(id)).json.reservation.proposal).toMatchObject({ id: p2.id });
    setNow(at(THU, 8) + 7 * DAY + MIN);
    expect((await detail(id)).json.reservation.proposal).toBeNull();
  });
});

describe("proposal emails", () => {
  it("customer (pending): message escaped, options as buttons with time zone, choose another time, expiry; no technicians", async () => {
    const id = await submit(pat, at(FRI, 10));
    const ref = (await row(id)).ref as string;
    const p = (
      await propose(id, [{ startAt: at(FRI, 11), staffId: team.a }, { startAt: at(FRI, 12), staffId: team.b }], 1, { message: "Sorry — <b>double-booked</b> & more" })
    ).json.reservation.proposal;
    await processOutbox(env, 50);
    const m = (await mail("pat@example.test"))!;
    expect(m.subject).toContain(ref);
    expect(m.text).toContain("Sorry — <b>double-booked</b> & more");
    expect(m.html).toContain("Sorry — &lt;b&gt;double-booked&lt;/b&gt; &amp; more");
    expect(m.html).not.toContain("<b>double-booked</b>");
    expect(m.text).toContain(`Fri, Oct 2, 2026, 10:00 ${TZ_LABEL}`);
    expect(m.text).toContain(`Fri, Oct 2, 2026, 11:00 ${TZ_LABEL}`);
    expect(m.text).toContain(`Fri, Oct 2, 2026, 12:00 ${TZ_LABEL}`);
    // Expiry, with its time zone.
    expect(m.text).toContain(`Fri, Oct 2, 2026, 08:00 ${TZ_LABEL}`);
    for (const o of p.options) expect(m.text).toMatch(new RegExp(`/r#t=[A-Za-z0-9_-]+&action=proposal&option=${o.id}`));
    expect(m.text).toMatch(/\/r#t=[A-Za-z0-9_-]+&action=proposal&choice=other/);
    expect(m.text).not.toContain("choice=keep");
    expect(m.text).not.toMatch(/Tim Tech|Una Tech|Ada Admin/);
  });

  it("customer (confirmed): the current appointment and a keep-my-time link", async () => {
    const id = await submit(pat, at(FRI, 10));
    await approve(id, team.a);
    await env.DB.prepare("DELETE FROM email_jobs").run();
    await propose(id, [{ startAt: at(FRI, 11), staffId: team.b }], 2);
    await processOutbox(env, 50);
    const m = (await mail("pat@example.test"))!;
    expect(m.text).toContain(`Your current appointment: Fri, Oct 2, 2026, 10:00 ${TZ_LABEL}`);
    expect(m.text).toMatch(/Keep my original time: http:\/\/localhost:5173\/r#t=[A-Za-z0-9_-]+&action=proposal&choice=keep/);
    expect(m.text).toMatch(/Choose another time: http:\/\/localhost:5173\/r#t=[A-Za-z0-9_-]+&action=proposal&choice=other/);
    expect(m.text).not.toMatch(/Tim Tech|Una Tech/);
  });

  it("team notice names who proposed and each option's technician", async () => {
    const id = await submit(pat, at(FRI, 10));
    const ref = (await row(id)).ref as string;
    await propose(id, [{ startAt: at(FRI, 11), staffId: team.a }, { startAt: at(FRI, 12), staffId: team.b }], 1);
    await processOutbox(env, 50);
    const m = (await mail("tech-c@example.test"))!;
    expect(m.subject).toContain(ref);
    expect(m.text).toContain("Ada Admin");
    expect(m.text).toContain(`Fri, Oct 2, 2026, 11:00 ${TZ_LABEL} — Tim Tech`);
    expect(m.text).toContain(`Fri, Oct 2, 2026, 12:00 ${TZ_LABEL} — Una Tech`);
    expect(m.text).toContain(`/staff/r/${id}`);
    // Team wording, not the customer's.
    expect(m.text).toContain(`Requested time: Fri, Oct 2, 2026, 10:00 ${TZ_LABEL}`);
    expect(m.text).not.toContain("Your requested time");
    expect(await count("SELECT COUNT(*) AS n FROM email_jobs WHERE template = 'proposal' AND to_email = 'admin@example.test'")).toBe(0);
  });

  it("a superseded, withdrawn or cancelled proposal's queued mail is never sent", async () => {
    const id = await submit(pat, at(FRI, 10));
    const p1 = (await propose(id, [{ startAt: at(FRI, 11), staffId: team.b }], 1)).json.reservation.proposal;
    // Re-queue the first one's mail as if it had not been picked up yet when the second proposal landed.
    await propose(id, [{ startAt: at(FRI, 12), staffId: team.b }], 2);
    await env.DB.prepare("UPDATE email_jobs SET status = 'queued' WHERE dedupe_key = ?").bind(`proposal:${p1.id}`).run();
    await processOutbox(env, 50);
    expect((await env.DB.prepare("SELECT status FROM email_jobs WHERE dedupe_key = ?").bind(`proposal:${p1.id}`).first<any>()).status).toBe("skipped");

    await env.DB.prepare("DELETE FROM email_jobs").run();
    const p3 = (await propose(id, [{ startAt: at(FRI, 11), staffId: team.b }], 3)).json.reservation.proposal;
    await env.DB.prepare("UPDATE email_jobs SET status = 'queued' WHERE dedupe_key = ?").bind(`proposal:${p3.id}`).run();
    await cancelReservation(env, { kind: "customer", email: "pat@example.test" }, id, { version: 4 });
    expect((await env.DB.prepare("SELECT status FROM email_jobs WHERE dedupe_key = ?").bind(`proposal:${p3.id}`).first<any>()).status).toBe("cancelled");
    expect(await count("SELECT COUNT(*) AS n FROM email_jobs WHERE template = 'proposal' AND status = 'queued'")).toBe(0);
  });
});
