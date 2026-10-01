import type { ScheduleCtx } from "../scheduling/context";
import { assertSql } from "../lib/db";
import { rangeBlocks } from "../../domain/slots";

/** Customer account and contact are both still active for this contact email. Binds: customerId, email. */
export const ELIGIBLE_SQL = `SELECT 1 FROM customers c JOIN customer_contacts k ON k.customer_id = c.id
  WHERE c.id = ? AND c.active = 1 AND k.active = 1 AND k.email = ?`;

/** One statement inserting all of a reservation's 5-minute blocks (epoch minutes) for `staffId`. */
export function blockInsert(db: D1Database, staffId: number, minutes: number[], ownerId: string): D1PreparedStatement {
  return db
    .prepare("INSERT INTO tech_blocks(staff_id, block_start, owner_kind, owner_id) SELECT ?, value, 'reservation', ? FROM json_each(?)")
    .bind(staffId, ownerId, JSON.stringify(minutes));
}

/** A pending request whose provisional technician changes, with its stored occupied range. */
export interface PendingMove {
  id: string;
  /** Old provisional technician. */
  from: number | null;
  to: number;
  occStart: number;
  occEnd: number;
}

/**
 * Batch statements moving pending requests: assert each is still pending with its old technician, free every
 * moved hold's blocks first, then update and re-insert, so swaps never collide on (staff_id, block_start).
 */
export function movePendingStatements(db: D1Database, moves: PendingMove[], now: number): D1PreparedStatement[] {
  return [
    ...moves.map((m) => assertSql(db, "SELECT 1 FROM reservations WHERE id = ? AND status = 'pending' AND provisional_staff_id IS ?", m.id, m.from)),
    ...moves.map((m) => db.prepare("DELETE FROM tech_blocks WHERE owner_kind = 'reservation' AND owner_id = ?").bind(m.id)),
    ...moves.map((m) =>
      db.prepare("UPDATE reservations SET provisional_staff_id = ?, updated_at = ? WHERE id = ? AND status = 'pending'").bind(m.to, now, m.id),
    ),
    ...moves.map((m) => blockInsert(db, m.to, rangeBlocks(m.occStart, m.occEnd), m.id)),
  ];
}

/** Pending requests (other than `exceptId`) whose provisional technician changes under `assignment`. */
export function movedPending(ctx: ScheduleCtx, assignment: Map<string, number>, exceptId?: string): PendingMove[] {
  const moved: PendingMove[] = [];
  for (const [holdId, newStaff] of assignment) {
    const owner = ctx.holdOwners.get(holdId);
    if (holdId === exceptId || !owner || owner.kind !== "reservation" || owner.status !== "pending" || owner.staffId === newStaff) continue;
    const hold = ctx.holds.find((h) => h.id === holdId)!;
    moved.push({ id: holdId, from: owner.staffId, to: newStaff, occStart: hold.start, occEnd: hold.end });
  }
  return moved;
}
