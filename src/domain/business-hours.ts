import { utcToWall, wallToUtc, addDays, MIN } from "./time";
import type { BusinessHours } from "./settings";

export interface BhCtx {
  tz: string;
  hours: BusinessHours;
  holidays: Set<string>;
}

export function addBusinessMinutes(fromMs: number, minutes: number, ctx: BhCtx): number {
  if (minutes <= 0) return fromMs;

  let remaining = minutes;
  let { date } = utcToWall(fromMs, ctx.tz);

  for (let i = 0; i < 800; i++, date = addDays(date, 1)) {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const h = ctx.hours[weekday];

    if (!h || ctx.holidays.has(date)) continue;

    const open = wallToUtc(date, h.start, ctx.tz);
    const close = wallToUtc(date, h.end, ctx.tz);
    const start = Math.max(open, fromMs);

    if (start >= close) continue;

    const avail = (close - start) / MIN;
    if (avail >= remaining) return start + remaining * MIN;

    remaining -= avail;
  }

  throw new Error("business hours misconfigured: no open time within 800 days");
}
