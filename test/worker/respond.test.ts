import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../helpers";
import { loginCustomer, loginStaff, seedCustomer, seedTeam, seedWeekly, TZ, withBatchHook } from "../fixtures";
import { clock, setNow } from "../../src/worker/lib/clock";
import { sha256Hex } from "../../src/worker/lib/crypto";
import { processOutbox } from "../../src/worker/mail/outbox";
import { approveReservation } from "../../src/worker/reservations/approve";
import { cancelReservation } from "../../src/worker/reservations/cancel";
import { withdrawProposal } from "../../src/worker/reservations/propose";
import { acceptProposal, rejectProposal } from "../../src/worker/reservations/respond";
import { submitReservation } from "../../src/worker/reservations/submit";
import { expireProposals } from "../../src/worker/cron/proposal-expiry";
import { runSweeps } from "../../src/worker/cron";
import { wallToUtc } from "../../src/domain/time";
import type { StaffPrincipal } from "../../src/worker/env";

afterEach(() => setNow(null));

const THU = "2026-10-01";
const FRI = "2026-10-02";
const at = (date: string, h: number, m = 0) => wallToUtc(date, h * 60 + m, TZ);
const TZ_LABEL = "Asia/Tokyo (GMT+9)";
const TECH_NAMES = /Tim Tech|Una Tech|Cy Tech|Dee Tech|Ada Admin/;

let team: Awaited<ReturnType<typeof seedTeam>>;
let pat: { id: number; cookie: string };
let sam: { id: number; cookie: string };
let adminCookie: string;
const admin = (): StaffPrincipal => ({ id: team.admin, email: "admin@example.test", name: "Ada Admin", role: "admin" });

beforeEach(async () => {
  setNow(at(THU, 8));
  team = await seedTeam();
  for (const [id, name] of [
    [team.admin, "Ada Admin"],
    [team.a, "Tim Tech"],
    [team.b, "Una Tech"],
    [team.c, "Cy Tech"],
    [team.d, "Dee Tech"],
  ] as const) {
    await env.DB.prepare("UPDATE staff SET name = ? WHERE id = ?").bind(name, id).run();
  }
  pat = { id: await seedCustomer({ email: "pat@example.test", name: "Pat Co" }), cookie: "" };
  sam = { id: await seedCustomer({ email: "sam@example.test", name: "Sam Co" }), cookie: "" };
  pat.cookie = await loginCustomer("pat@example.test");
  sam.cookie = await loginCustomer("sam@example.test");
  adminCookie = await loginStaff("admin@example.test");
  // Friday 10:00–13:00 with technicians a and b: 30-minute slots every 30 minutes, 10 minutes buffer after.
  await seedWeekly(5, 600, 780, [team.a, team.b]);
  await env.DB.prepare("DELETE FROM email_jobs").run();
  await env.DB.prepare("DELETE FROM dev_mailbox").run();
});

const submitRes = (who: { id: number; cookie: string }, startAt: number, extra: Record<string, unknown> = {}) =>
  api("POST", "/api/customer/reservations", {
    cookie: who.cookie,
    body: { customerId: who.id, startAt, contactName: "Pat Example", phone: "+81 3-1234-5678", issue: "Printer is offline", idempotencyKey: crypto.randomUUID(), ...extra },
  });
