import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import type { CodedMessage } from "../../../../domain/csv";
import type { ImportRow, ImportRowAction } from "../../../../domain/customer-import";
import { MAX_CSV_BODY_BYTES, MAX_CUSTOMER_IMPORT_CHARS, MAX_CUSTOMER_IMPORT_ROWS } from "../../../../shared/schemas";
import { apiFetch, handleSignedOut, isApiError, queryKeys, useMe, type CustomerImportPreview, type CustomerImportResult } from "../../../api";
import { Button, ButtonLink } from "../../../components/Button";
import { Card, Notice } from "../../../components/Card";
import { focusWhenReady } from "../../../components/Dialog";
import { inputClass } from "../../../components/Field";
import { PageHeading, usePageTitle } from "../../../components/Layout";
import { codedText } from "../coded";
import { actionErrorText } from "../detail/shared";
import { AdminOnly, BackLink, cu } from "./shared";

const w = (key: string, params?: Record<string, string | number>) => cu(`import.${key}`, params);

/** Where the sample file is served (built from docs/sample-customers.csv; see vite.config.ts). */
const SAMPLE_URL = "/samples/customers.csv";
/** Rows rendered at a time; a 5000-row file shows the first ones and "Show more". */
const PAGE = 200;

type Step = "file" | "check" | "done";
type Filter = "all" | "changes" | "errors";
/** `top`: about the table (it was re-checked), shown under the step heading; otherwise next to the buttons. */
type Message = { tone: "info" | "warning" | "error"; text: string; top?: boolean };

const rowText = (m: CodedMessage) => codedText(m, w("unknownMessage"));

/** The file is over the limit (checked before sending; the server refuses it too). */
function tooLarge(csv: string): boolean {
  if (csv.length > MAX_CUSTOMER_IMPORT_CHARS) return true;
  // The request carries the text as JSON (escaped, UTF-8) with the plan hash next to it.
  return new Blob([JSON.stringify({ csv, planHash: "0".repeat(64) })]).size > MAX_CSV_BODY_BYTES;
}

/** Message for a failed preview or apply that isn't handled by re-checking the file. */
function errorText(e: unknown): string {
  if (isApiError(e, 413) || (isApiError(e, 400, "invalid") && JSON.stringify(e.details ?? "").includes('"csv"'))) return w("tooLarge");
  if (isApiError(e, 400, "invalid_csv") || isApiError(e, 400, "invalid_header") || isApiError(e, 400, "too_many_rows")) {
    const d = e.details as (CodedMessage & { line?: number; column?: number }) | undefined;
    return d?.code ? codedText({ code: d.code, params: { line: d.line ?? "", column: d.column ?? "", ...d.params } }, w("invalidFile")) : w("invalidFile");
  }
  if (isApiError(e, 400)) return w("invalidFile");
  if (isApiError(e, 403)) return cu("errors.forbidden");
  return actionErrorText(e);
}

/** `/staff/customers/import` — add or update customers from a CSV file: add the file, check what it does, import. Administrators only. */
export default function ImportWizard() {
  usePageTitle(w("title"));
  const me = useMe();
  const back = <BackLink to="/staff/customers">{cu("backToList")}</BackLink>;
  if (me.data?.staff?.role !== "admin") {
    return (
      <div className="space-y-6">
        {back}
        <AdminOnly text={cu("adminOnlyImport")} />
      </div>
    );
  }
  return (
    <div className="space-y-6">
      {back}
      <div className="space-y-1">
        <PageHeading>{w("title")}</PageHeading>
        <p className="text-slate-600 dark:text-slate-400">{w("lead")}</p>
      </div>
      <Wizard />
    </div>
  );
}

