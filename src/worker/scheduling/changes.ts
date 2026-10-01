// Each ScheduleChange as (1) a validated in-memory transform of the schedule inputs, used to preview its roster
// impact without writing, and (2) the SQL statements that make it real (run inside the caller's capacityBatch).

import type { SlotInput, WindowDef } from "../../domain/slots";
import { DEFAULT_SETTINGS, type Settings } from "../../domain/settings";
import type { ScheduleChange, WindowInput } from "../../shared/types";
import { HttpError } from "../lib/http";
import type { RosterState } from "./roster";

export interface ResolvedChange {
  /** Schedule inputs with the change applied (nothing written). */
  slotInput: SlotInput;
  /** The writes, in order, for one batch. */
  statements(db: D1Database, now: number): D1PreparedStatement[];
  /** Audit summary: ids and values, no personal data. */
  details: Record<string, unknown>;
}

type Patchable = Record<keyof Settings, unknown>;

const sortedIds = (ids: number[]) => [...ids].sort((a, b) => a - b);

/** Copy deep enough that the transforms below never touch the loaded state. */
function cloneInput(s: SlotInput): SlotInput {
  return {
    ...s,
    windows: s.windows.map((w) => ({ ...w, staffIds: [...w.staffIds] })),
    overrideDates: new Set(s.overrideDates),
    holidays: new Set(s.holidays),
    unavailability: [...s.unavailability],
    bookableStaff: new Set(s.bookableStaff),
    cfg: { ...s.cfg },
  };
}

function assertActiveStaff(state: RosterState, ids: number[]): void {
  const bad = ids.filter((id) => !state.staff.get(id)?.active);
  if (bad.length > 0) throw new HttpError(400, "invalid_staff", { staffIds: bad });
}

const windowSummary = (w: WindowInput) => ({
  ...(w.kind === "weekly" ? { weekday: w.weekday } : {}),
  startMin: w.startMin,
  endMin: w.endMin,
  staffIds: sortedIds(w.staffIds),
});

/** Inserts a window plus its staff; the staff rows find the window as the newest id (we are inside one batch). */
function insertWindow(db: D1Database, w: WindowInput): D1PreparedStatement[] {
  return [
    db
      .prepare("INSERT INTO availability_windows(kind, weekday, date, start_min, end_min) VALUES (?, ?, ?, ?, ?)")
      .bind(w.kind, w.weekday, w.date, w.startMin, w.endMin),
    db
      .prepare("INSERT INTO availability_window_staff(window_id, staff_id) SELECT (SELECT MAX(id) FROM availability_windows), value FROM json_each(?)")
      .bind(JSON.stringify(sortedIds(w.staffIds))),
  ];
}

function deleteDateWindows(db: D1Database, date: string): D1PreparedStatement[] {
  return [
    db
      .prepare("DELETE FROM availability_window_staff WHERE window_id IN (SELECT id FROM availability_windows WHERE kind = 'date' AND date = ?)")
      .bind(date),
    db.prepare("DELETE FROM availability_windows WHERE kind = 'date' AND date = ?").bind(date),
  ];
}

/**
 * Validates `change` against the loaded state (staff exist and are active, edited rows exist) and applies it in
 * memory. Shape rules (grid, ranges, lengths) are the shared Zod schemas' job, at the route.
 */
