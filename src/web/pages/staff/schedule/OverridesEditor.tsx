import { useEffect, useId, useMemo, useRef, useState } from "react";
import { isoDateSchema, windowInputSchema } from "../../../../shared/schemas";
import type { WindowDTO, WindowInput } from "../../../../shared/types";
import type { Holiday, ScheduleOverride, ScheduleStaff, ScheduleWindows } from "../../../api";
import { Button } from "../../../components/Button";
import { Notice } from "../../../components/Card";
import { EmptyState } from "../../../components/EmptyState";
import { inputClass } from "../../../components/Field";
import { dayParts, fmtLongDate, fmtMinuteRange, fmtShortDate, fmtWeekday, weekdayOf } from "../../../format";
import { scheduleRequest, type Submit } from "./ImpactDialog";
import { bookableIds, InlineForm, k, StaffPicker, StaffTags, TimeSelect } from "./shared";

interface Row {
  date: string;
  override: ScheduleOverride | null;
  holiday: string | null;
}

type Editing = { mode: "new"; date?: string } | { mode: "edit"; date: string } | null;

/**
 * Date-specific schedules (closed, or custom hours) with the upcoming holidays alongside, since a date's own
 * schedule takes precedence over both the holiday and the weekly pattern.
 */
export function OverridesEditor({
  data,
  holidays,
  today,
  canEdit,
  myId,
  submit,
}: {
  data: ScheduleWindows;
  holidays: Holiday[];
  today: string;
  canEdit: boolean;
  myId: number | null;
  submit: Submit;
}) {
  const [editing, setEditing] = useState<Editing>(null);
  const restoreFocus = useRef<string | null>(null);
  const staff = useMemo(() => new Map(data.staff.map((s) => [s.id, s])), [data.staff]);
  const holidayByDate = useMemo(() => new Map(holidays.map((h) => [h.date, h.name])), [holidays]);
  const rows = useMemo(() => {
    const m = new Map<string, Row>();
    for (const o of data.overrides) m.set(o.date, { date: o.date, override: o, holiday: holidayByDate.get(o.date) ?? null });
    for (const h of holidays) if (h.date >= today && !m.has(h.date)) m.set(h.date, { date: h.date, override: null, holiday: h.name });
    return [...m.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [data.overrides, holidays, holidayByDate, today]);

  useEffect(() => {
    if (editing === null && restoreFocus.current) {
      document.getElementById(restoreFocus.current)?.focus();
      restoreFocus.current = null;
    }
  }, [editing]);

  const close = (focusId: string) => {
    restoreFocus.current = focusId;
    setEditing(null);
  };

  const formFor = (date: string | undefined, focusId: string) => (
    <OverrideForm
      key={date ?? "new"}
      date={date}
      today={today}
      data={data}
      holidayByDate={holidayByDate}
      myId={myId}
      submit={submit}
      onClose={() => close(focusId)}
    />
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-prose space-y-1">
          <p className="text-slate-600 dark:text-slate-400">{k("overrides.lead")}</p>
          <p className="flex items-start gap-1.5 text-sm text-slate-600 dark:text-slate-400">
            <svg className="mt-0.5 size-4 shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.75" />
              <path d="M12 11v5m0-8h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            {k("overrides.precedence")}
          </p>
        </div>
        {canEdit && !(editing?.mode === "new" && !editing.date) && (
          <Button id="add-override" onClick={() => setEditing({ mode: "new" })}>
            <svg className="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            {k("overrides.add")}
          </Button>
        )}
      </div>

      {editing?.mode === "new" && !editing.date && formFor(undefined, "add-override")}

      {rows.length === 0 && editing === null ? (
        <EmptyState title={k("overrides.empty")} body={canEdit ? k("overrides.emptyBody") : undefined} />
      ) : (
        <ul className="space-y-2">
          {rows.map((r) =>
            editing?.date === r.date ? (
              <li key={r.date}>{formFor(r.date, `override-${r.date}`)}</li>
            ) : (
              <li key={r.date}>
                <OverrideRow
                  r={r}
                  staff={staff}
                  myId={myId}
                  canEdit={canEdit && editing === null}
                  submit={submit}
                  onEdit={() => setEditing(r.override ? { mode: "edit", date: r.date } : { mode: "new", date: r.date })}
                />
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}

function DateTile({ date }: { date: string }) {
  const p = dayParts(date);
  return (
    <div className="flex w-14 shrink-0 flex-col items-center self-start rounded-xl bg-slate-100 py-1.5 leading-tight dark:bg-slate-800" aria-hidden="true">
      <span className="text-xs font-semibold text-slate-500 uppercase dark:text-slate-400">{p.weekday}</span>
      <span className="text-xl font-bold tabular-nums">{p.day}</span>
      <span className="text-xs text-slate-600 dark:text-slate-400">{p.month}</span>
    </div>
  );
}

function OverrideRow({
  r,
  staff,
  myId,
  canEdit,
  submit,
  onEdit,
}: {
  r: Row;
  staff: Map<number, ScheduleStaff>;
  myId: number | null;
  canEdit: boolean;
  submit: Submit;
  onEdit: () => void;
}) {
  const id = useId();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const o = r.override;
  const label = fmtShortDate(r.date);

  useEffect(() => {
    if (asking) keepRef.current?.focus();
  }, [asking]);

  const stopAsking = () => {
    setAsking(false);
    requestAnimationFrame(() => removeRef.current?.focus());
  };

  async function clear() {
    setBusy(true);
    setProblem(null);
    const result = await submit(
      scheduleRequest(
        { type: "override.clear", date: r.date },
        { summary: k("overrides.summaryClear", { date: label }), done: k("overrides.doneClear", { date: label }) },
      ),
    );
    setBusy(false);
    if (result.status === "failed") {
      setAsking(false);
      setProblem(result.message);
    }
  }

  return (
    <article aria-labelledby={`${id}-date`} className="flex gap-3 rounded-2xl border border-slate-200 bg-white p-3 sm:gap-4 sm:p-4 dark:border-slate-800 dark:bg-slate-900">
      <DateTile date={r.date} />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id={`${id}-date`} className="font-semibold">
            {fmtLongDate(r.date)}
          </h3>
          {r.holiday && (
            <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-900 dark:bg-violet-400/15 dark:text-violet-200">
              {k("overrides.holiday", { name: r.holiday })}
            </span>
          )}
        </div>
        {!o ? (
          <p className="text-slate-600 dark:text-slate-400">{k("overrides.holidayClosed")}</p>
        ) : o.windows.length === 0 ? (
          <p>
            <span className="rounded-full bg-zinc-200 px-2.5 py-0.5 text-sm font-semibold text-zinc-800 dark:bg-zinc-700 dark:text-zinc-100">
              {k("overrides.closedAllDay")}
            </span>
          </p>
        ) : (
          <ul className="space-y-1.5">
            {[...o.windows].sort((a, b) => a.startMin - b.startMin).map((w) => (
              <li key={w.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-semibold tabular-nums">{fmtMinuteRange(w.startMin, w.endMin)}</span>
                <StaffTags ids={w.staffIds} staff={staff} myId={myId} />
              </li>
            ))}
          </ul>
        )}
        {o?.note && <p className="text-sm break-words text-slate-600 italic dark:text-slate-400">{o.note}</p>}
        {o && r.holiday && <p className="text-sm text-slate-500 dark:text-slate-400">{k("overrides.overridesHoliday")}</p>}

        <div aria-live="polite" className="empty:hidden">
          {problem && <Notice tone="error">{problem}</Notice>}
        </div>

        {canEdit &&
          (asking ? (
            <div
              role="group"
              aria-labelledby={`${id}-ask`}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  if (!busy) stopAsking();
                }
              }}
              className="space-y-3 rounded-lg border border-slate-300 bg-slate-50 p-3 dark:border-slate-600 dark:bg-slate-800/50"
            >
              <p id={`${id}-ask`} className="text-sm font-medium">
                {r.holiday ? k("overrides.clearAskHoliday", { date: label }) : k("overrides.clearAsk", { date: label })}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="danger" loading={busy} onClick={() => void clear()}>
                  {busy ? k("checking") : k("overrides.clearConfirm")}
                </Button>
                <Button ref={keepRef} variant="secondary" disabled={busy} onClick={stopAsking}>
                  {k("keep")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="-ml-2 flex flex-wrap gap-1">
              <Button id={`override-${r.date}`} variant="ghost" onClick={onEdit}>
                {o ? k("edit") : k("overrides.setHours")}
                <span className="sr-only"> {label}</span>
              </Button>
              {o && (
                <Button
                  ref={removeRef}
                  variant="ghost"
                  onClick={() => setAsking(true)}
                  className="text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-400/10"
                >
                  {k("overrides.clear")}
                  <span className="sr-only"> {label}</span>
                </Button>
              )}
            </div>
          ))}
      </div>
    </article>
  );
}

interface Range {
  key: number;
  startMin: number;
  endMin: number;
  staffIds: number[];
}

let rangeKey = 0;
const toRange = (w: { startMin: number; endMin: number; staffIds: number[] }): Range => ({ key: ++rangeKey, startMin: w.startMin, endMin: w.endMin, staffIds: [...w.staffIds] });
const MAX_RANGES = 24;

function OverrideForm({
  date: fixedDate,
  today,
  data,
  holidayByDate,
  myId,
  submit,
  onClose,
}: {
  /** Set when editing (or starting from a holiday row); the date can then not change. */
  date?: string;
  today: string;
  data: ScheduleWindows;
  holidayByDate: Map<string, string>;
  myId: number | null;
  submit: Submit;
  onClose: () => void;
}) {
  const id = useId();
  const existingFor = (d: string) => data.overrides.find((o) => o.date === d) ?? null;
  const weeklyFor = (d: string): WindowDTO[] =>
    isoDateSchema.safeParse(d).success ? data.weekly.filter((w) => w.weekday === weekdayOf(d)).sort((a, b) => a.startMin - b.startMin) : [];
  const initial = fixedDate ? existingFor(fixedDate) : null;

  const [date, setDate] = useState(fixedDate ?? "");
  const [closed, setClosed] = useState(initial ? initial.windows.length === 0 : !fixedDate);
  const [ranges, setRanges] = useState<Range[]>(() =>
    initial && initial.windows.length > 0 ? initial.windows.map(toRange) : fixedDate ? weeklyFor(fixedDate).map(toRange) : [],
  );
  const [note, setNote] = useState(initial?.note ?? "");
  const [errors, setErrors] = useState<{ date?: string; ranges?: Record<number, { range?: string; staff?: string }>; form?: string }>({});
  const [busy, setBusy] = useState(false);

  const validDate = isoDateSchema.safeParse(date).success;
  const existing = !fixedDate && validDate ? existingFor(date) : null;
  const holiday = validDate ? holidayByDate.get(date) : undefined;
  const weekly = validDate ? weeklyFor(date) : [];

  function chooseCustom() {
    setClosed(false);
    if (ranges.length === 0) {
      const base = weekly.length > 0 ? weekly : [{ startMin: 540, endMin: 1020, staffIds: bookableIds(data.staff) }];
      setRanges(base.map(toRange));
    }
  }

  const update = (key: number, patch: Partial<Range>) => setRanges((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  async function save() {
    const next: typeof errors = {};
    if (!validDate) next.date = k("errors.date");
    else if (date < today) next.date = k("errors.pastDate");
    const windows: WindowInput[] = closed ? [] : ranges.map((r) => ({ kind: "date", weekday: null, date, startMin: r.startMin, endMin: r.endMin, staffIds: r.staffIds }));
    if (!closed) {
      if (ranges.length === 0) next.form = k("errors.addRange");
      const rangeErrors: Record<number, { range?: string; staff?: string }> = {};
      ranges.forEach((r, i) => {
        const parsed = windowInputSchema.safeParse({ ...windows[i]!, date: validDate ? date : "2000-01-01" });
        if (parsed.success) return;
        const paths = new Set(parsed.error.issues.map((x) => String(x.path[0])));
        rangeErrors[r.key] = {
          range: paths.has("endMin") || paths.has("startMin") ? k("errors.endAfterStart") : undefined,
          staff: paths.has("staffIds") ? k("errors.chooseStaff") : undefined,
        };
      });
      if (Object.keys(rangeErrors).length > 0) next.ranges = rangeErrors;
    }
    setErrors(next);
    if (next.date || next.ranges || next.form) {
      if (next.date) document.getElementById(`${id}-date`)?.focus();
      return;
    }
    setBusy(true);
    const label = fmtShortDate(date);
    const trimmed = note.trim();
    const result = await submit(
      scheduleRequest(
        { type: "override.set", date, windows, ...(trimmed ? { note: trimmed } : {}) },
        closed
          ? { summary: k("overrides.summaryClosed", { date: label }), done: k("overrides.doneClosed", { date: label }) }
          : { summary: k("overrides.summaryHours", { date: label }), done: k("overrides.doneHours", { date: label }) },
        onClose,
      ),
    );
    setBusy(false);
    if (result.status === "failed") setErrors({ form: result.message });
  }

  const title = initial ? k("overrides.editTitle", { date: fmtLongDate(fixedDate!) }) : fixedDate ? k("overrides.newTitleFor", { date: fmtLongDate(fixedDate) }) : k("overrides.newTitle");

  return (
    <InlineForm title={title} busy={busy} onCancel={onClose} onSubmit={() => void save()}>
      {!fixedDate && (
        <div className="max-w-xs">
          <label htmlFor={`${id}-date`} className="mb-1.5 block font-medium">
            {k("overrides.date")}
          </label>
          <input
            id={`${id}-date`}
            type="date"
            min={today}
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              setErrors((x) => ({ ...x, date: undefined }));
              const found = existingFor(e.target.value);
              if (found) {
                setClosed(found.windows.length === 0);
                setRanges(found.windows.map(toRange));
                setNote(found.note ?? "");
              }
            }}
            aria-invalid={Boolean(errors.date)}
            aria-describedby={errors.date ? `${id}-date-error` : undefined}
            className={`${inputClass} min-h-11 py-2.5`}
          />
          {errors.date && (
            <p id={`${id}-date-error`} className="mt-1.5 text-sm font-medium text-red-700 dark:text-red-400">
              {errors.date}
            </p>
          )}
        </div>
      )}

      {validDate && (
        <div className="space-y-1 text-sm text-slate-600 dark:text-slate-400">
          <p>
            {weekly.length > 0
              ? k("overrides.normally", { day: fmtWeekday(weekdayOf(date)), ranges: weekly.map((w) => fmtMinuteRange(w.startMin, w.endMin)).join(", ") })
              : k("overrides.normallyClosed", { day: fmtWeekday(weekdayOf(date)) })}
          </p>
          {holiday && <p className="font-medium text-violet-800 dark:text-violet-300">{k("overrides.isHoliday", { name: holiday })}</p>}
          {existing && <p className="font-medium text-amber-800 dark:text-amber-300">{k("overrides.alreadySet")}</p>}
        </div>
      )}

      <fieldset>
        <legend className="mb-1.5 font-medium">{k("overrides.mode")}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {([true, false] as const).map((isClosed) => (
            <label
              key={String(isClosed)}
              className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-slate-300 bg-white px-4 py-2.5 has-checked:border-blue-700 has-checked:bg-blue-50 has-checked:ring-1 has-checked:ring-blue-700 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-blue-600 dark:border-slate-600 dark:bg-slate-900 dark:has-checked:border-blue-400 dark:has-checked:bg-blue-400/10 dark:has-checked:ring-blue-400"
            >
              <input
                type="radio"
                name={`${id}-mode`}
                checked={closed === isClosed}
                onChange={() => (isClosed ? setClosed(true) : chooseCustom())}
                className="size-5 shrink-0 accent-blue-700 focus-visible:outline-none"
              />
              <span>
                <span className="block font-medium">{isClosed ? k("overrides.closedAllDay") : k("overrides.customHours")}</span>
                <span className="block text-sm text-slate-600 dark:text-slate-400">{isClosed ? k("overrides.closedHint") : k("overrides.customHint")}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {!closed && (
        <ol className="space-y-3">
          {ranges.map((r, i) => {
            const err = errors.ranges?.[r.key];
            const errId = `${id}-r${r.key}-error`;
            return (
              <li key={r.key} className="space-y-3 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
                <div className="flex items-end gap-3">
                  <div className="grid flex-1 grid-cols-2 gap-3 sm:max-w-sm">
                    <TimeSelect
                      id={`${id}-r${r.key}-start`}
                      label={k("from")}
                      value={r.startMin}
                      onChange={(v) => update(r.key, { startMin: v })}
                      invalid={Boolean(err?.range)}
                      describedBy={err?.range ? errId : undefined}
                    />
                    <TimeSelect
                      id={`${id}-r${r.key}-end`}
                      label={k("to")}
                      value={r.endMin}
                      end
                      onChange={(v) => update(r.key, { endMin: v })}
                      invalid={Boolean(err?.range)}
                      describedBy={err?.range ? errId : undefined}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setRanges((rs) => rs.filter((x) => x.key !== r.key))}
                    className="ml-auto grid size-11 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-red-50 hover:text-red-700 dark:text-slate-400 dark:hover:bg-red-400/10 dark:hover:text-red-300"
                    aria-label={k("overrides.removeRange", { n: i + 1 })}
                  >
                    <svg className="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </div>
                {err?.range && (
                  <p id={errId} className="-mt-1.5 text-sm font-medium text-red-700 dark:text-red-400">
                    {err.range}
                  </p>
                )}
                <StaffPicker staff={data.staff} value={r.staffIds} onChange={(ids) => update(r.key, { staffIds: ids })} myId={myId} error={err?.staff} />
              </li>
            );
          })}
          {ranges.length < MAX_RANGES && (
            <li>
              <Button
                variant="ghost"
                onClick={() => {
                  const last = ranges.at(-1);
                  const start = last && last.endMin <= 1380 ? last.endMin : 540;
                  setRanges((rs) => [...rs, toRange({ startMin: start, endMin: Math.min(start + 180, 1440), staffIds: last?.staffIds ?? bookableIds(data.staff) })]);
                }}
                className="w-full border border-dashed border-slate-300 dark:border-slate-700"
              >
                <svg className="size-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                {k("overrides.addRange")}
              </Button>
            </li>
          )}
        </ol>
      )}

      <div>
        <label htmlFor={`${id}-note`} className="mb-1.5 block font-medium">
          {k("overrides.note")} <span className="font-normal text-slate-500 dark:text-slate-400">({k("optional")})</span>
        </label>
        <input
          id={`${id}-note`}
          value={note}
          maxLength={200}
          onChange={(e) => setNote(e.target.value)}
          aria-describedby={`${id}-note-hint`}
          className={`${inputClass} min-h-11 py-2.5`}
        />
        <p id={`${id}-note-hint`} className="mt-1.5 text-sm text-slate-600 dark:text-slate-400">
          {k("overrides.noteHint")}
        </p>
      </div>

      <div aria-live="polite" className="empty:hidden">
        {errors.form && <Notice tone="error">{errors.form}</Notice>}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={busy} className="flex-1 sm:flex-none">
          {busy ? k("checking") : k("save")}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onClose} className="flex-1 sm:flex-none">
          {k("cancel")}
        </Button>
      </div>
    </InlineForm>
  );
}
