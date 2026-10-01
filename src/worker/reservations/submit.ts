import { approvalDeadlines, minNoticeAt } from "../../domain/deadlines";
import { component, solve, type Hold } from "../../domain/matching";
import { newRef } from "../../domain/ref";
import { findSlot, occupiedRange, rangeBlocks } from "../../domain/slots";
import { addDays, utcToWall } from "../../domain/time";
import type { Env } from "../env";
import { clock } from "../lib/clock";
import { uuid } from "../lib/crypto";
import { assertSql, audit, capacityBatch, withRetry } from "../lib/db";
import { HttpError } from "../lib/http";
import { enqueueEmail } from "../mail/outbox";
import { notifyStaff } from "../repos/staff";
import { loadScheduleCtx } from "../scheduling/context";
import { blockInsert, ELIGIBLE_SQL, movedPending, movePendingStatements } from "./holds";
import { closeProposalStatements } from "./propose";

export interface SubmitInput {
  customerId: number;
  startAt: number;
  contactName: string;
  phone: string;
  issue: string;
  idempotencyKey: string;
  /** Asks to change this pending or confirmed reservation of the same account ("choose another time"). */
  replacesId?: string;
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
 *
 * With `replacesId` it is a replacement request ("choose another time"): the original must be a pending or confirmed
 * reservation of the same account that has not started (404 otherwise, indistinguishable from unknown; 409
 * original_not_active once closed or started)
 * with no other pending replacement (409 replacement_exists). It does not count against the per-account limit, the
 * original keeps its time until the replacement is approved, and the original's open proposal is rejected (its options
 * released) in the same batch.
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

  const original = input.replacesId === undefined ? null : await loadOriginal(db, input.replacesId, input.customerId, now);
  if (!original) {
    const active = await db
      // An appointment that has already ended no longer counts, even before it is marked completed.
      .prepare("SELECT COUNT(*) AS n FROM reservations WHERE customer_id = ? AND status IN ('pending','confirmed') AND end_at > ?")
      .bind(input.customerId, now)
      .first<{ n: number }>();
    if ((active?.n ?? 0) >= ctx.settings.maxActivePerAccount) throw new HttpError(409, "limit_reached");
  }

  if (input.startAt < minNoticeAt(now, ctx.settings, ctx.bh)) throw new HttpError(400, "too_soon");
  const lastDate = addDays(utcToWall(now, env.APP_TIMEZONE).date, ctx.settings.bookingHorizonDays);
  if (utcToWall(input.startAt, env.APP_TIMEZONE).date > lastDate) throw new HttpError(409, "slot_unavailable");

  const slot = findSlot(ctx.slots, input.startAt);
  if (!slot) throw new HttpError(409, "slot_unavailable");

  const id = uuid();
  const [occStart, occEnd] = occupiedRange(slot.startAt, slot.endAt, ctx.cfg);
  const newHold: Hold = { id, start: occStart, end: occEnd, fixed: null, eligible: slot.staffIds, preferred: null };
  // A replacement releases the original's open proposal in the same batch (before its own blocks go in): those options don't count.
  const released = new Set(original?.openOptionIds ?? []);
  const holds = ctx.holds.filter((h) => !released.has(h.id));
  const assignment = solve(component([...holds, newHold], occStart, occEnd));
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
    ...(original ? replacementStatements(db, original, id, email, input.customerId, now) : []),
    ...movePendingStatements(db, moved, now),
    db
      .prepare(
        `INSERT INTO reservations(id, ref, customer_id, contact_email, contact_name, phone, issue, start_at, end_at, occ_start, occ_end, status,
           provisional_staff_id, idempotency_key, approval_reminder_at, escalation_at, expires_at, created_at, updated_at, replaces_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id, ref, input.customerId, email, input.contactName, input.phone, input.issue, slot.startAt, slot.endAt, occStart, occEnd,
        staffId, input.idempotencyKey, deadlines.reminderAt, deadlines.escalationAt, deadlines.expiresAt, now, now, original?.id ?? null,
      ),
    blockInsert(db, staffId, rangeBlocks(occStart, occEnd), id),
    enqueueEmail(db, { template: "request_received", to: email, dedupeKey: `received:${id}`, reservationId: id }),
    ...staff.map((s) => enqueueEmail(db, { template: "new_request", to: s.email, dedupeKey: `new:${id}:${s.id}`, reservationId: id })),
    audit(db, {
      actorKind: "customer",
      actor: email,
      action: "reservation.requested",
      reservationId: id,
      customerId: input.customerId,
      details: { startAt: slot.startAt, provisionalStaffId: staffId, ...(original ? { replacesId: original.id } : {}) },
    }),
  ]);
  return { id, ref, status: "pending", startAt: slot.startAt, endAt: slot.endAt, created: true };
}

interface Original {
  id: string;
  status: string;
  /** The original's open proposal, rejected by the replacement, and its options. */
  openProposalId: string | null;
  openOptionIds: string[];
}

/** The reservation a replacement request asks to change, checked as described on submitReservation. */
async function loadOriginal(db: D1Database, id: string, customerId: number, now: number): Promise<Original> {
  const row = await db
    .prepare(
      `SELECT r.status, r.start_at,
              (SELECT p.id FROM proposals p WHERE p.reservation_id = r.id AND p.status = 'open') AS open_proposal_id,
              EXISTS (SELECT 1 FROM reservations x WHERE x.replaces_id = r.id AND x.status = 'pending') AS has_replacement
       FROM reservations r WHERE r.id = ? AND r.customer_id = ?`,
    )
    .bind(id, customerId)
    .first<{ status: string; start_at: number; open_proposal_id: string | null; has_replacement: number }>();
  if (!row) throw new HttpError(404, "not_found");
  if ((row.status !== "pending" && row.status !== "confirmed") || row.start_at <= now) throw new HttpError(409, "original_not_active");
  if (row.has_replacement) throw new HttpError(409, "replacement_exists");
  const { results: options } = row.open_proposal_id
    ? await db.prepare("SELECT id FROM proposal_options WHERE proposal_id = ?").bind(row.open_proposal_id).all<{ id: string }>()
    : { results: [] };
  return { id, status: row.status, openProposalId: row.open_proposal_id, openOptionIds: options.map((o) => o.id) };
}

/**
 * In-batch checks and writes of a replacement request: the original is as read and has no other pending replacement;
 * its open proposal (if any) is rejected and its options released, or still none is open.
 */
function replacementStatements(db: D1Database, original: Original, replacementId: string, email: string, customerId: number, now: number): D1PreparedStatement[] {
  return [
    assertSql(db, "SELECT 1 FROM reservations WHERE id = ? AND status = ?", original.id, original.status),
    assertSql(db, "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM reservations WHERE replaces_id = ? AND status = 'pending')", original.id),
    ...(original.openProposalId
      ? [
          ...closeProposalStatements(db, original.id, original.openProposalId, "rejected", now),
          audit(db, {
            actorKind: "customer",
            actor: email,
            action: "reservation.proposal_rejected",
            reservationId: original.id,
            customerId,
            details: { proposalId: original.openProposalId, via: "replacement", replacementId },
          }),
        ]
      : [assertSql(db, "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM proposals WHERE reservation_id = ? AND status = 'open')", original.id)]),
  ];
}
