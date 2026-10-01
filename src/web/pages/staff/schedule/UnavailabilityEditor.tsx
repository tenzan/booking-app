import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { utcToWall, wallToUtc } from "../../../../domain/time";
import { isoDateSchema, MAX_UNAVAILABILITY_DAYS, unavailabilityChangeSchemas } from "../../../../shared/schemas";
import type { UnavailabilityDTO } from "../../../../shared/types";
import { apiFetch, queryKeys, type ScheduleStaff, type UnavailabilityList } from "../../../api";
import { Button } from "../../../components/Button";
import { Card, Notice } from "../../../components/Card";
import { EmptyState } from "../../../components/EmptyState";
import { inputClass } from "../../../components/Field";
import { Skeleton } from "../../../components/Spinner";
import { addDays, fmtShortDate, fmtTime } from "../../../format";
import { t } from "../../../i18n";
import { scheduleRequest, type Submit } from "./ImpactDialog";
import { InlineForm, k, selectClass, TimeSelect } from "./shared";

const DAY_MS = 24 * 60 * 60_000;
/** How far ahead the list looks. */
const SPAN_MS = (MAX_UNAVAILABILITY_DAYS + 1) * DAY_MS;

/** Wall-clock pieces of an instant in `tz`: date and minute of the day. */
const wall = (ms: number, tz: string) => utcToWall(ms, tz);

/** All day: starts and ends at midnight. */
const isAllDay = (u: { startAt: number; endAt: number }, tz: string) => wall(u.startAt, tz).minute === 0 && wall(u.endAt, tz).minute === 0;

/** "Mon, Oct 5 · All day", "Mon, Oct 5 – Wed, Oct 7 · All day", "Mon, Oct 5 · 09:00 – 12:00", "Mon, Oct 5, 09:00 – Tue, Oct 6, 17:00". */
export function fmtTimeOff(u: { startAt: number; endAt: number }, tz: string): string {
  const s = wall(u.startAt, tz);
  const e = wall(u.endAt, tz);
  if (isAllDay(u, tz)) {
    const last = addDays(e.date, -1);
    return last === s.date
      ? k("timeOff.allDayOne", { date: fmtShortDate(s.date) })
      : k("timeOff.allDayRange", { from: fmtShortDate(s.date), to: fmtShortDate(last) });
  }
  if (s.date === e.date) return k("timeOff.sameDay", { date: fmtShortDate(s.date), from: fmtTime(u.startAt, tz), to: fmtTime(u.endAt, tz) });
  return k("timeOff.span", { fromDate: fmtShortDate(s.date), from: fmtTime(u.startAt, tz), toDate: fmtShortDate(e.date), to: fmtTime(u.endAt, tz) });
}

type Editing = { mode: "new" } | { mode: "edit"; id: number } | null;

/**
 * Upcoming time off, grouped by technician. Administrators manage everyone's; a technician adds, edits and removes
 * only their own (and sees the rest).
 */
