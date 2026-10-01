import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { z } from "zod";
import type { Settings } from "../../../../domain/settings";
import { settingsPatchIssues, settingsShape } from "../../../../shared/schemas";
import { apiFetch, isApiError, type Previewed } from "../../../api";
import { Button } from "../../../components/Button";
import { Card, Notice } from "../../../components/Card";
import { inputClass } from "../../../components/Field";
import { t } from "../../../i18n";
import type { Submit } from "../schedule/ImpactDialog";
import { selectClass } from "../schedule/shared";

export const s = (key: string, params?: Record<string, string | number>) => t(`web.staff.settings.${key}`, params);

/** "30 min", "1 h 30 min", "2 days", "1 d 6 h". */
export function fmtDuration(min: number): string {
  if (min < 60) return s("dur.min", { n: min });
  if (min < 1440 || min % 60 !== 0) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m === 0 ? s("dur.h", { n: h }) : s("dur.hMin", { h, m });
  }
  const d = Math.floor(min / 1440);
  const h = (min % 1440) / 60;
  if (h === 0) return d === 1 ? s("dur.day") : s("dur.days", { n: d });
  return s("dur.dayH", { d, h });
}

type Key = keyof Settings;
/** Field errors by field: a setting's key, or `businessHours.<weekday>` for one day. */
export type FieldErrors = Record<string, string>;

/** The DOM id of a setting's control (the focus target for its error). */
export const fieldId = (field: string) => `settings-${field.replace(".", "-")}`;

type Bounds = { minValue?: number | null; maxValue?: number | null; maxLength?: number | null };
const bounds = (key: Key) => settingsShape[key] as unknown as Bounds;

/** The field an issue belongs to: the setting, or the day for business hours. */
function issueField(path: readonly PropertyKey[]): string {
  const key = String(path[0]);
  return key === "businessHours" && typeof path[1] === "number" ? `${key}.${path[1]}` : key;
}

type Issue = Pick<z.core.$ZodIssue, "code" | "path"> & { origin?: string; maximum?: unknown };

/** Catalog text for one schema issue, worded for the setting it concerns. */
function issueText(i: Issue): string {
  const key = String(i.path[0]) as Key;
  if (key === "approvalReminderBh" && i.code === "custom") return s("errors.reminderOrder");
  if (key === "approvalEscalationBh" && i.code === "custom") return s("errors.escalationOrder");
  if (key === "businessHours") return s("errors.endAfterStart");
  if (i.origin === "string") {
    if (i.code === "too_small") return s("errors.required");
    if (i.code === "too_big") return s("errors.tooLong", { max: Number(i.maximum) });
    if (key === "supportPhone") return s("errors.phone");
    return s("errors.invalid");
  }
  if (i.code === "custom") return s("errors.grid");
  const b = bounds(key);
  if ((i.code === "too_small" || i.code === "too_big") && b.minValue != null && b.maxValue != null) return s("errors.range", { min: b.minValue, max: b.maxValue });
  return s("errors.wholeNumber");
}

/** The first problem per field, in schema order. */
export function errorsFrom(issues: readonly Issue[]): FieldErrors {
  const out: FieldErrors = {};
  for (const i of issues) {
    const f = issueField(i.path);
    out[f] ??= issueText(i);
  }
  return out;
}

/** A whole number typed into a text field; null when it isn't one. */
export const readInt = (raw: string): number | null => (/^\s*\d+\s*$/.test(raw) ? Number(raw) : null);

