import { MIN, utcToWall } from "../../domain/time";
import { freeStaffAt, generateSlots, type Slot, type SlotCfg, type SlotInput } from "../../domain/slots";
import type { Hold } from "../../domain/matching";
import type { BhCtx } from "../../domain/business-hours";
import type { Settings } from "../../domain/settings";
import type { Env } from "../env";
import { readScheduleVersion } from "../lib/db";
import { getHolidays, getSettings } from "../repos/settings";
import {
  bookableStaffIds,
  loadOptionHolds,
  loadOverrideDates,
  loadReservationHolds,
  loadUnavailability,
  loadWindows,
} from "../repos/schedule";

const DAY = 24 * 60 * MIN;

export interface HoldOwner {
  kind: "reservation" | "option";
  id: string;
  status: string;
  /** Assigned (confirmed) / provisional (pending) / option technician. */
  staffId: number | null;
  ref: string | null;
}

export interface ScheduleCtx {
  settings: Settings;
  bh: BhCtx;
  cfg: SlotCfg;
  slots: Slot[];
  /** What `slots` was generated from (for callers that need a variant, e.g. ignoring unavailability). */
  slotInput: SlotInput;
  holds: Hold[];
  version: number;
  holdOwners: Map<string, HoldOwner>;
}

/**
 * Pure scheduling inputs from the database for dates covering [fromMs - 1 day, toMs + 1 day]:
 * generated slots (from the current settings) plus the holds (pending/confirmed reservations, open proposal options)
 * that overlap that range, each with the occupied range stored when it was created.
 */
export async function loadScheduleCtx(env: Env, fromMs: number, toMs: number): Promise<ScheduleCtx> {
  const db = env.DB;
  // Read the version BEFORE any schedule data: a write committing in between then leaves us with a
  // stale version (a later guard fails and the caller retries) rather than stale data under a fresh version.
  const version = await readScheduleVersion(db);
  const settings = await getSettings(db, env);
  const holidays = await getHolidays(db);
  const bh: BhCtx = { tz: env.APP_TIMEZONE, hours: settings.businessHours, holidays };
  const cfg: SlotCfg = {
    tz: env.APP_TIMEZONE,
    durationMin: settings.durationMin,
    stepMin: settings.slotStepMin,
    bufferBeforeMin: settings.bufferBeforeMin,
    bufferAfterMin: settings.bufferAfterMin,
  };

  const lo = fromMs - DAY;
  const hi = toMs + DAY;
  const fromDate = utcToWall(lo, cfg.tz).date;
  const toDate = utcToWall(hi, cfg.tz).date;

  const [bookableStaff, windows, overrideDates, unavailability] = await Promise.all([
    bookableStaffIds(db),
    loadWindows(db, fromDate, toDate),
    loadOverrideDates(db, fromDate, toDate),
    loadUnavailability(db, lo, hi),
  ]);
  const slotInput: SlotInput = { fromDate, toDate, windows, overrideDates, holidays, unavailability, bookableStaff, cfg };
  const slots = generateSlots(slotInput);

  const [reservations, options] = await Promise.all([
    loadReservationHolds(db, lo, hi),
    loadOptionHolds(db, lo, hi),
  ]);

  const holds: Hold[] = [];
  const holdOwners = new Map<string, HoldOwner>();
  for (const r of reservations) {
    const { occStart: start, occEnd: end } = r;
    if (r.status === "confirmed") {
      holds.push({ id: r.id, start, end, fixed: r.assignedStaffId, eligible: r.assignedStaffId === null ? [] : [r.assignedStaffId], preferred: null });
      holdOwners.set(r.id, { kind: "reservation", id: r.id, status: r.status, staffId: r.assignedStaffId, ref: r.ref });
    } else {
      // Eligibility comes from the hold's own data (its window and stored range), not from today's duration/buffers.
      // When nobody is free any more, the request keeps its provisional technician here so that it goes on holding
      // capacity while it waits (other requests are matched around it). This fallback is for matching only:
      // approve and techOptions use `freeStaffAt` exactly, so a technician on leave is never offered nor accepted.
      const free = freeStaffAt(slotInput, r.startAt, start, end);
      const eligible = free.length > 0 ? free : r.provisionalStaffId !== null ? [r.provisionalStaffId] : [];
      holds.push({ id: r.id, start, end, fixed: null, eligible, preferred: r.provisionalStaffId });
      holdOwners.set(r.id, { kind: "reservation", id: r.id, status: r.status, staffId: r.provisionalStaffId, ref: r.ref });
    }
  }
  for (const o of options) {
    const { occStart: start, occEnd: end } = o;
    holds.push({ id: o.id, start, end, fixed: o.staffId, eligible: [o.staffId], preferred: null });
    holdOwners.set(o.id, { kind: "option", id: o.id, status: "open", staffId: o.staffId, ref: o.ref });
  }

  return { settings, bh, cfg, slots, slotInput, holds, version, holdOwners };
}

