import { Link } from "react-router";
import type { CalendarProposalHoldDTO, CalendarReservationDTO, CalendarSlotDTO } from "../../../../shared/types";
import { StatusBadge } from "../../../components/StatusBadge";
import { dateIn, fmtShortDate, fmtTime, fmtTimeRange } from "../../../format";
import { t } from "../../../i18n";
import { TECH_COLORS } from "./colors";

export const k = (key: string, params?: Record<string, string | number>) => t(`web.staff.calendar.${key}`, params);

/** One entry on the calendar: a reservation, or a time held for an open proposal (an option). */
export type CalItem =
  | { kind: "reservation"; id: string; startAt: number; endAt: number; r: CalendarReservationDTO }
  | { kind: "hold"; id: string; startAt: number; endAt: number; h: CalendarProposalHoldDTO };

export interface Day {
  date: string;
  slots: CalendarSlotDTO[];
  reservations: CalendarReservationDTO[];
  /** Reservations and proposal holds, soonest first. */
  items: CalItem[];
}

/** A technician's colour index (see techColorIndex), shared by the chips, the grids and the lists. */
export type ColorOf = (staffId: number) => number;

/** What the views need to say who has what. */
export interface WhoProps {
  /** The filtered technician's name (for "provisionally theirs"), or null. */
  techName: string | null;
  /** The signed-in staff member, whose bookings are marked "(You)". */
  meId: number | null;
  colorOf: ColorOf;
}

/** Status looks: pending and proposed times are dashed (nobody's yet); confirmed ones wear their technician's colour. */
export const blockTone = {
  hold: "border border-dashed border-violet-500 bg-violet-50 text-violet-950 hover:bg-violet-100 dark:border-violet-400 dark:bg-violet-950 dark:text-violet-100 dark:hover:bg-violet-900",
  pending:
    "border border-dashed border-amber-500 bg-amber-50 text-amber-950 hover:bg-amber-100 dark:border-amber-400 dark:bg-amber-950 dark:text-amber-100 dark:hover:bg-amber-900",
} as const;

/** Agenda cards are larger than grid blocks: softer fills. */
export const agendaTone = {
  hold: "border border-dashed border-violet-500 bg-violet-50 text-violet-950 hover:bg-violet-100 dark:border-violet-400/70 dark:bg-violet-400/10 dark:text-violet-100 dark:hover:bg-violet-400/15",
  pending: "border border-dashed border-amber-500 bg-amber-50 text-amber-950 hover:bg-amber-100 dark:border-amber-400/70 dark:bg-amber-400/10 dark:text-amber-100 dark:hover:bg-amber-400/15",
} as const;

/** A reservation's look in a grid block: its status, or (confirmed) its technician's colour. */
export function reservationTone(r: CalendarReservationDTO, colorOf: ColorOf): { className: string; color?: number } {
  if (r.status === "pending" || !r.assignedStaff) return { className: blockTone.pending };
  const color = colorOf(r.assignedStaff.id);
  return { className: `border border-l-4 ${TECH_COLORS[color]!.block}`, color };
}

function reservationSoftTone(r: CalendarReservationDTO, colorOf: ColorOf): { className: string; color?: number } {
  if (r.status === "pending" || !r.assignedStaff) return { className: agendaTone.pending };
  const color = colorOf(r.assignedStaff.id);
  return { className: `border border-l-4 ${TECH_COLORS[color]!.soft}`, color };
}

/** The signed-in staff member's own bookings say so: "Ada Admin (You)". */
export const nameFor = (id: number, name: string, meId: number | null) => (id === meId ? k("you", { name }) : name);

/** Who has it, as staff should read it: the assigned technician; a pending request is unassigned (or, on one technician's view, provisionally theirs). */
export function whoText(r: CalendarReservationDTO, techName: string | null, meId: number | null): string {
  if (r.assignedStaff) return nameFor(r.assignedStaff.id, r.assignedStaff.name, meId);
  if (r.status === "pending" && techName && r.provisionalForFilteredStaff) return k("provisional", { name: techName });
  return t("web.staff.dashboard.unassigned");
}

