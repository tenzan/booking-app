import type { ReactNode } from "react";
import { Link } from "react-router";
import { contactNameSchema, customerNameSchema, customerNotesSchema, customerNumberSchema, emailSchema, phoneSchema } from "../../../../shared/schemas";
import { isApiError } from "../../../api";
import { inputClass } from "../../../components/Field";
import { t } from "../../../i18n";
import { actionErrorText } from "../detail/shared";

export const cu = (key: string, params?: Record<string, string | number>) => t(`web.staff.customers.${key}`, params);

/** History state a customer page leaves for the page it links to, so "back" returns to the same list or customer. */
export interface CustomersBackState {
  /** The list's search string ("?q=…&status=…"), for the back link on the detail page. */
  listSearch?: string;
  /** Read by the staff reservation page: where its back link goes, and what it says. */
  back?: { to: string; label: string };
  /** A confirmation to show once on arrival (after creating a customer). */
  toast?: string;
}

export function StatusChip({ active }: { active: boolean }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-sm font-medium ring-1 ring-inset ${
        active
          ? "bg-green-100 text-green-900 ring-green-300 dark:bg-green-400/15 dark:text-green-200 dark:ring-green-400/40"
          : "bg-zinc-100 text-zinc-700 ring-zinc-300 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-600"
      }`}
    >
      <span className={`size-2 rounded-full ${active ? "bg-green-600" : "bg-zinc-400"}`} aria-hidden="true" />
      {active ? cu("active") : cu("inactive")}
    </span>
  );
}

/** "3 contacts", "2 of 3 active", "No contacts". */
export function contactsSummary(active: number, total: number): string {
  if (total === 0) return cu("contactsNone");
  if (active === total) return total === 1 ? cu("contactsOne") : cu("contactsAll", { n: total });
  return cu("contactsSome", { active, total });
}

/** Message for a failed customer or contact change without a field to put it on. */
export function customerErrorText(e: unknown): string {
  if (isApiError(e, 409, "number_taken")) return cu("errors.numberTaken");
  if (isApiError(e, 409, "number_locked")) return cu("errors.numberLocked");
  if (isApiError(e, 409, "contact_exists")) return cu("errors.contactExists");
  if (isApiError(e, 409, "has_history")) return cu("errors.hasHistory");
  if (isApiError(e, 404)) return cu("errors.notFound");
  if (isApiError(e, 403)) return cu("errors.forbidden");
  if (isApiError(e, 400)) return cu("errors.invalid");
  return actionErrorText(e);
}

export type FieldName = "customerNumber" | "name" | "phone" | "notes" | "email" | "contactName";

const maxOf = (schema: unknown) => (schema as { maxLength: number }).maxLength;

/** Field limits, read from the shared schemas, for maxLength and the "too long" message. */
export const LIMITS: Record<FieldName, number> = {
  customerNumber: maxOf(customerNumberSchema),
  name: maxOf(customerNameSchema),
  phone: maxOf(phoneSchema),
  notes: maxOf(customerNotesSchema),
  // emailSchema is a pipeline (trim, length, format, lower-case): its first stage holds the bound.
  email: maxOf((emailSchema as unknown as { in: { in: unknown } }).in.in),
  contactName: maxOf(contactNameSchema),
};

export interface Issue {
  path: PropertyKey[];
  code: string;
  maximum?: unknown;
}

/** The message for one schema issue (client-side parse, or a server `invalid` detail) on `field`. */
export function issueText(field: FieldName, issue: Issue | undefined, value: string): string {
  if (value.trim() === "" && (field === "customerNumber" || field === "name" || field === "email")) return cu("errors.required");
  if (issue?.code === "too_big") return cu("errors.tooLong", { max: Number(issue.maximum ?? LIMITS[field]) });
  if (field === "customerNumber") return cu("errors.numberChars");
  if (field === "phone") return cu("errors.phoneChars");
  if (field === "email") return cu("errors.email");
  return cu("errors.invalidField");
}

export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="-ml-2 inline-flex min-h-11 items-center gap-1 rounded-lg px-2 font-medium text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-slate-800"
    >
      <svg className="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M19 12H5m5 5-5-5 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {children}
    </Link>
  );
}

/** Label, input (or textarea), hint, error and an optional counter, wired together for screen readers. */
export function TextInput({
  id,
  label,
  value,
  onChange,
  error,
  hint,
  optional = false,
  maxLength,
  type = "text",
  multiline = false,
  counter = false,
  inputMode,
  mono = false,
  inputRef,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: ReactNode;
  optional?: boolean;
  maxLength?: number;
  type?: string;
  multiline?: boolean;
  counter?: boolean;
  inputMode?: "text" | "tel" | "email";
  mono?: boolean;
  inputRef?: (el: HTMLInputElement | null) => void;
}) {
  const describedBy = [error && `${id}-error`, hint && `${id}-hint`].filter(Boolean).join(" ") || undefined;
  const common = {
    id,
    value,
    maxLength,
    spellCheck: false,
    "aria-invalid": Boolean(error),
    "aria-describedby": describedBy,
  };
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1.5 block font-medium">
        {label}
        {optional && <span className="font-normal text-slate-500 dark:text-slate-400"> {cu("optional")}</span>}
      </label>
      {multiline ? (
        <textarea {...common} rows={3} spellCheck onChange={(e) => onChange(e.target.value)} className={`${inputClass} min-h-24 resize-y py-2.5`} />
      ) : (
        <input
          {...common}
          ref={inputRef}
          type={type}
          inputMode={inputMode}
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
          className={`${inputClass} min-h-11 py-2.5 ${mono ? "font-mono" : ""}`}
        />
      )}
      {(error || hint || counter) && (
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
          {counter && maxLength !== undefined && (
            <span className="shrink-0 text-slate-500 tabular-nums dark:text-slate-400" aria-hidden="true">
              {value.length}/{maxLength}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** For technicians on an administrators-only page (create, import): what they can't do, and a way back. */
export function AdminOnly({ text }: { text: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 px-6 py-10 text-center dark:border-slate-700">
      <p className="text-lg font-semibold">{text}</p>
      <Link to="/staff/customers" className="mt-4 inline-flex min-h-11 items-center font-medium text-blue-700 underline underline-offset-2 dark:text-blue-300">
        {cu("backToList")}
      </Link>
    </div>
  );
}
