import { TZDate } from "@date-fns/tz";

export const MIN = 60_000;

export function wallToUtc(date: string, minuteOfDay: number, tz: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new TZDate(y, m - 1, d, Math.floor(minuteOfDay / 60), minuteOfDay % 60, 0, tz).getTime();
}

export function utcToWall(ms: number, tz: string) {
  const t = new TZDate(ms, tz);
  const date = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  return { date, minute: t.getHours() * 60 + t.getMinutes(), weekday: t.getDay() };
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    out.push(d);
  }
  return out;
}
