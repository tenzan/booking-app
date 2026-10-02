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
import { activeStaffByIds, noticeRecipients, notifyStaff } from "../repos/staff";
import { loadScheduleCtx } from "../scheduling/context";
import { blockInsert, ELIGIBLE_SQL, movedPending, movePendingStatements } from "./holds";
import { closeProposalStatements } from "./propose";
import { cancelReplacedStatements } from "./replacement";

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
  replaces_id: string | null;
}

async function findByIdempotencyKey(env: Env, email: string, input: SubmitInput): Promise<SubmitResult | null> {
  const row = await env.DB.prepare(
    "SELECT id, ref, status, customer_id, contact_email, start_at, end_at, replaces_id FROM reservations WHERE idempotency_key = ?",
  )
    .bind(input.idempotencyKey)
    .first<ExistingRow>();
  if (!row) return null;
  if (
    row.customer_id !== input.customerId ||
    row.contact_email.toLowerCase() !== email.toLowerCase() ||
    !(await sameReplacement(env.DB, row.replaces_id, input.replacesId ?? null))
  ) {
    throw new HttpError(409, "idempotency_conflict");
  }
  return { id: row.id, ref: row.ref, status: row.status, startAt: row.start_at, endAt: row.end_at, created: false };
}

/**
 * Was a request stored with `stored` as its original made by a submit asking to replace `asked`? The same id, or (a
 * superseding submit stores the root original) a pending change request of that original.
 */
async function sameReplacement(db: D1Database, stored: string | null, asked: string | null): Promise<boolean> {
  if (stored === asked) return true;
  if (stored === null || asked === null) return false;
  return (await db.prepare("SELECT replaces_id FROM reservations WHERE id = ?").bind(asked).first<string | null>("replaces_id")) === stored;
}

