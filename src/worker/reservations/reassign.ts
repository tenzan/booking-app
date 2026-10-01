import { component, solve } from "../../domain/matching";
import { freeStaffAt, rangeBlocks } from "../../domain/slots";
import type { Env, StaffPrincipal } from "../env";
import { clock } from "../lib/clock";
import { assertSql, audit, capacityBatch, withRetry } from "../lib/db";
import { HttpError } from "../lib/http";
import { enqueueEmail } from "../mail/outbox";
import { notifyStaff } from "../repos/staff";
import { loadScheduleCtx } from "../scheduling/context";
import { blockInsert, movedPending, movePendingStatements } from "./holds";
import { getReservation, techOptions, type ReservationDTO } from "./queries";

/**
 * Give a confirmed appointment another technician at the same time. The target must be free on the appointment's
 * window and stored range, and everything else must stay assignable with it fixed there (pending requests may move).
 * Same batch discipline as approve: of two racing reassignments exactly one commits, the other is stale on retry.
 */
export async function reassignReservation(env: Env, actor: StaffPrincipal, id: string, staffId: number, version: number): Promise<ReservationDTO> {
  return withRetry(() => attempt(env, actor, id, staffId, version));
}

async function attempt(env: Env, actor: StaffPrincipal, id: string, staffId: number, version: number): Promise<ReservationDTO> {
  const db = env.DB;
  const current = await getReservation(db, id);
  if (!current) throw new HttpError(404, "not_found");
  if (current.status !== "confirmed" || current.version !== version || !current.assignedStaff) throw new HttpError(409, "stale", { current });
  const from = current.assignedStaff.id;
  if (from === staffId) throw new HttpError(409, "same_tech");
  if (current.endAt <= clock.now()) throw new HttpError(409, "too_late");

  const ctx = await loadScheduleCtx(env, current.startAt, current.endAt);
  const target = ctx.holds.find((h) => h.id === id);
  if (!target) throw new HttpError(409, "stale", { current: (await getReservation(db, id)) ?? current });

  const free = freeStaffAt(ctx.slotInput, current.startAt, target.start, target.end);
  const fixedHolds = ctx.holds.map((h) => (h.id === id ? { ...h, fixed: staffId, eligible: [staffId] } : h));
  const assignment = free.includes(staffId) ? solve(component(fixedHolds, target.start, target.end)) : null;
  if (!assignment) throw new HttpError(409, "tech_unavailable", { options: await techOptions(env, current) });

  const now = clock.now();
  const newVersion = version + 1;
  const moved = movedPending(ctx, assignment, id);
  const staff = await notifyStaff(db);

  await capacityBatch(db, ctx.version, [
    assertSql(db, "SELECT 1 FROM reservations WHERE id = ? AND status = 'confirmed' AND version = ? AND assigned_staff_id = ?", id, version, from),
    // The appointment's blocks go first so a moved request may take its old technician.
    db.prepare("DELETE FROM tech_blocks WHERE owner_kind = 'reservation' AND owner_id = ?").bind(id),
    ...movePendingStatements(db, moved, now),
    db
      .prepare(
        `UPDATE reservations SET assigned_staff_id = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND status = 'confirmed' AND version = ?`,
      )
      .bind(staffId, now, id, version),
    blockInsert(db, staffId, rangeBlocks(target.start, target.end), id),
    ...staff
      .filter((s) => s.id !== actor.id)
      .map((s) =>
        enqueueEmail(db, {
          template: "reassigned",
          to: s.email,
          dedupeKey: `reassigned:${id}:v${newVersion}:${s.id}`,
          reservationId: id,
          payload: { audience: "team", from, to: staffId, by: actor.id },
        }),
      ),
    ...(ctx.settings.notifyCustomerOnReassign
      ? [
          enqueueEmail(db, {
            template: "reassigned",
            to: current.contactEmail,
            dedupeKey: `reassigned-customer:${id}:v${newVersion}`,
            reservationId: id,
            payload: { audience: "customer", to: staffId },
          }),
        ]
      : []),
    audit(db, {
      actorKind: "staff",
      actor: String(actor.id),
      action: "reservation.reassigned",
      reservationId: id,
      customerId: current.customer.id,
      details: { from, to: staffId },
    }),
  ]);
  return (await getReservation(db, id))!;
}
