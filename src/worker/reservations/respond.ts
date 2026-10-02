import { z } from "zod";
import type { Env } from "../env";
import { clock } from "../lib/clock";
import { assertSql, audit, capacityBatch, readScheduleVersion, withRetry } from "../lib/db";
import { HttpError } from "../lib/http";
import { enqueueEmail } from "../mail/outbox";
import { getSettings } from "../repos/settings";
import { activeStaffByIds, noticeRecipients, notifyStaff } from "../repos/staff";
import { cancelObsoleteMail, ELIGIBLE_SQL } from "./holds";
import { closeProposalStatements } from "./propose";
import { customerView, getReservation, type CustomerReservationDTO, type ReservationDTO } from "./queries";
import { reminderStatements } from "./reminders";
import { cancelReplacedStatements, replacedBy } from "./replacement";

const idField = z.string().min(1).max(100);
export const acceptBody = z.object({ proposalId: idField, optionId: idField });
export const rejectBody = z.object({ proposalId: idField });

interface OpenProposal {
  scheduleVersion: number;
  current: ReservationDTO;
  now: number;
}

/**
 * The reservation `id` with its proposal `proposalId` still open, for a customer answering it. Reads the schedule version
 * first (then the data), so a change in between fails the caller's batch guard and it retries. 404 when the proposal is
 * not this reservation's; 409 proposal_closed with the customer's view when it was answered, superseded, withdrawn, or
 * is past its expiry (whether or not the sweep has run yet).
 */
async function loadOpen(env: Env, id: string, proposalId: string): Promise<OpenProposal> {
  const db = env.DB;
  const scheduleVersion = await readScheduleVersion(db);
  const current = await getReservation(db, id);
  const proposal = current
    ? await db.prepare("SELECT status, expires_at FROM proposals WHERE id = ? AND reservation_id = ?").bind(proposalId, id).first<{ status: string; expires_at: number }>()
    : null;
  if (!current || !proposal) throw new HttpError(404, "not_found");
  const now = clock.now();
  if (proposal.status !== "open" || proposal.expires_at <= now || (current.status !== "pending" && current.status !== "confirmed")) {
    throw new HttpError(409, "proposal_closed", { current: await customerView(db, id) });
  }
  return { scheduleVersion, current, now };
}

/** In-batch: the proposal is still open and unexpired, and the reservation is as read (status and version). */
const assertOpenStatements = (db: D1Database, current: ReservationDTO, proposalId: string, now: number): D1PreparedStatement[] => [
  assertSql(db, "SELECT 1 FROM reservations WHERE id = ? AND status = ? AND version = ?", current.id, current.status, current.version),
  assertSql(db, "SELECT 1 FROM proposals WHERE id = ? AND reservation_id = ? AND status = 'open' AND expires_at > ?", proposalId, current.id, now),
];

/**
 * The customer takes one of the proposed times. A staff-proposed time is pre-approved, so the reservation (pending or
 * confirmed) becomes confirmed at the option's time with the option's technician, in one batch: the original's blocks
 * are freed, the chosen option's blocks become the reservation's (the option already held them, so no capacity can be
 * lost in between), the other options are released and the proposal is accepted. Queued mail about the old time is
 * cancelled and reminders for the new time queued; the customer gets one `rescheduled` email and the team the outcome.
 * A pending request needs an eligible customer and contact (403 not_eligible), as approval would; a confirmed
 * appointment does not. Accepting on a pending replacement request is its approval: the original it replaces, while
 * still active (pending or confirmed, not started), is cancelled in the same batch as an approval would, and the
 * customer's `rescheduled` email names the original's time as the previous one. `email` is who answered (the session's
 * contact, or the reservation's contact for a link).
 */
export async function acceptProposal(env: Env, email: string, id: string, input: { proposalId: string; optionId: string }): Promise<CustomerReservationDTO> {
  return withRetry(() => acceptAttempt(env, email, id, input.proposalId, input.optionId));
}

