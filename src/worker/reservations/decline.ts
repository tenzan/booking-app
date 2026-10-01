import type { Env, StaffPrincipal } from "../env";
import { clock } from "../lib/clock";
import { assertSql, audit, capacityBatch, readScheduleVersion, withRetry } from "../lib/db";
import { HttpError } from "../lib/http";
import { enqueueEmail } from "../mail/outbox";
import { cancelObsoleteMail, releaseHoldStatements } from "./holds";
import { getReservation, type ReservationDTO } from "./queries";

/**
 * Decline a pending request: frees its blocks, withdraws an open proposal (releasing its options; the declined email is
 * all the customer needs), cancels its obsolete queued mail and tells the customer. Other holds keep their technicians
 * (freeing capacity moves nobody). A declined replacement request leaves the reservation it asked to change as it is.
 */
export async function declineReservation(env: Env, actor: StaffPrincipal, id: string, reason: string, version: number): Promise<ReservationDTO> {
  return withRetry(() => attempt(env, actor, id, reason, version));
}

async function attempt(env: Env, actor: StaffPrincipal, id: string, reason: string, version: number): Promise<ReservationDTO> {
  const db = env.DB;
  // Schedule version first, then the reservation: a change in between fails the guard and we retry.
  const scheduleVersion = await readScheduleVersion(db);
  const current = await getReservation(db, id);
  if (!current) throw new HttpError(404, "not_found");
  if (current.status !== "pending" || current.version !== version) throw new HttpError(409, "stale", { current });

  const now = clock.now();
  await capacityBatch(db, scheduleVersion, [
    assertSql(db, "SELECT 1 FROM reservations WHERE id = ? AND status = 'pending' AND version = ?", id, version),
    ...releaseHoldStatements(db, id, now),
    db
      .prepare(
        `UPDATE reservations SET status = 'declined', closed_at = ?, closed_by_kind = 'staff', closed_by = ?,
           close_reason = ?, provisional_staff_id = NULL, version = version + 1, updated_at = ?
         WHERE id = ? AND status = 'pending' AND version = ?`,
      )
      .bind(now, String(actor.id), reason, now, id, version),
    cancelObsoleteMail(db, id),
    enqueueEmail(db, { template: "declined", to: current.contactEmail, dedupeKey: `declined:${id}`, reservationId: id }),
    audit(db, {
      actorKind: "staff",
      actor: String(actor.id),
      action: "reservation.declined",
      reservationId: id,
      customerId: current.customer.id,
      details: { reason },
    }),
  ]);
  return (await getReservation(db, id))!;
}