const submit = async (who: { id: number; cookie: string }, startAt: number, extra: Record<string, unknown> = {}) => {
  const res = await submitRes(who, startAt, extra);
  expect([res.status, res.json.error]).toEqual([201, undefined]);
  return res.json.reservation.id as string;
};
const approve = async (id: string, staffId: number, version = 1) => {
  const res = await api("POST", `/api/staff/reservations/${id}/approve`, { cookie: adminCookie, body: { staffId, version } });
  expect([res.status, res.json.error]).toEqual([200, undefined]);
  return res.json.reservation;
};
type Opt = { startAt: number; staffId: number };
const propose = async (id: string, options: Opt[], version: number) => {
  const res = await api("POST", `/api/staff/reservations/${id}/propose`, { cookie: adminCookie, body: { options, version } });
  expect([res.status, res.json.error]).toEqual([200, undefined]);
  return res.json.reservation.proposal as { id: string; expiresAt: number; options: Array<{ id: string; startAt: number; staffId: number }> };
};
const mintToken = async (reservationId: string) => {
  const token = `tok-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  await env.DB.prepare("INSERT INTO access_tokens(token_hash, reservation_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), reservationId, clock.now(), at(FRI, 23) + 14 * 86_400_000)
    .run();
  return token;
};
const acceptViaToken = (token: string, proposalId: string, optionId: string) => api("POST", "/api/access/proposal/accept", { body: { token, proposalId, optionId } });
const rejectViaToken = (token: string, proposalId: string) => api("POST", "/api/access/proposal/reject", { body: { token, proposalId } });
const acceptViaSession = (cookie: string, id: string, proposalId: string, optionId: string) =>
  api("POST", `/api/customer/reservations/${id}/proposal/accept`, { cookie, body: { proposalId, optionId } });
const rejectViaSession = (cookie: string, id: string, proposalId: string) =>
  api("POST", `/api/customer/reservations/${id}/proposal/reject`, { cookie, body: { proposalId } });

const count = async (sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;
const row = (id: string) => env.DB.prepare("SELECT * FROM reservations WHERE id = ?").bind(id).first<any>();
const proposalRow = (id: string) => env.DB.prepare("SELECT * FROM proposals WHERE id = ?").bind(id).first<any>();
const blocksOf = async (ownerId: string) =>
  (
    await env.DB.prepare("SELECT staff_id, block_start, owner_kind FROM tech_blocks WHERE owner_id = ? ORDER BY staff_id, block_start").bind(ownerId).all<{
      staff_id: number;
      block_start: number;
      owner_kind: string;
    }>()
  ).results;
const optionBlocks = () => count("SELECT COUNT(*) AS n FROM tech_blocks WHERE owner_kind = 'option'");
const jobs = async (template: string) =>
  (
    await env.DB.prepare("SELECT to_email, status, dedupe_key, payload, send_after FROM email_jobs WHERE template = ? ORDER BY to_email, dedupe_key")
      .bind(template)
      .all<{ to_email: string; status: string; dedupe_key: string; payload: string; send_after: number }>()
  ).results;
const mailsTo = async (email: string) =>
  (await env.DB.prepare("SELECT subject, text, html FROM dev_mailbox WHERE to_email = ? ORDER BY id").bind(email).all<{ subject: string; text: string; html: string }>())
    .results;
const auditOf = async (action: string) => {
  const a = await env.DB.prepare("SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC").bind(action).first<any>();
  return a ? { ...a, details: JSON.parse(a.details) } : null;
};

describe("accepting a proposed time", () => {
  it("moves a confirmed appointment to the chosen option: its blocks re-owned exactly, the rest released, reminders moved, one email", async () => {
    const id = await submit(pat, at(FRI, 10));
    await approve(id, team.a);
    const p = await propose(id, [{ startAt: at(FRI, 11), staffId: team.b }, { startAt: at(FRI, 12), staffId: team.a }], 2);
    const [chosen, other] = p.options;
    const chosenBlocks = await blocksOf(chosen!.id);
    expect(chosenBlocks).toHaveLength(8);
    // The appointment's reminders for 10:00 are queued.
    expect((await jobs("appointment_reminder")).map((j) => [j.dedupe_key, j.status])).toEqual([
      [`reminder:${id}:v2:${at(FRI, 10)}:1440`, "queued"],
      [`reminder:${id}:v2:${at(FRI, 10)}:60`, "queued"],
    ]);
    await env.DB.prepare("DELETE FROM email_jobs WHERE template <> 'appointment_reminder'").run();
    await env.DB.prepare("DELETE FROM dev_mailbox").run();

    const token = await mintToken(id);
    const res = await acceptViaToken(token, p.id, chosen!.id);
    expect(res.status).toBe(200);
    expect(res.json.reservation).toMatchObject({
      id,
      status: "confirmed",
      startAt: at(FRI, 11),
      endAt: at(FRI, 11, 30),
      version: 4,
      proposal: { id: p.id, status: "accepted" },
    });
    expect(JSON.stringify(res.json)).not.toMatch(/staff|Tim Tech|Una Tech/i);

    expect(await row(id)).toMatchObject({
      status: "confirmed",
      start_at: at(FRI, 11),
      end_at: at(FRI, 11, 30),
      occ_start: at(FRI, 11),
      occ_end: at(FRI, 11, 40),
      assigned_staff_id: team.b,
      provisional_staff_id: null,
      confirmed_at: at(THU, 8),
      confirmed_by: null,
      version: 4,
    });
    // Exactly the option's blocks now belong to the reservation; the original's and the other option's are gone.
    expect(await blocksOf(id)).toEqual(chosenBlocks.map((b) => ({ ...b, owner_kind: "reservation" })));
    expect(await blocksOf(chosen!.id)).toEqual([]);
    expect(await blocksOf(other!.id)).toEqual([]);
    expect(await optionBlocks()).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM tech_blocks")).toBe(8);
    expect(await proposalRow(p.id)).toMatchObject({ status: "accepted", resolved_at: at(THU, 8) });

    // Old reminders cancelled, new ones for 11:00 queued.
    expect((await jobs("appointment_reminder")).map((j) => [j.dedupe_key, j.status, j.send_after])).toEqual([
      [`reminder:${id}:v2:${at(FRI, 10)}:1440`, "cancelled", at(THU, 10)],
      [`reminder:${id}:v2:${at(FRI, 10)}:60`, "cancelled", at(FRI, 9)],
      [`reminder:${id}:v4:${at(FRI, 11)}:1440`, "queued", at(THU, 11)],
      [`reminder:${id}:v4:${at(FRI, 11)}:60`, "queued", at(FRI, 10)],
    ]);
    // The customer gets one rescheduled email; the team (notify staff and both technicians) the outcome.
    expect((await jobs("rescheduled")).map((j) => [j.to_email, j.dedupe_key])).toEqual([["pat@example.test", `rescheduled:${id}:v4`]]);
    expect(await jobs("confirmed")).toEqual([]);
    expect((await jobs("proposal_outcome")).map((j) => j.to_email)).toEqual([
      "admin@example.test",
      "tech-a@example.test",
      "tech-b@example.test",
      "tech-c@example.test",
      "tech-d@example.test",
    ]);

    const a = await auditOf("reservation.rescheduled");
    expect(a).toMatchObject({ actor_kind: "customer", actor: "pat@example.test", reservation_id: id, customer_id: pat.id });
    expect(a.details).toEqual({ via: "proposal", proposalId: p.id, from: { startAt: at(FRI, 10), staffId: team.a }, to: { startAt: at(FRI, 11), staffId: team.b } });

    await processOutbox(env, 50);
    const mails = await mailsTo("pat@example.test");
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toContain("Fri, Oct 2, 2026, 11:00");
    expect(mails[0]!.text).toContain(`Fri, Oct 2, 2026, 11:00 ${TZ_LABEL}`);
    expect(mails[0]!.text).toContain(`Fri, Oct 2, 2026, 10:00 ${TZ_LABEL}`);
    expect(mails[0]!.text).toMatch(/\/r#t=[A-Za-z0-9_-]+&action=ics/);
    // Same reservation, same calendar event: no need to remove an earlier entry.
    expect(mails[0]!.text).not.toContain("remove");
    expect(mails[0]!.text).not.toMatch(TECH_NAMES);
    const teamMail = (await mailsTo("tech-c@example.test"))[0]!;
    expect(teamMail.text).toContain("chose");
    expect(teamMail.text).toContain(`Fri, Oct 2, 2026, 11:00 ${TZ_LABEL}`);
    expect(teamMail.text).toContain("Una Tech");
  });

  it("confirms a pending request at the chosen time (session), pre-approved by the proposal", async () => {
    const id = await submit(pat, at(FRI, 10));
    const provisional = (await row(id)).provisional_staff_id;
    const p = await propose(id, [{ startAt: at(FRI, 12), staffId: team.b }], 1);
    await env.DB.prepare("DELETE FROM email_jobs").run();
    await env.DB.prepare("DELETE FROM dev_mailbox").run();

    const res = await acceptViaSession(pat.cookie, id, p.id, p.options[0]!.id);
    expect(res.status).toBe(200);
    expect(res.json.reservation).toMatchObject({ status: "confirmed", startAt: at(FRI, 12), version: 3 });
    expect(await row(id)).toMatchObject({ status: "confirmed", assigned_staff_id: team.b, provisional_staff_id: null, occ_start: at(FRI, 12), occ_end: at(FRI, 12, 40) });
    expect((await blocksOf(id)).every((b) => b.staff_id === team.b && b.owner_kind === "reservation")).toBe(true);
    expect(await blocksOf(id)).toHaveLength(8);
    expect(provisional).not.toBeNull();
    expect((await jobs("appointment_reminder")).map((j) => j.dedupe_key)).toEqual([`reminder:${id}:v3:${at(FRI, 12)}:1440`, `reminder:${id}:v3:${at(FRI, 12)}:60`]);
    expect((await auditOf("reservation.rescheduled")).details).toMatchObject({ from: { startAt: at(FRI, 10), staffId: null }, to: { startAt: at(FRI, 12), staffId: team.b } });
    await processOutbox(env, 50);
    const mails = await mailsTo("pat@example.test");
    expect(mails).toHaveLength(1);
    expect(mails[0]!.text).toContain("confirmed");
    expect(mails[0]!.text).not.toMatch(TECH_NAMES);
  });

  it("is proposal_closed (with the customer's current view) once the proposal is withdrawn, superseded or past its expiry", async () => {
    const id = await submit(pat, at(FRI, 10));
    await approve(id, team.a);
    const token = await mintToken(id);
    const p1 = await propose(id, [{ startAt: at(FRI, 11), staffId: team.b }], 2);
    const p2 = await propose(id, [{ startAt: at(FRI, 12), staffId: team.b }], 3);
    let res = await acceptViaToken(token, p1.id, p1.options[0]!.id);
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ error: "proposal_closed", details: { current: { id, status: "confirmed", startAt: at(FRI, 10), proposal: { id: p2.id, status: "open" } } } });
    expect(JSON.stringify(res.json)).not.toMatch(/staff|Una Tech/i);

    // Past its expiry, before the sweep has run: closed all the same, and nothing moves.
    setNow(p2.expiresAt);
    res = await acceptViaToken(token, p2.id, p2.options[0]!.id);
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("proposal_closed");
    expect(await row(id)).toMatchObject({ start_at: at(FRI, 10), version: 4 });
    expect(await optionBlocks()).toBe(8);

    setNow(at(THU, 8));
    await withdrawProposal(env, admin(), id, p2.id);
    res = await acceptViaSession(pat.cookie, id, p2.id, p2.options[0]!.id);
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ error: "proposal_closed", details: { current: { proposal: { id: p2.id, status: "withdrawn" } } } });
  });

  it("404s an unknown proposal, an option of another proposal, another account's reservation and a bad link; 400 without ids", async () => {
    const id = await submit(pat, at(FRI, 10));
    const other = await submit(sam, at(FRI, 11));
    const p = await propose(id, [{ startAt: at(FRI, 12), staffId: team.b }], 1);
    const q = await propose(other, [{ startAt: at(FRI, 12, 30), staffId: team.a }], 1);
    const token = await mintToken(id);
    expect((await acceptViaToken(token, "nope", p.options[0]!.id)).status).toBe(404);
    expect((await acceptViaToken(token, p.id, q.options[0]!.id)).status).toBe(404);
    expect((await acceptViaToken(token, q.id, q.options[0]!.id)).status).toBe(404);
    expect((await acceptViaSession(pat.cookie, other, q.id, q.options[0]!.id)).status).toBe(404);
    expect((await rejectViaSession(pat.cookie, other, q.id)).status).toBe(404);
    const bad = await acceptViaToken(`tok-${crypto.randomUUID()}-${crypto.randomUUID()}`, p.id, p.options[0]!.id);
    expect([bad.status, bad.json.error]).toEqual([404, "invalid_link"]);
    expect((await api("POST", "/api/access/proposal/accept", { body: { token, proposalId: p.id } })).status).toBe(400);
    expect((await api("POST", `/api/customer/reservations/${id}/proposal/accept`, { body: { proposalId: p.id, optionId: p.options[0]!.id } })).status).toBe(401);
    expect(await count("SELECT COUNT(*) AS n FROM proposals WHERE status = 'open'")).toBe(2);
  });

  it("a pending request needs an eligible customer and contact (403 not_eligible); a confirmed appointment does not", async () => {
    const id = await submit(pat, at(FRI, 10));
    const p = await propose(id, [{ startAt: at(FRI, 12), staffId: team.b }], 1);
    const token = await mintToken(id);
    await env.DB.prepare("UPDATE customers SET active = 0 WHERE id = ?").bind(pat.id).run();
    let res = await acceptViaToken(token, p.id, p.options[0]!.id);
    expect([res.status, res.json.error]).toEqual([403, "not_eligible"]);
    await env.DB.prepare("UPDATE customers SET active = 1 WHERE id = ?").bind(pat.id).run();
    await env.DB.prepare("UPDATE customer_contacts SET active = 0 WHERE email = 'pat@example.test'").run();
    res = await acceptViaToken(token, p.id, p.options[0]!.id);
    expect([res.status, res.json.error]).toEqual([403, "not_eligible"]);
    expect((await row(id)).status).toBe("pending");
    expect((await proposalRow(p.id)).status).toBe("open");

    // Confirmed: moving an existing appointment works whatever the eligibility.
    await env.DB.prepare("UPDATE customer_contacts SET active = 1").run();
    const conf = await submit(sam, at(FRI, 11));
    await approve(conf, team.a);
    const q = await propose(conf, [{ startAt: at(FRI, 12, 30), staffId: team.a }], 2);
    await env.DB.prepare("UPDATE customers SET active = 0 WHERE id = ?").bind(sam.id).run();
    res = await acceptViaToken(await mintToken(conf), q.id, q.options[0]!.id);
    expect(res.status).toBe(200);
    expect(res.json.reservation.startAt).toBe(at(FRI, 12, 30));
  });

  it("eligibility lost after the check aborts the batch; the retry answers not_eligible", async () => {
    const id = await submit(pat, at(FRI, 10));
    const p = await propose(id, [{ startAt: at(FRI, 12), staffId: team.b }], 1);
    const w = withBatchHook(async () => {
      await env.DB.prepare("UPDATE customers SET active = 0 WHERE id = ?").bind(pat.id).run();
    });
    await expect(acceptProposal(w.env, "pat@example.test", id, { proposalId: p.id, optionId: p.options[0]!.id })).rejects.toMatchObject({
      status: 403,
      code: "not_eligible",
    });
    expect(w.calls.batches).toBe(1);
    expect(await row(id)).toMatchObject({ status: "pending", version: 2 });
    expect((await proposalRow(p.id)).status).toBe("open");
  });

  it("racing a staff withdrawal: the withdrawal wins, the accept is proposal_closed and nothing moves", async () => {
    const id = await submit(pat, at(FRI, 10));
    await approve(id, team.a);
    const p = await propose(id, [{ startAt: at(FRI, 11), staffId: team.b }], 2);
    const original = await blocksOf(id);
    const w = withBatchHook(async () => {
      await withdrawProposal(env, admin(), id, p.id);
    });
    await expect(acceptProposal(w.env, "pat@example.test", id, { proposalId: p.id, optionId: p.options[0]!.id })).rejects.toMatchObject({
      status: 409,
      code: "proposal_closed",
      details: { current: { status: "confirmed", startAt: at(FRI, 10), proposal: { status: "withdrawn" } } },
    });
    // The first batch failed its guard; the retry stopped at its own check.
    expect(w.calls.batches).toBe(1);
    expect(await blocksOf(id)).toEqual(original);
    expect(await optionBlocks()).toBe(0);
    expect(await row(id)).toMatchObject({ start_at: at(FRI, 10), assigned_staff_id: team.a, version: 3 });
    expect(await jobs("rescheduled")).toEqual([]);
  });

  it("racing a cancellation: the cancellation wins, the accept is proposal_closed", async () => {
    const id = await submit(pat, at(FRI, 10));
    await approve(id, team.a);
    const p = await propose(id, [{ startAt: at(FRI, 11), staffId: team.b }], 2);
    const w = withBatchHook(async () => {
      await cancelReservation(env, { kind: "staff", staff: admin() }, id, { reason: "Office closed", version: 3 });
    });
    await expect(acceptProposal(w.env, "pat@example.test", id, { proposalId: p.id, optionId: p.options[0]!.id })).rejects.toMatchObject({
      status: 409,
      code: "proposal_closed",
      details: { current: { status: "cancelled" } },
    });
    expect(await count("SELECT COUNT(*) AS n FROM tech_blocks")).toBe(0);
    expect((await row(id)).status).toBe("cancelled");
  });

  it("accepting first: a racing withdrawal is proposal_closed", async () => {
    const id = await submit(pat, at(FRI, 10));
    const p = await propose(id, [{ startAt: at(FRI, 11), staffId: team.b }], 1);
    const w = withBatchHook(async () => {
      await acceptProposal(env, "pat@example.test", id, { proposalId: p.id, optionId: p.options[0]!.id });
    });
    await expect(withdrawProposal(w.env, admin(), id, p.id)).rejects.toMatchObject({ status: 409, code: "proposal_closed" });
    expect(await row(id)).toMatchObject({ status: "confirmed", start_at: at(FRI, 11) });
    expect((await proposalRow(p.id)).status).toBe("accepted");
  });
});

describe("keeping the original time", () => {
  it("rejects the proposal: options released, original untouched, customer and team told", async () => {
    const id = await submit(pat, at(FRI, 10));
    await approve(id, team.a);
    const p = await propose(id, [{ startAt: at(FRI, 11), staffId: team.b }, { startAt: at(FRI, 12), staffId: team.b }], 2);
    const original = await blocksOf(id);
    await env.DB.prepare("DELETE FROM email_jobs").run();
    await env.DB.prepare("DELETE FROM dev_mailbox").run();

    const res = await rejectViaToken(await mintToken(id), p.id);
    expect(res.status).toBe(200);
    expect(res.json.reservation).toMatchObject({ status: "confirmed", startAt: at(FRI, 10), version: 3, proposal: { id: p.id, status: "rejected" } });
    expect(await proposalRow(p.id)).toMatchObject({ status: "rejected", resolved_at: at(THU, 8) });
    expect(await optionBlocks()).toBe(0);
    expect(await blocksOf(id)).toEqual(original);
    expect(await row(id)).toMatchObject({ status: "confirmed", version: 3, assigned_staff_id: team.a });
    const a = await auditOf("reservation.proposal_rejected");
    expect(a).toMatchObject({ actor_kind: "customer", actor: "pat@example.test", reservation_id: id });
    expect(a.details).toEqual({ proposalId: p.id, via: "keep" });

    expect((await jobs("proposal_outcome")).map((j) => j.to_email)).toEqual([
      "admin@example.test",
      "pat@example.test",
      "tech-a@example.test",
      "tech-b@example.test",
      "tech-c@example.test",
      "tech-d@example.test",
    ]);
    await processOutbox(env, 50);
    const mine = await mailsTo("pat@example.test");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain("keep your original time");
    expect(mine[0]!.text).toContain(`Fri, Oct 2, 2026, 10:00 ${TZ_LABEL}`);
    expect(mine[0]!.text).not.toMatch(TECH_NAMES);
    expect((await mailsTo("tech-c@example.test"))[0]!.text).toContain("customer kept the original time");

    const again = await rejectViaToken(await mintToken(id), p.id);
    expect([again.status, again.json.error]).toEqual([409, "proposal_closed"]);
  });

  it("a pending request may keep its requested time too (session)", async () => {
    const id = await submit(pat, at(FRI, 10));
    const p = await propose(id, [{ startAt: at(FRI, 12), staffId: team.b }], 1);
    await env.DB.prepare("DELETE FROM email_jobs").run();
    const res = await rejectViaSession(pat.cookie, id, p.id);
    expect(res.status).toBe(200);
    expect(res.json.reservation).toMatchObject({ status: "pending", proposal: { status: "rejected" } });
    await processOutbox(env, 50);
    expect((await mailsTo("pat@example.test")).at(-1)!.text).toContain("still pending review");
  });
});

describe("choosing another time: replacement requests", () => {
  it("creates a pending replacement outside the per-account limit and rejects the open proposal in the same batch", async () => {
    const id = await submit(pat, at(FRI, 10));
    await approve(id, team.a);
    const p = await propose(id, [{ startAt: at(FRI, 11), staffId: team.b }], 2);
    await env.DB.prepare("DELETE FROM email_jobs").run();
    await env.DB.prepare("DELETE FROM dev_mailbox").run();
    const originalBlocks = await blocksOf(id);

    // The limit (1 active per account) is already reached by the original.
    expect((await submitRes(pat, at(FRI, 12))).json.error).toBe("limit_reached");
    const w = withBatchHook(async () => {});
    const result = await submitReservation(w.env, "pat@example.test", {
      customerId: pat.id,
      startAt: at(FRI, 12),
      contactName: "Pat Example",
      phone: "+81 3-1234-5678",
      issue: "Printer is offline",
      idempotencyKey: crypto.randomUUID(),
      replacesId: id,
    });
    expect(w.calls.batches).toBe(1);
    expect(result).toMatchObject({ status: "pending", startAt: at(FRI, 12), created: true });
    expect(await row(result.id)).toMatchObject({ status: "pending", replaces_id: id });
    // The original stays as it is, holding its time; the proposal is rejected and its holds freed.
    expect(await row(id)).toMatchObject({ status: "confirmed", version: 3 });
    expect(await blocksOf(id)).toEqual(originalBlocks);
    expect(await proposalRow(p.id)).toMatchObject({ status: "rejected", resolved_at: at(THU, 8) });
    expect(await optionBlocks()).toBe(0);
    expect((await auditOf("reservation.proposal_rejected")).details).toEqual({ proposalId: p.id, via: "replacement", replacementId: result.id });
    // The team hears that the held times were released (no answer email to the customer: the request-received covers it).
    expect((await jobs("proposal_outcome")).map((j) => [j.to_email, JSON.parse(j.payload).via])).toEqual([
      ["admin@example.test", "replacement"],
      ["tech-a@example.test", "replacement"],
      ["tech-b@example.test", "replacement"],
      ["tech-c@example.test", "replacement"],
      ["tech-d@example.test", "replacement"],
    ]);
    expect((await auditOf("reservation.requested")).details).toMatchObject({ replacesId: id });

    await processOutbox(env, 50);
    const mine = await mailsTo("pat@example.test");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain("stays as it is until the new time is confirmed");
    const ref = (await row(id)).ref as string;
    expect(mine[0]!.text).toContain(ref);
    const adminMails = await mailsTo("admin@example.test");
    expect(adminMails.find((m) => m.subject.includes("asked for another time"))!.text).toContain("proposed times have been released");
    expect(adminMails.find((m) => m.subject.includes("New remote support request"))!.text).toContain(`Replaces: ${ref}`);
  });

  it("may take a time only the original's own proposal was holding (released in the same batch)", async () => {
    const id = await submit(pat, at(FRI, 10));
    await approve(id, team.a);
    const p = await propose(id, [{ startAt: at(FRI, 11), staffId: team.b }], 2);
    const sams = await submit(sam, at(FRI, 11));
    await approve(sams, team.a);
    // 11:00 is full for everyone else: a has sam, b has pat's option.
    expect((await submitRes(sam, at(FRI, 11))).json.error).toBe("limit_reached");
    const lee = { id: await seedCustomer({ email: "lee@example.test", name: "Lee Co" }), cookie: await loginCustomer("lee@example.test") };
    expect((await submitRes(lee, at(FRI, 11))).json.error).toBe("slot_unavailable");
    const replacement = await submit(pat, at(FRI, 11), { replacesId: id });
    expect(await row(replacement)).toMatchObject({ status: "pending", provisional_staff_id: team.b });
    expect((await proposalRow(p.id)).status).toBe("rejected");
  });

  it("through the API: one active replacement per original (replacement_exists), only for the caller's active reservations", async () => {
    const id = await submit(pat, at(FRI, 10));
    await approve(id, team.a);
    const first = await submit(pat, at(FRI, 11), { replacesId: id });
    let res = await submitRes(pat, at(FRI, 12), { replacesId: id });
    expect([res.status, res.json.error]).toEqual([409, "replacement_exists"]);

    // Once that one is declined, another may be requested.
    expect((await api("POST", `/api/staff/reservations/${first}/decline`, { cookie: adminCookie, body: { reason: "Fully booked", version: 1 } })).status).toBe(200);
    await submit(pat, at(FRI, 12), { replacesId: id });

    const sams = await submit(sam, at(FRI, 10, 30));
    res = await submitRes(pat, at(FRI, 12, 30), { replacesId: sams });
    expect([res.status, res.json.error]).toEqual([404, "not_found"]);
    res = await submitRes(pat, at(FRI, 12, 30), { replacesId: "nope" });
    expect([res.status, res.json.error]).toEqual([404, "not_found"]);

    await cancelReservation(env, { kind: "staff", staff: admin() }, sams, { reason: "x", version: 1 });
    res = await submitRes(sam, at(FRI, 12, 30), { replacesId: sams });
    expect([res.status, res.json.error]).toEqual([409, "original_not_active"]);

    // Nor once the original has started (Friday 10:00).
    setNow(at(FRI, 10, 5));
    await expect(
      submitReservation(env, "pat@example.test", {
        customerId: pat.id,
        startAt: at(FRI, 12, 30),
        contactName: "Pat Example",
        phone: "+81 3-1234-5678",
        issue: "Printer is offline",
        idempotencyKey: crypto.randomUUID(),
        replacesId: id,
      }),
    ).rejects.toMatchObject({ status: 409, code: "original_not_active" });
  });

  describe("approving the replacement", () => {
    it("cancels the original in the same batch: one rescheduled email to the customer, the team told what it replaces", async () => {
      const id = await submit(pat, at(FRI, 10));
      await approve(id, team.a);
      const ref = (await row(id)).ref as string;
      const replacement = await submit(pat, at(FRI, 10, 30), { replacesId: id });
      // The original holds a until 10:40, so the replacement waits on b.
      expect((await row(replacement)).provisional_staff_id).toBe(team.b);
      await env.DB.prepare("DELETE FROM email_jobs WHERE template <> 'appointment_reminder'").run();
      await env.DB.prepare("DELETE FROM dev_mailbox").run();

      // Approving it with a works: the original's hold is released in the same batch (the options say so too).
      const options = (await api("GET", `/api/staff/reservations/${replacement}`, { cookie: adminCookie })).json.techOptions;
      expect(options.find((o: any) => o.id === team.a)).toMatchObject({ assignable: true });
      const w = withBatchHook(async () => {});
      const r = await approveReservation(w.env, admin(), replacement, team.a, 1);
      expect(w.calls.batches).toBe(1);
      expect(r).toMatchObject({ status: "confirmed", assignedStaff: { id: team.a }, startAt: at(FRI, 10, 30) });
      expect(await row(id)).toMatchObject({ status: "cancelled", close_reason: "rescheduled", closed_by_kind: "staff", closed_by: String(team.admin), version: 3 });
      expect(await blocksOf(id)).toEqual([]);
      expect((await blocksOf(replacement)).every((b) => b.staff_id === team.a)).toBe(true);
      expect(await blocksOf(replacement)).toHaveLength(8);

      expect((await jobs("appointment_reminder")).map((j) => [j.dedupe_key, j.status]).sort((x, y) => x[1]!.localeCompare(y[1]!) || x[0]!.localeCompare(y[0]!))).toEqual([
        [`reminder:${id}:v2:${at(FRI, 10)}:1440`, "cancelled"],
        [`reminder:${id}:v2:${at(FRI, 10)}:60`, "cancelled"],
        [`reminder:${replacement}:v2:${at(FRI, 10, 30)}:1440`, "queued"],
        [`reminder:${replacement}:v2:${at(FRI, 10, 30)}:60`, "queued"],
      ]);
      const customerJobs = (await env.DB.prepare("SELECT template FROM email_jobs WHERE to_email = 'pat@example.test' AND template <> 'appointment_reminder'").all<any>()).results;
      expect(customerJobs.map((j) => j.template)).toEqual(["rescheduled"]);
      expect((await jobs("assigned")).map((j) => j.to_email)).toEqual(["tech-a@example.test", "tech-b@example.test", "tech-c@example.test", "tech-d@example.test"]);
      expect(await jobs("cancelled")).toEqual([]);

      expect((await auditOf("reservation.approved")).details).toEqual({ assignedStaffId: team.a, replacesId: id, originalCancelled: true });
      const c = await auditOf("reservation.cancelled");
      expect(c).toMatchObject({ actor_kind: "staff", actor: String(team.admin), reservation_id: id });
      expect(c.details).toEqual({ reason: "rescheduled", from: "confirmed", replacedBy: replacement });

      await processOutbox(env, 50);
      const mine = await mailsTo("pat@example.test");
      expect(mine).toHaveLength(1);
      expect(mine[0]!.text).toContain(`Fri, Oct 2, 2026, 10:30 ${TZ_LABEL}`);
      expect(mine[0]!.text).toContain(ref);
      expect(mine[0]!.text).toMatch(/&action=ics/);
      // A new reservation is a new calendar event: the old one has to go by hand.
      expect(mine[0]!.text).toContain("If you added your earlier time to your calendar, please remove it");
      expect(mine[0]!.text).not.toMatch(TECH_NAMES);
      const teamMail = (await mailsTo("tech-c@example.test"))[0]!;
      expect(teamMail.text).toContain(`Replaces ${ref}`);
    });

    it("approves normally when the original is no longer active, and says so", async () => {
      const id = await submit(pat, at(FRI, 10));
      await approve(id, team.a);
      const ref = (await row(id)).ref as string;
      const replacement = await submit(pat, at(FRI, 11), { replacesId: id });
      await env.DB.prepare("DELETE FROM email_jobs").run();
      await env.DB.prepare("DELETE FROM dev_mailbox").run();

      // The original has started: it is left as it is.
      setNow(at(FRI, 10, 5));
      await approve(replacement, team.b);
      expect(await row(id)).toMatchObject({ status: "confirmed", close_reason: null });
      expect((await jobs("confirmed")).map((j) => j.to_email)).toEqual(["pat@example.test"]);
      expect(await jobs("rescheduled")).toEqual([]);
      expect((await auditOf("reservation.approved")).details).toEqual({ assignedStaffId: team.b, replacesId: id, originalCancelled: false });
      await processOutbox(env, 50);
      expect((await mailsTo("tech-c@example.test"))[0]!.text).toContain(`${ref}, which was left as it is`);
    });

    it("an original cancelled while the approval is in flight takes its change request with it: the approval is stale", async () => {
      const id = await submit(pat, at(FRI, 10));
      await approve(id, team.a);
      const replacement = await submit(pat, at(FRI, 11), { replacesId: id });
      await env.DB.prepare("DELETE FROM email_jobs").run();
      const w = withBatchHook(async () => {
        await cancelReservation(env, { kind: "customer", email: "pat@example.test" }, id, { version: 2 });
      });
      await expect(approveReservation(w.env, admin(), replacement, team.b, 1)).rejects.toMatchObject({ status: 409, code: "stale" });
      expect(await row(id)).toMatchObject({ status: "cancelled", closed_by_kind: "customer" });
      expect(await row(replacement)).toMatchObject({ status: "cancelled", close_reason: "original_cancelled" });
      expect(await jobs("confirmed")).toEqual([]);
      expect((await jobs("cancelled")).map((j) => j.to_email)).toContain("pat@example.test");
    });

    it("cancels a pending original too", async () => {
      const id = await submit(pat, at(FRI, 10));
      const replacement = await submit(pat, at(FRI, 12), { replacesId: id });
      await approve(replacement, team.b);
      expect(await row(id)).toMatchObject({ status: "cancelled", close_reason: "rescheduled", provisional_staff_id: null });
      expect(await blocksOf(id)).toEqual([]);
    });
  });

  it("declining the replacement leaves the original as it is and tells the customer so", async () => {
    const id = await submit(pat, at(FRI, 10));
    await approve(id, team.a);
    const original = await blocksOf(id);
    const replacement = await submit(pat, at(FRI, 11), { replacesId: id });
    await env.DB.prepare("DELETE FROM dev_mailbox").run();
    expect((await api("POST", `/api/staff/reservations/${replacement}/decline`, { cookie: adminCookie, body: { reason: "Fully booked", version: 1 } })).status).toBe(200);
    expect(await row(id)).toMatchObject({ status: "confirmed", version: 2 });
    expect(await blocksOf(id)).toEqual(original);
    await processOutbox(env, 50);
    const mine = await mailsTo("pat@example.test");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain("Your original appointment stays as it is.");
  });

  it("an expired replacement whose original is gone does not claim the original stays", async () => {
    const id = await submit(pat, at(FRI, 10));
    const replacement = await submit(pat, at(FRI, 11), { replacesId: id });
    expect((await api("POST", `/api/staff/reservations/${id}/decline`, { cookie: adminCookie, body: { reason: "Fully booked", version: 1 } })).status).toBe(200);
    await processOutbox(env, 50);
    await env.DB.prepare("DELETE FROM dev_mailbox").run();
    setNow(at(THU, 17));
    await runSweeps(env, at(THU, 17));
    expect((await row(replacement)).status).toBe("expired");
    await processOutbox(env, 50);
    const mine = await mailsTo("pat@example.test");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).not.toContain("stays as it is");
  });
});

describe("an original with a pending change request", () => {
  const cancelledJobs = async () =>
    (await env.DB.prepare("SELECT to_email, reservation_id, payload FROM email_jobs WHERE template = 'cancelled' ORDER BY to_email").all<{ to_email: string; reservation_id: string; payload: string }>())
      .results;

  it("the customer cancelling the original cancels the change request in the same batch, with one email covering both", async () => {
    const id = await submit(pat, at(FRI, 10));
    await approve(id, team.a);
    const ref = (await row(id)).ref as string;
    const replacement = await submit(pat, at(FRI, 11), { replacesId: id });
    const rRef = (await row(replacement)).ref as string;
    expect(await blocksOf(replacement)).not.toEqual([]);
    await env.DB.prepare("DELETE FROM dev_mailbox").run();
    await env.DB.prepare("UPDATE email_jobs SET status = 'queued' WHERE reservation_id = ?").bind(replacement).run();

    const w = withBatchHook(async () => {});
    const c = await cancelReservation(w.env, { kind: "customer", email: "pat@example.test" }, id, { version: 2 });
    expect(w.calls.batches).toBe(1);
    expect(c.status).toBe("cancelled");
    expect(await row(replacement)).toMatchObject({
      status: "cancelled",
      close_reason: "original_cancelled",
      closed_by_kind: "customer",
      closed_by: "pat@example.test",
      provisional_staff_id: null,
      version: 2,
    });
    expect(await blocksOf(replacement)).toEqual([]);
    expect(await blocksOf(id)).toEqual([]);
    // The change request's own queued mail is obsolete; it gets no cancellation email of its own.
    expect(await count("SELECT COUNT(*) AS n FROM email_jobs WHERE reservation_id = ? AND status = 'queued'", replacement)).toBe(0);
    const cancelled = await cancelledJobs();
    expect(cancelled.every((j) => j.reservation_id === id)).toBe(true);
    expect(cancelled.filter((j) => j.to_email === "pat@example.test")).toHaveLength(1);
    expect(cancelled.every((j) => JSON.parse(j.payload).alsoCancelledRef === rRef)).toBe(true);
    const a = await env.DB.prepare("SELECT * FROM audit_log WHERE action = 'reservation.cancelled' AND reservation_id = ?").bind(replacement).first<any>();
    expect(a).toMatchObject({ actor_kind: "customer", actor: "pat@example.test" });
    expect(JSON.parse(a.details)).toEqual({ reason: "original_cancelled", from: "pending", original: id });

    await processOutbox(env, 50);
    const mine = await mailsTo("pat@example.test");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.subject).toContain(ref);
    expect(mine[0]!.text).toContain(`Your change request ${rRef} has been cancelled too.`);
    const teamMail = (await mailsTo("admin@example.test")).find((m) => m.subject.startsWith(`${ref} cancelled`))!;
    expect(teamMail.text).toContain(`Its pending change request ${rRef} was cancelled with it.`);

    // The customer's views: the original no longer points at a change, the request says why it closed.
    const views = (await api("GET", "/api/customer/reservations", { cookie: pat.cookie })).json.reservations as any[];
    expect(views.find((v) => v.id === id)).toMatchObject({ status: "cancelled", replacedByRef: null });
    expect(views.find((v) => v.id === replacement)).toMatchObject({ status: "cancelled", closeReason: "original_cancelled" });
  });

  it("staff cancelling a pending original do the same, and a retry of that cancel is unchanged", async () => {
    const id = await submit(pat, at(FRI, 10));
    const replacement = await submit(pat, at(FRI, 12), { replacesId: id });
    const rRef = (await row(replacement)).ref as string;
    await env.DB.prepare("DELETE FROM email_jobs").run();
    const res = await api("POST", `/api/staff/reservations/${id}/cancel`, { cookie: adminCookie, body: { reason: "Solved by phone", version: 1 } });
    expect([res.status, res.json.error]).toEqual([200, undefined]);
    expect(await row(replacement)).toMatchObject({ status: "cancelled", close_reason: "original_cancelled", closed_by_kind: "staff", closed_by: String(team.admin) });
    expect(await count("SELECT COUNT(*) AS n FROM tech_blocks")).toBe(0);
    const jobsNow = await cancelledJobs();
    expect(jobsNow.every((j) => j.reservation_id === id)).toBe(true);
    expect(jobsNow.filter((j) => j.to_email === "pat@example.test").map((j) => JSON.parse(j.payload))).toEqual([{ audience: "customer", alsoCancelledRef: rRef }]);
    const again = await api("POST", `/api/staff/reservations/${id}/cancel`, { cookie: adminCookie, body: { reason: "Solved by phone", version: 1 } });
    expect(again.status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM email_jobs WHERE template = 'cancelled'")).toBe(jobsNow.length);
  });

  it("a change request made while the cancel is in flight is caught: the retry cancels it too", async () => {
    const id = await submit(pat, at(FRI, 10));
    await approve(id, team.a);
    let replacement = "";
    const w = withBatchHook(async () => {
      if (replacement === "") replacement = await submit(pat, at(FRI, 11), { replacesId: id });
    });
    await cancelReservation(w.env, { kind: "customer", email: "pat@example.test" }, id, { version: 2 });
    expect(w.calls.batches).toBe(2);
    expect(await row(replacement)).toMatchObject({ status: "cancelled", close_reason: "original_cancelled" });
  });

  it("a pending original expiring leaves the change request pending; its email offers no rebooking while that request waits", async () => {
    const id = await submit(pat, at(FRI, 10));
    const ref = (await row(id)).ref as string;
    const replacement = await submit(pat, at(FRI, 12), { replacesId: id });
    const rRef = (await row(replacement)).ref as string;
    await env.DB.prepare("UPDATE reservations SET expires_at = ? WHERE id = ?").bind(at(THU, 9), id).run();
    await env.DB.prepare("DELETE FROM dev_mailbox").run();
    setNow(at(THU, 9));
    expect((await runSweeps(env, at(THU, 9))).counts.expiry).toBe(1);
    expect((await row(id)).status).toBe("expired");
    expect((await row(replacement)).status).toBe("pending");
    await processOutbox(env, 50);
    const mine = (await mailsTo("pat@example.test")).find((m) => m.subject.includes(`in time (${ref})`))!;
    expect(mine.text).toContain(`Your change request ${rRef} is still waiting for our team's review`);
    expect(mine.text).not.toContain("Choose another time");
    const teamMail = (await mailsTo("admin@example.test")).find((m) => m.subject.startsWith(`${ref} expired`))!;
    expect(teamMail.text).toContain(`Its change request ${rRef} is still pending`);
  });
});

