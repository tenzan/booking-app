import { assignableFor } from "../../domain/matching";
import { freeStaffAt, windowStaffAt } from "../../domain/slots";
import { AUDIT_PAGE_SIZE, RESERVATIONS_PAGE_DEFAULT } from "../../shared/schemas";
import type { AuditEntryDTO, AuditListDTO, AuditRow, CustomerReservationDTO, ReservationDTO, ReservationListDTO, ReservationStatus, TechOption } from "../../shared/types";
import type { Env } from "../env";
import { decodeCursor, encodeCursor } from "../lib/cursor";
import { loadScheduleCtx } from "../scheduling/context";

export type { AuditRow, CustomerReservationDTO, ReservationDTO, ReservationStatus, TechOption } from "../../shared/types";

const SELECT = `SELECT r.id, r.ref, r.status, r.version, r.start_at, r.end_at,
    r.customer_id, c.customer_number, c.name AS customer_name, c.active AS customer_active,
    r.contact_name, r.contact_email, r.phone, r.issue,
    r.assigned_staff_id, asg.name AS assigned_name, r.provisional_staff_id,
    r.created_at, r.expires_at, r.closed_at, COALESCE(closer.name, r.closed_by) AS closed_by, r.close_reason,
    r.confirmed_at, r.confirmed_by, cb.name AS confirmed_by_name
  FROM reservations r
  JOIN customers c ON c.id = r.customer_id
  LEFT JOIN staff asg ON asg.id = r.assigned_staff_id
  LEFT JOIN staff cb ON cb.id = r.confirmed_by
  LEFT JOIN staff closer ON r.closed_by_kind = 'staff' AND CAST(closer.id AS TEXT) = r.closed_by`;

interface Row {
  id: string;
  ref: string;
  status: ReservationStatus;
  version: number;
  start_at: number;
  end_at: number;
  customer_id: number;
  customer_number: string;
  customer_name: string;
  customer_active: number;
  contact_name: string;
  contact_email: string;
  phone: string;
  issue: string;
  assigned_staff_id: number | null;
  assigned_name: string | null;
  provisional_staff_id: number | null;
  created_at: number;
  expires_at: number | null;
  closed_at: number | null;
  closed_by: string | null;
  close_reason: string | null;
  confirmed_at: number | null;
  confirmed_by: number | null;
  confirmed_by_name: string | null;
}

const toDTO = (r: Row): ReservationDTO => ({
  id: r.id,
  ref: r.ref,
  status: r.status,
  version: r.version,
  startAt: r.start_at,
  endAt: r.end_at,
  customer: { id: r.customer_id, number: r.customer_number, name: r.customer_name, active: r.customer_active === 1 },
  contactName: r.contact_name,
  contactEmail: r.contact_email,
  phone: r.phone,
  issue: r.issue,
  assignedStaff: r.assigned_staff_id === null ? null : { id: r.assigned_staff_id, name: r.assigned_name ?? "" },
  provisionalStaffId: r.provisional_staff_id,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  closedAt: r.closed_at,
  closedBy: r.closed_by,
  closeReason: r.close_reason,
  confirmedAt: r.confirmed_at,
  confirmedBy: r.confirmed_by === null ? null : { id: r.confirmed_by, name: r.confirmed_by_name ?? "" },
});

export async function getReservation(db: D1Database, id: string): Promise<ReservationDTO | null> {
  const row = await db.prepare(`${SELECT} WHERE r.id = ?`).bind(id).first<Row>();
  return row ? toDTO(row) : null;
}

/**
 * Filters: `from` inclusive / `to` exclusive on the start time; `staffId` matches the assigned technician only
 * (`orProvisionalStaffId` additionally matches pending requests provisionally on that technician: the calendar's view).
 * Soonest first (then creation time, then id), `limit` rows (default 50) after `cursor`.
 */