export async function resolveChange(db: D1Database, state: RosterState, change: ScheduleChange): Promise<ResolvedChange> {
  const next = cloneInput(state.slotInput);
  const asDef = (w: WindowInput, id: number): WindowDef => ({ id, ...w, staffIds: sortedIds(w.staffIds) });
  const findWeekly = (id: number) => {
    const w = next.windows.find((x) => x.id === id && x.kind === "weekly");
    if (!w) throw new HttpError(404, "not_found");
    return w;
  };

  if ((change.type === "window.create" || change.type === "window.update") && change.window.kind !== "weekly") {
    // Same rule as the shared schema, for callers that skip it: a date's windows change only through override.set.
    throw new HttpError(400, "invalid", { path: ["window", "kind"] });
  }

  switch (change.type) {
    case "window.create": {
      assertActiveStaff(state, change.window.staffIds);
      next.windows.push(asDef(change.window, -1));
      return {
        slotInput: next,
        statements: (db) => insertWindow(db, change.window),
        details: { window: windowSummary(change.window) },
      };
    }
    case "window.update": {
      findWeekly(change.id);
      assertActiveStaff(state, change.window.staffIds);
      next.windows = next.windows.map((w) => (w.id === change.id ? asDef(change.window, change.id) : w));
      const w = change.window;
      return {
        slotInput: next,
        statements: (db) => [
          db
            .prepare("UPDATE availability_windows SET weekday = ?, start_min = ?, end_min = ? WHERE id = ? AND kind = 'weekly'")
            .bind(w.weekday, w.startMin, w.endMin, change.id),
          db.prepare("DELETE FROM availability_window_staff WHERE window_id = ?").bind(change.id),
          db
            .prepare("INSERT INTO availability_window_staff(window_id, staff_id) SELECT ?, value FROM json_each(?)")
            .bind(change.id, JSON.stringify(sortedIds(w.staffIds))),
        ],
        details: { id: change.id, window: windowSummary(w) },
      };
    }
    case "window.delete": {
      findWeekly(change.id);
      next.windows = next.windows.filter((w) => w.id !== change.id);
      return {
        slotInput: next,
        statements: (db) => [
          db.prepare("DELETE FROM availability_window_staff WHERE window_id = ?").bind(change.id),
          db.prepare("DELETE FROM availability_windows WHERE id = ?").bind(change.id),
        ],
        details: { id: change.id },
      };
    }
    case "override.set": {
      assertActiveStaff(state, [...new Set(change.windows.flatMap((w) => w.staffIds))]);
      next.windows = [
        ...next.windows.filter((w) => !(w.kind === "date" && w.date === change.date)),
        ...change.windows.map((w, i) => asDef(w, -1 - i)),
      ];
      next.overrideDates.add(change.date);
      return {
        slotInput: next,
        statements: (db) => [
          db
            .prepare("INSERT INTO date_overrides(date, note) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET note = excluded.note")
            .bind(change.date, change.note || null),
          ...deleteDateWindows(db, change.date),
          ...change.windows.flatMap((w) => insertWindow(db, w)),
        ],
        details: { date: change.date, windows: change.windows.map(windowSummary) },
      };
    }
    case "override.clear": {
      if (!(await db.prepare("SELECT 1 FROM date_overrides WHERE date = ?").bind(change.date).first())) throw new HttpError(404, "not_found");
      next.windows = next.windows.filter((w) => !(w.kind === "date" && w.date === change.date));
      next.overrideDates.delete(change.date);
      return {
        slotInput: next,
        statements: (db) => [...deleteDateWindows(db, change.date), db.prepare("DELETE FROM date_overrides WHERE date = ?").bind(change.date)],
        details: { date: change.date },
      };
    }
    case "unavailability.create": {
      assertActiveStaff(state, [change.staffId]);
      next.unavailability.push({ staffId: change.staffId, startAt: change.startAt, endAt: change.endAt });
      return {
        slotInput: next,
        statements: (db) => [
          db
            .prepare("INSERT INTO staff_unavailability(staff_id, start_at, end_at, reason) VALUES (?, ?, ?, ?)")
            .bind(change.staffId, change.startAt, change.endAt, change.reason || null),
        ],
        // The reason is free text about a person: kept out of the audit log.
        details: { staffId: change.staffId, startAt: change.startAt, endAt: change.endAt },
      };
    }
    case "unavailability.delete": {
      const row = await db.prepare("SELECT staff_id AS staffId FROM staff_unavailability WHERE id = ?").bind(change.id).first<{ staffId: number }>();
      if (!row) throw new HttpError(404, "not_found");
      // Loaded rows carry their id; a period outside the holds' ranges was never loaded and affects nobody.
      next.unavailability = state.unavailability.filter((u) => u.id !== change.id);
      return {
        slotInput: next,
        statements: (db) => [db.prepare("DELETE FROM staff_unavailability WHERE id = ?").bind(change.id)],
        details: { id: change.id, staffId: row.staffId },
      };
    }
    case "holiday.set": {
      next.holidays.add(change.date);
      return {
        slotInput: next,
        statements: (db) => [
          db.prepare("INSERT INTO holidays(date, name) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET name = excluded.name").bind(change.date, change.name),
        ],
        details: { date: change.date, name: change.name },
      };
    }
    case "holiday.delete": {
      if (!state.slotInput.holidays.has(change.date)) throw new HttpError(404, "not_found");
      next.holidays.delete(change.date);
      return {
        slotInput: next,
        statements: (db) => [db.prepare("DELETE FROM holidays WHERE date = ?").bind(change.date)],
        details: { date: change.date },
      };
    }
    case "staff.update": {
      const current = state.staff.get(change.id);
      if (!current) throw new HttpError(404, "not_found");
      const active = change.active ?? current.active;
      const bookable = change.bookable ?? current.bookable;
      if (active && bookable) next.bookableStaff.add(change.id);
      else next.bookableStaff.delete(change.id);
      return {
        slotInput: next,
        statements: (db, now) => [
          db
            .prepare("UPDATE staff SET active = ?, bookable = ?, updated_at = ? WHERE id = ?")
            .bind(active ? 1 : 0, bookable ? 1 : 0, now, change.id),
        ],
        details: { id: change.id, ...(change.active === undefined ? {} : { active }), ...(change.bookable === undefined ? {} : { bookable }) },
      };
    }
    case "settings.update": {
      // Only known settings are written. Capacity fields change slot generation for NEW requests only: existing
      // holds keep their stored ranges, so the engine sees no difference for them.
      const patch = Object.fromEntries(Object.entries(change.patch).filter(([k, v]) => Object.hasOwn(DEFAULT_SETTINGS, k) && v !== undefined)) as Partial<Patchable>;
      const merged = { ...state.settings, ...patch } as Settings;
      next.cfg = {
        ...next.cfg,
        durationMin: merged.durationMin,
        stepMin: merged.slotStepMin,
        bufferBeforeMin: merged.bufferBeforeMin,
        bufferAfterMin: merged.bufferAfterMin,
      };
      return {
        slotInput: next,
        statements: (db) =>
          Object.entries(patch).map(([key, value]) =>
            db
              .prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
              .bind(key, JSON.stringify(value)),
          ),
        details: { patch },
      };
    }
  }
}
