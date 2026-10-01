import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { z } from "zod";
import { staffCreateSchema } from "../../../../shared/schemas";
import type { StaffDTO } from "../../../../shared/types";
import { apiFetch, handleSignedOut, isApiError, queryKeys } from "../../../api";
import { Button } from "../../../components/Button";
import { Notice } from "../../../components/Card";
import { inputClass } from "../../../components/Field";
import { Switch } from "../../../components/Switch";
import { t } from "../../../i18n";
import { actionErrorText } from "../detail/shared";

export const tm = (key: string, params?: Record<string, string | number>) => t(`web.staff.team.${key}`, params);

/** Message for a failed team change; `what` says which rule a 409 "self" is about. */
export function teamErrorText(e: unknown, what: "deactivate" | "demote" = "deactivate"): string {
  if (isApiError(e, 409, "self")) return what === "demote" ? tm("errors.selfDemote") : tm("errors.selfDeactivate");
  if (isApiError(e, 409, "last_admin")) return tm("errors.lastAdmin");
  if (isApiError(e, 409, "email_taken")) return tm("errors.emailTaken");
  if (isApiError(e, 404)) return tm("errors.notFound");
  if (isApiError(e, 403)) return tm("errors.forbidden");
  if (isApiError(e, 400)) return tm("errors.invalid");
  return actionErrorText(e);
}

type Role = StaffDTO["role"];
type Errors = { name?: string; email?: string; form?: string };
type Issue = { path: PropertyKey[]; code: string };

/** Field errors from a schema (or the server's `invalid` details) for the add/edit forms. */
function fieldErrors(issues: readonly Issue[]): Errors {
  const out: Errors = {};
  for (const i of issues) {
    const f = String(i.path[0]);
    if (f === "name") out.name ??= i.code === "too_big" ? tm("errors.tooLong", { max: 100 }) : tm("errors.required");
    if (f === "email") out.email ??= i.code === "too_big" ? tm("errors.tooLong", { max: 254 }) : tm("errors.email");
  }
  return out;
}

const focusFirst = (id: string, errors: Errors) => document.getElementById(errors.name ? `${id}-name` : `${id}-email`)?.focus();

/**
 * Administrator / technician as two radio cards with what each may do. `adminOnly` locks the choice to administrator
 * and says why (your own role: someone else has to change it).
 */
