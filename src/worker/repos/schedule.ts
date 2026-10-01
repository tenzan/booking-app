import type { Unavail, WindowDef } from "../../domain/slots";

/** Active, bookable technicians. */
export async function bookableStaffIds(db: D1Database): Promise<Set<number>> {
  const { results } = await db.prepare("SELECT id FROM staff WHERE active = 1 AND bookable = 1").all<{ id: number }>();
  return new Set(results.map((r) => r.id));
}

/** Every weekly window plus the date windows in [fromDate, toDate], each with its staff list. */
export async function loadWindows(db: D1Database, fromDate: string, toDate: string): Promise<WindowDef[]> {
  const { results: rows } = await db
    .prepare(
      `SELECT id, kind, weekday, date, start_min AS startMin, end_min AS endMin
       FROM availability_windows
       WHERE kind = 'weekly' OR (kind = 'date' AND date BETWEEN ? AND ?)
       ORDER BY id`,
    )
    .bind(fromDate, toDate)
    .all<Omit<WindowDef, "staffIds">>();
  const { results: links } = await db
    .prepare("SELECT window_id AS windowId, staff_id AS staffId FROM availability_window_staff ORDER BY staff_id")
    .all<{ windowId: number; staffId: number }>();
  const staffByWindow = new Map<number, number[]>();
  for (const { windowId, staffId } of links) {
    const list = staffByWindow.get(windowId) ?? [];
    list.push(staffId);
    staffByWindow.set(windowId, list);
  }
  return rows.map((w) => ({ ...w, staffIds: staffByWindow.get(w.id) ?? [] }));
}

export async function loadOverrideDates(db: D1Database, fromDate: string, toDate: string): Promise<Set<string>> {
  const { results } = await db
    .prepare("SELECT date FROM date_overrides WHERE date BETWEEN ? AND ?")
    .bind(fromDate, toDate)
    .all<{ date: string }>();
  return new Set(results.map((r) => r.date));
}

/** Unavailability periods overlapping [fromMs, toMs). */
export async function loadUnavailability(db: D1Database, fromMs: number, toMs: number): Promise<Unavail[]> {
  const { results } = await db
    .prepare("SELECT staff_id AS staffId, start_at AS startAt, end_at AS endAt FROM staff_unavailability WHERE start_at < ? AND end_at > ?")
    .bind(toMs, fromMs)
    .all<Unavail>();
  return results;
}

export interface ReservationHoldRow {
  id: string;
  ref: string;
  status: "pending" | "confirmed";
  startAt: number;
  endAt: number;
  assignedStaffId: number | null;
  provisionalStaffId: number | null;
}
export interface OptionHoldRow {
  id: string;
  ref: string;
  startAt: number;
  endAt: number;
  staffId: number;
}

/** Pending/confirmed reservations whose occupied range (buffers included) overlaps [fromMs, toMs). */
export async function loadReservationHolds(
  db: D1Database,
  fromMs: number,
  toMs: number,
  buffers: { beforeMs: number; afterMs: number },
): Promise<ReservationHoldRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, ref, status, start_at AS startAt, end_at AS endAt,
              assigned_staff_id AS assignedStaffId, provisional_staff_id AS provisionalStaffId
       FROM reservations
       WHERE status IN ('pending','confirmed') AND start_at - ? < ? AND end_at + ? > ?
       ORDER BY start_at, id`,
    )
    .bind(buffers.beforeMs, toMs, buffers.afterMs, fromMs)
    .all<ReservationHoldRow>();
  return results;
}

/** Options of open proposals whose occupied range overlaps [fromMs, toMs); `ref` is the proposal's reservation. */
export async function loadOptionHolds(
  db: D1Database,
  fromMs: number,
  toMs: number,
  buffers: { beforeMs: number; afterMs: number },
): Promise<OptionHoldRow[]> {
  const { results } = await db
    .prepare(
      `SELECT o.id AS id, r.ref AS ref, o.start_at AS startAt, o.end_at AS endAt, o.staff_id AS staffId
       FROM proposal_options o
       JOIN proposals p ON p.id = o.proposal_id
       JOIN reservations r ON r.id = p.reservation_id
       WHERE p.status = 'open' AND o.start_at - ? < ? AND o.end_at + ? > ?
       ORDER BY o.start_at, o.id`,
    )
    .bind(buffers.beforeMs, toMs, buffers.afterMs, fromMs)
    .all<OptionHoldRow>();
  return results;
}