/**
 * Create a pending request for `input.startAt`, atomically and idempotently.
 * Everything runs in one db.batch() that is guarded by the schedule version read before the schedule data,
 * so concurrent capacity changes (including the per-account active limit) serialize through retries.
 *
 * With `replacesId` it is a replacement request ("choose another time"): the original must be a pending or confirmed
 * reservation of the same account that has not started (404 otherwise, indistinguishable from unknown; 409
 * original_not_active once closed or started) with no other pending replacement (409 replacement_exists). The original
 * keeps its time until the replacement is approved, and the original's open proposal is rejected (its options released,
 * the team told) in the same batch. When the chosen reservation is itself a pending change request of a still-active
 * original, the new request changes that change: in the same batch the earlier request is cancelled ('superseded', its
 * holds released, no cancellation email) and the new one replaces the root original, so an account never holds more
 * than an original plus one pending change of it.
 *
 * Max-active: a pending replacement whose original is still active never counts (the original does), neither for the
 * replacement itself nor for later requests.
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

  const plan = input.replacesId === undefined ? null : await planReplacement(db, input.replacesId, input.customerId, now);
  if (!plan) {
    const active = await db
      // An appointment that has already ended no longer counts, even before it is marked completed; nor does a pending
      // change request while the reservation it changes is still active (that one counts).
      .prepare(
        `SELECT COUNT(*) AS n FROM reservations r
         WHERE r.customer_id = ?1 AND r.status IN ('pending','confirmed') AND r.end_at > ?2
           AND NOT (r.status = 'pending' AND r.replaces_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM reservations o WHERE o.id = r.replaces_id AND o.status IN ('pending','confirmed') AND o.end_at > ?2))`,
      )
      .bind(input.customerId, now)
      .first<{ n: number }>();
    if ((active?.n ?? 0) >= ctx.settings.maxActivePerAccount) throw new HttpError(409, "limit_reached");
  }
  const original = plan?.original ?? null;

  if (input.startAt < minNoticeAt(now, ctx.settings, ctx.bh)) throw new HttpError(400, "too_soon");
  const lastDate = addDays(utcToWall(now, env.APP_TIMEZONE).date, ctx.settings.bookingHorizonDays);
  if (utcToWall(input.startAt, env.APP_TIMEZONE).date > lastDate) throw new HttpError(409, "slot_unavailable");

  const slot = findSlot(ctx.slots, input.startAt);
  if (!slot) throw new HttpError(409, "slot_unavailable");

  const id = uuid();
  const [occStart, occEnd] = occupiedRange(slot.startAt, slot.endAt, ctx.cfg);
  const newHold: Hold = { id, start: occStart, end: occEnd, fixed: null, eligible: slot.staffIds, preferred: null };
  // A replacement releases, in the same batch and before its own blocks go in, the original's open proposal and a
  // superseded change request (with its own open proposal): those holds don't count.
  const released = new Set(plan?.releasedIds ?? []);
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
  // The held times a replacement releases: everyone who follows requests and the technicians involved hear of it.
  const proposalTeam = original?.openProposalId
    ? noticeRecipients(staff, await activeStaffByIds(db, [...(original.assignedStaffId !== null ? [original.assignedStaffId] : []), ...original.openOptionStaff]))
    : [];
  const supersedesRef = plan?.superseded ? { supersedesRef: plan.superseded.ref } : {};

  await capacityBatch(db, ctx.version, [
    assertSql(db, ELIGIBLE_SQL, input.customerId, email),
    // Aborts (and retries into the check above) when booking was paused after our settings snapshot.
    assertSql(db, "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'bookingEnabled' AND value = 'false')"),
    ...(plan ? replacementStatements(db, plan, { replacementId: id, email, customerId: input.customerId, now, team: proposalTeam }) : []),
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
    enqueueEmail(db, { template: "request_received", to: email, dedupeKey: `received:${id}`, reservationId: id, payload: supersedesRef }),
    ...staff.map((s) => enqueueEmail(db, { template: "new_request", to: s.email, dedupeKey: `new:${id}:${s.id}`, reservationId: id, payload: supersedesRef })),
    audit(db, {
      actorKind: "customer",
      actor: email,
      action: "reservation.requested",
      reservationId: id,
      customerId: input.customerId,
      details: {
        startAt: slot.startAt,
        provisionalStaffId: staffId,
        ...(original ? { replacesId: original.id } : {}),
        ...(plan?.superseded ? { supersedes: plan.superseded.id } : {}),
      },
    }),
  ]);
  return { id, ref, status: "pending", startAt: slot.startAt, endAt: slot.endAt, created: true };
}

interface ReplacedRow {
  id: string;
  ref: string;
  status: "pending" | "confirmed";
  version: number;
  start_at: number;
  replaces_id: string | null;
  assigned_staff_id: number | null;
  open_proposal_id: string | null;
}

interface ReplacementPlan {
  /** The reservation being changed (the root original when a pending change request is superseded). */
  original: {
    id: string;
    status: "pending" | "confirmed";
    assignedStaffId: number | null;
    /** Its open proposal, rejected by the replacement, and that proposal's technicians. */
    openProposalId: string | null;
    openOptionStaff: number[];
  };
  /** The original's pending change request that this one supersedes. */
  superseded: { id: string; ref: string; version: number; openProposalId: string | null } | null;
  /** Holds the batch releases: the original's open options; the superseded request and its open options. */
  releasedIds: string[];
}