function Wizard() {
  const id = useId();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("file");
  const [csv, setCsv] = useState("");
  const [fileNote, setFileNote] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [plan, setPlan] = useState<CustomerImportPreview | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [shown, setShown] = useState(PAGE);
  const [message, setMessage] = useState<Message | null>(null);
  const [partial, setPartial] = useState(false);
  const [busy, setBusy] = useState<"check" | "apply" | null>(null);
  const [result, setResult] = useState<CustomerImportResult | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const firstStep = useRef(true);

  // Each new step's heading takes focus (not on first load: the page heading has it then).
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    stepHeading.current?.focus();
  }, [step]);

  async function readFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_CUSTOMER_IMPORT_CHARS) {
      setFileNote({ tone: "error", text: w("fileTooLarge", { name: file.name }) });
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    try {
      const text = await file.text();
      setCsv(text.replace(/^﻿/, ""));
      setFileNote({ tone: "success", text: w("fileChosen", { name: file.name }) });
      setMessage(null);
    } catch {
      setFileNote({ tone: "error", text: w("fileFailed") });
    }
  }

  const preview = () => apiFetch<CustomerImportPreview>("/api/staff/customers/import/preview", { method: "POST", body: { csv } });

  function showPlan(next: CustomerImportPreview) {
    setPlan(next);
    setFilter(next.summary.errors > 0 ? "errors" : "all");
    setShown(PAGE);
  }

  async function check() {
    setMessage(null);
    if (csv.trim() === "") {
      setMessage({ tone: "error", text: w("emptyCsv") });
      textRef.current?.focus();
      return;
    }
    if (tooLarge(csv)) {
      setMessage({ tone: "error", text: w("tooLarge") });
      textRef.current?.focus();
      return;
    }
    setBusy("check");
    try {
      showPlan(await preview());
      setPartial(false);
      setStep("check");
    } catch (e) {
      if (!handleSignedOut(qc, e)) setMessage({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(null);
    }
  }

  /** The data (or the rules) moved since the preview: check the same file again and say why the table changed. */
  async function recheck(why: string, tone: Message["tone"] = "warning") {
    try {
      showPlan(await preview());
      setMessage({ tone, text: why, top: true });
    } catch (e) {
      if (!handleSignedOut(qc, e)) setMessage({ tone: "error", text: errorText(e) });
    }
    focusWhenReady(() => stepHeading.current);
  }

  async function apply() {
    if (!plan) return;
    setBusy("apply");
    setMessage(null);
    try {
      const done = await apiFetch<CustomerImportResult>("/api/staff/customers/import/apply", { method: "POST", body: { csv, planHash: plan.planHash } });
      void qc.invalidateQueries({ queryKey: queryKeys.customers });
      setResult(done);
      setPartial(false);
      setStep("done");
    } catch (e) {
      if (handleSignedOut(qc, e)) return;
      if (isApiError(e, 409, "stale_import")) await recheck(w("stale"));
      else if (isApiError(e, 400, "invalid_rows")) await recheck(w("nowInvalid"));
      else if (isApiError(e, 400, "nothing_to_import")) await recheck(w("nowNothing"), "info");
      else if (isApiError(e, 500, "import_failed")) {
        // Some chunks were committed: the list has changed. Importing the same file again finishes the job.
        void qc.invalidateQueries({ queryKey: queryKeys.customers });
        setPartial(true);
        setMessage({ tone: "error", text: w("partial") });
        // The Import button gives way to "Check the file again".
        focusWhenReady(() => document.getElementById("import-rerun"));
      } else {
        setMessage({ tone: "error", text: errorText(e) });
        focusWhenReady(() => document.getElementById("import-apply"));
      }
    } finally {
      setBusy(null);
    }
  }

  async function rerun() {
    setBusy("check");
    setMessage(null);
    try {
      showPlan(await preview());
      setPartial(false);
      setMessage({ tone: "info", text: w("rechecked"), top: true });
    } catch (e) {
      if (!handleSignedOut(qc, e)) setMessage({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(null);
      focusWhenReady(() => stepHeading.current);
    }
  }

  function restart() {
    setCsv("");
    setFileNote(null);
    setPlan(null);
    setResult(null);
    setMessage(null);
    setPartial(false);
    if (fileRef.current) fileRef.current.value = "";
    setStep("file");
  }

  const messageBox = (top: boolean) => (
    <div aria-live="polite" className="empty:mb-0">
      {message && Boolean(message.top) === top && <Notice tone={message.tone}>{message.text}</Notice>}
    </div>
  );

  return (
    <div className="space-y-5">
      <Steps step={step} />

      {step === "file" && (
        <Card>
          <form
            noValidate
            aria-labelledby={`${id}-step`}
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy) void check();
            }}
            className="space-y-5"
          >
            <h2 ref={stepHeading} id={`${id}-step`} tabIndex={-1} className="text-lg font-semibold outline-none">
              {w("step1")}
            </h2>
            <FormatHelp />
            <div>
              <label htmlFor={`${id}-file`} className="mb-1.5 block font-medium">
                {w("file")}
              </label>
              <input
                ref={fileRef}
                id={`${id}-file`}
                type="file"
                accept=".csv,text/csv,text/plain"
                aria-describedby={`${id}-file-hint`}
                onChange={(e) => void readFile(e.target.files?.[0])}
                className="block w-full text-sm file:mr-3 file:min-h-11 file:cursor-pointer file:rounded-xl file:border file:border-slate-300 file:bg-white file:px-4 file:font-semibold file:text-slate-900 hover:file:bg-slate-100 dark:file:border-slate-600 dark:file:bg-slate-900 dark:file:text-slate-100"
              />
              <p id={`${id}-file-hint`} className="mt-1.5 text-sm text-slate-600 dark:text-slate-400">
                {w("fileHint", { rows: MAX_CUSTOMER_IMPORT_ROWS })}
              </p>
              <div aria-live="polite" className="empty:mb-0">
                {fileNote && (
                  <p className={`mt-1.5 text-sm font-medium ${fileNote.tone === "error" ? "text-red-700 dark:text-red-400" : "text-green-800 dark:text-green-300"}`}>{fileNote.text}</p>
                )}
              </div>
            </div>
            <div>
              <label htmlFor={`${id}-csv`} className="mb-1.5 block font-medium">
                {w("paste")}
              </label>
              <textarea
                ref={textRef}
                id={`${id}-csv`}
                rows={7}
                value={csv}
                spellCheck={false}
                placeholder={w("pastePlaceholder")}
                onChange={(e) => {
                  setCsv(e.target.value);
                  setMessage(null);
                }}
                className={`${inputClass} min-h-36 resize-y font-mono text-sm`}
              />
            </div>
            {messageBox(false)}
            <div className="grid gap-3 min-[26rem]:grid-cols-2 sm:flex">
              <Button type="submit" loading={busy === "check"}>
                {busy === "check" ? w("checking") : w("check")}
              </Button>
              <Button variant="secondary" disabled={busy !== null} onClick={() => navigate("/staff/customers")}>
                {cu("cancel")}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {step === "check" && plan && (
        <Review
          plan={plan}
          filter={filter}
          setFilter={(f) => {
            setFilter(f);
            setShown(PAGE);
          }}
          shown={shown}
          showMore={() => setShown((n) => n + PAGE)}
          headingRef={stepHeading}
          busy={busy}
          partial={partial}
          messageBox={messageBox}
          onApply={() => void apply()}
          onRerun={() => void rerun()}
          onBack={() => {
            setStep("file");
            setMessage(null);
            setPartial(false);
          }}
          onCancel={() => navigate("/staff/customers")}
        />
      )}

      {step === "done" && result && <Done result={result} headingRef={stepHeading} onAnother={restart} />}
    </div>
  );
}

function Steps({ step }: { step: Step }) {
  const order: Step[] = ["file", "check", "done"];
  const at = order.indexOf(step);
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" aria-label={w("progress")}>
      {order.map((s, i) => (
        <li key={s} aria-current={i === at ? "step" : undefined} className="flex items-center gap-2">
          {i > 0 && <span className="h-px w-4 bg-slate-300 dark:bg-slate-700" aria-hidden="true" />}
          <span
            className={`grid size-6 place-items-center rounded-full text-xs font-bold ${
              i < at ? "bg-green-600 text-white" : i === at ? "bg-blue-700 text-white dark:bg-blue-500" : "bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
            }`}
            aria-hidden="true"
          >
            {i < at ? "✓" : i + 1}
          </span>
          {/* Phones show only the current step's name; the others keep theirs for screen readers. */}
          <span className={i === at ? "font-semibold" : "sr-only text-slate-600 sm:not-sr-only dark:text-slate-400"}>
            <span className="sr-only">{w("stepOf", { n: i + 1 })}: </span>
            {w(`step${i + 1}`)}
            {i < at && <span className="sr-only"> ({w("stepDone")})</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

const COLUMNS: Array<{ name: string; required: boolean }> = [
  { name: "customer_number", required: true },
  { name: "name", required: true },
  { name: "phone", required: false },
  { name: "contact_email", required: true },
  { name: "contact_name", required: false },
  { name: "active", required: false },
];

function FormatHelp() {
  return (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm dark:border-slate-700 dark:bg-slate-800/40">
      <p>{w("format")}</p>
      <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-[auto_minmax(0,1fr)]">
        {COLUMNS.map((c) => (
          <div key={c.name} className="contents">
            <dt className="font-mono font-semibold break-all">
              {c.name}
              {c.required && <span className="font-sans font-normal text-slate-600 dark:text-slate-400"> · {w("required")}</span>}
            </dt>
            <dd className="mb-1 text-slate-700 sm:mb-0 dark:text-slate-300">{w(`columns.${c.name}`)}</dd>
          </div>
        ))}
      </dl>
      <ul className="list-disc space-y-1 pl-5 text-slate-700 dark:text-slate-300">
        <li>{w("ruleGroup")}</li>
        <li>{w("ruleBlank")}</li>
        <li>{w("ruleNoDelete")}</li>
      </ul>
      <a
        href={SAMPLE_URL}
        download="sample-customers.csv"
        className="-ml-2 inline-flex min-h-11 items-center gap-2 rounded-lg px-2 font-semibold text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-slate-800"
      >
        <svg className="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {w("sample")}
      </a>
    </div>
  );
}

const ACTION_STYLE: Record<ImportRowAction, string> = {
  create: "bg-green-100 text-green-900 ring-green-300 dark:bg-green-400/15 dark:text-green-200 dark:ring-green-400/40",
  update: "bg-blue-100 text-blue-900 ring-blue-300 dark:bg-blue-400/15 dark:text-blue-200 dark:ring-blue-400/40",
  unchanged: "bg-slate-100 text-slate-700 ring-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-600",
  error: "bg-red-100 text-red-900 ring-red-300 dark:bg-red-400/15 dark:text-red-200 dark:ring-red-400/40",
};

const matches = (f: Filter, r: ImportRow) => f === "all" || (f === "errors" ? r.action === "error" : r.action === "create" || r.action === "update");

function Review({
  plan,
  filter,
  setFilter,
  shown,
  showMore,
  headingRef,
  busy,
  partial,
  messageBox,
  onApply,
  onRerun,
  onBack,
  onCancel,
}: {
  plan: CustomerImportPreview;
  filter: Filter;
  setFilter: (f: Filter) => void;
  shown: number;
  showMore: () => void;
  headingRef: RefObject<HTMLHeadingElement | null>;
  busy: "check" | "apply" | null;
  partial: boolean;
  messageBox: (top: boolean) => ReactNode;
  onApply: () => void;
  onRerun: () => void;
  onBack: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const { summary: s } = plan;
  const counts: Record<Filter, number> = {
    all: plan.rows.length,
    changes: plan.rows.filter((r) => matches("changes", r)).length,
    errors: s.errors,
  };
  const rows = plan.rows.filter((r) => matches(filter, r));
  const changes = s.customers.create + s.customers.update + s.contacts.add + s.contacts.update;
  const blocked = s.errors > 0 ? (s.errors === 1 ? w("blockedErrorsOne") : w("blockedErrors", { n: s.errors })) : changes === 0 ? (plan.rows.length === 0 ? w("noRows") : w("nothing")) : null;

  return (
    <Card className="space-y-5">
      <h2 ref={headingRef} id={`${id}-title`} tabIndex={-1} className="text-lg font-semibold outline-none">
        {w("step2")}
      </h2>
      {messageBox(true)}

      <div className="grid gap-3 sm:grid-cols-2">
        <SummaryGroup
          title={w("summaryCustomers")}
          items={[
            ["create", w("countNew", { n: s.customers.create })],
            ["update", w("countUpdated", { n: s.customers.update })],
            ["unchanged", w("countUnchanged", { n: s.customers.unchanged })],
          ]}
        />
        <SummaryGroup
          title={w("summaryContacts")}
          items={[
            ["create", w("countNew", { n: s.contacts.add })],
            ["update", w("countUpdated", { n: s.contacts.update })],
            ["unchanged", w("countUnchanged", { n: s.contacts.unchanged })],
          ]}
        />
      </div>
      {s.errors > 0 && (
        <p className="flex items-center gap-2 font-semibold text-red-800 dark:text-red-300">
          <svg className="size-5 shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
            <path d="M12 7.5v5.5M12 16.5h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          {s.errors === 1 ? w("countErrorsOne") : w("countErrors", { n: s.errors })}
        </p>
      )}

      {plan.warnings.length > 0 && (
        <Notice tone="warning">
          <ul className="space-y-1">
            {plan.warnings.map((m, i) => (
              <li key={i}>{rowText(m)}</li>
            ))}
          </ul>
        </Notice>
      )}

      {plan.rows.length > 0 && (
        <>
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium">{w("filter")}</legend>
            <div className="inline-grid w-full grid-cols-3 rounded-xl border border-slate-300 bg-white p-1 sm:w-auto dark:border-slate-600 dark:bg-slate-900">
              {(["all", "changes", "errors"] as const).map((f) => (
                <label
                  key={f}
                  className="flex min-h-11 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-3 lg:min-h-9 text-sm font-medium whitespace-nowrap text-slate-700 has-checked:bg-blue-700 has-checked:text-white has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-blue-600 hover:bg-slate-100 has-checked:hover:bg-blue-700 dark:text-slate-300 dark:has-checked:bg-blue-600 dark:hover:bg-slate-800"
                >
                  <input type="radio" name={`${id}-filter`} value={f} checked={filter === f} onChange={() => setFilter(f)} className="sr-only" />
                  {w(`filters.${f}`)}
                  <span className="tabular-nums opacity-80">{counts[f]}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {rows.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-300 px-4 py-6 text-center text-slate-600 dark:border-slate-700 dark:text-slate-400">{w(`filterEmpty.${filter}`)}</p>
          ) : (
            <>
              <PlanTable rows={rows.slice(0, shown)} />
              {rows.length > shown && (
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-sm text-slate-600 dark:text-slate-400">{w("showing", { n: shown, total: rows.length })}</p>
                  <Button variant="secondary" onClick={showMore}>
                    {w("showMore")}
                  </Button>
                </div>
              )}
            </>
          )}
        </>
      )}

      <div className="space-y-4 border-t border-slate-200 pt-5 dark:border-slate-800">
        {messageBox(false)}
        {partial ? (
          <div className="grid gap-3 min-[26rem]:grid-cols-2 sm:flex">
            <Button id="import-rerun" onClick={onRerun} loading={busy === "check"} className="min-[26rem]:col-span-2 sm:col-span-1">
              {busy === "check" ? w("checking") : w("rerun")}
            </Button>
            <ButtonLink to="/staff/customers" variant="secondary" className="min-[26rem]:col-span-2 sm:col-span-1">
              {w("toList")}
            </ButtonLink>
          </div>
        ) : (
          <>
            {blocked ? (
              <p id={`${id}-blocked`} className="text-sm font-medium text-slate-700 dark:text-slate-300">
                {blocked}
              </p>
            ) : (
              <p id={`${id}-ready`} className="text-sm text-slate-700 dark:text-slate-300">
                {w("ready")} {busy === "apply" && w("applyingNote")}
              </p>
            )}
            <div className="grid gap-3 min-[26rem]:grid-cols-2 sm:flex">
              <Button
                id="import-apply"
                onClick={onApply}
                loading={busy === "apply"}
                disabled={blocked !== null || busy !== null}
                aria-describedby={blocked ? `${id}-blocked` : `${id}-ready`}
                className="min-[26rem]:col-span-2 sm:col-span-1"
              >
                {busy === "apply" ? w("applying") : w("apply")}
              </Button>
              <Button variant="secondary" disabled={busy !== null} onClick={onBack}>
                {w("back")}
              </Button>
              <Button variant="secondary" disabled={busy !== null} onClick={onCancel}>
                {cu("cancel")}
              </Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

function SummaryGroup({ title, items }: { title: string; items: Array<[ImportRowAction, string]> }) {
  return (
    <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
      <p className="mb-2 text-sm font-semibold text-slate-600 dark:text-slate-400">{title}</p>
      <ul className="flex flex-wrap gap-2 text-sm" aria-label={title}>
        {items.map(([tone, text]) => (
          <li key={tone} className={`rounded-full px-2.5 py-0.5 font-semibold ring-1 ring-inset ${ACTION_STYLE[tone]}`}>
            {text}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RowResult({ r }: { r: ImportRow }) {
  return (
    <div className="space-y-1">
      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${ACTION_STYLE[r.action]}`}>{w(`action.${r.action}`)}</span>
      {r.messages.length > 0 && (
        <ul className={`space-y-0.5 text-sm ${r.action === "error" ? "text-red-800 dark:text-red-300" : "text-slate-600 dark:text-slate-400"}`}>
          {r.messages.map((m, i) => (
            <li key={i} className="break-words">
              {rowText(m)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A table on wider screens, a list of cards on phones. */
function PlanTable({ rows }: { rows: ImportRow[] }) {
  const dash = (v: string) => v || "–";
  return (
    <>
      {/* Scrolls on its own: focusable and named so keyboard users can scroll it too. */}
      <div
        role="region"
        aria-label={w("table")}
        tabIndex={0}
        className="hidden max-h-[32rem] overflow-auto rounded-xl border border-slate-200 bg-white sm:block dark:border-slate-700 dark:bg-slate-900"
      >
        <table className="w-full text-left text-sm">
          <caption className="sr-only">{w("table")}</caption>
          <thead className="sticky top-0 z-10 bg-slate-50 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            <tr>
              <th scope="col" className="px-3 py-2 font-semibold whitespace-nowrap">
                {w("line")}
              </th>
              <th scope="col" className="px-3 py-2 font-semibold whitespace-nowrap">
                {w("colCustomer")}
              </th>
              <th scope="col" className="px-3 py-2 font-semibold whitespace-nowrap">
                {w("colEmail")}
              </th>
              <th scope="col" className="px-3 py-2 font-semibold whitespace-nowrap">
                {w("result")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
            {rows.map((r) => (
              <tr key={r.line} className={r.action === "error" ? "bg-red-50/60 dark:bg-red-400/5" : ""}>
                <td className="px-3 py-2 align-top text-slate-500 tabular-nums dark:text-slate-400">{r.line}</td>
                <td className="px-3 py-2 align-top font-mono break-all">{dash(r.customerNumber)}</td>
                <td className="min-w-40 px-3 py-2 align-top [overflow-wrap:anywhere]">{dash(r.email)}</td>
                <td className="px-3 py-2 align-top">
                  <RowResult r={r} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="max-h-[32rem] space-y-2 overflow-auto rounded-xl sm:hidden" aria-label={w("table")} tabIndex={0}>
        {rows.map((r) => (
          <li key={r.line} className={`rounded-xl border p-3 ${r.action === "error" ? "border-red-300 bg-red-50/60 dark:border-red-400/40 dark:bg-red-400/5" : "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"}`}>
            <p className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-mono font-semibold break-all">{dash(r.customerNumber)}</span>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {w("line")} {r.line}
              </span>
            </p>
            <p className="mb-1.5 text-sm break-all text-slate-600 dark:text-slate-400">{dash(r.email)}</p>
            <RowResult r={r} />
          </li>
        ))}
      </ul>
    </>
  );
}

function Done({ result, headingRef, onAnother }: { result: CustomerImportResult; headingRef: RefObject<HTMLHeadingElement | null>; onAnother: () => void }) {
  const items: Array<[string, number]> = [
    [w("doneCreated"), result.created],
    [w("doneUpdated"), result.updated],
    [w("doneUnchanged"), result.unchanged],
    [w("doneContactsAdded"), result.contactsAdded],
    [w("doneContactsUpdated"), result.contactsUpdated],
  ];
  return (
    <section aria-labelledby="import-done" className="space-y-5 rounded-2xl border border-green-300 bg-green-50 p-5 sm:p-6 dark:border-green-400/40 dark:bg-green-400/10">
      <div className="flex items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-green-600 text-white" aria-hidden="true">
          <svg className="size-6" viewBox="0 0 24 24" fill="none">
            <path d="m5 12.5 4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <h2 ref={headingRef} id="import-done" tabIndex={-1} className="text-lg font-semibold outline-none">
          {w("doneTitle")}
        </h2>
      </div>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {items.map(([label, n]) => (
          <div key={label} className="rounded-xl bg-white px-3 py-2.5 dark:bg-slate-900">
            <dt className="text-sm text-slate-600 dark:text-slate-400">{label}</dt>
            <dd className="text-2xl font-bold tabular-nums">{n}</dd>
          </div>
        ))}
      </dl>
      <div className="grid gap-3 min-[26rem]:grid-cols-2 sm:flex">
        <ButtonLink to="/staff/customers">{w("toList")}</ButtonLink>
        <Button variant="secondary" onClick={onAnother}>
          {w("another")}
        </Button>
      </div>
    </section>
  );
}
