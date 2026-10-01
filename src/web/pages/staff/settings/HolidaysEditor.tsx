import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CodedMessage } from "../../../../domain/csv";
import { holidayNameSchema, isoDateSchema, MAX_HOLIDAY_IMPORT_ROWS } from "../../../../shared/schemas";
import { apiFetch, handleSignedOut, isApiError, queryKeys, type Holiday, type HolidayImportPreview, type HolidayImportRowView } from "../../../api";
import { Button } from "../../../components/Button";
import { Notice } from "../../../components/Card";
import { focusWhenReady } from "../../../components/Dialog";
import { EmptyState } from "../../../components/EmptyState";
import { inputClass } from "../../../components/Field";
import { Skeleton } from "../../../components/Spinner";
import { dayParts, fmtDateWithYear, fmtLongDate, todayIn } from "../../../format";
import { t } from "../../../i18n";
import { actionErrorText } from "../detail/shared";
import { scheduleRequest, type Submit } from "../schedule/ImpactDialog";

const h = (key: string, params?: Record<string, string | number>) => t(`web.staff.holidays.${key}`, params);
const NAME_MAX = (holidayNameSchema as unknown as { maxLength: number }).maxLength;

/** Catalog text for an import message (row error or file problem). */
export function importMessage(m: CodedMessage | undefined): string {
  if (!m) return h("import.unknownError");
  const key = `web.staff.import.messages.${m.code}`;
  const text = t(key, m.params);
  return text === key ? h("import.unknownError") : text;
}

/**
 * Holidays of one year at a time: list (with delete), add, and CSV import with a preview. Every change is a
 * schedule change (holiday.set / holiday.delete / the import), so bookings on the date go through the impact review.
 */
