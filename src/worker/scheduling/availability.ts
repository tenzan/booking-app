import { spotsFor } from "../../domain/matching";
import { minNoticeAt } from "../../domain/deadlines";
import { occupiedRange } from "../../domain/slots";
import { addDays, eachDate, utcToWall, wallToUtc } from "../../domain/time";
import type { Env } from "../env";
import { clock } from "../lib/clock";
import { bhCtx, getSettings } from "../repos/settings";
import { loadScheduleCtx } from "./context";

export interface AvailabilityResponse {
  timezone: string;
  days: Array<{ date: string; slots: Array<{ startAt: number; endAt: number; spots: number }> }>;
}

/**
 * Bookable slots per local date in [fromDate, toDate], limited to dates from today through
 * today + bookingHorizonDays. A slot is listed when it starts at or after the minimum-notice instant
 * and at least one more booking fits (`spots`).
 */
export async function customerAvailability(env: Env, fromDate: string, toDate: string): Promise<AvailabilityResponse> {
  const tz = env.APP_TIMEZONE;
  const now = clock.now();
  const today = utcToWall(now, tz).date;

  // The horizon decides which range to load, so settings are read first (the context re-reads them; they are cheap).
  const settings = await getSettings(env.DB, env);
  const earliest = minNoticeAt(now, settings, await bhCtx(env.DB, env, settings));
  const first = fromDate < today ? today : fromDate;
  const last = [toDate, addDays(today, settings.bookingHorizonDays)].sort()[0]!;
  if (first > last) return { timezone: tz, days: [] };

  const ctx = await loadScheduleCtx(env, wallToUtc(first, 0, tz), wallToUtc(addDays(last, 1), 0, tz));
  const days = eachDate(first, last).map((date) => ({ date, slots: [] as AvailabilityResponse["days"][number]["slots"] }));
  const byDate = new Map(days.map((d) => [d.date, d]));

  for (const slot of ctx.slots) {
    if (slot.startAt < earliest) continue;
    const day = byDate.get(utcToWall(slot.startAt, tz).date);
    if (!day) continue;
    const [start, end] = occupiedRange(slot.startAt, slot.endAt, ctx.cfg);
    const spots = spotsFor(ctx.holds, { start, end, eligible: slot.staffIds });
    if (spots > 0) day.slots.push({ startAt: slot.startAt, endAt: slot.endAt, spots });
  }
  return { timezone: tz, days };
}
