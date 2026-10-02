import { component, solve } from "../../domain/matching";
import { freeStaffAt, rangeBlocks } from "../../domain/slots";
import type { Env, StaffPrincipal } from "../env";
import { clock } from "../lib/clock";
import { assertSql, audit, capacityBatch, withRetry } from "../lib/db";
import { HttpError } from "../lib/http";
import { enqueueEmail } from "../mail/outbox";
import { getSettings } from "../repos/settings";
import { activeStaffByIds, noticeRecipients, notifyStaff } from "../repos/staff";
import { loadScheduleCtx } from "../scheduling/context";
import { blockInsert, ELIGIBLE_SQL, movedPending, movePendingStatements } from "./holds";
import { closeProposalStatements } from "./propose";
import { reminderStatements } from "./reminders";
import { getReservation, techOptions, type ReservationDTO } from "./queries";
import { cancelReplacedStatements, releasedHolds, replacedBy } from "./replacement";

/**
 * Confirm a pending request with `staffId` as its technician. Same batch discipline as submit: the schedule
 * version read before the data guards the batch, so of two concurrent approvals exactly one commits and the
 * other's retry re-reads the reservation and reports 409 stale.
 *
 * In the same batch: an open proposal on the request is withdrawn (staff decided; the customer just gets the
 * confirmation), and for a replacement request whose original is still pending or confirmed, that original is cancelled
 * (close_reason 'rescheduled') and the customer gets one `rescheduled` email instead of a confirmation and a cancellation.
 * A replacement whose original is gone or has already started is approved like any request; the original is left as is.
 */
export async function approveReservation(env: Env, actor: StaffPrincipal, id: string, staffId: number, version: number): Promise<ReservationDTO> {
  return withRetry(() => attempt(env, actor, id, staffId, version));
}

async function attempt(env: Env, actor: StaffPrincipal, id: string, staffId: number, version: number): Promise<ReservationDTO> {
  const db = env.DB;
  const current = await getReservation(db, id);
  if (!current) throw new HttpError(404, "not_found");
  if (current.status !== "pending" || current.version !== version) throw new HttpError(409, "stale", { current });
  if (current.startAt <= clock.now()) throw new HttpError(409, "too_late");
  if (!current.customer.active || !(await db.prepare(ELIGIBLE_SQL).bind(current.customer.id, current.contactEmail).first())) {
    throw new HttpError(409, "customer_ineligible");
  }
  const { replacesId, original } = await replacedBy(db, id, clock.now());

  const ctx = await loadScheduleCtx(env, current.startAt, current.endAt);
  const target = ctx.holds.find((h) => h.id === id);
  // Pending a moment ago but no longer holding capacity: it changed under us.
  if (!target) throw new HttpError(409, "stale", { current: (await getReservation(db, id)) ?? current });

  // Only a technician free on the request's own window and stored range may take it: never the provisional fallback
  // the context keeps for holding capacity (that technician may be on leave). Holds this batch releases don't count.
  const released = releasedHolds(ctx, current, original);
  const free = freeStaffAt(ctx.slotInput, current.startAt, target.start, target.end);
  const fixedHolds = ctx.holds.filter((h) => !released.has(h.id)).map((h) => (h.id === id ? { ...h, fixed: staffId } : h));
  const assignment = free.includes(staffId) ? solve(component(fixedHolds, target.start, target.end)) : null;
  if (!assignment) throw new HttpError(409, "tech_unavailable", { options: await techOptions(env, current) });

  const now = clock.now();
  const newVersion = version + 1;
  const moved = movedPending(ctx, assignment, id);
  const targetBlocks = rangeBlocks(target.start, target.end);
  // The approver already knows; everyone else who follows requests is told who got it, and so is the technician of a
  // replaced appointment (it is cancelled).
  const team = noticeRecipients(await notifyStaff(db), original?.assignedStaffId ? await activeStaffByIds(db, [original.assignedStaffId]) : [], actor.id);
  const settings = await getSettings(db, env);
  const openProposal = current.proposal?.status === "open" ? current.proposal : null;

  await capacityBatch(db, ctx.version, [
    assertSql(db, "SELECT 1 FROM reservations WHERE id = ? AND status = 'pending' AND version = ?", id, version),
    assertSql(db, ELIGIBLE_SQL, current.customer.id, current.contactEmail),
    // Released before anything takes their blocks: the request's open proposal, and the original it replaces.
    ...(openProposal ? closeProposalStatements(db, id, openProposal.id, "withdrawn", now) : []),
    ...(original
      ? cancelReplacedStatements(db, original, {
          by: { kind: "staff", id: String(actor.id) },
          reason: "rescheduled",
          replacementId: id,
          customerId: current.customer.id,
          now,
        })
      : []),
    // The target's blocks go first so a moved request may take its old provisional technician.
    db.prepare("DELETE FROM tech_blocks WHERE owner_kind = 'reservation' AND owner_id = ?").bind(id),
    ...movePendingStatements(db, moved, now),
    db
      .prepare(
        `UPDATE reservations SET status = 'confirmed', assigned_staff_id = ?, provisional_staff_id = NULL,
           confirmed_at = ?, confirmed_by = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND status = 'pending' AND version = ?`,
      )
      .bind(staffId, now, actor.id, now, id, version),
    blockInsert(db, staffId, targetBlocks, id),
    original
      ? enqueueEmail(db, {
          template: "rescheduled",
          to: current.contactEmail,
          dedupeKey: `rescheduled:${id}:v${newVersion}`,
          reservationId: id,
          payload: { startAt: current.startAt, fromStartAt: original.startAt, via: "replacement", replacesRef: original.ref },
        })
      : enqueueEmail(db, { template: "confirmed", to: current.contactEmail, dedupeKey: `confirmed:${id}:v${newVersion}`, reservationId: id }),
    ...reminderStatements(db, settings, { id, startAt: current.startAt, contactEmail: current.contactEmail, version: newVersion }, now),
    ...team.map((s) =>
      enqueueEmail(db, {
        template: "assigned",
        to: s.email,
        dedupeKey: `assigned:${id}:v${newVersion}:${s.id}`,
        reservationId: id,
        ...(replacesId ? { payload: { originalCancelled: original !== null } } : {}),
      }),
    ),
    audit(db, {
      actorKind: "staff",
      actor: String(actor.id),
      action: "reservation.approved",
      reservationId: id,
      customerId: current.customer.id,
      details: { assignedStaffId: staffId, ...(replacesId ? { replacesId, originalCancelled: original !== null } : {}) },
    }),
  ]);
  return (await getReservation(db, id))!;
}