export async function listReservations(
  db: D1Database,
  f: {
    status?: ReservationStatus[];
    from?: number;
    to?: number;
    staffId?: number;
    orProvisionalStaffId?: number;
    limit?: number;
    cursor?: string;
  },
): Promise<ReservationListDTO> {
  const limit = f.limit ?? RESERVATIONS_PAGE_DEFAULT;
  const where: string[] = [];
  const binds: unknown[] = [];
  if (f.status && f.status.length > 0) {
    where.push(`r.status IN (${f.status.map(() => "?").join(",")})`);
    binds.push(...f.status);
  }
  if (f.from !== undefined) {
    where.push("r.start_at >= ?");
    binds.push(f.from);
  }
  if (f.to !== undefined) {
    where.push("r.start_at < ?");
    binds.push(f.to);
  }
  if (f.staffId !== undefined) {
    where.push("r.assigned_staff_id = ?");
    binds.push(f.staffId);
  }
  if (f.orProvisionalStaffId !== undefined) {
    where.push("(r.assigned_staff_id = ? OR (r.status = 'pending' AND r.provisional_staff_id = ?))");
    binds.push(f.orProvisionalStaffId, f.orProvisionalStaffId);
  }
  if (f.cursor !== undefined) {
    const [startAt, createdAt, id] = decodeCursor(f.cursor, ["number", "number", "string"]);
    where.push("(r.start_at > ? OR (r.start_at = ? AND (r.created_at > ? OR (r.created_at = ? AND r.id > ?))))");
    binds.push(startAt, startAt, createdAt, createdAt, id);
  }
  const sql = `${SELECT}${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY r.start_at, r.created_at, r.id LIMIT ?`;
  const { results } = await db.prepare(sql).bind(...binds, limit + 1).all<Row>();
  const page = results.slice(0, limit).map(toDTO);
  const last = page.at(-1);
  return { reservations: page, nextCursor: results.length > limit && last ? encodeCursor([last.startAt, last.createdAt, last.id]) : null };
}

const CUSTOMER_SELECT = `SELECT r.id, r.ref, r.status, r.version, r.start_at, r.end_at, c.name AS account_name, c.customer_number,
    r.contact_name, r.phone, r.issue, r.created_at, r.close_reason
  FROM reservations r JOIN customers c ON c.id = r.customer_id`;

interface CustomerRow {
  id: string;
  ref: string;
  status: ReservationStatus;
  version: number;
  start_at: number;
  end_at: number;
  account_name: string;
  customer_number: string;
  contact_name: string;
  phone: string;
  issue: string;
  created_at: number;
  close_reason: string | null;
}

const toCustomerDTO = (r: CustomerRow): CustomerReservationDTO => ({
  id: r.id,
  ref: r.ref,
  status: r.status,
  version: r.version,
  startAt: r.start_at,
  endAt: r.end_at,
  accountName: r.account_name,
  customerNumber: r.customer_number,
  contactName: r.contact_name,
  phone: r.phone,
  issue: r.issue,
  createdAt: r.created_at,
  closeReason: r.close_reason,
});

/** The customer's view of a staff DTO: no technician, approver or contact-email fields ever cross over. */
export const toCustomerView = (r: ReservationDTO): CustomerReservationDTO => ({
  id: r.id,
  ref: r.ref,
  status: r.status,
  version: r.version,
  startAt: r.startAt,
  endAt: r.endAt,
  accountName: r.customer.name,
  customerNumber: r.customer.number,
  contactName: r.contactName,
  phone: r.phone,
  issue: r.issue,
  createdAt: r.createdAt,
  closeReason: r.closeReason,
});

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(",");

/** Reservations of the given accounts, newest first. Callers pass only accounts they have proven ownership of. */
export async function listCustomerReservations(db: D1Database, accountIds: number[]): Promise<CustomerReservationDTO[]> {
  if (accountIds.length === 0) return [];
  const { results } = await db
    .prepare(`${CUSTOMER_SELECT} WHERE r.customer_id IN (${placeholders(accountIds.length)}) ORDER BY r.start_at DESC, r.created_at DESC, r.id`)
    .bind(...accountIds)
    .all<CustomerRow>();
  return results.map(toCustomerDTO);
}

