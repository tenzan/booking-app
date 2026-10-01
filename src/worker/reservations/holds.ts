import type { Hold } from "../../domain/matching";
import type { ScheduleCtx } from "../scheduling/context";

/** Customer account and contact are both still active for this contact email. Binds: customerId, email. */
export const ELIGIBLE_SQL = `SELECT 1 FROM customers c JOIN customer_contacts k ON k.customer_id = c.id
  WHERE c.id = ? AND c.active = 1 AND k.active = 1 AND k.email = ?`;

/** A hold's range already includes its buffers when it comes from the schedule context. */
export const NO_BUFFER = { bufferBeforeMin: 0, bufferAfterMin: 0 };

export function blockInserts(db: D1Database, staffId: number, minutes: number[], ownerId: string): D1PreparedStatement[] {
  return minutes.map((m) =>
    db.prepare("INSERT INTO tech_blocks(staff_id, block_start, owner_kind, owner_id) VALUES (?, ?, 'reservation', ?)").bind(staffId, m, ownerId),
  );
}

export interface MovedHold {
  holdId: string;
  /** Old provisional technician. */
  fromStaffId: number | null;
  staffId: number;
  hold: Hold;
}

/** Pending requests (other than `exceptId`) whose provisional technician changes under `assignment`. */
export function movedPending(ctx: ScheduleCtx, assignment: Map<string, number>, exceptId?: string): MovedHold[] {
  const moved: MovedHold[] = [];
  for (const [holdId, newStaff] of assignment) {
    const owner = ctx.holdOwners.get(holdId);
    if (holdId === exceptId || !owner || owner.kind !== "reservation" || owner.status !== "pending" || owner.staffId === newStaff) continue;
    moved.push({ holdId, fromStaffId: owner.staffId, staffId: newStaff, hold: ctx.holds.find((h) => h.id === holdId)! });
  }
  return moved;
}
