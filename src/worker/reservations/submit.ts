import { approvalDeadlines, minNoticeAt } from "../../domain/deadlines";
import { component, solve, type Hold } from "../../domain/matching";
import { newRef } from "../../domain/ref";
import { blockMinutes, findSlot, occupiedRange } from "../../domain/slots";
import { addDays, utcToWall } from "../../domain/time";
import type { Env } from "../env";
import { clock } from "../lib/clock";
import { uuid } from "../lib/crypto";
import { assertSql, audit, capacityBatch, withRetry } from "../lib/db";
import { HttpError } from "../lib/http";
import { enqueueEmail } from "../mail/outbox";
import { notifyStaff } from "../repos/staff";
import { loadScheduleCtx } from "../scheduling/context";
import { blockInserts, ELIGIBLE_SQL, movedPending, NO_BUFFER } from "./holds";

export interface SubmitInput {
  customerId: number;
  startAt: number;
  contactName: string;
  phone: string;
  issue: string;
  idempotencyKey: string;
}

export interface SubmitResult {
  id: string;
  ref: string;
  status: string;
  startAt: number;
  endAt: number;
  created: boolean;
}

interface ExistingRow {
  id: string;
  ref: string;
  status: string;
  customer_id: number;
  contact_email: string;
  start_at: number;
  end_at: number;
}

async function findByIdempotencyKey(env: Env, email: string, input: SubmitInput): Promise<SubmitResult | null> {
  const row = await env.DB.prepare(
    "SELECT id, ref, status, customer_id, contact_email, start_at, end_at FROM reservations WHERE idempotency_key = ?",
  )
    .bind(input.idempotencyKey)
    .first<ExistingRow>();
  if (!row) return null;
  if (row.customer_id !== input.customerId || row.contact_email.toLowerCase() !== email.toLowerCase()) {
    throw new HttpError(409, "idempotency_conflict");
  }
  return { id: row.id, ref: row.ref, status: row.status, startAt: row.start_at, endAt: row.end_at, created: false };
}

/**
 * Create a pending request for `input.startAt`, atomically and idempotently.
 * Everything runs in one db.batch() that is guarded by the schedule version read before the schedule data,
 * so concurrent capacity changes (including the per-account active limit) serialize through retries.
 */
export async function submitReservation(env: Env, email: string, input: SubmitInput): Promise<SubmitResult> {
  try {
    return await withRetry(() => attempt(env, email, input));
  } catch (e) {
    // A concurrent duplicate with the same idempotency key won the race: return what it created.
    if (e instanceof Error && e.message.includes("UNIQUE constraint failed: reservations.idempotency_key")) {
      const existing = await findByIdempotencyKey(env, email, input);
      if (existing) return existing;
    }
    throw e;
  }
}

async function attempt(env: Env, email: string, input: SubmitInput): Promise<SubmitResult> {
  const db = env.DB;
  const existing = await findByIdempotencyKey(env, email, input);
  if (existing) return existing;

  if (!(await db.prepare(ELIGIBLE_SQL).bind(input.customerId, email).first())) throw new HttpError(403, "not_eligible");

  const ctx = await loadScheduleCtx(env, input.startAt, input.startAt);
  // Re-read on every attempt: a pause flipped while we were working is respected (the batch guard below catches the final window).
  if (!ctx.settings.bookingEnabled) throw new HttpError(409, "booking_disabled");
  const now = clock.now();

  const active = await db
    // An appointment that has already ended no longer counts, even before it is marked completed.
    .prepare("SELECT COUNT(*) AS n FROM reservations WHERE customer_id = ? AND status IN ('pending','confirmed') AND end_at > ?")
    .bind(input.customerId, now)
    .first<{ n: number }>();
  if ((active?.n ?? 0) >= ctx.settings.maxActivePerAccount) throw new HttpError(409, "limit_reached");

  if (input.startAt < minNoticeAt(now, ctx.settings, ctx.bh)) throw new HttpError(400, "too_soon");
  const lastDate = addDays(utcToWall(now, env.APP_TIMEZONE).date, ctx.settings.bookingHorizonDays);
  if (utcToWall(input.startAt, env.APP_TIMEZONE).date > lastDate) throw new HttpError(409, "slot_unavailable");

  const slot = findSlot(ctx.slots, input.startAt);
  if (!slot) throw new HttpError(409, "slot_unavailable");

  const id = uuid();
  const [occStart, occEnd] = occupiedRange(slot.startAt, slot.endAt, ctx.cfg);
  const newHold: Hold = { id, start: occStart, end: occEnd, fixed: null, eligible: slot.staffIds, preferred: null };
  const assignment = solve(component([...ctx.holds, newHold], occStart, occEnd));
  if (!assignment) throw new HttpError(409, "slot_unavailable");
  const staffId = assignment.get(id)!;

  // Pending requests whose provisional technician changes: free their blocks first, then re-insert,
  // so swaps never collide on the (staff_id, block_start) key within the batch.
  const moved = movedPending(ctx, assignment);

  const deadlines = approvalDeadlines(now, slot.startAt, ctx.settings, ctx.bh);
  const ref = newRef();
  const staff = await notifyStaff(db);

  await capacityBatch(db, ctx.version, [
    assertSql(db, ELIGIBLE_SQL, input.customerId, email),
    // Aborts (and retries into the check above) when booking was paused after our settings snapshot.
    assertSql(db, "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'bookingEnabled' AND value = 'false')"),
    ...moved.map((m) =>
      assertSql(db, "SELECT 1 FROM reservations WHERE id = ? AND status = 'pending' AND provisional_staff_id IS ?", m.holdId, m.fromStaffId),
    ),
    ...moved.map((m) => db.prepare("DELETE FROM tech_blocks WHERE owner_kind = 'reservation' AND owner_id = ?").bind(m.holdId)),
    ...moved.map((m) =>
      db.prepare("UPDATE reservations SET provisional_staff_id = ?, updated_at = ? WHERE id = ? AND status = 'pending'").bind(m.staffId, now, m.holdId),
    ),
    ...moved.flatMap((m) => blockInserts(db, m.staffId, blockMinutes(m.hold.start, m.hold.end, NO_BUFFER), m.holdId)),
    db
      .prepare(
        `INSERT INTO reservations(id, ref, customer_id, contact_email, contact_name, phone, issue, start_at, end_at, status,
           provisional_staff_id, idempotency_key, approval_reminder_at, escalation_at, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id, ref, input.customerId, email, input.contactName, input.phone, input.issue, slot.startAt, slot.endAt,
        staffId, input.idempotencyKey, deadlines.reminderAt, deadlines.escalationAt, deadlines.expiresAt, now, now,
      ),
    ...blockInserts(db, staffId, blockMinutes(slot.startAt, slot.endAt, ctx.cfg), id),
    enqueueEmail(db, { template: "request_received", to: email, dedupeKey: `received:${id}`, reservationId: id }),
    ...staff.map((s) => enqueueEmail(db, { template: "new_request", to: s.email, dedupeKey: `new:${id}:${s.id}`, reservationId: id })),
    audit(db, {
      actorKind: "customer",
      actor: email,
      action: "reservation.requested",
      reservationId: id,
      customerId: input.customerId,
      details: { startAt: slot.startAt, provisionalStaffId: staffId },
    }),
  ]);
  return { id, ref, status: "pending", startAt: slot.startAt, endAt: slot.endAt, created: true };
}