/** One reservation, only when it belongs to one of `accountIds`. */
export async function getCustomerReservation(db: D1Database, id: string, accountIds: number[]): Promise<CustomerReservationDTO | null> {
  if (accountIds.length === 0) return null;
  const row = await db
    .prepare(`${CUSTOMER_SELECT} WHERE r.id = ? AND r.customer_id IN (${placeholders(accountIds.length)})`)
    .bind(id, ...accountIds)
    .first<CustomerRow>();
  return row ? toCustomerDTO(row) : null;
}

/** The reservation an unexpired access token points at (token given as its sha256 hex). */
export async function getCustomerReservationByAccessToken(db: D1Database, tokenHash: string, now: number): Promise<CustomerReservationDTO | null> {
  const row = await db
    .prepare(`${CUSTOMER_SELECT} JOIN access_tokens t ON t.reservation_id = r.id WHERE t.token_hash = ? AND t.expires_at > ?`)
    .bind(tokenHash, now)
    .first<CustomerRow>();
  return row ? toCustomerDTO(row) : null;
}

/** The reservation (id and contact email) an unexpired access token points at; the contact is who acts through the link. */
export async function getAccessTokenTarget(db: D1Database, tokenHash: string, now: number): Promise<{ id: string; contactEmail: string } | null> {
  const row = await db
    .prepare("SELECT r.id, r.contact_email FROM reservations r JOIN access_tokens t ON t.reservation_id = r.id WHERE t.token_hash = ? AND t.expires_at > ?")
    .bind(tokenHash, now)
    .first<{ id: string; contact_email: string }>();
  return row ? { id: row.id, contactEmail: row.contact_email } : null;
}

/** Audit trail of one reservation, oldest first; staff actors are shown by name. */
export async function getAudit(db: D1Database, reservationId: string): Promise<AuditRow[]> {
  const { results } = await db
    .prepare(
      `SELECT a.at, a.actor_kind, COALESCE(s.name, a.actor) AS actor, a.action, a.details
       FROM audit_log a
       LEFT JOIN staff s ON a.actor_kind = 'staff' AND CAST(s.id AS TEXT) = a.actor
       WHERE a.reservation_id = ?
       ORDER BY a.at, a.id`,
    )
    .bind(reservationId)
    .all<{ at: number; actor_kind: AuditRow["actorKind"]; actor: string | null; action: string; details: string }>();
  return results.map((r) => ({ at: r.at, actorKind: r.actor_kind, actor: r.actor, action: r.action, details: JSON.parse(r.details) }));
}

/**
 * The audit log, newest first, a page after `cursor`. `actor` is the stored actor (a staff id, or a customer email);
 * staff actors are shown by name. `action` lists terms, any of which may match: one ending in "." matches every action with
 * that prefix (`reservation.`), any other exactly.
 */
export async function listAudit(
  db: D1Database,
  f: { reservationId?: string; customerId?: number; actor?: string; action?: string[]; cursor?: string },
): Promise<AuditListDTO> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (f.reservationId !== undefined) {
    where.push("a.reservation_id = ?");
    binds.push(f.reservationId);
  }
  if (f.customerId !== undefined) {
    where.push("a.customer_id = ?");
    binds.push(f.customerId);
  }
  if (f.actor !== undefined) {
    where.push("a.actor = ?");
    binds.push(f.actor);
  }
  if (f.action !== undefined && f.action.length > 0) {
    // Any of the terms: `prefix.` matches by prefix, anything else exactly (no LIKE, so `%` and `_` are literal).
    const terms = f.action.map((term) => {
      if (term.endsWith(".")) {
        binds.push(term, term);
        return "substr(a.action, 1, length(?)) = ?";
      }
      binds.push(term);
      return "a.action = ?";
    });
    where.push(`(${terms.join(" OR ")})`);
  }
  if (f.cursor !== undefined) {
    const [at, id] = decodeCursor(f.cursor, ["number", "number"]);
    where.push("(a.at < ? OR (a.at = ? AND a.id < ?))");
    binds.push(at, at, id);
  }
  const { results } = await db
    .prepare(
      `SELECT a.id, a.at, a.actor_kind, COALESCE(s.name, a.actor) AS actor, a.actor AS actor_id, a.action, a.details,
              a.reservation_id, r.ref AS reservation_ref, a.customer_id
       FROM audit_log a
       LEFT JOIN staff s ON a.actor_kind = 'staff' AND CAST(s.id AS TEXT) = a.actor
       LEFT JOIN reservations r ON r.id = a.reservation_id
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY a.at DESC, a.id DESC LIMIT ?`,
    )
    .bind(...binds, AUDIT_PAGE_SIZE + 1)
    .all<{
      id: number;
      at: number;
      actor_kind: AuditRow["actorKind"];
      actor: string | null;
      actor_id: string | null;
      action: string;
      details: string;
      reservation_id: string | null;
      reservation_ref: string | null;
      customer_id: number | null;
    }>();
  const page = results.slice(0, AUDIT_PAGE_SIZE);
  const entries: AuditEntryDTO[] = page.map((r) => ({
    id: r.id,
    at: r.at,
    actorKind: r.actor_kind,
    actor: r.actor,
    actorId: r.actor_id,
    action: r.action,
    details: JSON.parse(r.details),
    reservationId: r.reservation_id,
    reservationRef: r.reservation_ref,
    customerId: r.customer_id,
  }));
  const last = page.at(-1);
  return { entries, nextCursor: results.length > AUDIT_PAGE_SIZE && last ? encodeCursor([last.at, last.id]) : null };
}

