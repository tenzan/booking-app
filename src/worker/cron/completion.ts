import type { Env } from "../env";
import { assertSql, audit, capacityBatch, readScheduleVersion, withRetry } from "../lib/db";
import { safeError } from "../mail/outbox";
import { getReservation } from "../reservations/queries";
import { SWEEP_LIMIT } from "./expiry";

async function completeOne(env: Env, id: string, now: number): Promise<boolean> {
  const db = env.DB;
  const scheduleVersion = await readScheduleVersion(db);
  const current = await getReservation(db, id);
  if (!current || current.status !== "confirmed" || current.endAt > now) return false;
  await capacityBatch(db, scheduleVersion, [
    assertSql(db, "SELECT 1 FROM reservations WHERE id = ? AND status = 'confirmed' AND version = ? AND end_at <= ?", id, current.version, now),
    // An ended appointment holds nothing; dropping its blocks keeps the table small.
    db.prepare("DELETE FROM tech_blocks WHERE owner_kind = 'reservation' AND owner_id = ?").bind(id),
    db
      .prepare(
        `UPDATE reservations SET status = 'completed', closed_at = ?, closed_by_kind = 'system', closed_by = NULL,
           version = version + 1, updated_at = ?
         WHERE id = ? AND status = 'confirmed' AND version = ?`,
      )
      .bind(now, now, id, current.version),
    audit(db, { actorKind: "system", actor: null, action: "reservation.completed", reservationId: id, customerId: current.customer.id }),
  ]);
  return true;
}

/** Confirmed appointments that have ended become `completed` (no mail). Returns how many it completed. */
export async function completeEnded(env: Env, now: number): Promise<number> {
  const { results } = await env.DB.prepare("SELECT id FROM reservations WHERE status = 'confirmed' AND end_at <= ? ORDER BY end_at, id LIMIT ?")
    .bind(now, SWEEP_LIMIT)
    .all<{ id: string }>();
  let done = 0;
  for (const { id } of results) {
    try {
      if (await withRetry(() => completeOne(env, id, now))) done++;
    } catch (e) {
      console.error("completion", id, safeError(e));
    }
  }
  return done;
}