function RoleChoice({ name, value, onChange, adminOnly }: { name: string; value: Role; onChange: (r: Role) => void; adminOnly?: string }) {
  const noteId = useId();
  return (
    <fieldset aria-describedby={adminOnly ? noteId : undefined}>
      <legend className="mb-1.5 font-medium">{tm("role")}</legend>
      {adminOnly && (
        <p id={noteId} className="mb-2 text-sm text-slate-600 dark:text-slate-400">
          {adminOnly}
        </p>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        {(["technician", "admin"] as const).map((r) => (
          <label
            key={r}
            className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-slate-300 bg-white px-4 py-2.5 has-checked:border-blue-700 has-checked:bg-blue-50 has-checked:ring-1 has-checked:ring-blue-700 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-blue-600 has-disabled:cursor-not-allowed has-disabled:opacity-60 dark:border-slate-600 dark:bg-slate-900 dark:has-checked:border-blue-400 dark:has-checked:bg-blue-400/10 dark:has-checked:ring-blue-400"
          >
            <input type="radio" name={name} checked={value === r} disabled={Boolean(adminOnly) && r !== "admin"} onChange={() => onChange(r)} className="mt-0.5 size-5 shrink-0 accent-blue-700 focus-visible:outline-none" />
            <span>
              <span className="block font-medium">{r === "admin" ? tm("roleAdmin") : tm("roleTechnician")}</span>
              <span className="block text-sm text-slate-600 dark:text-slate-400">{r === "admin" ? tm("roleAdminHint") : tm("roleTechnicianHint")}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function TextInput({ id, label, value, onChange, error, hint, type = "text", autoComplete }: { id: string; label: string; value: string; onChange: (v: string) => void; error?: string; hint?: string; type?: string; autoComplete?: string }) {
  const describedBy = [error && `${id}-error`, hint && `${id}-hint`].filter(Boolean).join(" ") || undefined;
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block font-medium">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        autoComplete={autoComplete}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy}
        className={`${inputClass} min-h-11 py-2.5`}
      />
      {error && (
        <p id={`${id}-error`} className="mt-1.5 text-sm font-medium text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
      {hint && (
        <p id={`${id}-hint`} className="mt-1.5 text-sm text-slate-600 dark:text-slate-400">
          {hint}
        </p>
      )}
    </div>
  );
}

/** The inline frame both forms share: labelled, Esc cancels (unless saving), first field focused on open. */
function FormFrame({ title, busy, onCancel, onSubmit, children }: { title: string; busy: boolean; onCancel: () => void; onSubmit: () => void; children: ReactNode }) {
  const id = useId();
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("input:not([disabled])")?.focus();
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
      className="space-y-4 rounded-2xl border border-blue-300 bg-blue-50/60 p-4 shadow-sm sm:p-5 dark:border-blue-400/40 dark:bg-blue-400/5"
    >
      <h2 id={id} className="text-lg font-semibold">
        {title}
      </h2>
      {children}
    </form>
  );
}

function Actions({ busy, label, busyLabel, onCancel }: { busy: boolean; label: string; busyLabel: string; onCancel: () => void }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:flex">
      <Button type="submit" loading={busy}>
        {busy ? busyLabel : label}
      </Button>
      <Button variant="secondary" disabled={busy} onClick={onCancel}>
        {tm("cancel")}
      </Button>
    </div>
  );
}

/** Add a team member: name, email, role, and whether they take bookings and get new-request emails. */
export function AddStaffForm({ onClose, onDone }: { onClose: () => void; onDone: (text: string, member: StaffDTO) => void }) {
  const id = useId();
  const qc = useQueryClient();
  const [form, setForm] = useState<z.input<typeof staffCreateSchema>>({ name: "", email: "", role: "technician", bookable: true, notify: true });
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    if (k === "name" || k === "email") setErrors((e) => ({ ...e, [k]: undefined }));
  };

  async function save() {
    const parsed = staffCreateSchema.safeParse(form);
    if (!parsed.success) {
      const errs = fieldErrors(parsed.error.issues);
      setErrors(errs);
      focusFirst(id, errs);
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      const { staff } = await apiFetch<{ staff: StaffDTO }>("/api/staff/team", { method: "POST", body: parsed.data });
      await qc.invalidateQueries({ queryKey: queryKeys.team });
      void qc.invalidateQueries({ queryKey: queryKeys.schedule });
      onDone(tm("done.created", { name: staff.name, email: staff.email }), staff);
    } catch (e) {
      if (handleSignedOut(qc, e)) return;
      if (isApiError(e, 409, "email_taken")) {
        setErrors({ email: tm("errors.emailTaken") });
        document.getElementById(`${id}-email`)?.focus();
      } else if (isApiError(e, 400, "invalid") && Array.isArray(e.details)) {
        const errs = fieldErrors(e.details as Issue[]);
        setErrors({ ...errs, form: tm("errors.invalid") });
        focusFirst(id, errs);
      } else setErrors({ form: teamErrorText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormFrame title={tm("addTitle")} busy={busy} onCancel={onClose} onSubmit={() => void save()}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextInput id={`${id}-name`} label={tm("name")} value={form.name} onChange={(v) => set("name", v)} error={errors.name} autoComplete="off" />
        <TextInput id={`${id}-email`} type="email" label={tm("email")} hint={tm("emailHint")} value={form.email} onChange={(v) => set("email", v)} error={errors.email} autoComplete="off" />
      </div>
      <RoleChoice name={`${id}-role`} value={form.role} onChange={(r) => set("role", r)} />
      <div className="grid gap-1 sm:grid-cols-2">
        <Switch checked={form.bookable} onChange={(v) => set("bookable", v)} label={tm("bookable")} hint={tm("bookableHint")} className="-mx-2 w-auto" />
        <Switch checked={form.notify} onChange={(v) => set("notify", v)} label={tm("notify")} hint={tm("notifyHint")} className="-mx-2 w-auto" />
      </div>
      <div aria-live="polite" className="empty:mb-0">
        {errors.form && <Notice tone="error">{errors.form}</Notice>}
      </div>
      <Actions busy={busy} label={tm("create")} busyLabel={tm("creating")} onCancel={onClose} />
    </FormFrame>
  );
}

/** Edit a member's name and role (email is their identity; switches handle the rest). */
export function EditStaffForm({ member, isSelf, onClose, onDone }: { member: StaffDTO; isSelf: boolean; onClose: () => void; onDone: (text: string) => void }) {
  const id = useId();
  const qc = useQueryClient();
  const [name, setName] = useState(member.name);
  const [role, setRole] = useState<Role>(member.role);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);

  async function save() {
    const parsed = staffCreateSchema.pick({ name: true }).safeParse({ name });
    if (!parsed.success) {
      const errs = fieldErrors(parsed.error.issues);
      setErrors(errs);
      focusFirst(id, errs);
      return;
    }
    const patch = { ...(parsed.data.name !== member.name ? { name: parsed.data.name } : {}), ...(role !== member.role ? { role } : {}) };
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      const { staff } = await apiFetch<{ staff: StaffDTO }>(`/api/staff/team/${member.id}`, { method: "PATCH", body: patch });
      await qc.invalidateQueries({ queryKey: queryKeys.team });
      void qc.invalidateQueries({ queryKey: queryKeys.schedule });
      // The signed-in admin's own name shows in the header.
      if (isSelf) void qc.invalidateQueries({ queryKey: queryKeys.me });
      onDone(tm("done.saved", { name: staff.name }));
    } catch (e) {
      if (handleSignedOut(qc, e)) return;
      if (isApiError(e, 404)) void qc.invalidateQueries({ queryKey: queryKeys.team });
      setErrors({ form: teamErrorText(e, "demote") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormFrame title={tm("editTitle", { name: member.name })} busy={busy} onCancel={onClose} onSubmit={() => void save()}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextInput
          id={`${id}-name`}
          label={tm("name")}
          value={name}
          onChange={(v) => {
            setName(v);
            setErrors((e) => ({ ...e, name: undefined }));
          }}
          error={errors.name}
          autoComplete="off"
        />
        <div>
          <p className="mb-1.5 font-medium">{tm("email")}</p>
          <p className="flex min-h-11 items-center break-all text-slate-700 dark:text-slate-300">{member.email}</p>
          <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-400">{tm("emailFixed")}</p>
        </div>
      </div>
      <RoleChoice name={`${id}-role`} value={role} onChange={setRole} adminOnly={isSelf && member.role === "admin" ? tm("errors.selfDemote") : undefined} />
      <div aria-live="polite" className="empty:mb-0">
        {errors.form && <Notice tone="error">{errors.form}</Notice>}
      </div>
      <Actions busy={busy} label={tm("save")} busyLabel={tm("saving")} onCancel={onClose} />
    </FormFrame>
  );
}
