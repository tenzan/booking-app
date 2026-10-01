import { MIN, eachDate, utcToWall, wallToUtc } from "./time";

export interface WindowDef {
  id: number;
  kind: "weekly" | "date";
  weekday: number | null;
  date: string | null;
  startMin: number;
  endMin: number;
  staffIds: number[];
}
export interface Unavail {
  staffId: number;
  startAt: number;
  endAt: number;
}
export interface SlotCfg {
  tz: string;
  durationMin: number;
  stepMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
}
export interface Slot {
  startAt: number;
  endAt: number;
  staffIds: number[];
}
export interface SlotInput {
  fromDate: string;
  toDate: string;
  windows: WindowDef[];
  overrideDates: Set<string>;
  holidays: Set<string>;
  unavailability: Unavail[];
  bookableStaff: Set<number>;
  cfg: SlotCfg;
}

type BufferCfg = Pick<SlotCfg, "bufferBeforeMin" | "bufferAfterMin">;

const BLOCK_MS = 5 * MIN;

export function occupiedRange(startAt: number, endAt: number, cfg: BufferCfg): [number, number] {
  return [startAt - cfg.bufferBeforeMin * MIN, endAt + cfg.bufferAfterMin * MIN];
}

/** Epoch-minute starts of the 5-minute blocks an occupied range [occStart, occEnd) touches. */
export function rangeBlocks(occStart: number, occEnd: number): number[] {
  const out: number[] = [];
  for (let ms = Math.floor(occStart / BLOCK_MS) * BLOCK_MS; ms < occEnd; ms += BLOCK_MS) {
    out.push(ms / MIN);
  }
  return out;
}

export function blockMinutes(startAt: number, endAt: number, cfg: BufferCfg): number[] {
  return rangeBlocks(...occupiedRange(startAt, endAt, cfg));
}

export function findSlot(slots: Slot[], startAt: number): Slot | undefined {
  return slots.find((s) => s.startAt === startAt);
}

function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function windowsForDate(input: SlotInput, date: string): WindowDef[] {
  if (input.overrideDates.has(date)) {
    return input.windows.filter((w) => w.kind === "date" && w.date === date);
  }
  if (input.holidays.has(date)) return [];
  const weekday = weekdayOf(date);
  return input.windows.filter((w) => w.kind === "weekly" && w.weekday === weekday);
}

/**
 * Bookable technicians listed on the windows covering `startAt`, ignoring the current duration/step (does the slot
 * still fit?) and time off. This is who an existing hold may be (re)assigned to, independent of settings changes.
 */
export function windowStaffAt(input: SlotInput, startAt: number): number[] {
  const { date, minute } = utcToWall(startAt, input.cfg.tz);
  const staff = new Set<number>();
  for (const win of windowsForDate(input, date)) {
    if (win.startMin > minute || minute >= win.endMin) continue;
    for (const id of win.staffIds) if (input.bookableStaff.has(id)) staff.add(id);
  }
  return [...staff].sort((a, b) => a - b);
}

export function generateSlots(input: SlotInput): Slot[] {
  const { cfg, unavailability, bookableStaff } = input;
  const byStart = new Map<number, { endAt: number; staff: Set<number> }>();

  for (const date of eachDate(input.fromDate, input.toDate)) {
    for (const win of windowsForDate(input, date)) {
      const candidates = win.staffIds.filter((id) => bookableStaff.has(id));
      for (let start = win.startMin; start + cfg.durationMin <= win.endMin; start += cfg.stepMin) {
        const startAt = wallToUtc(date, start, cfg.tz);
        const endAt = wallToUtc(date, start + cfg.durationMin, cfg.tz);
        const [occStart, occEnd] = occupiedRange(startAt, endAt, cfg);
        const free = candidates.filter(
          (id) => !unavailability.some((u) => u.staffId === id && u.startAt < occEnd && occStart < u.endAt),
        );
        if (free.length === 0) continue;
        const entry = byStart.get(startAt) ?? { endAt, staff: new Set<number>() };
        for (const id of free) entry.staff.add(id);
        byStart.set(startAt, entry);
      }
    }
  }

  return [...byStart.entries()]
    .sort(([a], [b]) => a - b)
    .map(([startAt, { endAt, staff }]) => ({ startAt, endAt, staffIds: [...staff].sort((a, b) => a - b) }));
}
