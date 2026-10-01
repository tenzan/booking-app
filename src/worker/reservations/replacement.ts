import type { ReservationDTO } from "../../shared/types";
import type { ScheduleCtx } from "../scheduling/context";

/** The reservation a replacement request asks to change, while it is still pending or confirmed. */
export interface ActiveOriginal {
  id: string;
  ref: string;
  status: "pending" | "confirmed";
  version: number;
  startAt: number;
  assignedStaffId: number | null;
}

/** `replacesId` of reservation `id`, with that original when it is still active (null when it is not, or there is none). */
export async function replacedBy(db: D1Database, id: string): Promise<{ replacesId: string | null; original: ActiveOriginal | null }> {
  const row = await db
    .prepare(
      `SELECT r.replaces_id, o.ref, o.status, o.version, o.start_at, o.assigned_staff_id
       FROM reservations r LEFT JOIN reservations o ON o.id = r.replaces_id WHERE r.id = ?`,
    )
    .bind(id)
    .first<{ replaces_id: string | null; ref: string | null; status: string | null; version: number; start_at: number; assigned_staff_id: number | null }>();
  if (!row?.replaces_id) return { replacesId: null, original: null };
  const active = row.status === "pending" || row.status === "confirmed";
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
