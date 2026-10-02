import { z } from "zod";
import { addBusinessMinutes } from "../../domain/business-hours";
import { minNoticeAt } from "../../domain/deadlines";
import { component, solve, type Hold } from "../../domain/matching";
import { findSlot, freeStaffAt, occupiedRange, rangeBlocks } from "../../domain/slots";
import { addDays, eachDate, MIN, utcToWall, wallToUtc } from "../../domain/time";
import { MAX_PROPOSAL_OPTIONS, PROPOSAL_MESSAGE_MAX } from "../../shared/schemas";
import type { ProposalCandidatesDTO, ProposalStatus } from "../../shared/types";
import type { Env, StaffPrincipal } from "../env";
import { clock } from "../lib/clock";
import { uuid } from "../lib/crypto";
import { assertSql, audit, capacityBatch, readScheduleVersion, withRetry } from "../lib/db";
import { HttpError } from "../lib/http";
import { enqueueEmail } from "../mail/outbox";
import { bhCtx, getSettings } from "../repos/settings";
import { activeStaffByIds, noticeRecipients, notifyStaff } from "../repos/staff";
import { loadScheduleCtx } from "../scheduling/context";
import { blockInsert, movedPending, movePendingStatements } from "./holds";
import { getReservation, type ReservationDTO } from "./queries";

export { MAX_PROPOSAL_OPTIONS, PROPOSAL_MESSAGE_MAX };
/** An option may start no sooner than this after the proposal expires (spec: expiry ≤ earliest option − 60 min). */
const OPTION_LEAD_MS = 60 * MIN;

export const proposeBody = z.object({
  options: z
    .array(z.object({ startAt: z.number().int(), staffId: z.number().int() }))
    .min(1)
    .max(MAX_PROPOSAL_OPTIONS),
  message: z.string().trim().max(PROPOSAL_MESSAGE_MAX).optional(),
  version: z.number().int(),
});
export type ProposeInput = z.output<typeof proposeBody>;

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;

/** Solve the holds that transitively overlap any of `extra` (added fixed holds) together with them. */
function solveWith(holds: Hold[], extra: Hold[]): Map<string, number> | null {
  const all = [...holds, ...extra];
  const touched = new Set<Hold>();
  for (const h of extra) for (const c of component(all, h.start, h.end)) touched.add(c);
  return solve(all.filter((h) => touched.has(h)));
}

/**
 * Batch statements closing an open proposal of reservation `reservationId` (superseded, withdrawn, …): assert it is still
 * open, free its option holds, set its status, and cancel the reservation's unsent `proposal` mail (only the open
 * proposal's can still be queued). Put them before anything that may reuse the freed blocks.
 */
export function closeProposalStatements(
  db: D1Database,
  reservationId: string,
  proposalId: string,
  status: Exclude<ProposalStatus, "open">,
  now: number,
): D1PreparedStatement[] {
  return [
    assertSql(db, "SELECT 1 FROM proposals WHERE id = ? AND reservation_id = ? AND status = 'open'", proposalId, reservationId),
    db
      .prepare("DELETE FROM tech_blocks WHERE owner_kind = 'option' AND owner_id IN (SELECT id FROM proposal_options WHERE proposal_id = ?)")
      .bind(proposalId),
    db.prepare("UPDATE proposals SET status = ?, resolved_at = ? WHERE id = ? AND status = 'open'").bind(status, now, proposalId),
    db
      .prepare("UPDATE email_jobs SET status = 'cancelled' WHERE reservation_id = ? AND template = 'proposal' AND status = 'queued'")
      .bind(reservationId),
  ];
}

/**
 * Offer the customer of a pending request or confirmed appointment 1–3 other times, each fixed to a technician and held
 * (`tech_blocks` owner_kind 'option') until the customer answers or the proposal closes. The original keeps its own hold
 * meanwhile, so the options must fit together with it and with every other hold (pending requests may move, the
 * original included when pending). An open proposal is superseded in the same batch, its holds freed first so its times
 * can be offered again. The reservation's version moves on, so a racing approve/reassign/cancel is stale.
 */
export async function proposeReservation(env: Env, actor: StaffPrincipal, id: string, input: ProposeInput): Promise<ReservationDTO> {
  return withRetry(() => attempt(env, actor, id, input));
}

