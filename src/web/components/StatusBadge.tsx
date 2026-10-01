import type { ReservationStatus } from "../../shared/types";
import { t } from "../i18n";

/** Semantic colours: amber = waiting, green = confirmed, grey = closed without a session, slate = done. */
export const statusTone: Record<ReservationStatus, { badge: string; panel: string; dot: string }> = {
  pending: {
    badge: "bg-amber-100 text-amber-900 ring-amber-300 dark:bg-amber-400/15 dark:text-amber-200 dark:ring-amber-400/40",
    panel: "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-100",
    dot: "bg-amber-500",
  },
  confirmed: {
    badge: "bg-green-100 text-green-900 ring-green-300 dark:bg-green-400/15 dark:text-green-200 dark:ring-green-400/40",
    panel: "border-green-300 bg-green-50 text-green-950 dark:border-green-400/40 dark:bg-green-400/10 dark:text-green-100",
    dot: "bg-green-600",
  },
  declined: closed(),
  expired: closed(),
  cancelled: closed(),
  completed: {
    badge: "bg-slate-200 text-slate-800 ring-slate-400 dark:bg-slate-700 dark:text-slate-100 dark:ring-slate-500",
    panel: "border-slate-300 bg-slate-100 text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100",
    dot: "bg-slate-600 dark:bg-slate-300",
  },
};

function closed() {
  return {
    badge: "bg-zinc-100 text-zinc-700 ring-zinc-300 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-600",
    panel: "border-zinc-300 bg-zinc-50 text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200",
    dot: "bg-zinc-400",
  };
}

export function StatusBadge({ status }: { status: ReservationStatus }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm font-medium ring-1 ring-inset ${statusTone[status].badge}`}>
      <span className={`size-2 rounded-full ${statusTone[status].dot}`} aria-hidden="true" />
      {t(`web.statusShort.${status}`)}
    </span>
  );
}
