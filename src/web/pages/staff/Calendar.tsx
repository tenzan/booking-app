import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useLocation, useSearchParams } from "react-router";
import { utcToWall, wallToUtc } from "../../../domain/time";
import { techColorIndex } from "../../../domain/tech-colors";
import type { CalendarDTO, CalendarSlotDTO } from "../../../shared/types";
import { apiFetch, queryKeys, useMe, type TeamList } from "../../api";
import { Button } from "../../components/Button";
import { Card, Notice } from "../../components/Card";
import { PageHeading, usePageTitle } from "../../components/Layout";
import { Skeleton, Spinner } from "../../components/Spinner";
import { TimezoneNote } from "../../components/TimezoneNote";
import { addDays, dateIn, dayParts, fmtShortDate, fmtTime, fmtTimeRange, todayIn, weekdayOf } from "../../format";
import { LOCALE, t } from "../../i18n";
import { useNow } from "./Countdown";
import { blockLabel, blockTone, holdLabel, initialsOf, ItemRow, k, reservationTone, whoText, type CalItem, type ColorOf, type Day, type WhoProps } from "./calendar/items";
import { TECH_COLORS } from "./calendar/colors";
import { MonthGrid } from "./calendar/MonthGrid";
import { SubscribeButton } from "./calendar/SubscribeButton";
import { TechChips, ViewSwitch } from "./calendar/TechChips";

const STATUSES = ["all", "pending", "confirmed"] as const;
type StatusFilter = (typeof STATUSES)[number];
const readStatus = (s: string | null): StatusFilter => (STATUSES.includes(s as StatusFilter) ? (s as StatusFilter) : "all");

/** Pixels per hour in the week grid: a 30-minute booking is 40px, room for two lines of text. */
const HOUR_PX = 80;
const DEFAULT_HOURS: [number, number] = [8, 19];
/** Blocks are at least this tall (pointer target size). */
const MIN_BLOCK_PX = 24;
/** At most this many side-by-side lanes; beyond it the last lane becomes a "+N more" button. Keeps blocks ≥ 24px wide. */
const MAX_LANES = 3;

/** The Monday on or before `date`. */
const mondayOf = (date: string): string => addDays(date, -((weekdayOf(date) + 6) % 7));
const readWeek = (s: string | null, today: string): string =>
  s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) ? mondayOf(s) : mondayOf(today);

type View = "week" | "month";
const readView = (s: string | null): View => (s === "month" ? "month" : "week");
/** "YYYY-MM" of a date. */
const monthOf = (date: string) => date.slice(0, 7);
const readMonth = (s: string | null, today: string): string => (s && /^\d{4}-(0[1-9]|1[0-2])$/.test(s) ? s : monthOf(today));
/** The first day of the month after `month`. */
const nextMonth = (month: string): string => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};
const prevMonth = (month: string): string => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};
/** "October 2026". */
const fmtMonth = (month: string) =>
  new Intl.DateTimeFormat(LOCALE, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));

