import { Link } from "react-router";
import { Card } from "../../../components/Card";
import { dayParts, fmtShortDate, fmtTime } from "../../../format";
import { t } from "../../../i18n";
import { TECH_COLORS } from "./colors";
import { blockLabel, blockTone, holdLabel, k, reservationTone, shortWho, type CalItem, type Day, type WhoProps } from "./items";

/** Entries a desktop month cell shows before "+N more". */
const SHOWN = 3;
/** Dots a phone month cell shows. */
const DOTS = 4;

interface MonthProps extends WhoProps {
  /** Every day of the grid, Monday first, in whole weeks (4–6). */
  days: Day[];
  /** "YYYY-MM": days outside it are muted. */
  month: string;
  tz: string;
  today: string;
  /** The day whose list is open below the grid (phones select a day to see it). */
  selected: string | null;
  linkState: object;
  onShowDay: (date: string) => void;
  onOpenWeek: (date: string) => void;
}

const inMonth = (date: string, month: string) => date.startsWith(month);
const countLabel = (n: number) => (n === 0 ? k("monthNone") : n === 1 ? k("monthOne") : k("monthMany", { n }));

/**
 * The month at a glance: Monday-first weeks, each confirmed booking in its technician's colour (pending dashed amber,
 * proposed times dashed violet). Desktop cells list up to three with "+N more" opening the day's list; on phones the
 * cells are compact (dots) and tapping one opens that day's list below.
 */
export function MonthGrid(props: MonthProps) {
  const weekdays = props.days.slice(0, 7).map((d) => dayParts(d.date).weekday);
  return (
    <>
      <Card flush className="hidden overflow-hidden lg:block">
        <div className="grid grid-cols-7 border-b border-slate-200 dark:border-slate-800" aria-hidden="true">
          {weekdays.map((w) => (
            <p key={w} className="py-2 text-center text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
              {w}
            </p>
          ))}
        </div>
        <ol className="grid grid-cols-7">
          {props.days.map((d) => (
            <DesktopCell key={d.date} d={d} {...props} />
          ))}
        </ol>
      </Card>
      <div className="lg:hidden">
        <div className="grid grid-cols-7 pb-1" aria-hidden="true">
          {weekdays.map((w) => (
            <p key={w} className="text-center text-xs font-semibold text-slate-500 uppercase dark:text-slate-400">
              {w.slice(0, 2)}
            </p>
          ))}
        </div>
        <ol className="grid grid-cols-7 gap-1">
          {props.days.map((d) => (
            <PhoneCell key={d.date} d={d} {...props} />
          ))}
        </ol>
      </div>
    </>
  );
}

function DesktopCell({ d, month, tz, today, linkState, onShowDay, onOpenWeek, techName, meId, colorOf }: MonthProps & { d: Day }) {
  const outside = !inMonth(d.date, month);
  const isToday = d.date === today;
  const shown = d.items.slice(0, d.items.length > SHOWN ? SHOWN - 1 : SHOWN);
  const hidden = d.items.length - shown.length;
  return (
    <li
      className={`min-h-32 min-w-0 border-r border-b border-slate-200 p-1.5 nth-[7n]:border-r-0 dark:border-slate-800 ${
        outside ? "bg-slate-50/70 dark:bg-slate-950/40" : d.slots.length === 0 ? "bg-slate-50 dark:bg-slate-950/30" : ""
      }`}
    >
      <h3 className="mb-1 flex items-center justify-between">
        <button
          type="button"
          onClick={() => onOpenWeek(d.date)}
          title={k("openWeek", { date: fmtShortDate(d.date) })}
          className={`grid size-7 place-items-center rounded-full text-sm font-semibold tabular-nums hover:bg-slate-100 dark:hover:bg-slate-800 ${
            isToday ? "bg-blue-700 text-white hover:bg-blue-800 dark:bg-blue-500" : outside ? "text-slate-400 dark:text-slate-500" : ""
          }`}
        >
          {dayParts(d.date).day}
          <span className="sr-only">
            , {k("openWeek", { date: fmtShortDate(d.date) })}
            {isToday ? ` (${k("today")})` : ""}
          </span>
        </button>
      </h3>
      <ul className="space-y-1">
        {shown.map((item) => (
          <li key={item.id}>
            <Entry item={item} tz={tz} linkState={linkState} techName={techName} meId={meId} colorOf={colorOf} />
          </li>
        ))}
        {hidden > 0 && (
          <li>
            <button
              type="button"
              onClick={() => onShowDay(d.date)}
              className="w-full rounded px-1.5 py-0.5 text-left text-xs font-semibold text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              {k("more", { n: hidden })}
              <span className="sr-only">, {k("moreLabel", { n: hidden, date: fmtShortDate(d.date) })}</span>
            </button>
          </li>
        )}
      </ul>
    </li>
  );
}

