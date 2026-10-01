import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { contactInputSchema, contactPatchSchema, CUSTOMER_RECENT_LIMIT } from "../../../../shared/schemas";
import type { CustomerContactDTO, CustomerDetailDTO, CustomerDTO, CustomerReservationSummaryDTO } from "../../../../shared/types";
import { apiFetch, handleSignedOut, isApiError, queryKeys, useMe } from "../../../api";
import { Button, ButtonLink } from "../../../components/Button";
import { Card, Notice } from "../../../components/Card";
import { focusWhenReady } from "../../../components/Dialog";
import { PageHeading, usePageTitle } from "../../../components/Layout";
import { Skeleton } from "../../../components/Spinner";
import { StatusBadge } from "../../../components/StatusBadge";
import { TimezoneNote } from "../../../components/TimezoneNote";
import { Toast, useToast } from "../../../components/Toast";
import { dateIn, fmtDateWithYear, fmtTimeRange } from "../../../format";
import { t } from "../../../i18n";
import { EditCustomerForm } from "./CustomerEditor";
import { BackLink, contactsSummary, cu, customerErrorText, issueText, LIMITS, StatusChip, TextInput, type CustomersBackState, type Issue } from "./shared";

/** `/staff/customers/:id` — one customer: details, contacts and recent reservations. Administrators can change them. */
export default function CustomerDetail() {
  const params = useParams();
  const id = Number(params.id);
  const valid = Number.isInteger(id) && id > 0;
  const me = useMe();
  const tz = me.data?.timezone ?? "UTC";
  const isAdmin = me.data?.staff?.role === "admin";
  const location = useLocation();
  const navigate = useNavigate();
  const arrived = location.state as CustomersBackState | null;
  const listSearch = useRef(arrived?.listSearch ?? "").current;
  const { toast, show, dismiss } = useToast();
  const q = useQuery({
    queryKey: queryKeys.customer(id),
    queryFn: () => apiFetch<CustomerDetailDTO>(`/api/staff/customers/${id}`),
    enabled: valid,
  });
  usePageTitle(q.data?.customer.name ?? cu("detailTitle"));

  // A confirmation handed over by the create form: show it once, then drop it from history so a reload doesn't repeat it.
  useEffect(() => {
    if (!arrived?.toast) return;
    show(arrived.toast);
    navigate(location.pathname, { replace: true, state: { listSearch } satisfies CustomersBackState });
  }, []);

  const back = <BackLink to={`/staff/customers${listSearch}`}>{cu("backToList")}</BackLink>;

  if (!valid || isApiError(q.error, 404)) {
    return (
      <div className="space-y-6">
        {back}
        <div className="rounded-2xl border border-dashed border-slate-300 px-6 py-10 text-center dark:border-slate-700">
          <PageHeading className="text-lg sm:text-xl">{cu("notFound")}</PageHeading>
          <p className="mt-1 text-slate-600 dark:text-slate-400">{cu("notFoundBody")}</p>
          <div className="mt-5 flex justify-center">
            <ButtonLink to="/staff/customers">{cu("backToList")}</ButtonLink>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {back}
      {q.isPending ? (
        <div className="space-y-4" aria-busy="true">
          <span className="sr-only">{t("web.common.loading")}</span>
          <Skeleton className="h-36" />
          <div className="grid gap-6 lg:grid-cols-5">
            <Skeleton className="h-64 lg:col-span-3" />
            <Skeleton className="h-64 lg:col-span-2" />
          </div>
        </div>
      ) : q.isError ? (
        <Notice tone="error" className="flex flex-wrap items-center justify-between gap-3">
          {cu("detailLoadFailed")}
          <Button variant="secondary" onClick={() => void q.refetch()}>
            {t("web.common.retry")}
          </Button>
        </Notice>
      ) : (
        <>
          <Header detail={q.data} isAdmin={isAdmin} onDone={show} />
          {me.data?.staff && !isAdmin && <p className="text-slate-600 dark:text-slate-400">{cu("techNote")}</p>}
          <div className="grid items-start gap-8 lg:grid-cols-5">
            <Contacts detail={q.data} isAdmin={isAdmin} onDone={show} className="lg:col-span-3" />
            <Reservations customer={q.data.customer} list={q.data.recentReservations} tz={tz} listSearch={listSearch} className="lg:col-span-2" />
          </div>
        </>
      )}
      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}

/** Refetch this customer and every list that shows it. */
function useRefresh(id: number) {
  const qc = useQueryClient();
  return (detail?: CustomerDetailDTO) => {
    if (detail) qc.setQueryData(queryKeys.customer(id), detail);
    return qc.invalidateQueries({ queryKey: queryKeys.customers });
  };
}

// ---- Header: who the customer is, edit, activate / deactivate ------------------------------------------------------

function Header({ detail, isAdmin, onDone }: { detail: CustomerDetailDTO; isAdmin: boolean; onDone: (text: string) => void }) {
  const c = detail.customer;
  const id = useId();
  const qc = useQueryClient();
  const refresh = useRefresh(c.id);
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (asking) keepRef.current?.focus();
  }, [asking]);

  async function setActive(active: boolean) {
    setBusy(true);
    setProblem(null);
    try {
      const updated = await apiFetch<CustomerDetailDTO>(`/api/staff/customers/${c.id}/active`, { method: "POST", body: { active } });
      await refresh(updated);
      setAsking(false);
      onDone(active ? cu("done.activated", { name: c.name }) : cu("done.deactivated", { name: c.name }));
      focusWhenReady(() => toggleRef.current);
    } catch (e) {
      if (handleSignedOut(qc, e)) return;
      if (isApiError(e, 404)) void refresh();
      setAsking(false);
      setProblem(customerErrorText(e));
      focusWhenReady(() => toggleRef.current);
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <div className="space-y-4">
        {/* The page keeps its h1 while the card is a form (a plain heading: the form's first field has focus). */}
        <div className="space-y-1">
          <p className="font-mono text-sm font-medium text-slate-600 dark:text-slate-400">
            <span className="sr-only">{cu("fields.number")}: </span>
            {c.customerNumber}
          </p>
          <h1 className="text-2xl font-bold tracking-tight break-words sm:text-3xl">{c.name}</h1>
        </div>
        <EditCustomerForm
          detail={detail}
          onClose={() => {
            setEditing(false);
            focusWhenReady(() => editRef.current);
          }}
          onDone={(text) => {
            setEditing(false);
            onDone(text);
            focusWhenReady(() => editRef.current);
          }}
        />
      </div>
    );
  }

  return (
    <Card className={c.active ? "" : "border-dashed"}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1.5">
          <p className="font-mono text-sm font-medium text-slate-600 dark:text-slate-400">
            <span className="sr-only">{cu("fields.number")}: </span>
            {c.customerNumber}
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <PageHeading className="break-words">{c.name}</PageHeading>
            <StatusChip active={c.active} />
          </div>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {contactsSummary(detail.contacts.filter((k) => k.active).length, detail.contacts.length)}
          </p>
        </div>
        {isAdmin && !asking && (
          <div className="grid w-full grid-cols-2 gap-3 sm:flex sm:w-auto">
            <Button ref={editRef} variant="secondary" onClick={() => setEditing(true)} disabled={busy}>
              {cu("edit")}
            </Button>
            <Button
              ref={toggleRef}
              variant="secondary"
              loading={busy}
              onClick={() => (c.active ? setAsking(true) : void setActive(true))}
            >
              {busy ? cu("working") : c.active ? cu("deactivate") : cu("activate")}
            </Button>
          </div>
        )}
      </div>

      {!c.active && <Notice className="mt-4">{cu("inactiveNote")}</Notice>}

      <dl className="mt-5 grid gap-4 border-t border-slate-200 pt-4 sm:grid-cols-2 dark:border-slate-800">
        <Fact label={cu("fields.phone")}>
          {c.phone ? (
            <a href={`tel:${c.phone.replace(/[^0-9+]/g, "")}`} className="inline-flex min-h-11 items-center font-medium text-blue-700 underline-offset-2 hover:underline sm:min-h-0 dark:text-blue-300">
              {c.phone}
            </a>
          ) : (
            <span className="text-slate-500 dark:text-slate-400">{cu("none")}</span>
          )}
        </Fact>
        <Fact label={cu("fields.notes")}>
          {c.notes ? <span className="whitespace-pre-wrap break-words">{c.notes}</span> : <span className="text-slate-500 dark:text-slate-400">{cu("noNotes")}</span>}
        </Fact>
      </dl>

      <div aria-live="polite" className="empty:mb-0">
        {problem && (
          <Notice tone="error" className="mt-4">
            {problem}
          </Notice>
        )}
      </div>

      {isAdmin && asking && (
        <div
          role="group"
          aria-labelledby={`${id}-ask`}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !busy) {
              e.preventDefault();
              setAsking(false);
              focusWhenReady(() => toggleRef.current);
            }
          }}
          className="mt-4 space-y-3 rounded-xl border border-red-300 bg-red-50/60 p-4 dark:border-red-400/40 dark:bg-red-400/5"
        >
          <p id={`${id}-ask`} className="font-medium">
            {cu("deactivateAsk", { name: c.name })}
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700 dark:text-slate-300">
            <li>{cu("deactivateBlocks")}</li>
            <li>{cu("deactivateKeeps")}</li>
          </ul>
          <div className="grid grid-cols-2 gap-3 sm:flex">
            <Button variant="danger" loading={busy} onClick={() => void setActive(false)}>
              {busy ? cu("working") : cu("deactivateConfirm")}
            </Button>
            <Button
              ref={keepRef}
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setAsking(false);
                focusWhenReady(() => toggleRef.current);
              }}
            >
              {cu("keepActive")}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-sm font-medium text-slate-600 dark:text-slate-400">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