/** "Oct 5 – 11, 2026" (or across months and years as needed). */
function fmtWeekRange(monday: string): string {
  const f = new Intl.DateTimeFormat(LOCALE, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  return f.formatRange(new Date(`${monday}T00:00:00Z`), new Date(`${addDays(monday, 6)}T00:00:00Z`));
}

/** Minute of the day an instant falls on in `tz`; an end exactly at the next midnight is 1440. */
function minuteIn(ms: number, tz: string, date: string): number {
  const w = utcToWall(ms, tz);
  return w.date > date ? 1440 : w.date < date ? 0 : w.minute;
}

/** How full a start time is: `booked` of `capacity` technicians (for one technician when filtered: 0 or 1 of 1). */
function slotLoad(s: CalendarSlotDTO, staffId: number | null): { booked: number; capacity: number } {
  if (staffId !== null) {
    if (!s.staffIds.includes(staffId)) return { booked: 0, capacity: 0 };
    return { booked: s.bookedStaffIds.includes(staffId) ? 1 : 0, capacity: 1 };
  }
  const capacity = s.staffIds.length;
  const fixed = s.bookedStaffIds.filter((id) => s.staffIds.includes(id)).length;
  return { booked: Math.min(capacity, fixed + s.pendingCount), capacity };
}

/** Start times on a day that can still take a booking, of those with anyone working. */
function openCount(day: Day, staffId: number | null): { open: number; total: number } {
  let open = 0;
  let total = 0;
  for (const s of day.slots) {
    const { booked, capacity } = slotLoad(s, staffId);
    if (capacity === 0) continue;
    total++;
    if (booked < capacity) open++;
  }
  return { open, total };
}

/** Side-by-side lanes for overlapping bookings: each gets its lane and the number of lanes in its overlap group. */
function layoutLanes(items: CalItem[]): Map<string, { lane: number; lanes: number; group: number }> {
  const out = new Map<string, { lane: number; lanes: number; group: number }>();
  let groupNo = 0;
  const sorted = [...items].sort((a, b) => a.startAt - b.startAt || a.endAt - b.endAt);
  let group: CalItem[] = [];
  let laneEnds: number[] = [];
  let groupEnd = -Infinity;
  const flush = () => {
    for (const r of group) out.get(r.id)!.lanes = laneEnds.length;
    group = [];
    laneEnds = [];
    groupNo++;
  };
  for (const r of sorted) {
    if (r.startAt >= groupEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= r.startAt);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(r.endAt);
    } else laneEnds[lane] = r.endAt;
    out.set(r.id, { lane, lanes: 0, group: groupNo });
    group.push(r);
    groupEnd = Math.max(groupEnd, r.endAt);
  }
  flush();
  return out;
}

/**
 * `/staff/calendar[?view=month&month=YYYY-MM | ?week=YYYY-MM-DD][&tech=<id>&status=pending|confirmed&day=YYYY-MM-DD]`:
 * the team's week or month at a glance, each confirmed booking in its technician's colour.
 */