/** "Avery" from "Avery Admin", or "You": the short form for a month cell. */
export function shortWho(r: CalendarReservationDTO, meId: number | null): string {
  if (!r.assignedStaff) return t("web.statusShort.pending");
  if (r.assignedStaff.id === meId) return k("youShort");
  return r.assignedStaff.name.trim().split(/\s+/)[0] || r.assignedStaff.name;
}

/** A proposal hold's tooltip and the rest of its accessible name. */
export function holdLabel(h: CalendarProposalHoldDTO, tz: string): string {
  return t("web.staff.lifecycle.calendar.holdLabel", {
    ref: h.ref,
    date: fmtShortDate(dateIn(h.startAt, tz)),
    time: fmtTimeRange(h.startAt, h.endAt, tz),
    customer: h.customerName,
    tech: h.staffName,
  });
}

/** Tooltip, and (after the visible text) the rest of the link's accessible name. */
export function blockLabel(r: CalendarReservationDTO, tz: string, techName: string | null, meId: number | null): string {
  return k("blockLabel", {
    ref: r.ref,
    status: t(`web.statusShort.${r.status}`),
    date: fmtShortDate(dateIn(r.startAt, tz)),
    time: fmtTimeRange(r.startAt, r.endAt, tz),
    customer: r.customer.name,
    who: whoText(r, techName, meId),
  });
}

export const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => [...w][0]!.toUpperCase())
    .join("");

export function ItemRow({ item, tz, linkState, ...who }: { item: CalItem; tz: string; linkState: object } & WhoProps) {
  return item.kind === "hold" ? <HoldRow h={item.h} tz={tz} linkState={linkState} /> : <AgendaRow r={item.r} tz={tz} linkState={linkState} {...who} />;
}

/** A time held for an open proposal, in the agenda / day list: it opens the reservation the proposal belongs to. */
function HoldRow({ h, tz, linkState }: { h: CalendarProposalHoldDTO; tz: string; linkState: object }) {
  return (
    <Link to={`/staff/r/${encodeURIComponent(h.reservationId)}`} state={linkState} className={`flex items-start gap-3 rounded-xl px-4 py-3 ${agendaTone.hold}`}>
      <p className="w-12 shrink-0 tabular-nums">
        <span className="block font-semibold">{fmtTime(h.startAt, tz)}</span>
        <span className="block text-sm opacity-80">{fmtTime(h.endAt, tz)}</span>
      </p>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="font-medium break-words">{t("web.staff.lifecycle.calendar.hold", { ref: h.ref })}</p>
        <p className="text-sm break-words opacity-90">{h.customerName}</p>
        <p className="text-sm break-words opacity-90">
          <span className="sr-only">{t("common.technician")}: </span>
          {h.staffName}
        </p>
      </div>
      <span className="shrink-0 rounded-full bg-violet-100 px-2.5 py-1 text-sm font-medium text-violet-900 ring-1 ring-violet-300 ring-inset dark:bg-violet-400/15 dark:text-violet-200 dark:ring-violet-400/40">
        {t("web.staff.lifecycle.calendar.holdBadge")}
      </span>
    </Link>
  );
}

function AgendaRow({ r, tz, techName, meId, colorOf, linkState }: { r: CalendarReservationDTO; tz: string; linkState: object } & WhoProps) {
  const tone = reservationSoftTone(r, colorOf);
  return (
    <Link
      to={`/staff/r/${encodeURIComponent(r.id)}`}
      state={linkState}
      data-tech-color={tone.color}
      className={`flex items-start gap-3 rounded-xl px-4 py-3 ${tone.className}`}
    >
      <p className="w-12 shrink-0 tabular-nums">
        <span className="block font-semibold">{fmtTime(r.startAt, tz)}</span>
        <span className="block text-sm opacity-80">{fmtTime(r.endAt, tz)}</span>
      </p>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="font-medium break-words">{r.customer.name}</p>
        <p className="flex items-center gap-1.5 text-sm break-words opacity-90">
          {tone.color !== undefined && <span className={`size-2.5 shrink-0 rounded-full ${TECH_COLORS[tone.color]!.dot}`} aria-hidden="true" />}
          <span className="sr-only">{t("common.technician")}: </span>
          {whoText(r, techName, meId)}
        </p>
        <p className="font-mono text-xs opacity-80">{r.ref}</p>
      </div>
      <span className="shrink-0">
        <StatusBadge status={r.status} />
      </span>
    </Link>
  );
}
