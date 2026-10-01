import { useEffect, useId, useRef, type ReactNode } from "react";
import type { ScheduleStaff } from "../../../api";
import { isApiError } from "../../../api";
import { inputClass } from "../../../components/Field";
import { fmtMinutes } from "../../../format";
import { t } from "../../../i18n";
import { actionErrorText } from "../detail/shared";

export const k = (key: string, params?: Record<string, string | number>) => t(`web.staff.schedule.${key}`, params);

const STEP = 5;
const range = (from: number, to: number) => Array.from({ length: (to - from) / STEP + 1 }, (_, i) => from + i * STEP);
const START_OPTIONS = range(0, 1440 - STEP);
const END_OPTIONS = range(STEP, 1440);

/** Selects only offer the 5-minute grid, so a value can never be off it. */
export const selectClass = `${inputClass.replace("px-4", "")} min-h-11 py-2.5 pr-2 pl-3 tabular-nums`;

/** A time of day on the 5-minute grid. `end` offers 00:05 … 24:00 (24:00 = end of the day), otherwise 00:00 … 23:55. */
export function TimeSelect({
  id,
  label,
  value,
  onChange,
  end = false,
  invalid = false,
  describedBy,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (minute: number) => void;
  end?: boolean;
  invalid?: boolean;
  describedBy?: string;
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        className={selectClass}
      >
        {(end ? END_OPTIONS : START_OPTIONS).map((m) => (
          <option key={m} value={m}>
            {fmtMinutes(m)}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Toggle chips (checkboxes) for choosing technicians. Inactive members only appear while already chosen. */
export function StaffPicker({
  staff,
  value,
  onChange,
  myId,
  error,
}: {
  staff: ScheduleStaff[];
  value: number[];
  onChange: (ids: number[]) => void;
  myId: number | null;
  error?: string | null;
}) {
  const legendId = useId();
  const errorId = useId();
  const shown = staff.filter((s) => s.active || value.includes(s.id));
  const toggle = (id: number) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <fieldset aria-describedby={error ? errorId : undefined}>
      <legend id={legendId} className="mb-1.5 text-sm font-medium">
        {k("technicians")}
      </legend>
      <div className="flex flex-wrap gap-2">
        {shown.map((s) => (
          <label
            key={s.id}
            className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 select-none hover:border-blue-600 has-checked:border-blue-700 has-checked:bg-blue-700 has-checked:text-white has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-blue-600 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-blue-400 dark:has-checked:border-blue-500 dark:has-checked:bg-blue-600 dark:has-focus-visible:outline-blue-400"
          >
            <input type="checkbox" className="peer sr-only" checked={value.includes(s.id)} onChange={() => toggle(s.id)} />
            <svg className="hidden size-4 shrink-0 peer-checked:block" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="m5 12.5 4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="size-4 shrink-0 rounded-full border-2 border-slate-400 peer-checked:hidden dark:border-slate-500" aria-hidden="true" />
            <span className="break-words">
              {s.name}
              {s.id === myId && <span className="font-normal opacity-80"> ({k("you")})</span>}
              {!s.active ? (
                <span className="font-normal opacity-80"> · {k("inactive")}</span>
              ) : (
                !s.bookable && <span className="font-normal opacity-80"> · {k("notBookable")}</span>
              )}
            </span>
          </label>
        ))}
      </div>
      {error && (
        <p id={errorId} className="mt-1.5 text-sm font-medium text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/** Read-only technician names of a window; the signed-in member is highlighted. */
export function StaffTags({ ids, staff, myId, compact = false }: { ids: number[]; staff: Map<number, ScheduleStaff>; myId: number | null; compact?: boolean }) {
  const sorted = [...ids].sort((a, b) => (staff.get(a)?.name ?? "").localeCompare(staff.get(b)?.name ?? ""));
  return (
    <ul className={`flex flex-wrap gap-1 ${compact ? "lg:flex-col lg:flex-nowrap lg:items-stretch" : ""}`} aria-label={k("technicians")}>
      {sorted.map((id) => {
        const s = staff.get(id);
        const mine = id === myId;
        return (
          <li
            key={id}
            title={s?.name}
            className={`min-w-0 truncate rounded-full px-2 py-0.5 text-xs font-medium ${
              mine
                ? "bg-blue-100 text-blue-900 dark:bg-blue-400/20 dark:text-blue-100"
                : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
            } ${s && !s.active ? "line-through opacity-70" : ""}`}
          >
            {s?.name ?? `#${id}`}
            {mine && <span className="sr-only"> ({k("you")})</span>}
          </li>
        );
      })}
    </ul>
  );
}

/** Message for a schedule save that failed before or outside the impact review. */
export function scheduleErrorText(e: unknown): string {
  if (isApiError(e, 403)) return k("errors.forbidden");
  if (isApiError(e, 404)) return k("errors.notFound");
  if (isApiError(e, 400, "invalid_staff")) return k("errors.invalidStaff");
  if (isApiError(e, 400)) return k("errors.invalid");
  return actionErrorText(e);
}

/**
 * The inline edit form's frame: a labelled region, Esc cancels (unless saving), and the first field takes focus
 * when it opens.
 */
export function InlineForm({
  title,
  busy,
  onCancel,
  onSubmit,
  children,
  className = "",
}: {
  title: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: () => void;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea")?.focus();
  }, []);
  return (
    <form
      ref={ref}
      aria-labelledby={id}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) onSubmit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
      className={`space-y-4 rounded-xl border border-blue-300 bg-blue-50/60 p-4 shadow-sm dark:border-blue-400/40 dark:bg-blue-400/5 ${className}`}
    >
      <h3 id={id} className="font-semibold">
        {title}
      </h3>
      {children}
    </form>
  );
}

/** Ids of every active, bookable member: the default selection for new hours. */
export const bookableIds = (staff: ScheduleStaff[]) => staff.filter((s) => s.active && s.bookable).map((s) => s.id);