export default function CalendarPage() {
  usePageTitle(k("heading"));
  const me = useMe();
  const tz = me.data?.timezone ?? "UTC";
  const now = useNow();
  const today = todayIn(tz, now);
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const view = readView(params.get("view"));
  const week = readWeek(params.get("week"), today);
  const month = readMonth(params.get("month"), today);
  const status = readStatus(params.get("status"));
  const techParam = params.get("tech") ?? "";
  const ids = useId();

  const team = useQuery({ queryKey: queryKeys.team, queryFn: () => apiFetch<TeamList>("/api/staff/team") });
  const technicians = (team.data?.staff ?? []).filter((s) => s.active);
  const allStaffIds = (team.data?.staff ?? []).map((s) => s.id);
  const colorOf: ColorOf = (id) => techColorIndex(allStaffIds, id);
  const staffId = /^\d+$/.test(techParam) ? Number(techParam) : null;
  const meId = me.data?.staff?.id ?? null;
  const techName = staffId === null ? null : (team.data?.staff.find((s) => s.id === staffId)?.name ?? null);

  // The days shown: a Monday-first week, or the whole weeks covering the month (4–6, within the feed's 42 days).
  const gridStart = view === "week" ? week : mondayOf(`${month}-01`);
  const gridEnd = view === "week" ? addDays(week, 7) : addDays(mondayOf(addDays(`${nextMonth(month)}-01`, -1)), 7);
  const dayCount = Math.round((Date.parse(`${gridEnd}T00:00:00Z`) - Date.parse(`${gridStart}T00:00:00Z`)) / 86_400_000);
  const from = wallToUtc(gridStart, 0, tz);
  const to = wallToUtc(gridEnd, 0, tz);
  const cal = useQuery({
    queryKey: queryKeys.calendar(`${gridStart}|${gridEnd}|${tz}`, techParam, status),
    queryFn: () => {
      const p = new URLSearchParams({ from: String(from), to: String(to) });
      if (staffId !== null) p.set("staffId", String(staffId));
      if (status !== "all") p.set("status", status);
      return apiFetch<CalendarDTO>(`/api/staff/calendar?${p}`);
    },
    enabled: me.isSuccess,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: "always",
    refetchInterval: 60_000,
  });
  const calTz = cal.data?.timezone ?? tz;

  const update = (next: { view?: View; week?: string | null; month?: string | null; tech?: string; status?: StatusFilter; day?: string | null }) => {
    // From the live URL: router navigations are transitions, so `params` can lag a filter changed a moment ago.
    const p = new URLSearchParams(window.location.search);
    const set = (key: string, value: string | null | undefined, dflt: string) => {
      if (value === undefined) return;
      if (value === null || value === dflt) p.delete(key);
      else p.set(key, value);
    };
    set("view", next.view, "week");
    set("week", next.week === undefined ? undefined : next.week === mondayOf(today) ? null : next.week, "");
    set("month", next.month === undefined ? undefined : next.month === monthOf(today) ? null : next.month, "");
    set("tech", next.tech, "");
    set("status", next.status, "all");
    // A day's list belongs to the week or month it was opened in.
    const moved = next.week !== undefined || next.month !== undefined || next.view !== undefined;
    set("day", next.day === undefined ? (moved ? null : undefined) : next.day, "");
    setParams(p, { replace: true, preventScrollReset: true });
  };
  // Switching views keeps the place: the month of the week shown, or the week the month starts with (today's, this month).
  const switchView = (v: View) => {
    if (v === view) return;
    if (v === "month") update({ view: v, month: monthOf(week === mondayOf(today) ? today : week), week: null });
    else update({ view: v, week: month === monthOf(today) ? null : mondayOf(`${month}-01`), month: null });
  };
  const openWeek = (date: string) => update({ view: "week", week: mondayOf(date), month: null });

  // Proposal holds are neither pending nor confirmed: shown with "All" only.
  const showHolds = status === "all";
  const days: Day[] = Array.from({ length: dayCount }, (_, i) => {
    const date = addDays(gridStart, i);
    const reservations = (cal.data?.reservations ?? []).filter((r) => dateIn(r.startAt, calTz) === date).sort((a, b) => a.startAt - b.startAt);
    const holds = showHolds ? (cal.data?.proposalHolds ?? []).filter((h) => dateIn(h.startAt, calTz) === date) : [];
    const items: CalItem[] = [
      ...reservations.map((r): CalItem => ({ kind: "reservation", id: r.id, startAt: r.startAt, endAt: r.endAt, r })),
      ...holds.map((h): CalItem => ({ kind: "hold", id: h.optionId, startAt: h.startAt, endAt: h.endAt, h })),
    ].sort((a, b) => a.startAt - b.startAt || a.endAt - b.endAt);
    return { date, slots: cal.data?.slots.find((d) => d.date === date)?.slots ?? [], reservations, items };
  });
  // The month view counts its own month's bookings, not the neighbouring days the grid also shows.
  const counted = view === "month" ? days.filter((d) => d.date.startsWith(month)) : days;
  const count = counted.reduce((n, d) => n + d.reservations.length, 0);
  const loading = cal.isFetching && cal.isPlaceholderData;
  const rangeLabel = view === "week" ? fmtWeekRange(week) : fmtMonth(month);
  // `?day=` (a "+N more" button, or a day tapped in the month): that day's bookings listed under the grid.
  const dayParam = params.get("day");
  const shownDay = days.find((d) => d.date === dayParam) ?? null;
  const phoneDefault = view === "month" && month === monthOf(today) ? (days.find((d) => d.date === today) ?? null) : null;
  const [dayOpened, setDayOpened] = useState(0);
  const showDay = (date: string) => {
    update({ day: date });
    setDayOpened((n) => n + 1);
  };
  const back = { back: { to: location.pathname + location.search, label: t("web.staff.nav.calendar") } };
  const who = { techName, meId, colorOf };
  const atToday = view === "week" ? week === mondayOf(today) : month === monthOf(today);
  const step = (dir: 1 | -1) =>
    view === "week" ? update({ week: addDays(week, 7 * dir) }) : update({ month: dir === 1 ? nextMonth(month) : prevMonth(month) });

  const statusLine =
    cal.isSuccess && !loading
      ? count === 0
        ? k("summaryNone", { week: rangeLabel })
        : count === 1
          ? k("summaryOne", { week: rangeLabel })
          : k("summary", { n: count, week: rangeLabel })
      : "";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <PageHeading>{k("heading")}</PageHeading>
          <TimezoneNote tz={calTz} atMs={from} />
        </div>
        <SubscribeButton />
      </div>

      <div className="space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              <IconButton label={k(view === "week" ? "prevWeek" : "prevMonth")} onClick={() => step(-1)} path="m15 6-6 6 6 6" />
              {/* aria-disabled, not disabled: it stays focusable and in the tab order next to the arrows. */}
              <Button
                variant="secondary"
                aria-disabled={atToday}
                onClick={() => !atToday && (view === "week" ? update({ week: null }) : update({ month: null }))}
                aria-label={k("todayLabel")}
                className="aria-disabled:cursor-default aria-disabled:opacity-60"
              >
                {k("today")}
              </Button>
              <IconButton label={k(view === "week" ? "nextWeek" : "nextMonth")} onClick={() => step(1)} path="m9 6 6 6-6 6" />
            </div>
            <h2 className="px-1 text-lg font-semibold tabular-nums sm:text-xl">{rangeLabel}</h2>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <ViewSwitch value={view} onChange={switchView} />
            <fieldset>
              <legend className="mb-1.5 block text-sm font-medium">{k("statusLabel")}</legend>
              <div className="grid grid-cols-3 rounded-xl border border-slate-300 bg-white p-1 dark:border-slate-600 dark:bg-slate-900">
                {STATUSES.map((s) => (
                  <label
                    key={s}
                    className="flex min-h-11 cursor-pointer items-center justify-center rounded-lg px-3 text-sm font-medium text-slate-700 hover:bg-slate-100 has-checked:bg-blue-700 has-checked:text-white has-checked:hover:bg-blue-700 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-blue-600 lg:min-h-9 dark:text-slate-300 dark:hover:bg-slate-800 dark:has-checked:bg-blue-600"
                  >
                    <input type="radio" name={`${ids}-status`} value={s} checked={status === s} onChange={() => update({ status: s })} className="sr-only" />
                    {k(`status.${s}`)}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
        </div>
        <TechChips
          staff={technicians}
          value={staffId}
          meId={meId}
          colorOf={colorOf}
          unknownName={techName}
          onChange={(id) => update({ tech: id === null ? "" : String(id) })}
        />
      </div>

      <div className="flex min-h-6 items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
        {loading && <Spinner className="size-4" />}
        <p role="status" aria-live="polite">
          {loading ? t("web.common.loading") : statusLine}
          {techName && !loading && cal.isSuccess && <> {k("filteredTo", { name: techName })}</>}
        </p>
      </div>

      {cal.data?.truncated && <Notice tone="warning">{k("truncated")}</Notice>}
      {showHolds && cal.data?.holdsTruncated && <Notice tone="warning">{t("web.staff.lifecycle.calendar.holdsTruncated")}</Notice>}

      {cal.isPending ? (
        <div aria-busy="true">
          <span className="sr-only">{t("web.common.loading")}</span>
          <Skeleton className="h-[32rem]" />
        </div>
      ) : cal.isError && !cal.data ? (
        <Notice tone="error" className="flex flex-wrap items-center justify-between gap-3">
          {k("loadFailed")}
          <Button variant="secondary" onClick={() => void cal.refetch()}>
            {t("web.common.retry")}
          </Button>
        </Notice>
      ) : (
        <div className={`space-y-4 transition-opacity ${loading ? "opacity-60" : ""}`} aria-busy={loading || undefined}>
          {cal.isError && (
            <Notice tone="error" className="flex flex-wrap items-center justify-between gap-3">
              {k("refreshFailed")}
              <Button variant="secondary" onClick={() => void cal.refetch()}>
                {t("web.common.retry")}
              </Button>
            </Notice>
          )}
          {view === "month" ? (
            <>
              <MonthGrid days={days} month={month} tz={calTz} today={today} selected={dayParam ?? phoneDefault?.date ?? null} linkState={back} onShowDay={showDay} onOpenWeek={openWeek} {...who} />
              {shownDay && <DayPanel day={shownDay} tz={calTz} today={today} staffId={staffId} linkState={back} focusOnOpen={dayOpened} onClose={() => update({ day: null })} {...who} />}
              {/* Phones: with no day chosen, today's list sits under the compact month (desktop cells already list it). */}
              {!shownDay && phoneDefault && (
                <div className="lg:hidden">
                  <DayPanel day={phoneDefault} tz={calTz} today={today} staffId={staffId} linkState={back} focusOnOpen={0} {...who} />
                </div>
              )}
            </>
          ) : (
            <>
              {/* The grid needs the width: tablets and phones get the day-by-day agenda. */}
              <div className="hidden lg:block">
                <WeekGrid days={days} tz={calTz} today={today} now={now} staffId={staffId} linkState={back} onShowDay={showDay} {...who} />
                {shownDay && <DayPanel day={shownDay} tz={calTz} today={today} staffId={staffId} linkState={back} focusOnOpen={dayOpened} onClose={() => update({ day: null })} {...who} />}
              </div>
              <div className="lg:hidden">
                <Agenda days={days} tz={calTz} today={today} staffId={staffId} linkState={back} {...who} />
              </div>
            </>
          )}
          <Legend filtered={staffId !== null} holds={showHolds} track={view === "week"} />
        </div>
      )}
    </div>
  );
}

function IconButton({ label, onClick, path }: { label: string; onClick: () => void; path: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-11 place-items-center rounded-xl border border-slate-300 bg-white text-slate-900 hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
    >
      <svg className="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d={path} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/** One hue, darker as it fills, so it never reads as a booking's own colour. */
const loadTone = (booked: number, capacity: number) =>
  booked === 0
    ? "bg-indigo-50 dark:bg-indigo-400/10"
    : booked < capacity
      ? "bg-indigo-200 text-indigo-950 dark:bg-indigo-400/35 dark:text-indigo-50"
      : "bg-indigo-600 text-white dark:bg-indigo-300 dark:text-indigo-950";

interface ViewProps extends WhoProps {
  days: Day[];
  tz: string;
  today: string;
  staffId: number | null;
  linkState: object;
}

function WeekGrid({ days, tz, today, now, staffId, techName, meId, colorOf, linkState, onShowDay }: ViewProps & { now: number; onShowDay: (date: string) => void }) {
  // Hours shown: the earliest start to the latest end of the week's times and bookings, whole hours.
  let lo = Infinity;
  let hi = -Infinity;
  for (const d of days) {
    for (const s of d.slots) {
      lo = Math.min(lo, minuteIn(s.startAt, tz, d.date));
      hi = Math.max(hi, minuteIn(s.endAt, tz, d.date));
    }
    for (const r of d.items) {
      lo = Math.min(lo, minuteIn(r.startAt, tz, d.date));
      hi = Math.max(hi, minuteIn(r.endAt, tz, d.date));
    }
  }
  const [startHour, endHour] = lo === Infinity ? DEFAULT_HOURS : [Math.floor(lo / 60), Math.max(Math.ceil(hi / 60), Math.floor(lo / 60) + 1)];
  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);
  const height = hours.length * HOUR_PX;
  const y = (minute: number) => ((Math.min(Math.max(minute, startHour * 60), endHour * 60) - startHour * 60) / 60) * HOUR_PX;

  // Days with nothing on them (closed, no bookings) shrink to a narrow column, unless the whole week is empty.
  const active = days.map((d) => d.slots.length > 0 || d.items.length > 0);
  const anyActive = active.some(Boolean);
  const cols = `3.5rem ${days.map((_, i) => (active[i] || !anyActive ? "minmax(0,1fr)" : "2.75rem")).join(" ")}`;
  const nowMinute = minuteIn(now, tz, today);

  return (
    <Card flush className="overflow-hidden">
      <div className="grid border-b border-slate-200 dark:border-slate-800" style={{ gridTemplateColumns: cols }}>
        <div aria-hidden="true" />
        {days.map((d, i) => {
          const p = dayParts(d.date);
          const isToday = d.date === today;
          const { open, total } = openCount(d, staffId);
          const wide = active[i] || !anyActive;
          return (
            <div key={d.date} className="min-w-0 border-l border-slate-200 px-1.5 py-2 text-center dark:border-slate-800">
              <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">{p.weekday}</p>
              <p
                className={`mx-auto mt-0.5 grid size-8 place-items-center rounded-full text-lg font-semibold tabular-nums ${isToday ? "bg-blue-700 text-white dark:bg-blue-500" : ""}`}
              >
                {p.day}
              </p>
              {isToday && <span className="sr-only">{k("today")}</span>}
              {wide && (
                <p className="mt-0.5 truncate text-xs text-slate-600 dark:text-slate-400">
                  {total === 0 ? k("closed") : open === 0 ? k("full") : k("openShort", { open, total })}
                </p>
              )}
              {!wide && <span className="sr-only">{k("closed")}</span>}
            </div>
          );
        })}
      </div>

      <div className="grid" style={{ gridTemplateColumns: cols }}>
        {/* Hour labels */}
        <div className="relative" style={{ height }} aria-hidden="true">
          {hours.map((h, i) => (
            <span
              key={h}
              className="absolute right-2 -translate-y-1/2 text-xs text-slate-500 tabular-nums dark:text-slate-400"
              style={{ top: i * HOUR_PX, display: i === 0 ? "none" : undefined }}
            >
              {String(h).padStart(2, "0")}:00
            </span>
          ))}
        </div>

        {days.map((d, i) => {
          const lanes = layoutLanes(d.items);
          const wide = active[i] || !anyActive;
          const lines: CSSProperties = {
            backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent ${HOUR_PX - 1}px, var(--hour-line) ${HOUR_PX - 1}px, var(--hour-line) ${HOUR_PX}px)`,
            height,
          };
          return (
            <section
              key={d.date}
              aria-label={fmtShortDate(d.date)}
              className={`relative min-w-0 border-l border-slate-200 [--hour-line:var(--color-slate-200)] dark:border-slate-800 dark:[--hour-line:var(--color-slate-800)] ${
                d.slots.length === 0 ? "bg-slate-50 dark:bg-slate-950/40" : ""
              }`}
              style={lines}
            >
              {/* Capacity track: one segment per start time, shaded by how many technicians are taken. */}
              <div className="absolute inset-y-0 left-0 w-6" aria-hidden="true">
                {d.slots.map((s, j) => {
                  const { booked, capacity } = slotLoad(s, staffId);
                  if (capacity === 0) return null;
                  const next = d.slots[j + 1];
                  const end = next && next.startAt < s.endAt ? next.startAt : s.endAt;
                  const top = y(minuteIn(s.startAt, tz, d.date));
                  const h = y(minuteIn(end, tz, d.date)) - top;
                  const label = `${fmtTimeRange(s.startAt, s.endAt, tz)} · ${k("load", { booked, capacity })}`;
                  return (
                    <div
                      key={s.startAt}
                      title={label}
                      className={`absolute inset-x-0.5 grid place-items-center overflow-hidden rounded-sm text-[0.625rem] leading-none font-semibold tabular-nums ${loadTone(booked, capacity)}`}
                      style={{ top: top + 1, height: Math.max(h - 2, 2) }}
                    >
                      {h >= 18 && booked > 0 && staffId === null && (
                        <span>
                          {booked}/{capacity}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>

              {d.date === today && nowMinute > startHour * 60 && nowMinute < endHour * 60 && (
                <div className="pointer-events-none absolute inset-x-0 z-20 border-t-2 border-red-500" style={{ top: y(nowMinute) }} aria-hidden="true">
                  <span className="absolute -top-[5px] -left-1 size-2 rounded-full bg-red-500" />
                </div>
              )}

              {!wide ? null : (
                <ol className="absolute inset-y-0 right-1 left-7">
                  {d.items.map((r) => {
                    const top = y(minuteIn(r.startAt, tz, d.date));
                    const h = Math.max(y(minuteIn(r.endAt, tz, d.date)) - top, MIN_BLOCK_PX + 2);
                    const { lane, lanes: n, group } = lanes.get(r.id)!;
                    const crowded = n > MAX_LANES;
                    if (crowded && lane >= MAX_LANES - 1) {
                      // Hidden in a crowded group: the group's first hidden booking carries the "+N more" button.
                      const hidden = d.items.filter((x) => lanes.get(x.id)!.group === group && lanes.get(x.id)!.lane >= MAX_LANES - 1);
                      if (hidden[0]!.id !== r.id) return null;
                      const from = Math.min(...hidden.map((x) => x.startAt));
                      const to = Math.max(...hidden.map((x) => x.endAt));
                      const oTop = y(minuteIn(from, tz, d.date));
                      const oH = Math.max(y(minuteIn(to, tz, d.date)) - oTop, MIN_BLOCK_PX + 2);
                      return (
                        <li key={`more-${r.id}`} className="absolute" style={{ top: oTop + 1, height: oH - 2, left: `${((MAX_LANES - 1) / MAX_LANES) * 100}%`, width: `calc(${100 / MAX_LANES}% - 2px)` }}>
                          <button
                            type="button"
                            onClick={() => onShowDay(d.date)}
                            title={k("moreLabel", { n: hidden.length, date: fmtShortDate(d.date) })}
                            className="block h-full w-full rounded-md border border-slate-300 bg-white text-xs font-semibold text-slate-800 shadow-xs hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
                          >
                            {k("more", { n: hidden.length })}
                            <span className="sr-only">, {k("moreLabel", { n: hidden.length, date: fmtShortDate(d.date) })}</span>
                          </button>
                        </li>
                      );
                    }
                    const shown = crowded ? MAX_LANES : n;
                    const style = { top: top + 1, height: h - 2, left: `${(lane / shown) * 100}%`, width: `calc(${100 / shown}% - 2px)` };
                    if (r.kind === "hold") {
                      const label = holdLabel(r.h, tz);
                      return (
                        <li key={r.id} className="absolute" style={style}>
                          <Link
                            to={`/staff/r/${encodeURIComponent(r.h.reservationId)}`}
                            state={linkState}
                            title={label}
                            className={`@container block h-full overflow-hidden rounded-md px-1 py-0.5 text-xs leading-4 shadow-xs focus-visible:z-10 ${blockTone.hold}`}
                          >
                            <span className="hidden truncate @min-[6rem]:block">
                              <span className="font-semibold tabular-nums">{fmtTime(r.startAt, tz)}</span> <span className="font-mono">{r.h.ref}</span>
                            </span>
                            <span className="hidden truncate opacity-80 @min-[6rem]:block">{t("web.staff.lifecycle.calendar.holdWho", { tech: r.h.staffName })}</span>
                            <span className="block truncate font-semibold @min-[6rem]:hidden">{initialsOf(r.h.staffName)}</span>
                            <span className="block truncate text-[0.625rem] tracking-tight tabular-nums opacity-80 @min-[6rem]:hidden">{fmtTime(r.startAt, tz)}</span>
                            <span className="sr-only">, {label}</span>
                          </Link>
                        </li>
                      );
                    }
                    const res = r.r;
                    const label = blockLabel(res, tz, techName, meId);
                    const tone = reservationTone(res, colorOf);
                    return (
                      <li key={r.id} className="absolute" style={style}>
                        <Link
                          to={`/staff/r/${encodeURIComponent(res.id)}`}
                          state={linkState}
                          title={label}
                          data-tech-color={tone.color}
                          className={`@container block h-full overflow-hidden rounded-md px-1 py-0.5 text-xs leading-4 shadow-xs focus-visible:z-10 ${tone.className}`}
                        >
                          {/* The name starts with the visible text; the rest is read after it. Narrow blocks show the
                              technician's initials and a small time instead. */}
                          <span className="hidden truncate @min-[6rem]:block">
                            <span className="font-semibold tabular-nums">{fmtTime(res.startAt, tz)}</span> {res.customer.name}
                          </span>
                          <span className="hidden truncate opacity-80 @min-[6rem]:block">{whoText(res, techName, meId)}</span>
                          <span className="block truncate font-semibold @min-[6rem]:hidden">
                            {res.assignedStaff ? (res.assignedStaff.id === meId ? k("youShort") : initialsOf(res.assignedStaff.name)) : "–"}
                          </span>
                          <span className="block truncate text-[0.625rem] tracking-tight tabular-nums opacity-80 @min-[6rem]:hidden">{fmtTime(res.startAt, tz)}</span>
                          <span className="sr-only">, {label}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>
          );
        })}
      </div>
    </Card>
  );
}

function Agenda({ days, tz, today, staffId, techName, meId, colorOf, linkState }: ViewProps) {
  return (
    <div className="space-y-5">
      {days.map((d) => {
        const { open, total } = openCount(d, staffId);
        const isToday = d.date === today;
        const empty = d.items.length === 0;
        return (
          <section key={d.date} aria-labelledby={`agenda-${d.date}`} className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <h3 id={`agenda-${d.date}`} className="font-semibold">
                {fmtShortDate(d.date)}
                {isToday && (
                  <span className="ml-2 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-800 dark:bg-blue-400/20 dark:text-blue-200">
                    {k("today")}
                  </span>
                )}
              </h3>
              <p className="text-sm text-slate-600 dark:text-slate-400">
                {total === 0 ? k("closed") : open === 0 ? k("fullLong") : k("openLong", { open, total })}
              </p>
            </div>
            {empty && total === 0 ? null : empty ? (
              <p className="rounded-xl border border-dashed border-slate-300 px-4 py-3 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-400">
                {k("nothingBooked")}
              </p>
            ) : (
              <ul className="space-y-2">
                {d.items.map((item) => (
                  <li key={item.id}>
                    <ItemRow item={item} tz={tz} techName={techName} meId={meId} colorOf={colorOf} linkState={linkState} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** Desktop: every booking of one day (opened from a crowded slot's "+N more"), listed under the grid. */
function DayPanel({
  day,
  tz,
  today,
  staffId,
  techName,
  meId,
  colorOf,
  linkState,
  focusOnOpen,
  onClose,
}: Omit<ViewProps, "days"> & { day: Day; focusOnOpen: number; onClose?: () => void }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusOnOpen > 0) headingRef.current?.focus();
  }, [focusOnOpen, day.date]);
  const { open, total } = openCount(day, staffId);
  return (
    <Card className="mt-4 space-y-3" role="region" aria-labelledby="calendar-day-panel">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="calendar-day-panel" ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none">
            {k("dayHeading", { date: fmtShortDate(day.date) })}
            {day.date === today && <span className="sr-only"> ({k("today")})</span>}
          </h2>
          <p className="text-sm text-slate-600 dark:text-slate-400">{total === 0 ? k("closed") : open === 0 ? k("fullLong") : k("openLong", { open, total })}</p>
        </div>
        {onClose && (
          <Button variant="secondary" onClick={onClose}>
            {k("closeDay")}
          </Button>
        )}
      </div>
      <ul className="grid gap-2 sm:grid-cols-2">
        {day.items.map((item) => (
          <li key={item.id}>
            <ItemRow item={item} tz={tz} techName={techName} meId={meId} colorOf={colorOf} linkState={linkState} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Swatch({ className, children }: { className: string; children: ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      <span className={`inline-block h-4 w-6 shrink-0 rounded ${className}`} aria-hidden="true" />
      {children}
    </li>
  );
}

function Legend({ filtered, holds, track }: { filtered: boolean; holds: boolean; track: boolean }) {
  return (
    <div className="space-y-2 text-sm text-slate-600 dark:text-slate-400">
      <h2 className="sr-only">{k("legend")}</h2>
      <ul className="flex flex-wrap gap-x-5 gap-y-2">
        <Swatch className={blockTone.pending}>{k("legendPending")}</Swatch>
        <li className="flex items-center gap-2">
          <span className="inline-flex h-4 w-6 shrink-0 overflow-hidden rounded border border-slate-300 dark:border-slate-600" aria-hidden="true">
            {TECH_COLORS.slice(0, 4).map((c) => (
              <span key={c.dot} className={`h-full flex-1 ${c.dot}`} />
            ))}
          </span>
          {k("legendConfirmed")}
        </li>
        {holds && <Swatch className={blockTone.hold}>{t("web.staff.lifecycle.calendar.legendHold")}</Swatch>}
        {track && (
          <li className="hidden items-center gap-2 lg:flex">
            <span className="inline-grid h-4 w-6 shrink-0 place-items-center rounded border border-slate-400 bg-white text-[0.6rem] font-semibold text-slate-900 dark:border-slate-500 dark:bg-slate-900 dark:text-slate-100" aria-hidden="true">
              BT
            </span>
            {k("legendInitials")}
          </li>
        )}
      </ul>
      {track && (
        <>
          <ul className="hidden flex-wrap gap-x-5 gap-y-2 lg:flex">
            <Swatch className={loadTone(0, 1)}>{filtered ? k("legendTechFree") : k("legendFree")}</Swatch>
            {!filtered && <Swatch className={loadTone(1, 2)}>{k("legendPartly")}</Swatch>}
            <Swatch className={loadTone(1, 1)}>{filtered ? k("legendTechBooked") : k("legendFull")}</Swatch>
          </ul>
          <p className="hidden lg:block">{filtered ? k("trackHintTech") : k("trackHint")}</p>
        </>
      )}
    </div>
  );
}