export function HolidaysEditor({ tz, canEdit, submit }: { tz: string; canEdit: boolean; submit: Submit }) {
  const today = todayIn(tz);
  const thisYear = Number(today.slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [importing, setImporting] = useState(false);
  const q = useQuery({ queryKey: queryKeys.holidays(year), queryFn: () => apiFetch<Holiday[]>(`/api/staff/holidays?year=${year}`) });
  const importButton = useRef<HTMLButtonElement>(null);
  const yearId = useId();

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-labelledby={yearId} className="flex items-center gap-1">
          <span id={yearId} className="sr-only">
            {h("year")}
          </span>
          <YearButton dir={-1} year={year} onClick={() => setYear(year - 1)} />
          <h3 className="min-w-20 text-center text-lg font-semibold tabular-nums" aria-live="polite">
            <span className="sr-only">{h("yearHeading", { year })}</span>
            <span aria-hidden="true">{year}</span>
          </h3>
          <YearButton dir={1} year={year} onClick={() => setYear(year + 1)} />
          {year !== thisYear && (
            <Button variant="ghost" onClick={() => setYear(thisYear)} className="ml-1">
              {h("thisYear")}
            </Button>
          )}
        </div>
        {canEdit && !importing && (
          <Button ref={importButton} variant="secondary" onClick={() => setImporting(true)}>
            <svg className="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {h("import.open")}
          </Button>
        )}
      </div>

      {importing && (
        <ImportWizard
          submit={submit}
          onClose={(importedYear) => {
            setImporting(false);
            if (importedYear !== undefined) setYear(importedYear);
            focusWhenReady(() => importButton.current);
          }}
        />
      )}

      {q.isPending ? (
        <div className="space-y-2" aria-busy="true">
          <span className="sr-only">{t("web.common.loading")}</span>
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : q.isError ? (
        <Notice tone="error" className="flex flex-wrap items-center justify-between gap-3">
          {h("loadFailed")}
          <Button variant="secondary" onClick={() => void q.refetch()}>
            {t("web.common.retry")}
          </Button>
        </Notice>
      ) : q.data.length === 0 ? (
        <EmptyState title={h("empty", { year })} body={canEdit ? h("emptyBody") : undefined} />
      ) : (
        <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
          {q.data.map((hol) => (
            <li key={hol.date}>
              <HolidayRow holiday={hol} past={hol.date < today} canEdit={canEdit} submit={submit} />
            </li>
          ))}
        </ul>
      )}

      {canEdit && <AddHoliday submit={submit} onAdded={(date) => setYear(Number(date.slice(0, 4)))} existing={q.data ?? []} shownYear={year} />}
    </div>
  );
}

function YearButton({ dir, year, onClick }: { dir: -1 | 1; year: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={dir < 0 ? h("prevYear", { year: year - 1 }) : h("nextYear", { year: year + 1 })}
      className="grid size-11 place-items-center rounded-lg text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
    >
      <svg className="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d={dir < 0 ? "m15 6-6 6 6 6" : "m9 6 6 6-6 6"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

function DateBadge({ date, muted }: { date: string; muted: boolean }) {
  const p = dayParts(date);
  return (
    <div
      className={`flex w-12 shrink-0 flex-col items-center self-start rounded-lg py-1 leading-tight ${muted ? "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400" : "bg-violet-100 text-violet-900 dark:bg-violet-400/15 dark:text-violet-100"}`}
      aria-hidden="true"
    >
      <span className="text-[0.7rem] font-semibold uppercase">{p.month}</span>
      <span className="text-lg font-bold tabular-nums">{p.day}</span>
    </div>
  );
}

function HolidayRow({ holiday, past, canEdit, submit }: { holiday: Holiday; past: boolean; canEdit: boolean; submit: Submit }) {
  const id = useId();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const label = fmtDateWithYear(holiday.date);

  useEffect(() => {
    if (asking) keepRef.current?.focus();
  }, [asking]);

  const stop = () => {
    setAsking(false);
    requestAnimationFrame(() => deleteRef.current?.focus());
  };

  async function remove() {
    setBusy(true);
    setProblem(null);
    const result = await submit(
      scheduleRequest(
        { type: "holiday.delete", date: holiday.date },
        { summary: h("summaryDelete", { date: label }), done: h("doneDelete", { date: label }) },
        // The row goes away with the refreshed list; focus moves to the year heading's region.
        () => focusWhenReady(() => document.getElementById("holidays-heading")),
      ),
    );
    setBusy(false);
    if (result.status === "failed") {
      setAsking(false);
      setProblem(result.message);
    }
  }

  return (
    <article aria-labelledby={`${id}-name`} className="flex gap-3 px-3 py-3 sm:px-4">
      <DateBadge date={holiday.date} muted={past} />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
          <div className="min-w-0">
            <h4 id={`${id}-name`} className={`font-semibold break-words ${past ? "text-slate-600 dark:text-slate-400" : ""}`}>
              {holiday.name}
            </h4>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              {fmtLongDate(holiday.date)}
              {past && <span> · {h("past")}</span>}
            </p>
          </div>
          {canEdit && !asking && (
            <Button ref={deleteRef} variant="ghost" onClick={() => setAsking(true)} className="-mr-2 text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-400/10">
              {h("delete")}
              <span className="sr-only">
                {" "}
                {holiday.name}, {label}
              </span>
            </Button>
          )}
        </div>
        <div aria-live="polite" className="empty:mb-0 empty:last:-mt-2">
          {problem && <Notice tone="error">{problem}</Notice>}
        </div>
        {canEdit && asking && (
          <div
            role="group"
            aria-labelledby={`${id}-ask`}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                if (!busy) stop();
              }
            }}
            className="space-y-3 rounded-lg border border-slate-300 bg-slate-50 p-3 dark:border-slate-600 dark:bg-slate-800/50"
          >
            <p id={`${id}-ask`} className="text-sm font-medium">
              {h("deleteAsk", { name: holiday.name, date: label })}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="danger" loading={busy} onClick={() => void remove()}>
                {busy ? h("adding") : h("deleteConfirm")}
              </Button>
              <Button ref={keepRef} variant="secondary" disabled={busy} onClick={stop}>
                {h("keep")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

function AddHoliday({ submit, onAdded, existing, shownYear }: { submit: Submit; onAdded: (date: string) => void; existing: Holiday[]; shownYear: number }) {
  const id = useId();
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const [errors, setErrors] = useState<{ date?: string; name?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const dateRef = useRef<HTMLInputElement>(null);
  // Only the shown year's holidays are loaded: the rename hint covers that year.
  const current = Number(date.slice(0, 4)) === shownYear ? existing.find((x) => x.date === date) : undefined;

  async function save() {
    const next: typeof errors = {};
    if (!isoDateSchema.safeParse(date).success) next.date = h("errorDate");
    const parsed = holidayNameSchema.safeParse(name);
    if (!parsed.success) next.name = name.trim() === "" ? h("errorName") : h("errorNameLong", { max: NAME_MAX });
    setErrors(next);
    if (next.date || next.name) {
      document.getElementById(next.date ? `${id}-date` : `${id}-name`)?.focus();
      return;
    }
    setBusy(true);
    const label = fmtDateWithYear(date);
    const clean = parsed.data!;
    const result = await submit(
      scheduleRequest(
        { type: "holiday.set", date, name: clean },
        { summary: h("summarySet", { date: label, name: clean }), done: h("doneSet", { date: label, name: clean }) },
        () => {
          onAdded(date);
          setDate("");
          setName("");
          focusWhenReady(() => dateRef.current);
        },
      ),
    );
    setBusy(false);
    if (result.status === "failed") setErrors({ form: result.message });
  }

  return (
    <form
      noValidate
      aria-labelledby={`${id}-title`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) void save();
      }}
      className="space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900/60"
    >
      <h3 id={`${id}-title`} className="font-semibold">
        {h("addTitle")}
      </h3>
      <div className="grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)_auto] sm:items-start">
        <div>
          <label htmlFor={`${id}-date`} className="mb-1.5 block text-sm font-medium">
            {h("date")}
          </label>
          <input
            ref={dateRef}
            id={`${id}-date`}
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              setErrors((x) => ({ ...x, date: undefined }));
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
        <div>
          <label htmlFor={`${id}-name`} className="mb-1.5 block text-sm font-medium">
            {h("name")}
          </label>
          <input
            id={`${id}-name`}
            value={name}
            maxLength={NAME_MAX}
            placeholder={h("namePlaceholder")}
            onChange={(e) => {
              setName(e.target.value);
              setErrors((x) => ({ ...x, name: undefined }));
            }}
            aria-invalid={Boolean(errors.name)}
            aria-describedby={errors.name ? `${id}-name-error` : undefined}
            className={`${inputClass} min-h-11 py-2.5`}
          />
          {errors.name && (
            <p id={`${id}-name-error`} className="mt-1.5 text-sm font-medium text-red-700 dark:text-red-400">
              {errors.name}
            </p>
          )}
        </div>
        <Button type="submit" loading={busy} className="sm:mt-7">
          {busy ? h("adding") : h("add")}
        </Button>
      </div>
      {current && <p className="text-sm font-medium text-amber-800 dark:text-amber-300">{h("renames", { date: fmtDateWithYear(date), name: current.name })}</p>}
      <div aria-live="polite" className="empty:mb-0 empty:last:-mt-4">
        {errors.form && <Notice tone="error">{errors.form}</Notice>}
      </div>
    </form>
  );
}

// ---- CSV import --------------------------------------------------------------------------------------------------

const STATUS_STYLE: Record<HolidayImportRowView["status"], string> = {
  new: "bg-green-100 text-green-900 ring-green-300 dark:bg-green-400/15 dark:text-green-200 dark:ring-green-400/40",
  changed: "bg-blue-100 text-blue-900 ring-blue-300 dark:bg-blue-400/15 dark:text-blue-200 dark:ring-blue-400/40",
  unchanged: "bg-slate-100 text-slate-700 ring-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-600",
  error: "bg-red-100 text-red-900 ring-red-300 dark:bg-red-400/15 dark:text-red-200 dark:ring-red-400/40",
};

/** Message for a failed import request (file problems come coded, like the customer import). */
function importErrorText(e: unknown): string | null {
  if (isApiError(e, 400, "invalid_csv") || isApiError(e, 400, "too_many_rows")) {
    const d = e.details as CodedMessage | undefined;
    return d?.code ? importMessage(d) : h("import.invalidFile");
  }
  if (isApiError(e, 400, "invalid_rows")) return h("import.invalidRows");
  if (isApiError(e, 400, "nothing_to_import")) return h("import.nothingToImport");
  if (isApiError(e, 400)) return h("import.invalidFile");
  return null;
}

const request = (csv: string, version?: number) => ({ method: "POST", body: version === undefined ? { csv } : { csv, version } });

/** Two steps: add the file (upload or paste) → check the planned rows and import. */
function ImportWizard({ submit, onClose }: { submit: Submit; onClose: (importedYear?: number) => void }) {
  const id = useId();
  const qc = useQueryClient();
  const [csv, setCsv] = useState("");
  const [fileNote, setFileNote] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [plan, setPlan] = useState<HolidayImportPreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const reviewRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);
  useEffect(() => {
    if (plan) reviewRef.current?.focus();
  }, [plan]);

  async function readFile(file: File | undefined) {
    if (!file) return;
    try {
      setCsv(await file.text());
      setFileNote({ tone: "success", text: h("import.fileChosen", { name: file.name }) });
    } catch {
      setFileNote({ tone: "error", text: h("import.fileFailed") });
    }
  }

  async function check() {
    setProblem(null);
    if (csv.trim() === "") {
      setProblem(h("import.emptyCsv"));
      textRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      setPlan(await apiFetch<HolidayImportPreview>("/api/staff/holidays/import/preview", request(csv)));
    } catch (e) {
      if (!handleSignedOut(qc, e)) setProblem(importErrorText(e) ?? actionErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!plan) return;
    const toWrite = plan.rows.filter((r) => r.status === "new" || r.status === "changed");
    const n = toWrite.length;
    setBusy(true);
    setProblem(null);
    const result = await submit({
      summary: h("import.summary", { n }),
      done: n === 1 ? h("import.doneOne") : h("import.done", { n }),
      preview: () => apiFetch<HolidayImportPreview>("/api/staff/holidays/import/preview", request(csv)),
      apply: (version) => apiFetch("/api/staff/holidays/import/apply", request(csv, version)),
      onApplied: () => onClose(Number([...toWrite].sort((a, b) => a.date.localeCompare(b.date))[0]!.date.slice(0, 4))),
      errorText: importErrorText,
    });
    setBusy(false);
    if (result.status === "failed") setProblem(result.message);
  }

  const counts = plan
    ? {
        new: plan.rows.filter((r) => r.status === "new").length,
        changed: plan.rows.filter((r) => r.status === "changed").length,
        unchanged: plan.rows.filter((r) => r.status === "unchanged").length,
        error: plan.rows.filter((r) => r.status === "error").length,
        conflicts: plan.rows.reduce((n, r) => n + r.conflicts, 0),
      }
    : null;
  const toImport = counts ? counts.new + counts.changed : 0;
  const blockedReason = counts ? (counts.error > 0 ? h("import.fixErrors") : toImport === 0 ? (plan!.rows.length === 0 ? h("import.noRows") : h("import.nothing")) : null) : null;

  return (
    <section
      aria-labelledby={`${id}-title`}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
      className="space-y-4 rounded-xl border border-blue-300 bg-blue-50/60 p-4 shadow-sm dark:border-blue-400/40 dark:bg-blue-400/5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 ref={titleRef} id={`${id}-title`} tabIndex={-1} className="font-semibold outline-none">
          {h("import.title")}
        </h3>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {h("import.stepOf", { n: plan ? 2 : 1 })} · {plan ? h("import.step2") : h("import.step1")}
        </p>
      </div>

      {!plan ? (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) void check();
          }}
          className="space-y-4"
        >
          <p className="text-sm text-slate-700 dark:text-slate-300">{h("import.format", { max: MAX_HOLIDAY_IMPORT_ROWS })}</p>
          <div>
            <label htmlFor={`${id}-file`} className="mb-1.5 block font-medium">
              {h("import.file")}
            </label>
            <input
              id={`${id}-file`}
              type="file"
              accept=".csv,text/csv,text/plain"
              onChange={(e) => void readFile(e.target.files?.[0])}
              className="block w-full text-sm file:mr-3 file:min-h-11 file:cursor-pointer file:rounded-xl file:border file:border-slate-300 file:bg-white file:px-4 file:font-semibold file:text-slate-900 hover:file:bg-slate-100 dark:file:border-slate-600 dark:file:bg-slate-900 dark:file:text-slate-100"
            />
            <div aria-live="polite" className="empty:mb-0">
              {fileNote && <p className={`mt-1.5 text-sm font-medium ${fileNote.tone === "error" ? "text-red-700 dark:text-red-400" : "text-green-800 dark:text-green-300"}`}>{fileNote.text}</p>}
            </div>
          </div>
          <div>
            <label htmlFor={`${id}-csv`} className="mb-1.5 block font-medium">
              {h("import.paste")}
            </label>
            <textarea
              ref={textRef}
              id={`${id}-csv`}
              rows={6}
              value={csv}
              spellCheck={false}
              placeholder={"date,name\n2026-11-03,Culture Day\n2026-11-23,Labour Thanksgiving Day"}
              onChange={(e) => setCsv(e.target.value)}
              className={`${inputClass} min-h-32 resize-y font-mono text-sm`}
            />
          </div>
          <div aria-live="polite" className="empty:mb-0">
            {problem && <Notice tone="error">{problem}</Notice>}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:flex">
            <Button type="submit" loading={busy}>
              {busy ? h("import.reviewing") : h("import.review")}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => onClose()}>
              {h("import.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="space-y-4">
          <h4 ref={reviewRef} tabIndex={-1} className="sr-only outline-none">
            {h("import.step2")}
          </h4>
          <ul className="flex flex-wrap gap-2 text-sm" aria-label={h("import.step2")}>
            <CountPill tone="new" text={h("import.countNew", { n: counts!.new })} />
            <CountPill tone="changed" text={h("import.countChanged", { n: counts!.changed })} />
            <CountPill tone="unchanged" text={h("import.countUnchanged", { n: counts!.unchanged })} />
            {counts!.error > 0 && <CountPill tone="error" text={h("import.countErrors", { n: counts!.error })} />}
            {counts!.conflicts > 0 && <CountPill tone="error" text={h("import.countConflicts", { n: counts!.conflicts })} />}
          </ul>

          {plan.rows.length > 0 && <PlanTable rows={plan.rows} />}

          {counts!.conflicts > 0 && !blockedReason && <Notice tone="warning">{h("import.conflictsNote")}</Notice>}
          <div aria-live="polite" className="empty:mb-0">
            {problem && <Notice tone="error">{problem}</Notice>}
          </div>
          {blockedReason && (
            <p id={`${id}-blocked`} className="text-sm font-medium text-slate-700 dark:text-slate-300">
              {blockedReason}
            </p>
          )}
          <div className="grid grid-cols-2 gap-3 sm:flex">
            <Button onClick={() => void apply()} loading={busy} disabled={blockedReason !== null} aria-describedby={blockedReason ? `${id}-blocked` : undefined} className="col-span-2 sm:col-span-1">
              {busy ? h("import.applying") : toImport === 0 ? h("import.applyNone") : toImport === 1 ? h("import.applyOne") : h("import.apply", { n: toImport })}
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setPlan(null);
                setProblem(null);
                requestAnimationFrame(() => textRef.current?.focus());
              }}
            >
              {h("import.back")}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => onClose()}>
              {h("import.cancel")}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function CountPill({ tone, text }: { tone: HolidayImportRowView["status"]; text: string }) {
  return <li className={`rounded-full px-2.5 py-0.5 font-semibold ring-1 ring-inset ${STATUS_STYLE[tone]}`}>{text}</li>;
}

function RowResult({ r }: { r: HolidayImportRowView }) {
  return (
    <div className="space-y-0.5">
      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${STATUS_STYLE[r.status]}`}>{h(`import.status.${r.status}`)}</span>
      {r.status === "error" && <p className="text-sm text-red-800 dark:text-red-300">{importMessage(r.error)}</p>}
      {r.status === "changed" && r.previousName && <p className="text-sm text-slate-600 dark:text-slate-400">{h("import.was", { name: r.previousName })}</p>}
      {r.conflicts > 0 && (
        <p className="text-sm font-medium text-amber-800 dark:text-amber-300">{r.conflicts === 1 ? h("import.conflictsOne") : h("import.conflicts", { n: r.conflicts })}</p>
      )}
    </div>
  );
}

/** A table on wider screens, a list of cards on phones. */
function PlanTable({ rows }: { rows: HolidayImportRowView[] }) {
  const dateText = (d: string) => (isoDateSchema.safeParse(d).success ? fmtDateWithYear(d) : d || "–");
  return (
    <>
      <div className="hidden max-h-96 overflow-auto rounded-xl border border-slate-200 bg-white sm:block dark:border-slate-700 dark:bg-slate-900">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">{h("import.table")}</caption>
          <thead className="sticky top-0 bg-slate-50 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            <tr>
              <th scope="col" className="px-3 py-2 font-semibold">
                {h("import.line")}
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                {h("date")}
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                {h("name")}
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                {h("import.result")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
            {rows.map((r) => (
              <tr key={r.line} className={r.status === "error" ? "bg-red-50/60 dark:bg-red-400/5" : ""}>
                <td className="px-3 py-2 align-top text-slate-500 tabular-nums dark:text-slate-400">{r.line}</td>
                <td className="px-3 py-2 align-top whitespace-nowrap tabular-nums">{dateText(r.date)}</td>
                <td className="px-3 py-2 align-top break-words">{r.name || "–"}</td>
                <td className="px-3 py-2 align-top">
                  <RowResult r={r} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="max-h-[28rem] space-y-2 overflow-auto sm:hidden" aria-label={h("import.table")}>
        {rows.map((r) => (
          <li key={r.line} className={`rounded-xl border p-3 ${r.status === "error" ? "border-red-300 bg-red-50/60 dark:border-red-400/40 dark:bg-red-400/5" : "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"}`}>
            <p className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-semibold break-words">{r.name || "–"}</span>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {h("import.line")} {r.line}
              </span>
            </p>
            <p className="mb-1.5 text-sm text-slate-600 tabular-nums dark:text-slate-400">{dateText(r.date)}</p>
            <RowResult r={r} />
          </li>
        ))}
      </ul>
    </>
  );
}