export function UnavailabilityEditor({
  staff,
  isAdmin,
  myId,
  tz,
  today,
  submit,
}: {
  staff: ScheduleStaff[];
  isAdmin: boolean;
  myId: number | null;
  tz: string;
  today: string;
  submit: Submit;
}) {
  const filterId = useId();
  const [filter, setFilter] = useState<number | "all">(isAdmin || myId === null ? "all" : myId);
  const [editing, setEditing] = useState<Editing>(null);
  const restoreFocus = useRef<string | null>(null);
  // From the start of today, so all-day entries for today stay listed.
  const from = wallToUtc(today, 0, tz);
  const query = `from=${from}&to=${from + SPAN_MS}${filter === "all" ? "" : `&staffId=${filter}`}`;
  const q = useQuery({
    queryKey: queryKeys.scheduleUnavailability(query),
    queryFn: () => apiFetch<UnavailabilityList>(`/api/staff/schedule/unavailability?${query}`),
  });

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

  const canManage = (staffId: number) => isAdmin || staffId === myId;
  const groups = useMemo(() => {
    const m = new Map<number, { staffId: number; name: string; items: UnavailabilityDTO[] }>();
    for (const u of q.data?.unavailability ?? []) {
      const g = m.get(u.staffId) ?? { staffId: u.staffId, name: u.staffName, items: [] };
      g.items.push(u);
      m.set(u.staffId, g);
    }
    // The signed-in member first, then by name.
    return [...m.values()].sort((a, b) => Number(b.staffId === myId) - Number(a.staffId === myId) || a.name.localeCompare(b.name));
  }, [q.data, myId]);
  const activeStaff = staff.filter((s) => s.active);

  const form = (initial: UnavailabilityDTO | null, focusId: string) => (
    <TimeOffForm
      initial={initial}
      staff={activeStaff}
      isAdmin={isAdmin}
      myId={myId}
      defaultStaffId={isAdmin ? (filter === "all" ? null : filter) : myId}
      tz={tz}
      today={today}
      submit={submit}
      onClose={() => close(focusId)}
    />
  );

  return (
    <div className="space-y-4">
      <p className="text-slate-600 dark:text-slate-400">{isAdmin ? k("timeOff.lead") : k("timeOff.leadOwn")}</p>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="w-full sm:w-64">
          <label htmlFor={filterId} className="mb-1.5 block text-sm font-medium">
            {k("timeOff.show")}
          </label>
          <select
            id={filterId}
            value={filter}
            onChange={(e) => setFilter(e.target.value === "all" ? "all" : Number(e.target.value))}
            className={selectClass}
          >
            <option value="all">{k("timeOff.everyone")}</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id === myId ? `${s.name} (${k("you")})` : s.name}
              </option>
            ))}
          </select>
        </div>
        {editing?.mode !== "new" && (isAdmin || myId !== null) && (
          <Button id="add-time-off" onClick={() => setEditing({ mode: "new" })} className="w-full sm:w-auto">
            <svg className="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            {isAdmin ? k("timeOff.add") : k("timeOff.addOwn")}
          </Button>
        )}
      </div>

      {editing?.mode === "new" && form(null, "add-time-off")}

      {q.isPending ? (
        <div className="space-y-3" aria-busy="true">
          <span className="sr-only">{t("web.common.loading")}</span>
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : q.isError ? (
        <Notice tone="error" className="flex flex-wrap items-center justify-between gap-3">
          {k("loadFailed")}
          <Button variant="secondary" onClick={() => void q.refetch()}>
            {t("web.common.retry")}
          </Button>
        </Notice>
      ) : groups.length === 0 ? (
        editing === null && <EmptyState title={k("timeOff.empty")} body={k("timeOff.emptyBody")} />
      ) : (
        <div className="space-y-5">
          {groups.map((g) => (
            <section key={g.staffId} aria-labelledby={`time-off-${g.staffId}`} className="space-y-2">
              <h3 id={`time-off-${g.staffId}`} className="font-semibold">
                {g.name}
                {g.staffId === myId && <span className="font-normal text-slate-500 dark:text-slate-400"> ({k("you")})</span>}
              </h3>
              <Card flush>
                <ul className="divide-y divide-slate-200 dark:divide-slate-800">
                  {g.items.map((u) =>
                    editing?.mode === "edit" && editing.id === u.id ? (
                      <li key={u.id} className="p-2">
                        {form(u, `time-off-edit-${u.id}`)}
                      </li>
                    ) : (
                      <li key={u.id}>
                        <TimeOffRow u={u} tz={tz} canManage={canManage(u.staffId) && editing === null} submit={submit} onEdit={() => setEditing({ mode: "edit", id: u.id })} />
                      </li>
                    ),
                  )}
                </ul>
              </Card>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function TimeOffRow({ u, tz, canManage, submit, onEdit }: { u: UnavailabilityDTO; tz: string; canManage: boolean; submit: Submit; onEdit: () => void }) {
  const id = useId();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const when = fmtTimeOff(u, tz);

  useEffect(() => {
    if (asking) keepRef.current?.focus();
  }, [asking]);

  const stopAsking = () => {
    setAsking(false);
    requestAnimationFrame(() => removeRef.current?.focus());
  };

  async function remove() {
    setBusy(true);
    setProblem(null);
    const result = await submit(
      scheduleRequest(
        { type: "unavailability.delete", id: u.id },
        { summary: k("timeOff.summaryDelete", { name: u.staffName, when }), done: k("timeOff.doneDelete", { name: u.staffName }) },
      ),
    );
    setBusy(false);
    if (result.status === "failed") {
      setAsking(false);
      setProblem(result.message);
    }
  }

  return (
    <div className="space-y-3 px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <p className="font-medium tabular-nums">{when}</p>
          {u.reason && <p className="text-sm break-words text-slate-600 dark:text-slate-400">{u.reason}</p>}
        </div>
        {canManage && !asking && (
          <div className="-mr-2 flex gap-1">
            <Button id={`time-off-edit-${u.id}`} variant="ghost" onClick={onEdit}>
              {k("edit")}
              <span className="sr-only"> {when}</span>
            </Button>
            <Button ref={removeRef} variant="ghost" onClick={() => setAsking(true)} className="text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-400/10">
              {k("delete")}
              <span className="sr-only"> {when}</span>
            </Button>
          </div>
        )}
      </div>
      <div aria-live="polite" className="empty:hidden">
        {problem && <Notice tone="error">{problem}</Notice>}
      </div>
      {asking && (
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
            {k("timeOff.deleteAsk", { name: u.staffName, when })}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="danger" loading={busy} onClick={() => void remove()}>
              {busy ? k("checking") : k("timeOff.deleteConfirm")}
            </Button>
            <Button ref={keepRef} variant="secondary" disabled={busy} onClick={stopAsking}>
              {k("keep")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

const createSchema = unavailabilityChangeSchemas[0];

function TimeOffForm({
  initial,
  staff,
  isAdmin,
  myId,
  defaultStaffId,
  tz,
  today,
  submit,
  onClose,
}: {
  initial: UnavailabilityDTO | null;
  staff: ScheduleStaff[];
  isAdmin: boolean;
  myId: number | null;
  defaultStaffId: number | null;
  tz: string;
  today: string;
  submit: Submit;
  onClose: () => void;
}) {
  const id = useId();
  const start = initial ? wall(initial.startAt, tz) : { date: today, minute: 540 };
  const end = initial ? wall(initial.endAt, tz) : { date: today, minute: 1020 };
  const initialAllDay = initial ? isAllDay(initial, tz) : true;
  const [chosenId, setStaffId] = useState<number | null>(initial?.staffId ?? defaultStaffId);
  // A technician only ever books time off for themselves, whatever the list is filtered to.
  const staffId = isAdmin ? chosenId : myId;
  const [allDay, setAllDay] = useState(initialAllDay);
  const [startDate, setStartDate] = useState(start.date);
  const [startMin, setStartMin] = useState(initialAllDay ? 540 : start.minute);
  // An all-day entry ends at midnight after its last day; the form shows that last day.
  const [endDate, setEndDate] = useState(initial && initialAllDay ? addDays(end.date, -1) : end.date);
  const [endMin, setEndMin] = useState(initialAllDay ? 1020 : end.minute === 0 ? 1440 : end.minute);
  const [reason, setReason] = useState(initial?.reason ?? "");
  const [errors, setErrors] = useState<{ staff?: string; range?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);

  async function save() {
    const next: typeof errors = {};
    if (staffId === null) next.staff = k("errors.chooseOne");
    if (!isoDateSchema.safeParse(startDate).success || !isoDateSchema.safeParse(endDate).success) next.range = k("errors.date");
    let startAt = 0;
    let endAt = 0;
    if (!next.range) {
      startAt = wallToUtc(startDate, allDay ? 0 : startMin, tz);
      endAt = allDay ? wallToUtc(addDays(endDate, 1), 0, tz) : wallToUtc(endDate, endMin, tz);
      const parsed = createSchema.safeParse({ type: "unavailability.create", staffId: staffId ?? 1, startAt, endAt, reason: reason.trim() || undefined });
      if (!parsed.success) {
        next.range = endAt <= startAt ? (allDay ? k("errors.lastDayAfterFirst") : k("errors.endAfterStart")) : k("errors.tooLong", { days: MAX_UNAVAILABILITY_DAYS });
      }
    }
    setErrors(next);
    if (next.staff || next.range) return;
    setBusy(true);
    const name = staff.find((s) => s.id === staffId)?.name ?? initial?.staffName ?? "";
    const when = fmtTimeOff({ startAt, endAt }, tz);
    const trimmed = reason.trim();
    const create = { type: "unavailability.create" as const, staffId: staffId!, startAt, endAt, ...(trimmed ? { reason: trimmed } : {}) };
    // There is no "update": an edit adds the new entry first, then removes the old one (so a failure never loses time off).
    const result = await submit(
      scheduleRequest(
        create,
        initial
          ? { summary: k("timeOff.summaryUpdate", { name, when }), done: k("timeOff.doneUpdate", { name }) }
          : { summary: k("timeOff.summaryCreate", { name, when }), done: k("timeOff.doneCreate", { name }) },
        initial ? () => void removeOld(initial.id) : onClose,
      ),
    );
    setBusy(false);
    if (result.status === "failed") setErrors({ form: result.message });
  }

  /** Second half of an edit; removing time off only frees capacity, so it never needs a review. */
  async function removeOld(oldId: number) {
    const result = await submit(
      scheduleRequest(
        { type: "unavailability.delete", id: oldId },
        { summary: k("timeOff.summaryDelete", { name: initial!.staffName, when: fmtTimeOff(initial!, tz) }), done: k("timeOff.doneUpdate", { name: initial!.staffName }) },
        // Closes the form whether this half applies at once or after a review in the dialog.
        onClose,
      ),
    );
    if (result.status === "failed") setErrors({ form: k("timeOff.oldNotRemoved") });
  }

  const me = staff.find((s) => s.id === myId);
  const rangeErrorId = `${id}-range-error`;
  const dateField = (which: "start" | "end") => (
    <div className="min-w-0">
      <label htmlFor={`${id}-${which}-date`} className="mb-1.5 block text-sm font-medium">
        {allDay ? (which === "start" ? k("timeOff.firstDay") : k("timeOff.lastDay")) : which === "start" ? k("timeOff.startDate") : k("timeOff.endDate")}
      </label>
      <input
        id={`${id}-${which}-date`}
        type="date"
        min={which === "start" ? today : startDate || today}
        value={which === "start" ? startDate : endDate}
        onChange={(e) => {
          const v = e.target.value;
          if (which === "start") {
            setStartDate(v);
            if (endDate < v) setEndDate(v);
          } else setEndDate(v);
        }}
        aria-invalid={Boolean(errors.range)}
        aria-describedby={errors.range ? rangeErrorId : undefined}
        className={`${inputClass} min-h-11 py-2.5`}
      />
    </div>
  );

  return (
    <InlineForm title={initial ? k("timeOff.editTitle", { name: initial.staffName }) : k("timeOff.newTitle")} busy={busy} onCancel={onClose} onSubmit={() => void save()}>
      {isAdmin ? (
        <div className="sm:max-w-xs">
          <label htmlFor={`${id}-staff`} className="mb-1.5 block text-sm font-medium">
            {t("common.technician")}
          </label>
          <select
            id={`${id}-staff`}
            value={staffId ?? ""}
            onChange={(e) => {
              setStaffId(e.target.value === "" ? null : Number(e.target.value));
              setErrors((x) => ({ ...x, staff: undefined }));
            }}
            aria-invalid={Boolean(errors.staff)}
            aria-describedby={errors.staff ? `${id}-staff-error` : undefined}
            className={selectClass}
          >
            <option value="">{k("timeOff.choose")}</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id === myId ? `${s.name} (${k("you")})` : s.name}
              </option>
            ))}
          </select>
          {errors.staff && (
            <p id={`${id}-staff-error`} className="mt-1.5 text-sm font-medium text-red-700 dark:text-red-400">
              {errors.staff}
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-slate-600 dark:text-slate-400">{k("timeOff.forYou", { name: me?.name ?? "" })}</p>
      )}

      <label className="flex min-h-11 cursor-pointer items-center gap-3">
        <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} className="size-5 shrink-0 accent-blue-700" />
        <span className="font-medium">{k("timeOff.allDay")}</span>
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className={allDay ? "" : "grid grid-cols-[1.4fr_1fr] gap-2"}>
          {dateField("start")}
          {!allDay && (
            <TimeSelect id={`${id}-start-time`} label={k("timeOff.startTime")} value={startMin} onChange={setStartMin} invalid={Boolean(errors.range)} describedBy={errors.range ? rangeErrorId : undefined} />
          )}
        </div>
        <div className={allDay ? "" : "grid grid-cols-[1.4fr_1fr] gap-2"}>
          {dateField("end")}
          {!allDay && (
            <TimeSelect id={`${id}-end-time`} label={k("timeOff.endTime")} value={endMin} end onChange={setEndMin} invalid={Boolean(errors.range)} describedBy={errors.range ? rangeErrorId : undefined} />
          )}
        </div>
      </div>
      {errors.range && (
        <p id={rangeErrorId} className="-mt-2 text-sm font-medium text-red-700 dark:text-red-400">
          {errors.range}
        </p>
      )}

      <div>
        <label htmlFor={`${id}-reason`} className="mb-1.5 block text-sm font-medium">
          {t("common.reason")} <span className="font-normal text-slate-500 dark:text-slate-400">({k("optional")})</span>
        </label>
        <input
          id={`${id}-reason`}
          value={reason}
          maxLength={200}
          onChange={(e) => setReason(e.target.value)}
          aria-describedby={`${id}-reason-hint`}
          className={`${inputClass} min-h-11 py-2.5`}
        />
        <p id={`${id}-reason-hint`} className="mt-1.5 text-sm text-slate-600 dark:text-slate-400">
          {k("timeOff.reasonHint")}
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