describe("staff decisions withdraw an open proposal (ruling)", () => {
  it("approve: withdrawn in the same batch, its options don't stand in the way, nothing extra to the customer", async () => {
    // Pat's request at 10:00 is provisionally on a; an option on b at 10:30 overlaps it.
    const id = await submit(pat, at(FRI, 10));
    const p = await propose(id, [{ startAt: at(FRI, 10, 30), staffId: team.b }], 1);
    await env.DB.prepare("UPDATE email_jobs SET status = 'queued' WHERE dedupe_key = ?").bind(`proposal:${p.id}`).run();
    await env.DB.prepare("DELETE FROM email_jobs WHERE dedupe_key <> ?").bind(`proposal:${p.id}`).run();
    const r = await approve(id, team.b, 2);
    expect(r).toMatchObject({ status: "confirmed", proposal: { id: p.id, status: "withdrawn" } });
    expect(await optionBlocks()).toBe(0);
    expect((await blocksOf(id)).every((b) => b.staff_id === team.b)).toBe(true);
    expect((await env.DB.prepare("SELECT status FROM email_jobs WHERE dedupe_key = ?").bind(`proposal:${p.id}`).first<any>()).status).toBe("cancelled");
    expect(await jobs("proposal_outcome")).toEqual([]);
  });

  it("decline: withdrawn, every hold released", async () => {
    const id = await submit(pat, at(FRI, 10));
    const p = await propose(id, [{ startAt: at(FRI, 12), staffId: team.b }], 1);
    const res = await api("POST", `/api/staff/reservations/${id}/decline`, { cookie: adminCookie, body: { reason: "No", version: 2 } });
    expect(res.status).toBe(200);
    expect(await proposalRow(p.id)).toMatchObject({ status: "withdrawn" });
    expect(await count("SELECT COUNT(*) AS n FROM tech_blocks")).toBe(0);
    expect(await jobs("proposal_outcome")).toEqual([]);
  });

  it("reassign: withdrawn, and the new technician may be one an option was holding", async () => {
    const id = await submit(pat, at(FRI, 10));
    await approve(id, team.a);
    const p = await propose(id, [{ startAt: at(FRI, 10, 30), staffId: team.b }], 2);
    const res = await api("POST", `/api/staff/reservations/${id}/reassign`, { cookie: adminCookie, body: { staffId: team.b, version: 3 } });
    expect([res.status, res.json.error]).toEqual([200, undefined]);
    expect(await proposalRow(p.id)).toMatchObject({ status: "withdrawn" });
    expect(await optionBlocks()).toBe(0);
    expect((await row(id)).assigned_staff_id).toBe(team.b);
    // The time is unchanged, so the customer is told the proposed times were withdrawn.
    expect((await jobs("proposal_outcome")).map((j) => [j.to_email, j.dedupe_key])).toEqual([["pat@example.test", `proposal-outcome:${p.id}`]]);
    await processOutbox(env, 50);
    expect((await mailsTo("pat@example.test")).at(-1)!.text).toContain("Your original appointment stands");
  });
});