/**
 * Every active bookable technician, assignable ones first, then by name, each with the reason it cannot take
 * this request (first match wins: not on the slot, unavailable, busy with a fixed hold, needed elsewhere).
 * Pending requests get approval candidates; confirmed appointments get same-time reassignment candidates, with the
 * current technician flagged `current`. Other statuses get no options.
 */
export async function techOptions(env: Env, r: ReservationDTO): Promise<TechOption[]> {
  if (r.status !== "pending" && r.status !== "confirmed") return [];
  const ctx = await loadScheduleCtx(env, r.startAt, r.endAt);
  const { results: staff } = await env.DB.prepare("SELECT id, name FROM staff WHERE active = 1 AND bookable = 1").all<{ id: number; name: string }>();

  // A pending or confirmed reservation always holds capacity, so its stored range is in the context.
  const own = ctx.holds.find((h) => h.id === r.id);
  if (!own) return [];
  const { start: occStart, end: occEnd } = own;
  // Scheduled on the window covering the request, regardless of time off and of today's duration.
  const scheduled = new Set(windowStaffAt(ctx.slotInput, r.startAt));
  const freeList = freeStaffAt(ctx.slotInput, r.startAt, occStart, occEnd);
  const free = new Set(freeList);
  // Exactly the free technicians: the context's provisional fallback (which only keeps capacity held) is no option.
  // A confirmed appointment is unfixed here so that each candidate is tried in place of its technician.
  const holds = ctx.holds.map((h) => (h.id === r.id ? { ...h, fixed: null, eligible: freeList } : h));
  const assignable = new Set(assignableFor(holds, r.id));
  const currentId = r.status === "confirmed" ? (r.assignedStaff?.id ?? null) : null;

  const options = staff.map((s): TechOption => {
    const base = { id: s.id, name: s.name, ...(s.id === currentId ? { current: true } : {}) };
    if (assignable.has(s.id)) return { ...base, assignable: true, reason: null };
    if (!scheduled.has(s.id)) return { ...base, assignable: false, reason: "not_scheduled" };
    if (!free.has(s.id)) return { ...base, assignable: false, reason: "unavailable" };
    const fixed = holds.find((h) => h.id !== r.id && h.fixed === s.id && h.start < occEnd && occStart < h.end);
    if (fixed) {
      const conflictRef = ctx.holdOwners.get(fixed.id)?.ref ?? undefined;
      return { ...base, assignable: false, reason: "busy", ...(conflictRef ? { conflictRef } : {}) };
    }
    return { ...base, assignable: false, reason: "needed_for_other_request" };
  });
  return options.sort((a, b) => Number(b.assignable) - Number(a.assignable) || a.name.localeCompare(b.name) || a.id - b.id);
}
