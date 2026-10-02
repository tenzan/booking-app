import type { ReservationDTO } from "../../shared/types";
import { assertSql, audit } from "../lib/db";
import type { ScheduleCtx } from "../scheduling/context";
import { cancelObsoleteMail, releaseHoldStatements } from "./holds";

/**
 * The reservation a replacement request asks to change, while it is still active: pending or confirmed and not yet
 * started (the same notion submit uses when the replacement is requested).
 */
export interface ActiveOriginal {
  id: string;
  ref: string;
  status: "pending" | "confirmed";
  version: number;
  startAt: number;
  assignedStaffId: number | null;
}

/** `replacesId` of reservation `id`, with that original when it is still active (null when it is not, or there is none). */
export async function replacedBy(db: D1Database, id: string, now: number): Promise<{ replacesId: string | null; original: ActiveOriginal | null }> {
  const row = await db
    .prepare(
      `SELECT r.replaces_id, o.ref, o.status, o.version, o.start_at, o.assigned_staff_id
       FROM reservations r LEFT JOIN reservations o ON o.id = r.replaces_id WHERE r.id = ?`,
    )
    .bind(id)
    .first<{ replaces_id: string | null; ref: string | null; status: string | null; version: number; start_at: number; assigned_staff_id: number | null }>();
  if (!row?.replaces_id) return { replacesId: null, original: null };
  const active = (row.status === "pending" || row.status === "confirmed") && row.start_at > now;
  return {
    replacesId: row.replaces_id,
    original: active
      ? { id: row.replaces_id, ref: row.ref!, status: row.status as ActiveOriginal["status"], version: row.version, startAt: row.start_at, assignedStaffId: row.assigned_staff_id }
      : null,
  };
}

/**
 * Holds a staff decision on `r` (approve, reassign) releases in its own batch, so they must not stand in its way: the
 * options of `r`'s open proposal (withdrawn), and for an approved replacement the original's hold and its open options
 * (the original is cancelled).
 */
export function releasedHolds(ctx: ScheduleCtx, r: ReservationDTO, original: ActiveOriginal | null): Set<string> {
  const out = new Set(r.proposal?.status === "open" ? r.proposal.options.map((o) => o.id) : []);
  if (original) {
    out.add(original.id);
    for (const [holdId, owner] of ctx.holdOwners) if (owner.kind === "option" && owner.ref === original.ref) out.add(holdId);
  }
  return out;
}

/**
 * Close a reservation another one takes over, inside the batch that does it: assert it is as read, release its hold and
 * open proposal, cancel it with `reason` and cancel its obsolete queued mail. No cancellation emails: the batch that
 * closes it tells the customer and the team. Used when a replacement is confirmed ('rescheduled': the original, with
 * `replacementId`), when a newer change request supersedes a pending one ('superseded', with `replacementId`), and when
 * an original is cancelled with its pending change request ('original_cancelled': the request, with `originalId`).
 */
export function cancelReplacedStatements(
  db: D1Database,
  target: { id: string; status: "pending" | "confirmed"; version: number },
  o: {
    by: { kind: "staff" | "customer"; id: string };
    reason: "rescheduled" | "superseded" | "original_cancelled";
    replacementId?: string;
    originalId?: string;
    customerId: number;
    now: number;
  },
): D1PreparedStatement[] {
  return [
    assertSql(db, "SELECT 1 FROM reservations WHERE id = ? AND status = ? AND version = ?", target.id, target.status, target.version),
    ...releaseHoldStatements(db, target.id, o.now),
    db
      .prepare(
        `UPDATE reservations SET status = 'cancelled', closed_at = ?, closed_by_kind = ?, closed_by = ?, close_reason = ?,
           provisional_staff_id = NULL, version = version + 1, updated_at = ?
         WHERE id = ? AND status = ? AND version = ?`,
      )
      .bind(o.now, o.by.kind, o.by.id, o.reason, o.now, target.id, target.status, target.version),
    cancelObsoleteMail(db, target.id),
    audit(db, {
      actorKind: o.by.kind,
      actor: o.by.id,
      action: "reservation.cancelled",
      reservationId: target.id,
      customerId: o.customerId,
      details: {
        reason: o.reason,
        from: target.status,
        ...(o.replacementId !== undefined ? { replacedBy: o.replacementId } : {}),
        ...(o.originalId !== undefined ? { original: o.originalId } : {}),
      },
    }),
  ];
}