describe("proposal expiry sweep", () => {
  it("expires a due proposal: options released, the original unchanged, customer and team told; idempotent", async () => {
    const id = await submit(pat, at(FRI, 10));
    await approve(id, team.a);
    const p = await propose(id, [{ startAt: at(FRI, 11), staffId: team.b }], 2);
    expect(p.expiresAt).toBe(at(FRI, 8));
    await env.DB.prepare("DELETE FROM email_jobs").run();
    await env.DB.prepare("DELETE FROM dev_mailbox").run();

    setNow(at(FRI, 8) - 60_000);
    expect((await runSweeps(env, at(FRI, 8) - 60_000)).counts.proposals).toBe(0);
    setNow(at(FRI, 8));
    const r = await runSweeps(env, at(FRI, 8));
    expect(r.counts.proposals).toBe(1);
    expect(r.failed).toEqual([]);
    expect(await proposalRow(p.id)).toMatchObject({ status: "expired", resolved_at: at(FRI, 8) });
    expect(await optionBlocks()).toBe(0);
    expect(await row(id)).toMatchObject({ status: "confirmed", version: 3, start_at: at(FRI, 10) });
    expect(await blocksOf(id)).toHaveLength(8);
    const a = await auditOf("reservation.proposal_expired");
    expect(a).toMatchObject({ actor_kind: "system", reservation_id: id });
    expect(a.details).toEqual({ proposalId: p.id });
    expect((await jobs("proposal_outcome")).map((j) => j.to_email)).toEqual([
      "admin@example.test",
      "pat@example.test",
      "tech-a@example.test",
      "tech-b@example.test",
      "tech-c@example.test",
      "tech-d@example.test",
    ]);
    expect((await runSweeps(env, at(FRI, 8))).counts.proposals).toBe(0);

    await processOutbox(env, 50);
    const mine = await mailsTo("pat@example.test");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain("Your original appointment stays as it is");
    expect(mine[0]!.text).not.toMatch(TECH_NAMES);
    expect((await mailsTo("tech-c@example.test"))[0]!.text).toContain("didn't answer");
  });

  it("a pending request outliving its proposal stays pending", async () => {
    await env.DB.prepare("INSERT INTO settings(key, value) VALUES ('proposalExpiryBh', '2')").run();
    const id = await submit(pat, at(FRI, 10));
    const p = await propose(id, [{ startAt: at(FRI, 12), staffId: team.b }], 1);
    expect(p.expiresAt).toBe(at(THU, 11));
    setNow(at(THU, 11));
    expect((await runSweeps(env, at(THU, 11))).counts).toMatchObject({ proposals: 1, expiry: 0 });
    expect((await row(id)).status).toBe("pending");
    await processOutbox(env, 50);
    expect((await mailsTo("pat@example.test")).at(-1)!.text).toContain("still pending review");
  });

  it("a pending request expiring with its proposal expires first (the request's expiry withdraws the proposal)", async () => {
    const id = await submit(pat, at(FRI, 10));
    const p = await propose(id, [{ startAt: at(FRI, 11), staffId: team.b }], 1);
    setNow(at(FRI, 8));
    expect((await runSweeps(env, at(FRI, 8))).counts).toMatchObject({ expiry: 1, proposals: 0 });
    expect((await row(id)).status).toBe("expired");
    expect((await proposalRow(p.id)).status).toBe("withdrawn");
  });

  describe("stale proposal expiries are closed silently", () => {
    const outcomeJobs = () => count("SELECT COUNT(*) AS n FROM email_jobs WHERE template = 'proposal_outcome'");

    it("every offered time already past: options released, nobody emailed, audited as silent", async () => {
      const id = await submit(pat, at(FRI, 10));
      await approve(id, team.a);
      const p = await propose(id, [{ startAt: at(FRI, 11), staffId: team.b }], 2);
      await env.DB.prepare("DELETE FROM email_jobs").run();
      // The cron was down from before the proposal's expiry until after its only option's time.
      setNow(at(FRI, 11, 5));
      expect((await runSweeps(env, at(FRI, 11, 5))).counts.proposals).toBe(1);
      expect(await proposalRow(p.id)).toMatchObject({ status: "expired", resolved_at: at(FRI, 11, 5) });
      expect(await optionBlocks()).toBe(0);
      expect(await outcomeJobs()).toBe(0);
      expect((await auditOf("reservation.proposal_expired")).details).toEqual({ proposalId: p.id, silent: true });
    });

    it("more than 24 hours past its expiry: closed without email, though its times are still to come", async () => {
      await env.DB.prepare("INSERT INTO settings(key, value) VALUES ('proposalExpiryBh', '2')").run();
      const id = await submit(pat, at(FRI, 10));
      const p = await propose(id, [{ startAt: at(FRI, 12), staffId: team.b }], 1);
      await env.DB.prepare("DELETE FROM email_jobs").run();
      await env.DB.prepare("UPDATE proposals SET expires_at = ? WHERE id = ?").bind(at(THU, 8) - 86_400_000 - 60_000, p.id).run();
      expect((await runSweeps(env, at(THU, 8))).counts.proposals).toBe(1);
      expect((await proposalRow(p.id)).status).toBe("expired");
      expect((await row(id)).status).toBe("pending");
      expect(await outcomeJobs()).toBe(0);
      expect((await auditOf("reservation.proposal_expired")).details).toEqual({ proposalId: p.id, silent: true });
    });
  });

  it("a proposal answered while the sweep is in flight is left alone", async () => {
    await env.DB.prepare("INSERT INTO settings(key, value) VALUES ('proposalExpiryBh', '2')").run();
    const id = await submit(pat, at(FRI, 10));
    const p = await propose(id, [{ startAt: at(FRI, 12), staffId: team.b }], 1);
    const w = withBatchHook(async () => {
      setNow(at(THU, 10));
      await rejectProposal(env, "pat@example.test", id, { proposalId: p.id });
      setNow(at(THU, 11));
    });
    setNow(at(THU, 11));
    expect(await expireProposals(w.env, at(THU, 11))).toBe(0);
    expect(w.calls.batches).toBe(1);
    expect((await proposalRow(p.id)).status).toBe("rejected");
    expect(await count("SELECT COUNT(*) AS n FROM email_jobs WHERE template = 'proposal_outcome' AND payload LIKE '%expired%'")).toBe(0);
  });
});

