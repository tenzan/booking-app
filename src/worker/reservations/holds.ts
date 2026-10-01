import type { ScheduleCtx } from "../scheduling/context";
import { assertSql } from "../lib/db";
import { rangeBlocks } from "../../domain/slots";

/** Customer account and contact are both still active for this contact email. Binds: customerId, email. */
export const ELIGIBLE_SQL = `SELECT 1 FROM customers c JOIN customer_contacts k ON k.customer_id = c.id
  WHERE c.id = ? AND c.active = 1 AND k.active = 1 AND k.email = ?`;

/** One statement inserting all of a hold's 5-minute blocks (epoch minutes) for `staffId`: a reservation's, or a proposal option's. */
export function blockInsert(
  db: D1Database,
  staffId: number,
  minutes: number[],
  ownerId: string,
  ownerKind: "reservation" | "option" = "reservation",
): D1PreparedStatement {
  return db
    .prepare("INSERT INTO tech_blocks(staff_id, block_start, owner_kind, owner_id) SELECT ?, value, ?, ? FROM json_each(?)")
    .bind(staffId, ownerKind, ownerId, JSON.stringify(minutes));
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

/** Queued mail about a reservation that is wrong once it is closed: reminders and confirmation-type messages. */
export const OBSOLETE_TEMPLATES = [
  "appointment_reminder",
  "approval_reminder",
  "approval_escalation",
  "request_received",
  "new_request",
  "confirmed",
  "assigned",
  "reassigned",
  "proposal",
] as const;

/**
 * The statements every closing of a reservation shares (cancel, expiry), to sit after the caller's in-batch assert and
 * before its own status update: delete the reservation's blocks, then the open proposal's option blocks (found through the
 * proposal, so before it is closed), then withdraw that proposal.
 */
export function releaseHoldStatements(db: D1Database, id: string, now: number): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM tech_blocks WHERE owner_kind = 'reservation' AND owner_id = ?").bind(id),
    db
      .prepare(
        `DELETE FROM tech_blocks WHERE owner_kind = 'option' AND owner_id IN (
           SELECT o.id FROM proposal_options o JOIN proposals p ON p.id = o.proposal_id WHERE p.reservation_id = ? AND p.status = 'open')`,
      )
      .bind(id),
    db.prepare("UPDATE proposals SET status = 'withdrawn', resolved_at = ? WHERE reservation_id = ? AND status = 'open'").bind(now, id),
  ];
}

/** Cancels the reservation's queued mail that a closing makes wrong (see OBSOLETE_TEMPLATES). */
export function cancelObsoleteMail(db: D1Database, id: string): D1PreparedStatement {
  const templates = OBSOLETE_TEMPLATES.map(() => "?").join(",");
  return db
    .prepare(`UPDATE email_jobs SET status = 'cancelled' WHERE reservation_id = ? AND status = 'queued' AND template IN (${templates})`)
    .bind(id, ...OBSOLETE_TEMPLATES);
}