/** A section's form: its draft, how to read settings from it, and what to say about saving it. */
export interface SectionSpec<D> {
  keys: readonly Key[];
  toDraft: (settings: Settings) => D;
  /** The settings in the draft; fields that can't be read (e.g. "abc" for a number) go to `errors` instead. */
  read: (draft: D) => { values: Partial<Settings>; errors: FieldErrors };
  summary: string;
  done: string;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The state of one settings card: the draft starts from the saved settings (and follows them while untouched), Save
 * sends only the settings that changed, validated first with the shared schemas, then through preview → apply.
 */
export function useSection<D>(spec: SectionSpec<D>, settings: Settings, submit: Submit) {
  const saved = spec.toDraft(settings);
  const savedJson = JSON.stringify(saved);
  const [draft, setDraftState] = useState<D>(saved);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  /** Set once a save is applied: the heading takes focus when the saved values come back. */
  const focusOnSaved = useRef(false);
  const dirty = JSON.stringify(draft) !== savedJson;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // Fresh settings from the server replace an untouched draft; after a save, focus goes to the card's heading
  // (the Save button is disabled again by then, and the toast says what happened).
  useEffect(() => {
    if (focusOnSaved.current) {
      focusOnSaved.current = false;
      setDraftState(JSON.parse(savedJson) as D);
      setErrors({});
      headingRef.current?.focus();
    } else if (!dirtyRef.current) setDraftState(JSON.parse(savedJson) as D);
  }, [savedJson]);

  // Leaving the page with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  /** Change the draft; the edited fields' errors go away. */
  const update = (fn: (d: D) => D, ...fields: string[]) => {
    setDraftState(fn);
    if (fields.length > 0) setErrors((e) => Object.fromEntries(Object.entries(e).filter(([f]) => !fields.includes(f))));
  };

  const focusFirst = (errs: FieldErrors) => {
    // Fields are laid out in key order; the first erroneous one in the document takes focus.
    const ids = Object.keys(errs).map(fieldId);
    const first = [...document.querySelectorAll<HTMLElement>("[id^='settings-']")].find((el) => ids.includes(el.id));
    first?.focus();
  };

  async function save() {
    const { values, errors: unreadable } = spec.read(draft);
    const patch = Object.fromEntries(spec.keys.filter((k) => values[k] !== undefined && !same(values[k], settings[k])).map((k) => [k, values[k]])) as Partial<Settings>;
    const found = { ...errorsFrom(settingsPatchIssues(settings, patch)), ...unreadable };
    setErrors(found);
    setProblem(null);
    if (Object.keys(found).length > 0) {
      focusFirst(found);
      return;
    }
    if (Object.keys(patch).length === 0) {
      // Only cosmetic differences (e.g. " 30" for 30): nothing to send.
      setDraftState(saved);
      return;
    }
    setBusy(true);
    const result = await submit({
      summary: spec.summary,
      done: spec.done,
      preview: () => apiFetch<Previewed>("/api/staff/settings/preview", { method: "POST", body: { patch } }),
      apply: (version) => apiFetch("/api/staff/settings/apply", { method: "POST", body: { patch, version } }),
      onApplied: () => void (focusOnSaved.current = true),
      errorText: (e) => (isApiError(e, 400, "invalid") ? s("errors.invalid") : isApiError(e, 403) ? s("errors.forbidden") : null),
    });
    setBusy(false);
    if (result.status === "failed") {
      setProblem(result.message);
      if (isApiError(result.error, 400, "invalid") && Array.isArray(result.error.details)) {
        // The server's paths are relative to the request body: ["patch", "<setting>", …].
        const fromServer = errorsFrom((result.error.details as Issue[]).filter((i) => i.path?.[0] === "patch").map((i) => ({ ...i, path: i.path.slice(1) })));
        setErrors(fromServer);
        focusFirst(fromServer);
      }
    }
  }

  const discard = () => {
    setDraftState(saved);
    setErrors({});
    setProblem(null);
  };

  return { draft, update, errors, problem, busy, dirty, save, discard, headingRef };
}

/** A settings card: titled region with an optional lead, its fields, and (for administrators) the save bar. */
export function SectionCard({
  id,
  title,
  lead,
  headingRef,
  children,
  footer,
  badge,
}: {
  id: string;
  title: string;
  lead?: ReactNode;
  headingRef?: RefObject<HTMLHeadingElement | null>;
  children: ReactNode;
  footer?: ReactNode;
  badge?: ReactNode;
}) {
  const headingId = `${id}-heading`;
  return (
    <section id={id} aria-labelledby={headingId} className="scroll-mt-36">
      <Card flush>
        <div className="space-y-5 p-5 sm:p-6">
          <div className="space-y-1">
            <h2 ref={headingRef} id={headingId} tabIndex={-1} className="flex flex-wrap items-center gap-2 text-lg font-semibold outline-none">
              {title}
              {badge}
            </h2>
            {lead && <div className="text-slate-600 dark:text-slate-400">{lead}</div>}
          </div>
          {children}
        </div>
        {footer}
      </Card>
    </section>
  );
}

/** The Save / Discard bar under an editable card, with the card's own error notice. */
export function SaveBar({ busy, dirty, problem, onSave, onDiscard }: { busy: boolean; dirty: boolean; problem: string | null; onSave: () => void; onDiscard: () => void }) {
  return (
    <div className="space-y-3 rounded-b-2xl border-t border-slate-200 bg-slate-50 px-5 py-3 sm:px-6 dark:border-slate-800 dark:bg-slate-900/60">
      <div aria-live="polite" className="empty:hidden">
        {problem && <Notice tone="error">{problem}</Notice>}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
        <p className={`mr-auto flex items-center gap-2 text-sm font-medium ${dirty ? "text-amber-800 dark:text-amber-300" : "invisible max-sm:hidden"}`} aria-hidden={!dirty}>
          <span className="size-2 rounded-full bg-amber-500" aria-hidden="true" />
          {s("unsaved")}
        </p>
        <div className="grid w-full grid-cols-2 gap-3 sm:flex sm:w-auto">
          <Button variant="secondary" disabled={!dirty || busy} onClick={onDiscard} className="px-3 whitespace-nowrap">
            {s("discard")}
          </Button>
          <Button type="submit" loading={busy} disabled={!dirty} className="px-3 whitespace-nowrap">
            {busy ? s("saving") : s("save")}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A form wrapping a card, so Enter in a field saves it. */
export function SectionForm({ onSubmit, busy, children }: { onSubmit: () => void; busy: boolean; children: ReactNode }) {
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) onSubmit();
      }}
    >
      {children}
    </form>
  );
}