it("has the indexes serving the open-proposal scans", async () => {
  const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_options_occ', 'idx_proposals_open') ORDER BY name").all<{ name: string }>();
  expect(results.map((r) => r.name)).toEqual(["idx_options_occ", "idx_proposals_open"]);
});

describe("fix round 1", () => {
  const setSetting = (key: string, value: unknown) =>
    env.DB.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)").bind(key, JSON.stringify(value)).run();

  it("accepting a proposal on a pending replacement approves it: its original is cancelled in the same batch, one email", async () => {
    const id = await submit(pat, at(FRI, 10));
    await approve(id, team.a);
    const ref = (await row(id)).ref as string;
    const replacement = await submit(pat, at(FRI, 11), { replacesId: id });
    const p = await propose(replacement, [{ startAt: at(FRI, 12), staffId: team.b }], 1);
    await env.DB.prepare("DELETE FROM email_jobs WHERE template <> 'appointment_reminder'").run();
    await env.DB.prepare("DELETE FROM dev_mailbox").run();

    const w = withBatchHook(async () => {});
    const r = await acceptProposal(w.env, "pat@example.test", replacement, { proposalId: p.id, optionId: p.options[0]!.id });
    expect(w.calls.batches).toBe(1);
    expect(r).toMatchObject({ status: "confirmed", startAt: at(FRI, 12) });
    expect(await row(id)).toMatchObject({ status: "cancelled", close_reason: "rescheduled", closed_by_kind: "customer", closed_by: "pat@example.test" });
    expect(await blocksOf(id)).toEqual([]);
    expect((await jobs("appointment_reminder")).filter((j) => j.dedupe_key.startsWith(`reminder:${id}:`)).map((j) => j.status)).toEqual(["cancelled", "cancelled"]);
    const customerJobs = (await env.DB.prepare("SELECT template, payload FROM email_jobs WHERE to_email = 'pat@example.test' AND template <> 'appointment_reminder'").all<any>()).results;
    expect(customerJobs.map((j) => [j.template, JSON.parse(j.payload).via])).toEqual([["rescheduled", "replacement"]]);
    expect(await jobs("cancelled")).toEqual([]);
    const c = await auditOf("reservation.cancelled");
    expect(c).toMatchObject({ actor_kind: "customer", actor: "pat@example.test", reservation_id: id });
    expect(c.details).toEqual({ reason: "rescheduled", from: "confirmed", replacedBy: replacement });
    expect((await auditOf("reservation.rescheduled")).details).toMatchObject({ replacesId: id });

    await processOutbox(env, 50);
    const mine = await mailsTo("pat@example.test");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain(`Previous time: Fri, Oct 2, 2026, 10:00 ${TZ_LABEL}`);
    expect(mine[0]!.text).toContain(`New time: Fri, Oct 2, 2026, 12:00 ${TZ_LABEL}`);
    expect(mine[0]!.text).toContain(ref);
    expect(mine[0]!.text).not.toMatch(TECH_NAMES);
    expect((await mailsTo("tech-a@example.test"))[0]!.text).toContain(`Replaces ${ref}, which has been cancelled.`);
  });

  it("an appointment moved away and back gets reminders for its start again", async () => {
    const id = await submit(pat, at(FRI, 10));
    await approve(id, team.a);
    const token = await mintToken(id);
    const p1 = await propose(id, [{ startAt: at(FRI, 11), staffId: team.b }], 2);
    expect((await acceptViaToken(token, p1.id, p1.options[0]!.id)).status).toBe(200);
    const p2 = await propose(id, [{ startAt: at(FRI, 10), staffId: team.a }], 4);
    expect((await acceptViaToken(token, p2.id, p2.options[0]!.id)).status).toBe(200);
    expect(await row(id)).toMatchObject({ start_at: at(FRI, 10), version: 6 });
    const queued = (await jobs("appointment_reminder")).filter((j) => j.status === "queued").map((j) => [j.dedupe_key, j.send_after]);
    expect(queued).toEqual([
      [`reminder:${id}:v6:${at(FRI, 10)}:1440`, at(THU, 10)],
      [`reminder:${id}:v6:${at(FRI, 10)}:60`, at(FRI, 9)],
    ]);
  });

  it("choosing another time from a pending change request supersedes it: never more than the original plus one change", async () => {
    const id = await submit(pat, at(FRI, 10));
    await approve(id, team.a);
    const first = await submit(pat, at(FRI, 11), { replacesId: id });
    const firstRef = (await row(first)).ref as string;
    const p = await propose(first, [{ startAt: at(FRI, 12), staffId: team.b }], 1);
    await env.DB.prepare("DELETE FROM email_jobs").run();
    await env.DB.prepare("DELETE FROM dev_mailbox").run();
    const activeCount = () => count("SELECT COUNT(*) AS n FROM reservations WHERE customer_id = ? AND status IN ('pending','confirmed')", pat.id);

    const key = crypto.randomUUID();
    const res = await submitRes(pat, at(FRI, 12, 30), { replacesId: first, idempotencyKey: key });
    expect([res.status, res.json.error]).toEqual([201, undefined]);
    const second = res.json.reservation.id as string;
    expect(await row(second)).toMatchObject({ status: "pending", replaces_id: id });
    expect(await row(first)).toMatchObject({ status: "cancelled", closed_by_kind: "customer", closed_by: "pat@example.test", close_reason: "superseded" });
    expect(await blocksOf(first)).toEqual([]);
    expect((await proposalRow(p.id)).status).toBe("rejected");
    expect(await optionBlocks()).toBe(0);
    expect(await row(id)).toMatchObject({ status: "confirmed", version: 2 });
    expect(await activeCount()).toBe(2);
    expect((await auditOf("reservation.requested")).details).toMatchObject({ replacesId: id, supersedes: first });
    expect(await jobs("cancelled")).toEqual([]);
    const mine = await mailsTo("pat@example.test");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain(`replaces your earlier change request ${firstRef}`);
    expect((await mailsTo("admin@example.test")).find((m) => m.subject.includes("New remote support request"))!.text).toContain(`Supersedes the change request: ${firstRef}`);

    // A retry of that very submit returns what it created.
    const replay = await submitRes(pat, at(FRI, 12, 30), { replacesId: first, idempotencyKey: key });
    expect([replay.status, replay.json.reservation.id]).toEqual([200, second]);

    // And again from the newest change; a normal request is still over the limit.
    const third = await submit(pat, at(FRI, 11), { replacesId: second });
    expect(await row(third)).toMatchObject({ replaces_id: id });
    expect((await row(second)).close_reason).toBe("superseded");
    expect(await activeCount()).toBe(2);
    expect((await submitRes(pat, at(FRI, 12))).json.error).toBe("limit_reached");
    // The original itself already has its one pending change.
    expect((await submitRes(pat, at(FRI, 12), { replacesId: id })).json.error).toBe("replacement_exists");
  });

  it("an idempotency key replayed with another replacesId is idempotency_conflict", async () => {
    const id = await submit(pat, at(FRI, 10));
    await approve(id, team.a);
    const key = crypto.randomUUID();
    expect((await submitRes(pat, at(FRI, 11), { replacesId: id, idempotencyKey: key })).status).toBe(201);
    for (const extra of [{}, { replacesId: "nope" }]) {
      const res = await submitRes(pat, at(FRI, 11), { idempotencyKey: key, ...extra });
      expect([res.status, res.json.error]).toEqual([409, "idempotency_conflict"]);
    }
  });

  it("a pending replacement never counts toward the per-account limit while its original is active", async () => {
    await setSetting("maxActivePerAccount", 2);
    const id = await submit(pat, at(FRI, 10));
    await approve(id, team.a);
    await submit(pat, at(FRI, 11), { replacesId: id });
    // Original + normal request = 2; the replacement is not counted.
    await submit(pat, at(FRI, 12));
    expect((await submitRes(pat, at(FRI, 12, 30))).json.error).toBe("limit_reached");
  });

  it("approving a replacement whose original has already started confirms it as a normal request and leaves the original", async () => {
    const id = await submit(pat, at(FRI, 10));
    await approve(id, team.a);
    const replacement = await submit(pat, at(FRI, 12), { replacesId: id });
    await env.DB.prepare("DELETE FROM email_jobs").run();
    setNow(at(FRI, 10, 5));
    const r = await approveReservation(env, admin(), replacement, team.b, 1);
    expect(r.status).toBe("confirmed");
    expect(await row(id)).toMatchObject({ status: "confirmed", version: 2 });
    expect(await blocksOf(id)).toHaveLength(8);
    expect((await jobs("confirmed")).map((j) => j.to_email)).toEqual(["pat@example.test"]);
    expect(await jobs("rescheduled")).toEqual([]);
    expect((await auditOf("reservation.approved")).details).toEqual({ assignedStaffId: team.b, replacesId: id, originalCancelled: false });
  });

  it("an accepted option keeps the occupied range stored with it, whatever the buffers are now", async () => {
    const id = await submit(pat, at(FRI, 10));
    await approve(id, team.a);
    const p = await propose(id, [{ startAt: at(FRI, 11), staffId: team.b }], 2);
    await setSetting("bufferAfterMin", 20);
    expect((await acceptViaToken(await mintToken(id), p.id, p.options[0]!.id)).status).toBe(200);
    expect(await row(id)).toMatchObject({ occ_start: at(FRI, 11), occ_end: at(FRI, 11, 40) });
    expect(await blocksOf(id)).toHaveLength(8);
  });

  it("the proposal-expiry sweep handles at most 50 proposals per run", async () => {
    const id = await submit(pat, at(FRI, 10));
    await env.DB.batch(
      Array.from({ length: 51 }, (_, i) =>
        env.DB.prepare("INSERT INTO proposals(id, reservation_id, status, created_by, created_at, expires_at) VALUES (?, ?, 'open', ?, ?, ?)").bind(
          `p${String(i).padStart(2, "0")}`,
          id,
          team.admin,
          at(THU, 8),
          at(THU, 9),
        ),
      ),
    );
    setNow(at(THU, 10));
    expect(await expireProposals(env, at(THU, 10))).toBe(50);
    expect(await count("SELECT COUNT(*) AS n FROM proposals WHERE status = 'open'")).toBe(1);
    expect(await expireProposals(env, at(THU, 10))).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM proposals WHERE status = 'expired'")).toBe(51);
  }, 60_000);
});
