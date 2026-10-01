import type { Env } from "../env";
import { assertSql, audit, capacityBatch, readScheduleVersion, withRetry } from "../lib/db";
import { enqueueEmail, safeError } from "../mail/outbox";
import { cancelObsoleteMail, releaseHoldStatements } from "../reservations/holds";
import { getReservation } from "../reservations/queries";
import { notifyStaff } from "../repos/staff";

/** Rows each sweep handles per run; the rest wait for the next minute. */
export const SWEEP_LIMIT = 50;

/** Close one pending request as expired. Returns false when it is no longer due (a racing approval, decline, cancel or sweep got there first). */
async function expireOne(env: Env, id: string, now: number): Promise<boolean> {
  const db = env.DB;
  // Schedule version first, then the reservation: a change in between fails the guard and we retry.
  const scheduleVersion = await readScheduleVersion(db);
  const current = await getReservation(db, id);
  if (!current || current.status !== "pending" || current.expiresAt === null || current.expiresAt > now) return false;
  const team = await notifyStaff(db);
  await capacityBatch(db, scheduleVersion, [
    assertSql(db, "SELECT 1 FROM reservations WHERE id = ? AND status = 'pending' AND version = ? AND expires_at <= ?", id, current.version, now),
    ...releaseHoldStatements(db, id, now),
    db
      .prepare(
        `UPDATE reservations SET status = 'expired', closed_at = ?, closed_by_kind = 'system', closed_by = NULL, close_reason = 'expired',
           provisional_staff_id = NULL, version = version + 1, updated_at = ?
         WHERE id = ? AND status = 'pending' AND version = ?`,
      )
      .bind(now, now, id, current.version),
    cancelObsoleteMail(db, id),
    enqueueEmail(db, { template: "expired", to: current.contactEmail, dedupeKey: `expired:${id}`, reservationId: id, payload: { audience: "customer" } }),
    ...team.map((s) =>
      enqueueEmail(db, { template: "expired", to: s.email, dedupeKey: `expired-team:${id}:${s.id}`, reservationId: id, payload: { audience: "team" } }),
    ),
    audit(db, {
      actorKind: "system",
      actor: null,
      action: "reservation.expired",
      reservationId: id,
      customerId: current.customer.id,
      details: { expiresAt: current.expiresAt },
    }),
  ]);
  return true;
}

/**
 * Pending requests past their approval deadline become `expired`: capacity freed, proposal withdrawn, customer and team
 * told. Each row commits on its own; a row that fails is logged and left for the next run. Returns how many it expired.
 */
export async function expirePending(env: Env, now: number): Promise<number> {
  const { results } = await env.DB.prepare("SELECT id FROM reservations WHERE status = 'pending' AND expires_at <= ? ORDER BY expires_at, id LIMIT ?")
    .bind(now, SWEEP_LIMIT)
    .all<{ id: string }>();
  let done = 0;
  for (const { id } of results) {
    try {
      if (await withRetry(() => expireOne(env, id, now))) done++;
    } catch (e) {
      console.error("expiry", id, safeError(e));
    }
  }
  return done;
}