/** The replacement a submit with `replacesId` makes, checked as described on submitReservation. */
async function planReplacement(db: D1Database, replacesId: string, customerId: number, now: number): Promise<ReplacementPlan> {
  const load = (id: string) =>
    db
      .prepare(
        `SELECT r.id, r.ref, r.status, r.version, r.start_at, r.replaces_id, r.assigned_staff_id,
                (SELECT p.id FROM proposals p WHERE p.reservation_id = r.id AND p.status = 'open') AS open_proposal_id
         FROM reservations r WHERE r.id = ? AND r.customer_id = ?`,
      )
      .bind(id, customerId)
      .first<ReplacedRow>();
  const active = (r: ReplacedRow | null): r is ReplacedRow => r !== null && (r.status === "pending" || r.status === "confirmed") && r.start_at > now;
  const options = async (proposalId: string | null) =>
    proposalId
      ? (await db.prepare("SELECT id, staff_id FROM proposal_options WHERE proposal_id = ?").bind(proposalId).all<{ id: string; staff_id: number }>()).results
      : [];

  const chosen = await load(replacesId);
  if (!chosen) throw new HttpError(404, "not_found");
  if (!active(chosen)) throw new HttpError(409, "original_not_active");
  let original = chosen;
  let superseded: ReplacedRow | null = null;
  if (chosen.status === "pending" && chosen.replaces_id !== null) {
    // A change of a change: replace the root original instead, superseding this pending request.
    const root = await load(chosen.replaces_id);
    if (active(root)) {
      original = root;
      superseded = chosen;
    }
  }
  const other = await db
    .prepare("SELECT 1 FROM reservations WHERE replaces_id = ? AND status = 'pending' AND id IS NOT ?")
    .bind(original.id, superseded?.id ?? null)
    .first();
  if (other) throw new HttpError(409, "replacement_exists");

  const originalOptions = await options(original.open_proposal_id);
  const supersededOptions = superseded ? await options(superseded.open_proposal_id) : [];
  return {
    original: {
      id: original.id,
      status: original.status,
      assignedStaffId: original.assigned_staff_id,
      openProposalId: original.open_proposal_id,
      openOptionStaff: originalOptions.map((o) => o.staff_id),
    },
    superseded: superseded ? { id: superseded.id, ref: superseded.ref, version: superseded.version, openProposalId: superseded.open_proposal_id } : null,
    releasedIds: [...originalOptions.map((o) => o.id), ...(superseded ? [superseded.id, ...supersededOptions.map((o) => o.id)] : [])],
  };
}

/**
 * In-batch checks and writes of a replacement request: the original is as read and still active, and it has no other
 * pending change request; a superseded request is cancelled; the original's open proposal (if any) is rejected, its
 * options released and the team told, or still none is open.
 */
function replacementStatements(
  db: D1Database,
  plan: ReplacementPlan,
  o: { replacementId: string; email: string; customerId: number; now: number; team: Array<{ id: number; email: string }> },
): D1PreparedStatement[] {
  const { original, superseded } = plan;
  return [
    assertSql(db, "SELECT 1 FROM reservations WHERE id = ? AND status = ? AND start_at > ?", original.id, original.status, o.now),
    assertSql(
      db,
      "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM reservations WHERE replaces_id = ? AND status = 'pending' AND id IS NOT ?)",
      original.id,
      superseded?.id ?? null,
    ),
    // The superseded request's own open proposal was answered by this request: rejected (not just withdrawn).
    ...(superseded?.openProposalId ? closeProposalStatements(db, superseded.id, superseded.openProposalId, "rejected", o.now) : []),
    ...(superseded
      ? cancelReplacedStatements(db, { id: superseded.id, status: "pending", version: superseded.version }, {
          by: { kind: "customer", id: o.email },
          reason: "superseded",
          replacementId: o.replacementId,
          customerId: o.customerId,
          now: o.now,
        })
      : []),
    ...(original.openProposalId
      ? [
          ...closeProposalStatements(db, original.id, original.openProposalId, "rejected", o.now),
          ...o.team.map((m) =>
            enqueueEmail(db, {
              template: "proposal_outcome",
              to: m.email,
              dedupeKey: `proposal-outcome-team:${original.openProposalId}:${m.id}`,
              reservationId: original.id,
              payload: { audience: "team", proposalId: original.openProposalId, outcome: "rejected", via: "replacement" },
            }),
          ),
          audit(db, {
            actorKind: "customer",
            actor: o.email,
            action: "reservation.proposal_rejected",
            reservationId: original.id,
            customerId: o.customerId,
            details: { proposalId: original.openProposalId, via: "replacement", replacementId: o.replacementId },
          }),
        ]
      : [assertSql(db, "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM proposals WHERE reservation_id = ? AND status = 'open')", original.id)]),
  ];
}
