import { useEffect, useState } from "react";
import { t } from "../../i18n";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The current time, refreshed every `everyMs` so relative times stay live. */
export function useNow(everyMs = MINUTE): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(id);
  }, [everyMs]);
  return now;
}

/** "1d 3h", "3h 10m", "45m" — the two largest units, rounded down. */
export function fmtDuration(ms: number): string {
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  const m = Math.floor((ms % HOUR) / MINUTE);
  const part = (unit: "days" | "hours" | "minutes", n: number) => t(`web.staff.duration.${unit}`, { n });
  if (d > 0) return h > 0 ? `${part("days", d)} ${part("hours", h)}` : part("days", d);
  if (h > 0) return m > 0 ? `${part("hours", h)} ${part("minutes", m)}` : part("hours", h);
  return part("minutes", m);
}

export function countdownText(expiresAt: number, now: number): string {
  const left = expiresAt - now;
  if (left <= 0) return t("web.staff.countdown.overdue");
  if (left < MINUTE) return t("web.staff.countdown.underMinute");
  return t("web.staff.countdown.expiresIn", { time: fmtDuration(left) });
}

/** Approval countdown pill: red under an hour (and once overdue), neutral otherwise. */
export function Countdown({ expiresAt, now }: { expiresAt: number; now: number }) {
  const urgent = expiresAt - now < HOUR;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm font-medium tabular-nums ring-1 ring-inset ${
        urgent
          ? "bg-red-50 text-red-800 ring-red-300 dark:bg-red-400/10 dark:text-red-200 dark:ring-red-400/40"
          : "bg-slate-100 text-slate-700 ring-slate-300 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-600"
      }`}
    >
      <svg className="size-4 shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      {countdownText(expiresAt, now)}
    </span>
  );
}
