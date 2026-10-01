import { MIN } from "../../domain/time";
import type { Env, StaffPrincipal } from "../env";
import { clock } from "../lib/clock";
import { assertSql, audit, capacityBatch, readScheduleVersion, withRetry } from "../lib/db";
import { HttpError } from "../lib/http";
import { enqueueEmail } from "../mail/outbox";
import { getSettings } from "../repos/settings";
import { notifyStaff } from "../repos/staff";
import { getReservation, type ReservationDTO } from "./queries";

export type CancelActor = { kind: "staff"; staff: StaffPrincipal } | { kind: "customer"; email: string };

/** Queued mail about the reservation that is wrong once it is cancelled: reminders and confirmation-type messages. */
const OBSOLETE_TEMPLATES = [
  "appointment_reminder",
  "approval_reminder",
  "approval_escalation",
  "request_received",
  "new_request",
  "confirmed",
  "assigned",
  "reassigned",
] as const;

const REASON_MAX = 500;

/**
 * Cancel a pending or confirmed reservation: frees its blocks and any open proposal's option holds, closes the
 * reservation, cancels its obsolete queued mail and tells the customer and the team. Staff need a reason and may
 * cancel until the appointment ends; customers may give one and cancel before the start (confirmed appointments only
 * until `cancelCutoffMin` before it). Ownership is the caller's job. Cancelling an already-cancelled reservation
 * returns it unchanged; a version that moved (e.g. a racing approval) is 409 stale.
 */
export async function cancelReservation(
  env: Env,
  actor: CancelActor,
  id: string,
  input: { reason?: string; version: number },
): Promise<ReservationDTO> {
  const reason = input.reason?.trim() || null;
  if ((actor.kind === "staff" && !reason) || (reason && reason.length > REASON_MAX)) throw new HttpError(400, "invalid");
  return withRetry(() => attempt(env, actor, id, reason, input.version));
}

async function attempt(env: Env, actor: CancelActor, id: string, reason: string | null, version: number): Promise<ReservationDTO> {
  const db = env.DB;
  // Schedule version first, then the reservation: a change in between fails the guard and we retry.
  const scheduleVersion = await readScheduleVersion(db);
  const current = await getReservation(db, id);
  if (!current) throw new HttpError(404, "not_found");
  if (current.status === "cancelled") return current;
  if ((current.status !== "pending" && current.status !== "confirmed") || current.version !== version) {
    throw new HttpError(409, "stale", { current });
  }

  const now = clock.now();
  if (actor.kind === "staff") {
    if (current.endAt <= now) throw new HttpError(409, "too_late");
  } else {
    if (current.startAt <= now) throw new HttpError(409, "too_late");
    if (current.status === "confirmed") {
      const { cancelCutoffMin } = await getSettings(db, env);
      if (current.startAt - cancelCutoffMin * MIN <= now) throw new HttpError(409, "past_cutoff");
    }
  }

  const closedBy = actor.kind === "staff" ? String(actor.staff.id) : actor.email;
  // A staff actor already knows; everyone else who follows requests is told.
  const team = (await notifyStaff(db)).filter((s) => actor.kind !== "staff" || s.id !== actor.staff.id);
  const templates = OBSOLETE_TEMPLATES.map(() => "?").join(",");

  await capacityBatch(db, scheduleVersion, [
    assertSql(db, "SELECT 1 FROM reservations WHERE id = ? AND status = ? AND version = ?", id, current.status, version),
    db.prepare("DELETE FROM tech_blocks WHERE owner_kind = 'reservation' AND owner_id = ?").bind(id),
    // Option blocks before closing their proposal (the subquery finds them through the open proposal).
    db
      .prepare(
        `DELETE FROM tech_blocks WHERE owner_kind = 'option' AND owner_id IN (
           SELECT o.id FROM proposal_options o JOIN proposals p ON p.id = o.proposal_id WHERE p.reservation_id = ? AND p.status = 'open')`,
      )
      .bind(id),
    db.prepare("UPDATE proposals SET status = 'withdrawn', resolved_at = ? WHERE reservation_id = ? AND status = 'open'").bind(now, id),
    db
      .prepare(
        `UPDATE reservations SET status = 'cancelled', closed_at = ?, closed_by_kind = ?, closed_by = ?, close_reason = ?,
           provisional_staff_id = NULL, version = version + 1, updated_at = ?
         WHERE id = ? AND status = ? AND version = ?`,
      )
      .bind(now, actor.kind, closedBy, reason, now, id, current.status, version),
    db
      .prepare(`UPDATE email_jobs SET status = 'cancelled' WHERE reservation_id = ? AND status = 'queued' AND template IN (${templates})`)
      .bind(id, ...OBSOLETE_TEMPLATES),
    enqueueEmail(db, { template: "cancelled", to: current.contactEmail, dedupeKey: `cancelled:${id}`, reservationId: id, payload: { audience: "customer" } }),
    ...team.map((s) =>
      enqueueEmail(db, { template: "cancelled", to: s.email, dedupeKey: `cancelled-team:${id}:${s.id}`, reservationId: id, payload: { audience: "team" } }),
    ),
    audit(db, {
      actorKind: actor.kind,
      actor: closedBy,
      action: "reservation.cancelled",
      reservationId: id,
      customerId: current.customer.id,
      details: { reason, from: current.status },
    }),
  ]);
  return (await getReservation(db, id))!;
}
