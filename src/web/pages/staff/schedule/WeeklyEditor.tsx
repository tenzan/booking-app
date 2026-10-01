import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { windowInputSchema } from "../../../../shared/schemas";
import type { WindowDTO, WindowInput } from "../../../../shared/types";
import type { ScheduleStaff, ScheduleWindows } from "../../../api";
import { Button } from "../../../components/Button";
import { Notice } from "../../../components/Card";
import { fmtMinuteRange, fmtWeekday } from "../../../format";
import { scheduleRequest, type Submit } from "./ImpactDialog";
import { bookableIds, InlineForm, k, StaffPicker, StaffTags, TimeSelect } from "./shared";

/** Monday first. */
export const WEEK = [1, 2, 3, 4, 5, 6, 0] as const;

type Editing = { mode: "new"; weekday: number } | { mode: "edit"; id: number } | null;

const byStart = (a: { startMin: number; endMin: number }, b: { startMin: number; endMin: number }) => a.startMin - b.startMin || a.endMin - b.endMin;

/**
 * The weekly pattern: seven day columns (a stacked list on phones) of time ranges with their technicians.
 * Administrators add, edit and delete ranges inline; the day being edited widens on large screens.
 */
export function WeeklyEditor({ data, canEdit, myId, submit }: { data: ScheduleWindows; canEdit: boolean; myId: number | null; submit: Submit }) {
  const [editing, setEditing] = useState<Editing>(null);
  const restoreFocus = useRef<string | null>(null);
  const staff = useMemo(() => new Map(data.staff.map((s) => [s.id, s])), [data.staff]);
  const byDay = useMemo(() => {
    const m = new Map<number, WindowDTO[]>(WEEK.map((d) => [d, []]));
    for (const w of data.weekly) if (w.weekday !== null) m.get(w.weekday)?.push(w);
    for (const list of m.values()) list.sort(byStart);
    return m;
  }, [data.weekly]);

  // An edited range may have vanished (deleted elsewhere): drop the form instead of editing nothing.
  useEffect(() => {
    if (editing?.mode === "edit" && !data.weekly.some((w) => w.id === editing.id)) setEditing(null);
  }, [data.weekly, editing]);

  // Back to the button that opened the form once it closes.
  useEffect(() => {
    if (editing === null && restoreFocus.current) {
      document.getElementById(restoreFocus.current)?.focus();
      restoreFocus.current = null;
    }
  }, [editing]);

  const editingDay = editing === null ? null : editing.mode === "new" ? editing.weekday : (data.weekly.find((w) => w.id === editing.id)?.weekday ?? null);
  const close = (focusId: string) => {
    restoreFocus.current = focusId;
    setEditing(null);
  };

  const cols = WEEK.map((d) => (d === editingDay ? "minmax(17rem,2.4fr)" : "minmax(0,1fr)")).join(" ");

  return (
    <div className="space-y-4">
      <p className="text-slate-600 dark:text-slate-400">{canEdit ? k("weekly.lead") : k("weekly.leadReadOnly")}</p>
      <ol className="grid gap-3 lg:grid-cols-(--week-cols) lg:gap-2" style={{ "--week-cols": cols } as CSSProperties}>
        {WEEK.map((day) => {
          const windows = byDay.get(day) ?? [];
          const addId = `add-hours-${day}`;
          const isNew = editing?.mode === "new" && editing.weekday === day;
          // While another day is edited on a large screen, this column is narrow.
          const narrow = editingDay !== null && editingDay !== day;
          return (
            <li key={day} className="min-w-0">
              <section
                aria-label={fmtWeekday(day)}
                className={`flex h-full flex-col gap-2 rounded-2xl border p-3 lg:p-2 ${
                  editingDay === day
                    ? "border-blue-300 bg-white dark:border-blue-400/40 dark:bg-slate-900"
                    : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
                }`}
              >
                <h3 className="flex items-center justify-between gap-2 px-1 font-semibold lg:block lg:text-center lg:text-sm lg:tracking-wide lg:uppercase">
                  <span className="lg:hidden">{fmtWeekday(day)}</span>
                  <span className="hidden lg:inline" aria-hidden="true">
                    {fmtWeekday(day, "short")}
                  </span>
                  {windows.length === 0 && !isNew && (
                    <span className="text-sm font-normal text-slate-500 lg:hidden dark:text-slate-400">{k("weekly.closed")}</span>
                  )}
                </h3>
                {windows.length === 0 && !isNew && (
                  <p className="hidden py-3 text-center text-sm text-slate-500 lg:block dark:text-slate-400">{k("weekly.closed")}</p>
                )}
                <ul className="space-y-2">
                  {windows.map((w) =>
                    editing?.mode === "edit" && editing.id === w.id ? (
                      <li key={w.id}>
                        <WindowForm
                          day={day}
                          initial={w}
                          staff={data.staff}
                          myId={myId}
                          submit={submit}
                          onClose={() => close(`window-${w.id}`)}
                          onDeleted={() => close(addId)}
                        />
                      </li>
                    ) : (
                      <li key={w.id}>
                        <WindowCard w={w} day={day} staff={staff} myId={myId} canEdit={canEdit} narrow={narrow} onEdit={() => setEditing({ mode: "edit", id: w.id })} />
                      </li>
                    ),
                  )}
                  {isNew && (
                    <li>
                      <WindowForm day={day} initial={null} staff={data.staff} myId={myId} submit={submit} lastEnd={windows.at(-1)?.endMin} onClose={() => close(addId)} />
                    </li>
                  )}
                </ul>
                {canEdit && !isNew && (
                  <Button
                    id={addId}
                    variant="ghost"
                    onClick={() => setEditing({ mode: "new", weekday: day })}
                    className="mt-auto w-full border border-dashed border-slate-300 text-sm lg:px-1 dark:border-slate-700"
                  >
                    <svg className="size-4 shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                    <span className={`truncate ${narrow ? "lg:sr-only" : ""}`}>{k("weekly.add")}</span>
                    <span className="sr-only">
                      {" "}
                      {k("weekly.onDay", { day: fmtWeekday(day) })}
                    </span>
                  </Button>
                )}
              </section>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function WindowCard({
  w,
  day,
  staff,
  myId,
  canEdit,
  narrow = false,
  onEdit,
}: {
  w: WindowDTO;
  day: number;
  staff: Map<number, ScheduleStaff>;
  myId: number | null;
  canEdit: boolean;
  narrow?: boolean;
  onEdit: () => void;
}) {
  const body = (
    <>
      <span className={`block font-semibold whitespace-nowrap tabular-nums lg:text-sm lg:tracking-tight ${narrow ? "lg:whitespace-normal" : ""}`}>{fmtMinuteRange(w.startMin, w.endMin)}</span>
      <span className="mt-1.5 block">
        <StaffTags ids={w.staffIds} staff={staff} myId={myId} compact />
      </span>
    </>
  );
  const box = "block w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-left lg:px-2 dark:border-slate-700 dark:bg-slate-800/60";
  if (!canEdit) return <div className={box}>{body}</div>;
  return (
    <div className="group relative">
      <div className={`${box} pr-10 transition-colors group-hover:border-blue-500 lg:pr-2 dark:group-hover:border-blue-400`}>{body}</div>
      {/* The whole card is the edit target; the button stretches over it so the list inside stays a list. */}
      <button
        type="button"
        id={`window-${w.id}`}
        onClick={onEdit}
        className="absolute inset-0 flex items-start justify-end rounded-xl p-2.5 text-slate-400 group-hover:text-blue-700 lg:p-1 dark:group-hover:text-blue-300"
      >
        <svg className="size-5 lg:hidden" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M4 20h4L19 9l-4-4L4 16v4ZM14 6l4 4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="sr-only">{k("weekly.edit", { day: fmtWeekday(day), range: fmtMinuteRange(w.startMin, w.endMin) })}</span>
      </button>
    </div>
  );
}

interface FormErrors {
  range?: string;
  staff?: string;
  form?: string;
}

function WindowForm({
  day,
  initial,
  staff,
  myId,
  submit,
  lastEnd,
  onClose,
  onDeleted,
}: {
  day: number;
  initial: WindowDTO | null;
  staff: ScheduleStaff[];
  myId: number | null;
  submit: Submit;
  /** End of the day's last range, to start a new one after it. */
  lastEnd?: number;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const id = useId();
  const defaultStart = lastEnd !== undefined && lastEnd <= 1380 ? lastEnd : 540;
  const [startMin, setStart] = useState(initial?.startMin ?? defaultStart);
  const [endMin, setEnd] = useState(initial?.endMin ?? Math.min(defaultStart + 180, 1440));
  const [staffIds, setStaffIds] = useState<number[]>(initial?.staffIds ?? bookableIds(staff));
  const [errors, setErrors] = useState<FormErrors>({});
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [askDelete, setAskDelete] = useState(false);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const rangeErrorId = `${id}-range-error`;
  const dayName = fmtWeekday(day);

  useEffect(() => {
    if (askDelete) keepRef.current?.focus();
  }, [askDelete]);

  async function save() {
    const window: WindowInput = { kind: "weekly", weekday: day, date: null, startMin, endMin, staffIds };
    const parsed = windowInputSchema.safeParse(window);
    if (!parsed.success) {
      const paths = new Set(parsed.error.issues.map((i) => String(i.path[0])));
      setErrors({ range: paths.has("endMin") || paths.has("startMin") ? k("errors.endAfterStart") : undefined, staff: paths.has("staffIds") ? k("errors.chooseStaff") : undefined });
      return;
    }
    setErrors({});
    setBusy("save");
    const range = fmtMinuteRange(startMin, endMin);
    const result = await submit(
      scheduleRequest(
        initial ? { type: "window.update", id: initial.id, window } : { type: "window.create", window },
        initial
          ? { summary: k("weekly.summaryUpdate", { day: dayName, range }), done: k("weekly.doneUpdate", { day: dayName, range }) }
          : { summary: k("weekly.summaryCreate", { day: dayName, range }), done: k("weekly.doneCreate", { day: dayName, range }) },
        onClose,
      ),
    );
    setBusy(null);
    if (result.status === "failed") setErrors({ form: result.message });
  }

  async function remove() {
    if (!initial) return;
    setBusy("delete");
    const range = fmtMinuteRange(initial.startMin, initial.endMin);
    const result = await submit(
      scheduleRequest(
        { type: "window.delete", id: initial.id },
        { summary: k("weekly.summaryDelete", { day: dayName, range }), done: k("weekly.doneDelete", { day: dayName, range }) },
        onDeleted,
      ),
    );
    setBusy(null);
    if (result.status === "failed") {
      setAskDelete(false);
      setErrors({ form: result.message });
    }
  }

  return (
    <InlineForm title={initial ? k("weekly.editTitle", { day: dayName }) : k("weekly.newTitle", { day: dayName })} busy={busy !== null} onCancel={onClose} onSubmit={() => void save()}>
      <div>
        <div className="grid grid-cols-2 gap-3">
          <TimeSelect id={`${id}-start`} label={k("from")} value={startMin} onChange={setStart} invalid={Boolean(errors.range)} describedBy={errors.range ? rangeErrorId : undefined} />
          <TimeSelect id={`${id}-end`} label={k("to")} value={endMin} onChange={setEnd} end invalid={Boolean(errors.range)} describedBy={errors.range ? rangeErrorId : undefined} />
        </div>
        {errors.range && (
          <p id={rangeErrorId} className="mt-1.5 text-sm font-medium text-red-700 dark:text-red-400">
            {errors.range}
          </p>
        )}
      </div>
      <StaffPicker staff={staff} value={staffIds} onChange={setStaffIds} myId={myId} error={errors.staff} />
      {/* Always rendered so problems are announced; it takes no space while empty. */}
      <div aria-live="polite" className="empty:hidden">
        {errors.form && <Notice tone="error">{errors.form}</Notice>}
      </div>
      {askDelete ? (
        <div
          role="group"
          aria-labelledby={`${id}-ask`}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              if (busy === null) {
                setAskDelete(false);
                requestAnimationFrame(() => deleteRef.current?.focus());
              }
            }
          }}
          className="space-y-3 rounded-lg border border-red-300 bg-white p-3 dark:border-red-400/40 dark:bg-slate-900"
        >
          <p id={`${id}-ask`} className="text-sm font-medium">
            {k("weekly.deleteAsk", { day: dayName, range: fmtMinuteRange(initial!.startMin, initial!.endMin) })}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="danger" loading={busy === "delete"} onClick={() => void remove()}>
              {busy === "delete" ? k("checking") : k("weekly.deleteConfirm")}
            </Button>
            <Button
              ref={keepRef}
              variant="secondary"
              disabled={busy !== null}
              onClick={() => {
                setAskDelete(false);
                requestAnimationFrame(() => deleteRef.current?.focus());
              }}
            >
              {k("keep")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" loading={busy === "save"} className="flex-1 sm:flex-none">
            {busy === "save" ? k("checking") : k("save")}
          </Button>
          <Button variant="secondary" disabled={busy !== null} onClick={onClose} className="flex-1 sm:flex-none">
            {k("cancel")}
          </Button>
          {initial && (
            <Button
              ref={deleteRef}
              variant="ghost"
              disabled={busy !== null}
              onClick={() => setAskDelete(true)}
              className="text-red-700 hover:bg-red-50 sm:ml-auto dark:text-red-300 dark:hover:bg-red-400/10"
            >
              {k("delete")}
            </Button>
          )}
        </div>
      )}
    </InlineForm>
  );
}