async function attempt(env: Env, actor: StaffPrincipal, id: string, input: ProposeInput): Promise<ReservationDTO> {
  const db = env.DB;
  const { version } = input;
  const current = await getReservation(db, id);
  if (!current) throw new HttpError(404, "not_found");
  if ((current.status !== "pending" && current.status !== "confirmed") || current.version !== version) throw new HttpError(409, "stale", { current });

  const currentTech = current.status === "confirmed" ? (current.assignedStaff?.id ?? null) : current.provisionalStaffId;
  // Customers see times only (never who would take them), so two options at one time, or an option at the current
  // time, would look the same to them. Another technician at the same time is a reassignment, not a proposal.
  const seen = new Set<number>();
  for (const [index, o] of input.options.entries()) {
    if (seen.has(o.startAt)) throw new HttpError(400, "option_duplicate_time", { index });
    seen.add(o.startAt);
    if (o.startAt === current.startAt) throw new HttpError(400, "option_same_as_current", { index });
  }

  const starts = input.options.map((o) => o.startAt);
  const ctx = await loadScheduleCtx(env, Math.min(current.startAt, ...starts), Math.max(current.endAt, ...starts));
  const s = ctx.settings;
  const now = clock.now();
  if (current.startAt - s.proposalExpiryBeforeStartMin * MIN <= now) throw new HttpError(409, "too_late");
  const own = ctx.holds.find((h) => h.id === id);
  // Pending/confirmed a moment ago but no longer holding capacity: it changed under us.
  if (!own) throw new HttpError(409, "stale", { current: (await getReservation(db, id)) ?? current });

  // Options are new bookings: generated slots under the current settings, between minimum notice and the horizon, with
  // the occupied range computed now and stored with the option.
  const earliest = minNoticeAt(now, s, ctx.bh);
  const lastDate = addDays(utcToWall(now, env.APP_TIMEZONE).date, s.bookingHorizonDays);
  const options: Array<Hold & { fixed: number; startAt: number; endAt: number }> = [];
  for (const [index, o] of input.options.entries()) {
    const slot = findSlot(ctx.slots, o.startAt);
    if (!slot) throw new HttpError(409, "option_not_a_slot", { index });
    if (o.startAt < earliest) throw new HttpError(409, "option_too_soon", { index });
    if (utcToWall(o.startAt, env.APP_TIMEZONE).date > lastDate) throw new HttpError(409, "option_beyond_horizon", { index });
    const [start, end] = occupiedRange(slot.startAt, slot.endAt, ctx.cfg);
    // The slot's technicians already fit its window and are free over its occupied range; freeStaffAt is the same rule
    // every hold is judged by later.
    if (!slot.staffIds.includes(o.staffId) || !freeStaffAt(ctx.slotInput, o.startAt, start, end).includes(o.staffId)) {
      throw new HttpError(409, "option_tech_unavailable", { index });
    }
    options.push({ id: uuid(), start, end, fixed: o.staffId, eligible: [o.staffId], preferred: null, startAt: slot.startAt, endAt: slot.endAt });
  }

  // The open proposal (if any) is superseded in this batch: its option holds don't count.
  const open = current.proposal?.status === "open" ? current.proposal : null;
  const supersededIds = new Set(open?.options.map((o) => o.id) ?? []);
  const holds = ctx.holds.filter((h) => !supersededIds.has(h.id));
  // The original stays held while the proposal is open (it is released only when an option is accepted), so the options
  // must fit alongside it. Leaving it out would accept sets the tech_blocks key then rejects.
  const assignment = solveWith(holds, options);
  if (!assignment) {
    // Only the original in the way: say so, pointing at the first option overlapping it (null when none does and the
    // original is in the way only through other holds it pins).
    if (solveWith(holds.filter((h) => h.id !== id), options)) {
      const index = options.findIndex((o) => overlaps(o, own));
      throw new HttpError(409, "option_overlaps_current", { index: index >= 0 ? index : null });
    }
    throw new HttpError(409, "options_conflict");
  }

  const expiresAt = Math.min(
    addBusinessMinutes(now, s.proposalExpiryBh * 60, ctx.bh),
    current.startAt - s.proposalExpiryBeforeStartMin * MIN,
    Math.min(...options.map((o) => o.startAt)) - OPTION_LEAD_MS,
  );
  if (expiresAt <= now) throw new HttpError(409, "too_late");

  const proposalId = uuid();
  const message = input.message ? input.message : null;
  const moved = movedPending(ctx, assignment);
  const involved = await activeStaffByIds(db, [...(current.status === "confirmed" && currentTech !== null ? [currentTech] : []), ...options.map((o) => o.fixed)]);
  const team = noticeRecipients(await notifyStaff(db), involved, actor.id);

  await capacityBatch(db, ctx.version, [
    assertSql(db, "SELECT 1 FROM reservations WHERE id = ? AND status = ? AND version = ?", id, current.status, version),
    ...(open
      ? closeProposalStatements(db, id, open.id, "superseded", now)
      : [assertSql(db, "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM proposals WHERE reservation_id = ? AND status = 'open')", id)]),
    ...movePendingStatements(db, moved, now),
    db
      .prepare("INSERT INTO proposals(id, reservation_id, status, message, created_by, created_at, expires_at) VALUES (?, ?, 'open', ?, ?, ?, ?)")
      .bind(proposalId, id, message, actor.id, now, expiresAt),
    ...options.flatMap((o) => [
      db
        .prepare("INSERT INTO proposal_options(id, proposal_id, start_at, end_at, staff_id, occ_start, occ_end) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(o.id, proposalId, o.startAt, o.endAt, o.fixed, o.start, o.end),
      blockInsert(db, o.fixed, rangeBlocks(o.start, o.end), o.id, "option"),
    ]),
    // Approval clock (ruling): a pending request must not expire while its customer is still deciding, so its deadline
    // moves out to the proposal's expiry when that is later. Withdrawing or expiring the proposal does not move it back:
    // the expiry sweep handles the request at the extended time. Reminders/escalations are skipped meanwhile (open proposal).
    db
      .prepare(
        `UPDATE reservations SET version = version + 1, updated_at = ?,
           expires_at = CASE WHEN status = 'pending' AND expires_at IS NOT NULL AND expires_at < ? THEN ? ELSE expires_at END
         WHERE id = ? AND status = ? AND version = ?`,
      )
      .bind(now, expiresAt, expiresAt, id, current.status, version),
    enqueueEmail(db, {
      template: "proposal",
      to: current.contactEmail,
      dedupeKey: `proposal:${proposalId}`,
      reservationId: id,
      payload: { audience: "customer", proposalId },
    }),
    ...team.map((m) =>
      enqueueEmail(db, {
        template: "proposal",
        to: m.email,
        dedupeKey: `proposal-team:${proposalId}:${m.id}`,
        reservationId: id,
        payload: { audience: "team", proposalId },
      }),
    ),
    audit(db, {
      actorKind: "staff",
      actor: String(actor.id),
      action: "reservation.proposed",
      reservationId: id,
      customerId: current.customer.id,
      details: {
        proposalId,
        options: options.map((o) => ({ startAt: o.startAt, staffId: o.fixed })),
        ...(open ? { supersedes: open.id } : {}),
      },
    }),
  ]);
  return (await getReservation(db, id))!;
}

/**
 * Withdraw the reservation's open proposal: its option holds are freed and the customer is told their original time
 * (appointment or pending request) stands. The reservation itself is unchanged (no version change: an approval or
 * reassignment in flight stays valid). 404 when the proposal is not this reservation's; 409 proposal_closed when it is
 * no longer open.
 */
export async function withdrawProposal(env: Env, actor: StaffPrincipal, id: string, proposalId: string): Promise<ReservationDTO> {
  return withRetry(() => withdrawAttempt(env, actor, id, proposalId));
}

async function withdrawAttempt(env: Env, actor: StaffPrincipal, id: string, proposalId: string): Promise<ReservationDTO> {
  const db = env.DB;
  // Schedule version first, then the data: a change in between fails the guard and we retry.
  const scheduleVersion = await readScheduleVersion(db);
  const proposal = await db
    .prepare("SELECT status FROM proposals WHERE id = ? AND reservation_id = ?")
    .bind(proposalId, id)
    .first<{ status: ProposalStatus }>();
  const current = proposal ? await getReservation(db, id) : null;
  if (!proposal || !current) throw new HttpError(404, "not_found");
  if (proposal.status !== "open") throw new HttpError(409, "proposal_closed", { current });

  const now = clock.now();
  await capacityBatch(db, scheduleVersion, [
    ...closeProposalStatements(db, id, proposalId, "withdrawn", now),
    enqueueEmail(db, {
      template: "proposal_outcome",
      to: current.contactEmail,
      dedupeKey: `proposal-outcome:${proposalId}`,
      reservationId: id,
      payload: { audience: "customer", proposalId, outcome: "withdrawn" },
    }),
    audit(db, {
      actorKind: "staff",
      actor: String(actor.id),
      action: "reservation.proposal_withdrawn",
      reservationId: id,
      customerId: current.customer.id,
      details: { proposalId },
    }),
  ]);
  return (await getReservation(db, id))!;
}

/** Longest span (in dates) the candidates endpoint lists at once. */
export const CANDIDATE_MAX_DAYS = 14;

/**
 * Times the reservation could be proposed for, per local date in [fromDate, toDate] (clamped to today … horizon), from
 * the minimum-notice instant on, each with the technicians an option there would fit for: the same test `propose`
 * applies to a single option. The reservation's own open options don't count (a new proposal supersedes them); its own
 * hold does (it stays held while the proposal is open), and its current time is no option. Slots whose proposal could not
 * expire before them (start − 60 min ≤ now) are left out, and so are slots nobody can take. 409 too_late when the
 * reservation is too close to its start for any proposal.
 */
export async function proposalCandidates(env: Env, id: string, fromDate: string, toDate: string): Promise<ProposalCandidatesDTO> {
  const db = env.DB;
  const tz = env.APP_TIMEZONE;
  const current = await getReservation(db, id);
  if (!current) throw new HttpError(404, "not_found");
  if (current.status !== "pending" && current.status !== "confirmed") throw new HttpError(409, "stale", { current });

  const now = clock.now();
  const today = utcToWall(now, tz).date;
  const settings = await getSettings(db, env);
  if (current.startAt - settings.proposalExpiryBeforeStartMin * MIN <= now) throw new HttpError(409, "too_late");
  const earliest = minNoticeAt(now, settings, await bhCtx(db, env, settings));
  const first = fromDate < today ? today : fromDate;
  const lastDate = addDays(today, settings.bookingHorizonDays);
  const last = [toDate, lastDate].sort()[0]!;
  if (first > last) return { timezone: tz, lastDate, days: [] };

  const ctx = await loadScheduleCtx(env, wallToUtc(first, 0, tz), wallToUtc(addDays(last, 1), 0, tz));
  const superseded = new Set(current.proposal?.status === "open" ? current.proposal.options.map((o) => o.id) : []);
  const holds = ctx.holds.filter((h) => !superseded.has(h.id));
  const { results: staffRows } = await db.prepare("SELECT id, name FROM staff WHERE active = 1 AND bookable = 1").all<{ id: number; name: string }>();
  const names = new Map(staffRows.map((r) => [r.id, r.name]));

  const days: ProposalCandidatesDTO["days"] = eachDate(first, last).map((date) => ({ date, slots: [] }));
  const byDate = new Map(days.map((d) => [d.date, d]));
  for (const slot of ctx.slots) {
    // The proposal must expire at least OPTION_LEAD_MS before each option, and that expiry must still be ahead.
    if (slot.startAt < earliest || slot.startAt - OPTION_LEAD_MS <= now || slot.startAt === current.startAt) continue;
    const day = byDate.get(utcToWall(slot.startAt, tz).date);
    if (!day) continue;
    const [start, end] = occupiedRange(slot.startAt, slot.endAt, ctx.cfg);
    const around = component(holds, start, end);
    const staff = slot.staffIds
      .filter((staffId) => solve([...around, { id: "__option", start, end, fixed: staffId, eligible: [staffId], preferred: null }]) !== null)
      .map((staffId) => ({ id: staffId, name: names.get(staffId) ?? "" }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
    if (staff.length > 0) day.slots.push({ startAt: slot.startAt, endAt: slot.endAt, staff });
  }
  return { timezone: tz, lastDate, days };
}
