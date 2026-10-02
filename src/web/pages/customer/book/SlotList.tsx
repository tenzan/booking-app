import type { Slot } from "../../../api";
import { fmtLongDate, fmtTimeRange } from "../../../format";
import { t } from "../../../i18n";

interface Props {
  date: string;
  slots: Slot[];
  tz: string;
  selected: number | null;
  onSelect: (slot: Slot) => void;
}

export function SlotList({ date, slots, tz, selected, onSelect }: Props) {
  return (
    <ul aria-label={t("web.book.slot.listLabel", { date: fmtLongDate(date) })} className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {slots.map((s) => {
        const isSelected = s.startAt === selected;
        return (
          <li key={s.startAt}>
            <button
              type="button"
              aria-pressed={isSelected}
              onClick={() => onSelect(s)}
              className={`relative flex min-h-16 w-full items-center justify-center rounded-xl border px-3 py-3 transition-colors ${
                isSelected
                  ? "border-blue-700 bg-blue-50 ring-2 ring-blue-700 dark:border-blue-400 dark:bg-blue-400/10 dark:ring-blue-400"
                  : "border-slate-300 bg-white hover:border-blue-600 hover:bg-blue-50 dark:border-slate-600 dark:bg-slate-900 dark:hover:border-blue-400 dark:hover:bg-slate-800"
              }`}
            >
              <span className="font-semibold whitespace-nowrap tabular-nums sm:text-lg">{fmtTimeRange(s.startAt, s.endAt, tz)}</span>
              {isSelected && (
                <svg className="absolute -top-2 -right-2 size-6 rounded-full bg-slate-50 text-blue-700 dark:bg-slate-950 dark:text-blue-300" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" fill="currentColor" />
                  <path d="m7.5 12 3 3 6-6" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
