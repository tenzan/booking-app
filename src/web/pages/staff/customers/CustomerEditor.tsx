import { useEffect, useId, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router";
import { customerCreateSchema, customerPatchSchema } from "../../../../shared/schemas";
import type { CustomerDetailDTO } from "../../../../shared/types";
import { apiFetch, handleSignedOut, isApiError, queryKeys, useMe } from "../../../api";
import { Button } from "../../../components/Button";
import { Card, Notice } from "../../../components/Card";
import { PageHeading, usePageTitle } from "../../../components/Layout";
import { AdminOnly, BackLink, cu, customerErrorText, issueText, LIMITS, TextInput, type CustomersBackState, type FieldName, type Issue } from "./shared";

/** Field errors keyed by path: "customerNumber", "contacts.0.email", … plus "form" for the whole form. */
type Errors = Record<string, string>;

interface CustomerDraft {
  customerNumber: string;
  name: string;
  phone: string;
  notes: string;
}

interface ContactDraft {
  key: number;
  email: string;
  name: string;
  phone: string;
}

const CONTACT_FIELDS: Record<string, FieldName> = { email: "email", name: "contactName", phone: "phone" };

/** Turns schema issues (from the client parse or a server 400 `invalid`) into field errors; the first issue per field wins. */
function errorsFrom(issues: readonly Issue[], draft: CustomerDraft, contacts: ContactDraft[] = []): Errors {
  const out: Errors = {};
  for (const i of issues) {
    const [head, index, sub] = i.path;
    if (head === "contacts" && typeof index === "number" && typeof sub === "string" && CONTACT_FIELDS[sub]) {
      const key = `contacts.${index}.${sub}`;
      const c = contacts[index];
      out[key] ??= issueText(CONTACT_FIELDS[sub], i, c ? c[sub as "email" | "name" | "phone"] : "");
    } else if (head === "contacts") {
      out.form ??= cu("errors.duplicateContact");
    } else if (head === "customerNumber" || head === "name" || head === "phone" || head === "notes") {
      out[head] ??= issueText(head, i, draft[head]);
    }
  }
  return out;
}

/** The ids of the fields in display order, to focus the first one with an error. */
function focusFirstError(formId: string, errors: Errors, order: string[]) {
  const first = order.find((k) => errors[k]);
  if (first) document.getElementById(`${formId}-${first.replaceAll(".", "-")}`)?.focus();
}

/** Number, name, phone and notes. The number is read-only, with the reason, when `lockedNumber` is set. */
function CustomerFields({
  formId,
  draft,
  set,
  errors,
  lockedNumber,
}: {
  formId: string;
  draft: CustomerDraft;
  set: (k: keyof CustomerDraft, v: string) => void;
  errors: Errors;
  lockedNumber?: string;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {lockedNumber !== undefined ? (
        <div>
          <p className="mb-1.5 font-medium">{cu("fields.number")}</p>
          <p className="flex min-h-11 items-center gap-2 font-mono text-slate-800 dark:text-slate-200" id={`${formId}-number-locked`}>
            <svg className="size-4 shrink-0 text-slate-500 dark:text-slate-400" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" strokeWidth="2" />
              <path d="M8 11V8a4 4 0 1 1 8 0v3" stroke="currentColor" strokeWidth="2" />
            </svg>
            {lockedNumber}
          </p>
          <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-400">{cu("fields.numberLocked")}</p>
        </div>
      ) : (
        <TextInput
          id={`${formId}-customerNumber`}
          label={cu("fields.number")}
          value={draft.customerNumber}
          onChange={(v) => set("customerNumber", v)}
          error={errors.customerNumber}
          hint={cu("fields.numberHint")}
          maxLength={LIMITS.customerNumber}
          mono
        />
      )}
      <TextInput id={`${formId}-name`} label={cu("fields.name")} value={draft.name} onChange={(v) => set("name", v)} error={errors.name} maxLength={LIMITS.name} />
      <TextInput
        id={`${formId}-phone`}
        label={cu("fields.phone")}
        optional
        type="tel"
        inputMode="tel"
        value={draft.phone}
        onChange={(v) => set("phone", v)}
        error={errors.phone}
        hint={cu("fields.phoneHint")}
        maxLength={LIMITS.phone}
      />
      <div className="sm:col-span-2">
        <TextInput
          id={`${formId}-notes`}
          label={cu("fields.notes")}
          optional
          multiline
          counter
          value={draft.notes}
          onChange={(v) => set("notes", v)}
          error={errors.notes}
          hint={cu("fields.notesHint")}
          maxLength={LIMITS.notes}
        />
      </div>
    </div>
  );
}

let nextKey = 1;
const blankContact = (): ContactDraft => ({ key: nextKey++, email: "", name: "", phone: "" });

/** `/staff/customers/new` — a new customer, with any number of contacts. Administrators only. */
export default function NewCustomerPage() {
  usePageTitle(cu("newTitle"));
  const me = useMe();
  const location = useLocation();
  const listSearch = (location.state as CustomersBackState | null)?.listSearch ?? "";
  const back = <BackLink to={`/staff/customers${listSearch}`}>{cu("backToList")}</BackLink>;
  if (me.data?.staff?.role !== "admin") {
    return (
      <div className="space-y-6">
        {back}
        <AdminOnly text={cu("adminOnlyCreate")} />
      </div>
    );
  }
  return (
    <div className="space-y-6">
      {back}
      <div className="space-y-1">
        <PageHeading>{cu("newTitle")}</PageHeading>
        <p className="text-slate-600 dark:text-slate-400">{cu("newLead")}</p>
      </div>
      <CreateForm listSearch={listSearch} />
    </div>
  );
}

function CreateForm({ listSearch }: { listSearch: string }) {
  const id = useId();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<CustomerDraft>({ customerNumber: "", name: "", phone: "", notes: "" });
  const [contacts, setContacts] = useState<ContactDraft[]>([]);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const focusAfter = useRef<string | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!focusAfter.current) return;
    const target = focusAfter.current === "add" ? addRef.current : document.getElementById(focusAfter.current);
    focusAfter.current = null;
    target?.focus();
  }, [contacts.length]);

  const set = (k: keyof CustomerDraft, v: string) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setErrors((e) => ({ ...e, [k]: "", form: "" }));
  };
  const setContact = (index: number, k: "email" | "name" | "phone", v: string) => {
    setContacts((list) => list.map((c, i) => (i === index ? { ...c, [k]: v } : c)));
    setErrors((e) => ({ ...e, [`contacts.${index}.${k}`]: "", form: "" }));
  };
  const addContact = () => {
    focusAfter.current = `${id}-contacts-${contacts.length}-email`;
    setContacts((list) => [...list, blankContact()]);
  };
  const removeContact = (index: number) => {
    // Errors are keyed by position: drop them rather than let them land on the wrong contact.
    setErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith("contacts."))));
    focusAfter.current = index < contacts.length - 1 ? `${id}-contacts-${index}-email` : "add";
    setContacts((list) => list.filter((_, i) => i !== index));
  };

  const order = ["customerNumber", "name", "phone", "notes", ...contacts.flatMap((_, i) => ["email", "name", "phone"].map((f) => `contacts.${i}.${f}`))];

  async function save() {
    const body = { ...draft, contacts: contacts.map(({ email, name, phone }) => ({ email, name, phone })) };
    const parsed = customerCreateSchema.safeParse(body);
    const next: Errors = parsed.success ? {} : errorsFrom(parsed.error.issues, draft, contacts);
    // The same email twice: point at the later one rather than the list as a whole.
    const seen = new Set<string>();
    contacts.forEach((c, i) => {
      const email = c.email.trim().toLowerCase();
      if (email && seen.has(email)) next[`contacts.${i}.email`] ??= cu("errors.duplicateEmail");
      seen.add(email);
    });
    if (Object.keys(next).some((k) => k.startsWith("contacts.")) && next.form === cu("errors.duplicateContact")) delete next.form;
    if (!parsed.success || Object.keys(next).length > 0) {
      setErrors(next);
      focusFirstError(id, next, order);
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      const created = await apiFetch<CustomerDetailDTO>("/api/staff/customers", { method: "POST", body: parsed.data });
      await qc.invalidateQueries({ queryKey: queryKeys.customers });
      const state: CustomersBackState = { listSearch, toast: cu("done.created", { name: created.customer.name, number: created.customer.customerNumber }) };
      navigate(`/staff/customers/${created.customer.id}`, { replace: true, state });
    } catch (e) {
      setBusy(false);
      if (handleSignedOut(qc, e)) return;
      if (isApiError(e, 409, "number_taken")) {
        const errs = { customerNumber: cu("errors.numberTaken") };
        setErrors(errs);
        focusFirstError(id, errs, order);
      } else if (isApiError(e, 400, "invalid") && Array.isArray(e.details)) {
        const errs = { ...errorsFrom(e.details as Issue[], draft, contacts) };
        errs.form ??= cu("errors.invalid");
        setErrors(errs);
        focusFirstError(id, errs, order);
      } else setErrors({ form: customerErrorText(e) });
    }
  }

  return (
    <Card>
      <form
        noValidate
        aria-label={cu("newTitle")}
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void save();
        }}
        className="space-y-6"
      >
        <CustomerFields formId={id} draft={draft} set={set} errors={errors} />

        <fieldset className="space-y-3" aria-describedby={`${id}-contacts-lead`}>
          <legend className="text-lg font-semibold">{cu("contacts.title")}</legend>
          <p id={`${id}-contacts-lead`} className="text-sm text-slate-600 dark:text-slate-400">
            {cu("contacts.newLead")}
          </p>
          {contacts.length > 0 && (
            <ol className="space-y-3">
              {contacts.map((c, i) => (
                <li key={c.key}>
                  <div role="group" aria-labelledby={`${id}-contact-${c.key}`} className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-800/40">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <h3 id={`${id}-contact-${c.key}`} className="font-semibold">
                        {cu("contacts.numbered", { n: i + 1 })}
                      </h3>
                      <Button variant="ghost" onClick={() => removeContact(i)} className="-my-1 -mr-2 text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-400/10">
                        {cu("contacts.remove")}
                        <span className="sr-only"> {cu("contacts.numbered", { n: i + 1 })}</span>
                      </Button>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-3">
                      <TextInput
                        id={`${id}-contacts-${i}-email`}
                        label={cu("contacts.email")}
                        type="email"
                        inputMode="email"
                        value={c.email}
                        onChange={(v) => setContact(i, "email", v)}
                        error={errors[`contacts.${i}.email`]}
                        maxLength={LIMITS.email}
                      />
                      <TextInput
                        id={`${id}-contacts-${i}-name`}
                        label={cu("contacts.name")}
                        optional
                        value={c.name}
                        onChange={(v) => setContact(i, "name", v)}
                        error={errors[`contacts.${i}.name`]}
                        maxLength={LIMITS.contactName}
                      />
                      <TextInput
                        id={`${id}-contacts-${i}-phone`}
                        label={cu("contacts.phone")}
                        optional
                        type="tel"
                        inputMode="tel"
                        value={c.phone}
                        onChange={(v) => setContact(i, "phone", v)}
                        error={errors[`contacts.${i}.phone`]}
                        maxLength={LIMITS.phone}
                      />
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
          {contacts.length < 50 && (
            <Button ref={addRef} variant="secondary" onClick={addContact}>
              <svg className="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              {contacts.length === 0 ? cu("contacts.addFirst") : cu("contacts.addAnother")}
            </Button>
          )}
        </fieldset>

        <div aria-live="polite" className="empty:mb-0">
          {errors.form && <Notice tone="error">{errors.form}</Notice>}
        </div>
        <div className="grid gap-3 border-t border-slate-200 pt-5 min-[26rem]:grid-cols-2 sm:flex dark:border-slate-800">
          <Button type="submit" loading={busy}>
            {busy ? cu("creating") : cu("create")}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => navigate(`/staff/customers${listSearch}`)}>
            {cu("cancel")}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** Edit the customer's own fields in place on the detail page (contacts have their own controls). */
export function EditCustomerForm({ detail, onClose, onDone }: { detail: CustomerDetailDTO; onClose: () => void; onDone: (text: string) => void }) {
  const id = useId();
  const qc = useQueryClient();
  const c = detail.customer;
  // Any reservation at all is in the recent list, so an empty list means none: the number may still change.
  const locked = detail.recentReservations.length > 0;
  const [draft, setDraft] = useState<CustomerDraft>({ customerNumber: c.customerNumber, name: c.name, phone: c.phone ?? "", notes: c.notes ?? "" });
  const [errors, setErrors] = useState<Errors>({});
  const [lockedNow, setLockedNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLFormElement>(null);
  const order = ["customerNumber", "name", "phone", "notes"];

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("input:not([disabled])")?.focus();
  }, []);

  const set = (k: keyof CustomerDraft, v: string) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setErrors((e) => ({ ...e, [k]: "", form: "" }));
  };

  async function save() {
    const numberEditable = !locked && !lockedNow;
    const candidate = {
      ...(numberEditable ? { customerNumber: draft.customerNumber } : {}),
      name: draft.name,
      phone: draft.phone.trim() === "" ? null : draft.phone,
      notes: draft.notes.trim() === "" ? null : draft.notes,
    };
    const parsed = customerPatchSchema.safeParse(candidate);
    if (!parsed.success) {
      const errs = errorsFrom(parsed.error.issues, draft);
      setErrors(errs);
      focusFirstError(id, errs, order);
      return;
    }
    const v = parsed.data;
    // Only what changed (the server would ignore the rest, but the audit and the toast should say what happened).
    const patch = {
      ...(v.customerNumber !== undefined && v.customerNumber !== c.customerNumber ? { customerNumber: v.customerNumber } : {}),
      ...(v.name !== undefined && v.name !== c.name ? { name: v.name } : {}),
      ...((v.phone ?? null) !== c.phone ? { phone: v.phone ?? null } : {}),
      ...((v.notes ?? null) !== c.notes ? { notes: v.notes ?? null } : {}),
    };
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      const updated = await apiFetch<CustomerDetailDTO>(`/api/staff/customers/${c.id}`, { method: "PATCH", body: patch });
      qc.setQueryData(queryKeys.customer(c.id), updated);
      void qc.invalidateQueries({ queryKey: queryKeys.customers });
      onDone(cu("done.saved", { name: updated.customer.name }));
    } catch (e) {
      setBusy(false);
      if (handleSignedOut(qc, e)) return;
      if (isApiError(e, 409, "number_taken")) {
        const errs = { customerNumber: cu("errors.numberTaken") };
        setErrors(errs);
        focusFirstError(id, errs, order);
      } else if (isApiError(e, 409, "number_locked")) {
        // A booking arrived since the page loaded: the number is fixed now. Show it as such and keep the other edits.
        setLockedNow(true);
        setDraft((d) => ({ ...d, customerNumber: c.customerNumber }));
        setErrors({ form: cu("errors.numberLockedNow") });
        void qc.invalidateQueries({ queryKey: queryKeys.customer(c.id) });
      } else if (isApiError(e, 400, "invalid") && Array.isArray(e.details)) {
        const errs = errorsFrom(e.details as Issue[], draft);
        errs.form ??= cu("errors.invalid");
        setErrors(errs);
        focusFirstError(id, errs, order);
      } else {
        if (isApiError(e, 404)) void qc.invalidateQueries({ queryKey: queryKeys.customers });
        setErrors({ form: customerErrorText(e) });
      }
    }
  }

  return (
    <form
      ref={ref}
      noValidate
      aria-labelledby={`${id}-title`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) void save();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
      className="space-y-5 rounded-2xl border border-blue-300 bg-blue-50/60 p-4 shadow-sm sm:p-6 dark:border-blue-400/40 dark:bg-blue-400/5"
    >
      <h2 id={`${id}-title`} className="text-lg font-semibold">
        {cu("editTitle")}
      </h2>
      <CustomerFields formId={id} draft={draft} set={set} errors={errors} lockedNumber={locked || lockedNow ? c.customerNumber : undefined} />
      <div aria-live="polite" className="empty:mb-0">
        {errors.form && <Notice tone={lockedNow && !Object.keys(errors).some((k) => k !== "form" && errors[k]) ? "warning" : "error"}>{errors.form}</Notice>}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:flex">
        <Button type="submit" loading={busy}>
          {busy ? cu("saving") : cu("save")}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          {cu("cancel")}
        </Button>
      </div>
    </form>
  );
}