/** Error and hint under a control, wired to it by id. */
function Below({ id, error, hint, aside }: { id: string; error?: string; hint?: ReactNode; aside?: ReactNode }) {
  if (!error && !hint && !aside) return null;
  return (
    <div className="mt-1.5 flex items-start justify-between gap-4 text-sm">
      <div className="min-w-0">
        {error && (
          <p id={`${id}-error`} className="font-medium text-red-700 dark:text-red-400">
            {error}
          </p>
        )}
        {hint && (
          <p id={`${id}-hint`} className="text-slate-600 dark:text-slate-400">
            {hint}
          </p>
        )}
      </div>
      {aside && <div className="shrink-0 text-slate-500 tabular-nums dark:text-slate-400">{aside}</div>}
    </div>
  );
}

const describedBy = (id: string, error?: string, hint?: ReactNode) => [error && `${id}-error`, hint && `${id}-hint`].filter(Boolean).join(" ") || undefined;

/** Read-only label/value pair (what technicians see instead of a control). */
export function ReadValue({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-sm font-medium text-slate-600 dark:text-slate-400">{label}</dt>
      <dd className="mt-0.5 font-medium break-words">{value}</dd>
    </div>
  );
}

export function TextField({
  field,
  label,
  value,
  onChange,
  error,
  hint,
  maxLength,
  type = "text",
  multiline = false,
  counter = false,
  autoComplete,
}: {
  field: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: ReactNode;
  maxLength?: number;
  type?: "text" | "tel";
  multiline?: boolean;
  counter?: boolean;
  autoComplete?: string;
}) {
  const id = fieldId(field);
  const common = {
    id,
    value,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
    "aria-invalid": Boolean(error),
    "aria-describedby": describedBy(id, error, hint),
  };
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block font-medium">
        {label}
      </label>
      {multiline ? (
        <textarea {...common} rows={4} className={`${inputClass} min-h-24 resize-y`} />
      ) : (
        <input {...common} type={type} autoComplete={autoComplete ?? "off"} inputMode={type === "tel" ? "tel" : undefined} className={`${inputClass} min-h-11 py-2.5`} />
      )}
      <Below id={id} error={error} hint={hint} aside={counter && maxLength ? s("org.counter", { n: value.length, max: maxLength }) : undefined} />
    </div>
  );
}

/** A whole number with its unit after the box ("3 business hours"). Typed as text so partial input isn't lost. */
export function IntField({
  field,
  label,
  value,
  onChange,
  unit,
  error,
  hint,
}: {
  field: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  unit: string;
  error?: string;
  hint?: ReactNode;
}) {
  const id = fieldId(field);
  const unitId = `${id}-unit`;
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block font-medium">
        {label}
      </label>
      <div className="flex items-center gap-3">
        <div className="w-24 shrink-0">
          <input
          id={id}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={Boolean(error)}
          aria-describedby={[unitId, describedBy(id, error, hint)].filter(Boolean).join(" ")}
          className={`${inputClass} min-h-11 py-2.5 text-right tabular-nums`}
          />
        </div>
        <span id={unitId} className="text-slate-700 dark:text-slate-300">
          {unit}
        </span>
      </div>
      <Below id={id} error={error} hint={hint} />
    </div>
  );
}

/** Minutes on the 5-minute grid from `from` to `to`, shown as durations. Off-grid stored values stay selectable. */
export function MinutesSelect({
  field,
  label,
  value,
  onChange,
  from,
  to,
  error,
  hint,
}: {
  field: string;
  label: string;
  value: number;
  onChange: (v: number) => void;
  from: number;
  to: number;
  error?: string;
  hint?: ReactNode;
}) {
  const id = fieldId(field);
  const options = Array.from({ length: (to - from) / 5 + 1 }, (_, i) => from + i * 5);
  if (!options.includes(value)) options.push(value), options.sort((a, b) => a - b);
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1.5 block font-medium">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy(id, error, hint)}
        className={selectClass}
      >
        {options.map((m) => (
          <option key={m} value={m}>
            {fmtDuration(m)}
          </option>
        ))}
      </select>
      <Below id={id} error={error} hint={hint} />
    </div>
  );
}

/** A plain note under a card's fields (capacity rule, "coming soon"). */
export function CardNote({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "soon" }) {
  return (
    <p className="flex items-start gap-2 rounded-xl bg-slate-100 px-3 py-2.5 text-sm text-slate-700 dark:bg-slate-800 dark:text-slate-300">
      <svg className="mt-0.5 size-4 shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        {tone === "soon" ? (
          <>
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.75" />
            <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
          </>
        ) : (
          <>
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.75" />
            <path d="M12 11v5m0-8h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </>
        )}
      </svg>
      <span>{children}</span>
    </p>
  );
}
