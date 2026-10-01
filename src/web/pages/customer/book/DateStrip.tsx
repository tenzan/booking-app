import { useEffect, useRef } from "react";
import type { Availability } from "../../../api";
import { Spinner } from "../../../components/Spinner";
import { dayParts, fmtLongDate } from "../../../format";
import { t } from "../../../i18n";

type Day = Availability["days"][number];

interface Props {
  days: Day[];
  selected: string | null;
  onSelect: (date: string) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}

const tile = "flex h-20 w-full flex-col items-center justify-center rounded-xl border text-center";

/** Horizontally scrolling day tiles on phones, a 7-column grid on wider screens. Days without times are dimmed. */
export function DateStrip({ days, selected, onSelect, hasMore, loadingMore, onLoadMore }: Props) {
  const selectedRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    selectedRef.current?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [selected]);

  return (
    <ul
      aria-label={t("web.book.date.stripLabel")}
      className="-mx-4 flex snap-x gap-2 overflow-x-auto scroll-px-4 px-4 pt-1 pb-3 sm:mx-0 sm:grid sm:grid-cols-7 sm:overflow-visible sm:px-0"
    >
      {days.map((d) => {
        const p = dayParts(d.date);
        const n = d.slots.length;
        const isSelected = d.date === selected;
        const count = n === 0 ? t("web.book.date.noTimes") : n === 1 ? t("web.book.date.oneTime") : t("web.book.date.times", { n });
        return (
          <li key={d.date} className="w-16 shrink-0 snap-start sm:w-auto">
            <button
              ref={isSelected ? selectedRef : undefined}
              type="button"
              disabled={n === 0}
              aria-pressed={isSelected}
              aria-label={`${fmtLongDate(d.date)}, ${count}`}
              onClick={() => onSelect(d.date)}
              className={`${tile} ${
                isSelected
                  ? "border-blue-700 bg-blue-700 text-white shadow-md dark:border-blue-500 dark:bg-blue-600"
                  : n === 0
                    ? "cursor-not-allowed border-transparent bg-slate-100 text-slate-500 dark:bg-slate-900/60 dark:text-slate-500"
                    : "border-slate-300 bg-white hover:border-blue-600 hover:bg-blue-50 dark:border-slate-600 dark:bg-slate-900 dark:hover:border-blue-400 dark:hover:bg-slate-800"
              }`}
            >
              <span className={`text-xs font-medium uppercase ${isSelected ? "text-blue-100" : ""}`}>{p.weekday}</span>
              <span className="text-xl leading-tight font-bold tabular-nums">{p.day}</span>
              <span className={`text-xs ${isSelected ? "text-blue-100" : n === 0 ? "" : "text-slate-500 dark:text-slate-400"}`}>{p.month}</span>
            </button>
          </li>
        );
      })}
      {hasMore && (
        <li className="w-24 shrink-0 snap-start sm:col-span-7 sm:w-auto">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loadingMore}
            aria-busy={loadingMore || undefined}
            className={`${tile} border-dashed sm:h-11 sm:flex-row sm:gap-2 border-slate-300 px-2 text-sm font-medium text-blue-700 hover:bg-blue-50 dark:border-slate-600 dark:text-blue-300 dark:hover:bg-slate-800`}
          >
            {loadingMore ? (
              <>
                <Spinner />
                <span className="sr-only">{t("web.book.date.loadingLater")}</span>
              </>
            ) : (
              <>
                {t("web.book.date.later")}
                <svg className="mt-1 size-4 sm:mt-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M5 12h14m-5-5 5 5-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </>
            )}
          </button>
        </li>
      )}
    </ul>
  );
}