/** One line in a desktop month cell: "13:00 Avery", in the technician's colour; the full details are its accessible name. */
function Entry({ item, tz, linkState, techName, meId, colorOf }: { item: CalItem; tz: string; linkState: object } & WhoProps) {
  if (item.kind === "hold") {
    const label = holdLabel(item.h, tz);
    return (
      <Link
        to={`/staff/r/${encodeURIComponent(item.h.reservationId)}`}
        state={linkState}
        title={label}
        className={`block truncate rounded px-1.5 py-0.5 text-xs ${blockTone.hold}`}
      >
        <span className="font-semibold tabular-nums">{fmtTime(item.startAt, tz)}</span> {t("web.staff.lifecycle.calendar.holdBadge")}
        <span className="sr-only">, {label}</span>
      </Link>
    );
  }
  const r = item.r;
  const tone = reservationTone(r, colorOf);
  const label = blockLabel(r, tz, techName, meId);
  return (
    <Link
      to={`/staff/r/${encodeURIComponent(r.id)}`}
      state={linkState}
      title={label}
      data-tech-color={tone.color}
      className={`block truncate rounded px-1.5 py-0.5 text-xs ${tone.className}`}
    >
      <span className="font-semibold tabular-nums">{fmtTime(r.startAt, tz)}</span> {shortWho(r, meId)}
      <span className="sr-only">, {label}</span>
    </Link>
  );
}

function PhoneCell({ d, month, today, selected, onShowDay, colorOf }: MonthProps & { d: Day }) {
  const outside = !inMonth(d.date, month);
  const isToday = d.date === today;
  const isSelected = d.date === selected;
  const n = d.items.length;
  return (
    <li>
      <button
        type="button"
        aria-pressed={isSelected}
        aria-label={`${fmtShortDate(d.date)}, ${countLabel(n)}${isToday ? ` (${k("today")})` : ""}`}
        onClick={() => onShowDay(d.date)}
        className={`flex min-h-14 w-full flex-col items-center gap-1 rounded-lg border px-0.5 pt-1.5 pb-1 ${
          isSelected
            ? "border-blue-700 bg-blue-50 dark:border-blue-400 dark:bg-blue-400/15"
            : "border-transparent hover:bg-slate-100 dark:hover:bg-slate-800"
        } ${outside ? "opacity-50" : ""}`}
      >
        <span
          className={`grid size-7 place-items-center rounded-full text-sm font-semibold tabular-nums ${isToday ? "bg-blue-700 text-white dark:bg-blue-500" : ""}`}
        >
          {dayParts(d.date).day}
        </span>
        <span className="flex flex-wrap justify-center gap-0.5" aria-hidden="true">
          {d.items.slice(0, DOTS).map((item) => (
            <span key={item.id} className={`size-1.5 rounded-full ${dotClass(item, colorOf)}`} />
          ))}
          {n > DOTS && <span className="text-[0.6rem] leading-none font-semibold text-slate-600 dark:text-slate-400">+</span>}
        </span>
      </button>
    </li>
  );
}

function dotClass(item: CalItem, colorOf: (id: number) => number): string {
  if (item.kind === "hold") return "bg-violet-500";
  const r = item.r;
  if (r.status === "pending" || !r.assignedStaff) return "bg-amber-500";
  return TECH_COLORS[colorOf(r.assignedStaff.id)]!.dot;
}
