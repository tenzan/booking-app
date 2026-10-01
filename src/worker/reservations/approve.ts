import { component, solve } from "../../domain/matching";
import { freeStaffAt, rangeBlocks } from "../../domain/slots";
import type { Env, StaffPrincipal } from "../env";
import { clock } from "../lib/clock";
import { assertSql, audit, capacityBatch, withRetry } from "../lib/db";
import { HttpError } from "../lib/http";
import { enqueueEmail } from "../mail/outbox";
import { notifyStaff } from "../repos/staff";
import { loadScheduleCtx } from "../scheduling/context";
import { blockInserts, ELIGIBLE_SQL, movedPending } from "./holds";
import { getReservation, techOptions, type ReservationDTO } from "./queries";

/**
 * Confirm a pending request with `staffId` as its technician. Same batch discipline as submit: the schedule
 * version read before the data guards the batch, so of two concurrent approvals exactly one commits and the
 * other's retry re-reads the reservation and reports 409 stale.
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

  const ctx = await loadScheduleCtx(env, current.startAt, current.endAt);
  const target = ctx.holds.find((h) => h.id === id);
  // Pending a moment ago but no longer holding capacity: it changed under us.
  if (!target) throw new HttpError(409, "stale", { current: (await getReservation(db, id)) ?? current });

  // Only a technician free on the request's own window and stored range may take it: never the provisional fallback
  // the context keeps for holding capacity (that technician may be on leave).
  const free = freeStaffAt(ctx.slotInput, current.startAt, target.start, target.end);
  const fixedHolds = ctx.holds.map((h) => (h.id === id ? { ...h, fixed: staffId } : h));
  const assignment = free.includes(staffId) ? solve(component(fixedHolds, target.start, target.end)) : null;
  if (!assignment) throw new HttpError(409, "tech_unavailable", { options: await techOptions(env, current) });

  const now = clock.now();
  const newVersion = version + 1;
  const moved = movedPending(ctx, assignment, id);
  const targetBlocks = rangeBlocks(target.start, target.end);
  const staff = await notifyStaff(db);

  await capacityBatch(db, ctx.version, [
    assertSql(db, "SELECT 1 FROM reservations WHERE id = ? AND status = 'pending' AND version = ?", id, version),
    assertSql(db, ELIGIBLE_SQL, current.customer.id, current.contactEmail),
    ...moved.map((m) =>
      assertSql(db, "SELECT 1 FROM reservations WHERE id = ? AND status = 'pending' AND provisional_staff_id IS ?", m.holdId, m.fromStaffId),
    ),
    // Free every moved hold's blocks first, then re-insert, so swaps never collide on (staff_id, block_start).
    db.prepare("DELETE FROM tech_blocks WHERE owner_kind = 'reservation' AND owner_id = ?").bind(id),
    ...moved.map((m) => db.prepare("DELETE FROM tech_blocks WHERE owner_kind = 'reservation' AND owner_id = ?").bind(m.holdId)),
    ...moved.map((m) =>
      db.prepare("UPDATE reservations SET provisional_staff_id = ?, updated_at = ? WHERE id = ? AND status = 'pending'").bind(m.staffId, now, m.holdId),
    ),
    db
      .prepare(
        `UPDATE reservations SET status = 'confirmed', assigned_staff_id = ?, provisional_staff_id = NULL,
           confirmed_at = ?, confirmed_by = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND status = 'pending' AND version = ?`,
      )
      .bind(staffId, now, actor.id, now, id, version),
    ...blockInserts(db, staffId, targetBlocks, id),
    ...moved.flatMap((m) => blockInserts(db, m.staffId, rangeBlocks(m.hold.start, m.hold.end), m.holdId)),
    enqueueEmail(db, { template: "confirmed", to: current.contactEmail, dedupeKey: `confirmed:${id}:v${newVersion}`, reservationId: id }),
    // The approver already knows; everyone else who follows requests is told who got it.
    ...staff
      .filter((s) => s.id !== actor.id)
      .map((s) =>
        enqueueEmail(db, { template: "assigned", to: s.email, dedupeKey: `assigned:${id}:v${newVersion}:${s.id}`, reservationId: id }),
      ),
    audit(db, {
      actorKind: "staff",
      actor: String(actor.id),
      action: "reservation.approved",
      reservationId: id,
      customerId: current.customer.id,
      details: { assignedStaffId: staffId },
    }),
  ]);
  return (await getReservation(db, id))!;
}
