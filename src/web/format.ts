import { addDays, utcToWall } from "../domain/time";
import { fmtDateTime, LOCALE, tzLabel } from "./i18n";

export { addDays };

/** Today's YYYY-MM-DD in `tz`. */
export const todayIn = (tz: string, now = Date.now()): string => utcToWall(now, tz).date;

/** Formats a calendar date (YYYY-MM-DD) without any time-zone shift. */
function fmtDate(date: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(LOCALE, { ...opts, timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
}

/** Pieces for a compact date tile: { weekday: "Thu", day: "1", month: "Oct" }. */
export const dayParts = (date: string) => ({
  weekday: fmtDate(date, { weekday: "short" }),
  day: fmtDate(date, { day: "numeric" }),
  month: fmtDate(date, { month: "short" }),
});

/** "Thursday, October 1". */
export const fmtLongDate = (date: string): string => fmtDate(date, { weekday: "long", month: "long", day: "numeric" });

/** "10:00" in `tz` (24-hour clock). */
export const fmtTime = (ms: number, tz: string): string =>
  new Intl.DateTimeFormat(LOCALE, { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);

/** "10:00 – 10:30". */
export const fmtTimeRange = (start: number, end: number, tz: string): string => `${fmtTime(start, tz)} – ${fmtTime(end, tz)}`;

/** "Thu, Oct 1, 2026, 10:00 – 10:30". */
export const fmtWhen = (start: number, end: number, tz: string): string => `${fmtDateTime(start, tz, LOCALE)} – ${fmtTime(end, tz)}`;

/** "Asia/Tokyo (GMT+9)", with the offset in effect at `atMs`. */
export const fmtTz = (tz: string, atMs: number = Date.now()): string => tzLabel(tz, atMs, LOCALE);

/** The YYYY-MM-DD an instant falls on in `tz`. */
export const dateIn = (ms: number, tz: string): string => utcToWall(ms, tz).date;

/** "Thu, Oct 1". */
export const fmtShortDate = (date: string): string => fmtDate(date, { weekday: "short", month: "short", day: "numeric" });