// ---- Contacts -------------------------------------------------------------------------------------------------------

function Contacts({ detail, isAdmin, onDone, className }: { detail: CustomerDetailDTO; isAdmin: boolean; onDone: (text: string) => void; className: string }) {
  const id = useId();
  const c = detail.customer;
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const active = detail.contacts.filter((k) => k.active).length;

  return (
    <section aria-labelledby={`${id}-title`} className={`min-w-0 space-y-3 ${className}`}>
      <div className="space-y-1">
        <h2 ref={headingRef} id={`${id}-title`} tabIndex={-1} className="flex items-center gap-2 text-lg font-semibold outline-none">
          {cu("contacts.title")}
          {detail.contacts.length > 0 && (
            <span className="rounded-full bg-slate-200 px-2 py-0.5 text-sm font-semibold text-slate-700 tabular-nums dark:bg-slate-800 dark:text-slate-200">
              <span className="sr-only">{contactsSummary(active, detail.contacts.length)}</span>
              <span aria-hidden="true">{active === detail.contacts.length ? active : `${active}/${detail.contacts.length}`}</span>
            </span>
          )}
        </h2>
        <p className="text-sm text-slate-600 dark:text-slate-400">{cu("contacts.lead")}</p>
      </div>

      {detail.contacts.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-amber-300 bg-amber-50/50 px-5 py-6 dark:border-amber-400/40 dark:bg-amber-400/5">
          <p className="font-semibold">{cu("contacts.empty")}</p>
          <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">{cu("contacts.emptyBody")}</p>
        </div>
      ) : (
        <ul className="space-y-3" aria-label={cu("contacts.listLabel", { name: c.name })}>
          {detail.contacts.map((k) => (
            <li key={k.id}>
              {editing === k.id ? (
                <EditContactForm
                  customer={c}
                  contact={k}
                  onClose={(text) => {
                    setEditing(null);
                    if (text) onDone(text);
                    focusWhenReady(() => document.getElementById(`contact-${k.id}-edit`));
                  }}
                />
              ) : (
                <ContactItem
                  customer={c}
                  contact={k}
                  isAdmin={isAdmin}
                  formOpen={adding || editing !== null}
                  onEdit={() => setEditing(k.id)}
                  onDone={onDone}
                  onDeleted={() => focusWhenReady(() => headingRef.current)}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {isAdmin &&
        (adding ? (
          <AddContactForm
            customer={c}
            onClose={(added) => {
              setAdding(false);
              if (added) {
                onDone(cu("done.contactAdded", { email: added.email, name: c.name }));
                focusWhenReady(() => document.getElementById(`contact-${added.id}-edit`));
              } else focusWhenReady(() => addRef.current);
            }}
          />
        ) : (
          <Button ref={addRef} variant="secondary" onClick={() => setAdding(true)} disabled={editing !== null}>
            <svg className="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            {cu("contacts.add")}
          </Button>
        ))}
    </section>
  );
}

function Chip({ tone, children }: { tone: "inactive" | "history"; children: string }) {
  const cls =
    tone === "inactive"
      ? "bg-zinc-100 text-zinc-700 ring-zinc-300 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-600"
      : "bg-slate-100 text-slate-700 ring-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-600";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${cls}`}>{children}</span>;
}

function ContactItem({
  customer,
  contact: k,
  isAdmin,
  formOpen,
  onEdit,
  onDone,
  onDeleted,
}: {
  customer: CustomerDTO;
  contact: CustomerContactDTO;
  isAdmin: boolean;
  formOpen: boolean;
  onEdit: () => void;
  onDone: (text: string) => void;
  onDeleted: () => void;
}) {
  const id = useId();
  const qc = useQueryClient();
  const refresh = useRefresh(customer.id);
  const [busy, setBusy] = useState<"active" | "delete" | null>(null);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (asking) keepRef.current?.focus();
  }, [asking]);

  const fail = (e: unknown, focus: () => HTMLElement | null) => {
    if (handleSignedOut(qc, e)) return;
    // Gone, or it booked meanwhile (no longer deletable): show the server's current state.
    if (isApiError(e, 404) || isApiError(e, 409, "has_history")) void refresh();
    setProblem(customerErrorText(e));
    focusWhenReady(focus);
  };

  async function setActive(active: boolean) {
    setBusy("active");
    setProblem(null);
    try {
      await apiFetch(`/api/staff/customers/${customer.id}/contacts/${k.id}`, { method: "PATCH", body: { active } });
      await refresh();
      onDone(active ? cu("done.contactActivated", { email: k.email }) : cu("done.contactDeactivated", { email: k.email, name: customer.name }));
      focusWhenReady(() => toggleRef.current);
    } catch (e) {
      fail(e, () => toggleRef.current);
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("delete");
    setProblem(null);
    try {
      await apiFetch(`/api/staff/customers/${customer.id}/contacts/${k.id}`, { method: "DELETE" });
      await refresh();
      onDone(cu("done.contactDeleted", { email: k.email }));
      onDeleted();
    } catch (e) {
      setAsking(false);
      fail(e, () => toggleRef.current);
      setBusy(null);
    }
  }

  const historyNoteId = `${id}-history`;
  return (
    <article
      aria-labelledby={`${id}-email`}
      className={`rounded-2xl border p-4 ${k.active ? "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900" : "border-dashed border-slate-300 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/50"}`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 id={`${id}-email`} className={`font-semibold break-all ${k.active ? "" : "text-slate-600 dark:text-slate-400"}`}>
          {k.email}
        </h3>
        {!k.active && <Chip tone="inactive">{cu("contacts.inactive")}</Chip>}
        {k.hasHistory && <Chip tone="history">{cu("contacts.hasBooked")}</Chip>}
      </div>
      <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">
        {k.name ?? <span className="italic">{cu("contacts.noName")}</span>}
        {k.phone && (
          <>
            {" · "}
            <a href={`tel:${k.phone.replace(/[^0-9+]/g, "")}`} className="text-blue-700 underline-offset-2 hover:underline dark:text-blue-300">
              {k.phone}
            </a>
          </>
        )}
      </p>
      {!k.active && <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{cu("contacts.inactiveHint")}</p>}

      {isAdmin && !asking && (
        <div className="mt-3 flex flex-wrap items-center gap-x-1 gap-y-1 border-t border-slate-200 pt-2 dark:border-slate-800">
          <Button id={`contact-${k.id}-edit`} variant="ghost" onClick={onEdit} disabled={formOpen || busy !== null} className="-ml-2">
            {cu("edit")}
            <span className="sr-only"> {k.email}</span>
          </Button>
          <Button
            ref={toggleRef}
            variant="ghost"
            loading={busy === "active"}
            disabled={formOpen || (busy !== null && busy !== "active")}
            onClick={() => void setActive(!k.active)}
            aria-describedby={k.hasHistory ? historyNoteId : undefined}
          >
            {busy === "active" ? cu("working") : k.active ? cu("deactivate") : cu("activate")}
            <span className="sr-only"> {k.email}</span>
          </Button>
          {!k.hasHistory && (
            <Button
              ref={deleteRef}
              variant="ghost"
              onClick={() => setAsking(true)}
              disabled={formOpen || busy !== null}
              className="text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-400/10"
            >
              {cu("contacts.delete")}
              <span className="sr-only"> {k.email}</span>
            </Button>
          )}
          {k.hasHistory && (
            <p id={historyNoteId} className="basis-full text-sm text-slate-600 sm:basis-auto sm:pl-2 dark:text-slate-400">
              {k.active ? cu("contacts.historyNote") : cu("contacts.historyNoteInactive")}
            </p>
          )}
        </div>
      )}

      <div aria-live="polite" className="empty:mb-0">
        {problem && (
          <Notice tone="error" className="mt-3">
            {problem}
          </Notice>
        )}
      </div>

      {isAdmin && asking && (
        <div
          role="group"
          aria-labelledby={`${id}-ask`}
          onKeyDown={(e) => {
            if (e.key === "Escape" && busy === null) {
              e.preventDefault();
              setAsking(false);
              focusWhenReady(() => deleteRef.current);
            }
          }}
          className="mt-3 space-y-3 rounded-xl border border-red-300 bg-red-50/60 p-3 dark:border-red-400/40 dark:bg-red-400/5"
        >
          <p id={`${id}-ask`} className="text-sm font-medium">
            {cu("contacts.deleteAsk", { email: k.email, name: customer.name })}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="danger" loading={busy === "delete"} onClick={() => void remove()}>
              {busy === "delete" ? cu("working") : cu("contacts.deleteConfirm")}
            </Button>
            <Button
              ref={keepRef}
              variant="secondary"
              disabled={busy !== null}
              onClick={() => {
                setAsking(false);
                focusWhenReady(() => deleteRef.current);
              }}
            >
              {cu("contacts.keep")}
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}

type ContactErrors = { email?: string; name?: string; phone?: string; form?: string };

function contactErrorsFrom(issues: readonly Issue[], values: { email: string; name: string; phone: string }): ContactErrors {
  const out: ContactErrors = {};
  for (const i of issues) {
    const f = i.path[0];
    if (f === "email") out.email ??= issueText("email", i, values.email);
    if (f === "name") out.name ??= issueText("contactName", i, values.name);
    if (f === "phone") out.phone ??= issueText("phone", i, values.phone);
  }
  return out;
}

const firstContactError = (formId: string, e: ContactErrors) => {
  const f = (["email", "name", "phone"] as const).find((k) => e[k]);
  if (f) document.getElementById(`${formId}-${f}`)?.focus();
};

/** Inline frame for the contact forms: labelled, Esc cancels unless saving, first field focused on open. */
function ContactFormFrame({ title, busy, onCancel, onSubmit, children }: { title: string; busy: boolean; onCancel: () => void; onSubmit: () => void; children: ReactNode }) {
  const id = useId();
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("input")?.focus();
  }, []);
  return (
    <form
      ref={ref}
      noValidate
      aria-labelledby={id}
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
      className="space-y-4 rounded-2xl border border-blue-300 bg-blue-50/60 p-4 shadow-sm dark:border-blue-400/40 dark:bg-blue-400/5"
    >
      <h3 id={id} className="font-semibold break-all">
        {title}
      </h3>
      {children}
    </form>
  );
}

function FormButtons({ busy, label, busyLabel, onCancel }: { busy: boolean; label: string; busyLabel: string; onCancel: () => void }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:flex">
      <Button type="submit" loading={busy}>
        {busy ? busyLabel : label}
      </Button>
      <Button variant="secondary" disabled={busy} onClick={onCancel}>
        {cu("cancel")}
      </Button>
    </div>
  );
}

function AddContactForm({ customer, onClose }: { customer: CustomerDTO; onClose: (added?: CustomerContactDTO) => void }) {
  const id = useId();
  const qc = useQueryClient();
  const refresh = useRefresh(customer.id);
  const [values, setValues] = useState({ email: "", name: "", phone: "" });
  const [errors, setErrors] = useState<ContactErrors>({});
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof values, v: string) => {
    setValues((x) => ({ ...x, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined, form: undefined }));
  };

  async function save() {
    const parsed = contactInputSchema.safeParse(values);
    if (!parsed.success) {
      const errs = contactErrorsFrom(parsed.error.issues, values);
      setErrors(errs);
      firstContactError(id, errs);
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      const { contact } = await apiFetch<{ contact: CustomerContactDTO }>(`/api/staff/customers/${customer.id}/contacts`, { method: "POST", body: parsed.data });
      await refresh();
      onClose(contact);
    } catch (e) {
      setBusy(false);
      if (handleSignedOut(qc, e)) return;
      if (isApiError(e, 409, "contact_exists")) {
        setErrors({ email: cu("errors.contactExists") });
        document.getElementById(`${id}-email`)?.focus();
      } else if (isApiError(e, 400, "invalid") && Array.isArray(e.details)) {
        const errs = { ...contactErrorsFrom(e.details as Issue[], values), form: cu("errors.invalid") };
        setErrors(errs);
        firstContactError(id, errs);
      } else {
        if (isApiError(e, 404)) void refresh();
        setErrors({ form: customerErrorText(e) });
      }
    }
  }

  return (
    <ContactFormFrame title={cu("contacts.addTitle")} busy={busy} onCancel={() => onClose()} onSubmit={() => void save()}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <TextInput
            id={`${id}-email`}
            label={cu("contacts.email")}
            type="email"
            inputMode="email"
            value={values.email}
            onChange={(v) => set("email", v)}
            error={errors.email}
            hint={cu("contacts.emailHint")}
            maxLength={LIMITS.email}
          />
        </div>
        <TextInput id={`${id}-name`} label={cu("contacts.name")} optional value={values.name} onChange={(v) => set("name", v)} error={errors.name} maxLength={LIMITS.contactName} />
        <TextInput id={`${id}-phone`} label={cu("contacts.phone")} optional type="tel" inputMode="tel" value={values.phone} onChange={(v) => set("phone", v)} error={errors.phone} maxLength={LIMITS.phone} />
      </div>
      <div aria-live="polite" className="empty:mb-0">
        {errors.form && <Notice tone="error">{errors.form}</Notice>}
      </div>
      <FormButtons busy={busy} label={cu("contacts.addSubmit")} busyLabel={cu("adding")} onCancel={() => onClose()} />
    </ContactFormFrame>
  );
}

function EditContactForm({ customer, contact: k, onClose }: { customer: CustomerDTO; contact: CustomerContactDTO; onClose: (text?: string) => void }) {
  const id = useId();
  const qc = useQueryClient();
  const refresh = useRefresh(customer.id);
  const [values, setValues] = useState({ email: k.email, name: k.name ?? "", phone: k.phone ?? "" });
  const [errors, setErrors] = useState<ContactErrors>({});
  const [busy, setBusy] = useState(false);
  const set = (key: "name" | "phone", v: string) => {
    setValues((x) => ({ ...x, [key]: v }));
    setErrors((e) => ({ ...e, [key]: undefined, form: undefined }));
  };

  async function save() {
    const parsed = contactPatchSchema.safeParse({ name: values.name.trim() === "" ? null : values.name, phone: values.phone.trim() === "" ? null : values.phone });
    if (!parsed.success) {
      const errs = contactErrorsFrom(parsed.error.issues, values);
      setErrors(errs);
      firstContactError(id, errs);
      return;
    }
    const v = parsed.data;
    const patch = { ...((v.name ?? null) !== k.name ? { name: v.name ?? null } : {}), ...((v.phone ?? null) !== k.phone ? { phone: v.phone ?? null } : {}) };
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      await apiFetch(`/api/staff/customers/${customer.id}/contacts/${k.id}`, { method: "PATCH", body: patch });
      await refresh();
      onClose(cu("done.contactSaved", { email: k.email }));
    } catch (e) {
      setBusy(false);
      if (handleSignedOut(qc, e)) return;
      if (isApiError(e, 400, "invalid") && Array.isArray(e.details)) {
        const errs = { ...contactErrorsFrom(e.details as Issue[], values), form: cu("errors.invalid") };
        setErrors(errs);
        firstContactError(id, errs);
      } else {
        if (isApiError(e, 404)) void refresh();
        setErrors({ form: customerErrorText(e) });
      }
    }
  }

  return (
    <ContactFormFrame title={cu("contacts.editTitle", { email: k.email })} busy={busy} onCancel={() => onClose()} onSubmit={() => void save()}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextInput id={`${id}-name`} label={cu("contacts.name")} optional value={values.name} onChange={(v) => set("name", v)} error={errors.name} maxLength={LIMITS.contactName} />
        <TextInput id={`${id}-phone`} label={cu("contacts.phone")} optional type="tel" inputMode="tel" value={values.phone} onChange={(v) => set("phone", v)} error={errors.phone} maxLength={LIMITS.phone} />
      </div>
      <p className="text-sm text-slate-600 dark:text-slate-400">{cu("contacts.emailFixed")}</p>
      <div aria-live="polite" className="empty:mb-0">
        {errors.form && <Notice tone="error">{errors.form}</Notice>}
      </div>
      <FormButtons busy={busy} label={cu("save")} busyLabel={cu("saving")} onCancel={() => onClose()} />
    </ContactFormFrame>
  );
}

// ---- Recent reservations --------------------------------------------------------------------------------------------

function Reservations({ customer, list, tz, listSearch, className }: { customer: CustomerDTO; list: CustomerReservationSummaryDTO[]; tz: string; listSearch: string; className: string }) {
  const id = useId();
  const location = useLocation();
  // Coming back from the reservation keeps the way back to the same customer search.
  const state: CustomersBackState = { back: { to: location.pathname, label: customer.name, state: { listSearch } } };
  return (
    <section aria-labelledby={`${id}-title`} className={`min-w-0 space-y-3 ${className}`}>
      <div className="space-y-1">
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          {cu("recent.title")}
        </h2>
        {list.length > 0 && <TimezoneNote tz={tz} />}
      </div>
      {list.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 px-5 py-6 dark:border-slate-700">
          <p className="font-semibold">{cu("recent.empty")}</p>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{cu("recent.emptyBody")}</p>
        </div>
      ) : (
        <>
          <Card flush>
            <ul className="divide-y divide-slate-200 dark:divide-slate-800">
              {list.map((r) => (
                <li key={r.id}>
                  <Link
                    to={`/staff/r/${encodeURIComponent(r.id)}`}
                    state={state}
                    className="group flex items-start gap-3 px-4 py-3.5 first:rounded-t-2xl last:rounded-b-2xl hover:bg-slate-50 dark:hover:bg-slate-800/50"
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                        <StatusBadge status={r.status} />
                        <span className="font-mono text-sm text-slate-500 dark:text-slate-400">{r.ref}</span>
                      </div>
                      <p className="font-semibold">
                        {fmtDateWithYear(dateIn(r.startAt, tz))} · <span className="tabular-nums">{fmtTimeRange(r.startAt, r.endAt, tz)}</span>
                      </p>
                      <p className="text-sm break-words text-slate-600 dark:text-slate-400">{r.contactName}</p>
                    </div>
                    <svg className="mt-1 size-5 shrink-0 text-slate-400 group-hover:text-blue-700 dark:group-hover:text-blue-300" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
          {list.length >= CUSTOMER_RECENT_LIMIT && <p className="text-sm text-slate-600 dark:text-slate-400">{cu("recent.limited", { n: CUSTOMER_RECENT_LIMIT })}</p>}
        </>
      )}
    </section>
  );
}
