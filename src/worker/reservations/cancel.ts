import { z } from "zod";
import { MIN } from "../../domain/time";
import type { Env, StaffPrincipal } from "../env";
import { clock } from "../lib/clock";
import { assertSql, audit, capacityBatch, readScheduleVersion, withRetry } from "../lib/db";
import { HttpError } from "../lib/http";
import { enqueueEmail } from "../mail/outbox";
import { getSettings } from "../repos/settings";
import { activeStaffByIds, noticeRecipients, notifyStaff } from "../repos/staff";
import { cancelObsoleteMail, releaseHoldStatements } from "./holds";
import { cancelReplacedStatements } from "./replacement";
import { customerView, getReservation, type CustomerReservationDTO, type ReservationDTO } from "./queries";

export type CancelActor = { kind: "staff"; staff: StaffPrincipal } | { kind: "customer"; email: string };

const REASON_MAX = 500;

/** Body of both customer cancel endpoints (the access-token one adds the token). */
export const customerCancelBody = z.object({ reason: z.string().max(REASON_MAX).optional(), version: z.number().int() });

/**
 * Cancel a pending or confirmed reservation: frees its blocks and any open proposal's option holds, closes the
 * reservation, cancels its obsolete queued mail and tells the customer and the team. A change request still pending on
 * it goes with it in the same batch (closed as 'original_cancelled'), and the one cancellation email covers both. Staff need a reason and may
 * cancel until the appointment ends; customers may give one and cancel before the start (confirmed appointments only
 * until `cancelCutoffMin` before it). Ownership is the caller's job. An already-cancelled reservation is returned
 * unchanged when asked at its current version or by a retry of the cancelling request itself (same actor, reason and
 * version); any other version that moved (a racing approval, or a second canceller) is 409 stale.
 */
export async function cancelReservation(
  env: Env,
  actor: CancelActor,
  id: string,
  input: { reason?: string; version: number },
): Promise<ReservationDTO> {
  const reason = input.reason?.trim() || null;
  if ((actor.kind === "staff" && !reason) || (reason && reason.length > REASON_MAX)) throw new HttpError(400, "invalid");
  return withRetry(() => attempt(env, actor, id, reason, input.version));
}

/** Did this actor, with this reason, cancel the reservation from `version` (the version a retry would still send)? */
async function isSameCancellation(db: D1Database, id: string, actor: CancelActor, reason: string | null, version: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT closed_by_kind, closed_by, close_reason, version FROM reservations WHERE id = ?")
    .bind(id)
    .first<{ closed_by_kind: string | null; closed_by: string | null; close_reason: string | null; version: number }>();
  const who = actor.kind === "staff" ? String(actor.staff.id) : actor.email;
  return row !== null && row.version === version + 1 && row.closed_by_kind === actor.kind && row.closed_by === who && row.close_reason === reason;
}

async function attempt(env: Env, actor: CancelActor, id: string, reason: string | null, version: number): Promise<ReservationDTO> {
  const db = env.DB;
  // Schedule version first, then the reservation: a change in between fails the guard and we retry.
  const scheduleVersion = await readScheduleVersion(db);
  const current = await getReservation(db, id);
  if (!current) throw new HttpError(404, "not_found");
  if (current.status === "cancelled") {
    // Unchanged for a caller who already sees it cancelled, or for a retry of the very request that cancelled it.
    // Anyone else working from an older version is told it changed: their reason was not sent.
    if (current.version === version || (await isSameCancellation(db, id, actor, reason, version))) return current;
    throw new HttpError(409, "stale", { current });
  }
  if ((current.status !== "pending" && current.status !== "confirmed") || current.version !== version) {
    throw new HttpError(409, "stale", { current });
  }

  const now = clock.now();
  if (actor.kind === "staff") {
    if (current.endAt <= now) throw new HttpError(409, "too_late");
  } else {
    if (current.startAt <= now) throw new HttpError(409, "too_late");
    if (current.status === "confirmed") {
      const { cancelCutoffMin, supportPhone } = await getSettings(db, env);
      if (current.startAt - cancelCutoffMin * MIN <= now) throw new HttpError(409, "past_cutoff", { cutoffMin: cancelCutoffMin, supportPhone });
    }
  }

  const closedBy = actor.kind === "staff" ? String(actor.staff.id) : actor.email;
  // Everyone who follows requests is told, and the technician the appointment is with whatever their notify setting.
  // A staff actor already knows.
  const involved = current.assignedStaff ? await activeStaffByIds(db, [current.assignedStaff.id]) : [];
  const team = noticeRecipients(await notifyStaff(db), involved, actor.kind === "staff" ? actor.staff.id : undefined);
  // The customer's change request for it, if one is waiting: nothing would be left for it to change.
  const replacement = await db
    .prepare("SELECT id, ref, version FROM reservations WHERE replaces_id = ? AND status = 'pending'")
    .bind(id)
    .first<{ id: string; ref: string; version: number }>();
  const mailPayload = replacement ? { alsoCancelledRef: replacement.ref } : {};

  await capacityBatch(db, scheduleVersion, [
    assertSql(db, "SELECT 1 FROM reservations WHERE id = ? AND status = ? AND version = ?", id, current.status, version),
    // No change request other than the one read (a racing one is caught here and the retry takes it along).
    assertSql(db, "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM reservations WHERE replaces_id = ? AND status = 'pending' AND id IS NOT ?)", id, replacement?.id ?? null),
    ...releaseHoldStatements(db, id, now),
    db
      .prepare(
        `UPDATE reservations SET status = 'cancelled', closed_at = ?, closed_by_kind = ?, closed_by = ?, close_reason = ?,
           provisional_staff_id = NULL, version = version + 1, updated_at = ?
         WHERE id = ? AND status = ? AND version = ?`,
      )
      .bind(now, actor.kind, closedBy, reason, now, id, current.status, version),
    cancelObsoleteMail(db, id),
    ...(replacement
      ? cancelReplacedStatements(
          db,
          { id: replacement.id, status: "pending", version: replacement.version },
          { by: { kind: actor.kind, id: closedBy }, reason: "original_cancelled", originalId: id, customerId: current.customer.id, now },
        )
      : []),
    enqueueEmail(db, {
      template: "cancelled",
      to: current.contactEmail,
      dedupeKey: `cancelled:${id}`,
      reservationId: id,
      payload: { audience: "customer", ...mailPayload },
    }),
    ...team.map((s) =>
      enqueueEmail(db, {
        template: "cancelled",
        to: s.email,
        dedupeKey: `cancelled-team:${id}:${s.id}`,
        reservationId: id,
        payload: { audience: "team", ...mailPayload },
      }),
    ),
    audit(db, {
      actorKind: actor.kind,
      actor: closedBy,
      action: "reservation.cancelled",
      reservationId: id,
      customerId: current.customer.id,
      details: { reason, from: current.status },
    }),
  ]);
  return (await getReservation(db, id))!;
}

/**
 * Cancel on behalf of the customer who proved ownership (an active contact's session, or an access token: then the
 * reservation's own contact email). The answer, and the current state of a stale 409, are the customer's view: never
 * technician or approver data.
 */
export async function cancelAsCustomer(env: Env, email: string, id: string, input: { reason?: string; version: number }): Promise<CustomerReservationDTO> {
  try {
    await cancelReservation(env, { kind: "customer", email }, id, input);
    return (await customerView(env.DB, id))!;
  } catch (e) {
    if (e instanceof HttpError && e.code === "stale") throw new HttpError(409, "stale", { current: await customerView(env.DB, id) });
    throw e;
  }
}