async function acceptAttempt(env: Env, email: string, id: string, proposalId: string, optionId: string): Promise<CustomerReservationDTO> {
  const db = env.DB;
  const { scheduleVersion, current, now } = await loadOpen(env, id, proposalId);
  const option = await db
    .prepare("SELECT start_at, end_at, occ_start, occ_end, staff_id FROM proposal_options WHERE id = ? AND proposal_id = ?")
    .bind(optionId, proposalId)
    .first<{ start_at: number; end_at: number; occ_start: number; occ_end: number; staff_id: number }>();
  if (!option) throw new HttpError(404, "not_found");
  const pending = current.status === "pending";
  if (pending && !(current.customer.active && (await db.prepare(ELIGIBLE_SQL).bind(current.customer.id, current.contactEmail).first()))) {
    throw new HttpError(403, "not_eligible");
  }

  const { original } = pending ? await replacedBy(db, id, now) : { original: null };
  const newVersion = current.version + 1;
  const fromStaff = current.assignedStaff?.id ?? null;
  const settings = await getSettings(db, env);
  // Everyone who follows requests, and the technicians the appointment moves from and to (a replaced original's included).
  const involved = [...(fromStaff !== null ? [fromStaff] : []), option.staff_id, ...(original?.assignedStaffId ? [original.assignedStaffId] : [])];
  const team = noticeRecipients(await notifyStaff(db), await activeStaffByIds(db, involved));

  await capacityBatch(db, scheduleVersion, [
    ...assertOpenStatements(db, current, proposalId, now),
    ...(pending ? [assertSql(db, ELIGIBLE_SQL, current.customer.id, current.contactEmail)] : []),
    // The option must still hold its blocks: they become the reservation's.
    assertSql(
      db,
      "SELECT 1 FROM proposal_options o WHERE o.id = ? AND o.proposal_id = ? AND EXISTS (SELECT 1 FROM tech_blocks b WHERE b.owner_kind = 'option' AND b.owner_id = o.id)",
      optionId,
      proposalId,
    ),
    ...(original
      ? cancelReplacedStatements(db, original, { by: { kind: "customer", id: email }, reason: "rescheduled", replacementId: id, customerId: current.customer.id, now })
      : []),
    db.prepare("DELETE FROM tech_blocks WHERE owner_kind = 'reservation' AND owner_id = ?").bind(id),
    db.prepare("UPDATE tech_blocks SET owner_kind = 'reservation', owner_id = ? WHERE owner_kind = 'option' AND owner_id = ?").bind(id, optionId),
    // Releases the other options' blocks (the chosen one's are the reservation's now) and accepts the proposal.
    ...closeProposalStatements(db, id, proposalId, "accepted", now),
    // confirmed_by stays empty: the customer confirmed a time staff offered (the audit trail records both).
    db
      .prepare(
        `UPDATE reservations SET start_at = ?, end_at = ?, occ_start = ?, occ_end = ?, status = 'confirmed', assigned_staff_id = ?,
           provisional_staff_id = NULL, confirmed_at = ?, confirmed_by = NULL, version = version + 1, updated_at = ?
         WHERE id = ? AND status = ? AND version = ?`,
      )
      .bind(option.start_at, option.end_at, option.occ_start, option.occ_end, option.staff_id, now, now, id, current.status, current.version),
    // Mail about the old time (reminders, a confirmation not yet sent) goes before the new time's is queued.
    cancelObsoleteMail(db, id),
    ...reminderStatements(db, settings, { id, startAt: option.start_at, contactEmail: current.contactEmail, version: newVersion }, now),
    enqueueEmail(db, {
      template: "rescheduled",
      to: current.contactEmail,
      dedupeKey: `rescheduled:${id}:v${newVersion}`,
      reservationId: id,
      payload: original
        ? { startAt: option.start_at, fromStartAt: original.startAt, via: "replacement", replacesRef: original.ref }
        : { startAt: option.start_at, fromStartAt: current.startAt, fromStatus: current.status, via: "proposal" },
    }),
    ...team.map((m) =>
      enqueueEmail(db, {
        template: "proposal_outcome",
        to: m.email,
        dedupeKey: `proposal-outcome-team:${proposalId}:${m.id}`,
        reservationId: id,
        payload: { audience: "team", proposalId, outcome: "accepted", fromStartAt: current.startAt, ...(original ? { replacesRef: original.ref } : {}) },
      }),
    ),
    audit(db, {
      actorKind: "customer",
      actor: email,
      action: "reservation.rescheduled",
      reservationId: id,
      customerId: current.customer.id,
      details: {
        via: "proposal",
        proposalId,
        from: { startAt: current.startAt, staffId: fromStaff },
        to: { startAt: option.start_at, staffId: option.staff_id },
        ...(original ? { replacesId: original.id } : {}),
      },
    }),
  ]);
  return (await customerView(db, id))!;
}

/**
 * The customer keeps their original time (a confirmed appointment, or a pending request as it is): the proposal is
 * rejected and its options released; the reservation itself is unchanged (no version change, like a withdrawal). The
 * customer gets a confirmation and the team (with the technicians involved) is told.
 */
export async function rejectProposal(env: Env, email: string, id: string, input: { proposalId: string }): Promise<CustomerReservationDTO> {
  return withRetry(() => rejectAttempt(env, email, id, input.proposalId));
}

async function rejectAttempt(env: Env, email: string, id: string, proposalId: string): Promise<CustomerReservationDTO> {
  const db = env.DB;
  const { scheduleVersion, current, now } = await loadOpen(env, id, proposalId);
  const optionStaff = current.proposal?.id === proposalId ? current.proposal.options.map((o) => o.staffId) : [];
  const involved = await activeStaffByIds(db, [...(current.assignedStaff ? [current.assignedStaff.id] : []), ...optionStaff]);
  const team = noticeRecipients(await notifyStaff(db), involved);

  await capacityBatch(db, scheduleVersion, [
    ...assertOpenStatements(db, current, proposalId, now),
    ...closeProposalStatements(db, id, proposalId, "rejected", now),
    ...outcomeEmails(db, { id, proposalId, contactEmail: current.contactEmail, outcome: "rejected", team }),
    audit(db, {
      actorKind: "customer",
      actor: email,
      action: "reservation.proposal_rejected",
      reservationId: id,
      customerId: current.customer.id,
      details: { proposalId, via: "keep" },
    }),
  ]);
  return (await customerView(db, id))!;
}

/** `proposal_outcome` to the customer (one per proposal) and to each of `team`. */
export function outcomeEmails(
  db: D1Database,
  o: { id: string; proposalId: string; contactEmail: string; outcome: "rejected" | "expired"; team: Array<{ id: number; email: string }> },
): D1PreparedStatement[] {
  return [
    enqueueEmail(db, {
      template: "proposal_outcome",
      to: o.contactEmail,
      dedupeKey: `proposal-outcome:${o.proposalId}`,
      reservationId: o.id,
      payload: { audience: "customer", proposalId: o.proposalId, outcome: o.outcome },
    }),
    ...o.team.map((m) =>
      enqueueEmail(db, {
        template: "proposal_outcome",
        to: m.email,
        dedupeKey: `proposal-outcome-team:${o.proposalId}:${m.id}`,
        reservationId: o.id,
        payload: { audience: "team", proposalId: o.proposalId, outcome: o.outcome },
      }),
    ),
  ];
}
