import { useId, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import type { Settings } from "../../../../domain/settings";
import { settingsShape } from "../../../../shared/schemas";
import { apiFetch, queryKeys, useMe, type SettingsView } from "../../../api";
import { Button } from "../../../components/Button";
import { Notice } from "../../../components/Card";
import { PageHeading, usePageTitle } from "../../../components/Layout";
import { Skeleton } from "../../../components/Spinner";
import { Switch } from "../../../components/Switch";
import { Toast, useToast } from "../../../components/Toast";
import { TimezoneNote } from "../../../components/TimezoneNote";
import { fmtMinuteRange, fmtMinutes, fmtWeekday } from "../../../format";
import { t } from "../../../i18n";
import { BookingCard } from "../BookingCard";
import { useImpactFlow, type Submit } from "../schedule/ImpactDialog";
import { selectClass, TimeSelect } from "../schedule/shared";
import { WEEK } from "../schedule/WeeklyEditor";
import {
  CardNote,
  fieldId,
  fmtDuration,
  IntField,
  intText,
  plain,
  MinutesSelect,
  ReadValue,
  readInt,
  s,
  SaveBar,
  SectionCard,
  SectionForm,
  TextField,
  trimmed,
  useSection,
  type FieldErrors,
  type SectionSpec,
} from "./fields";
import { HolidaysEditor } from "./HolidaysEditor";

const SECTIONS = [
  ["org", "org.title"],
  ["booking", "booking.title"],
  ["appointments", "appointments.title"],
  ["window", "window.title"],
  ["hours", "hours.title"],
  ["holidays", null],
  ["approval", "approval.title"],
  ["reminders", "reminders.title"],
  ["reassign", "reassign.title"],
  ["rescheduling", "rescheduling.title"],
] as const;
const sectionTitle = (id: string, key: string | null) => (key ? s(key) : id === "holidays" ? t("web.staff.holidays.title") : id);

/** `/staff/settings` — every setting in cards that save on their own. Technicians see the values read-only. */
export default function SettingsPage() {
  usePageTitle(s("heading"));
  const me = useMe();
  const tz = me.data?.timezone ?? "UTC";
  const staff = me.data?.staff ?? null;
  const isAdmin = staff?.role === "admin";
  const { toast, show, dismiss } = useToast();
  const { submit, dialog } = useImpactFlow({ tz, onDone: show, refresh: [queryKeys.settings, queryKeys.me] });
  const q = useQuery({ queryKey: queryKeys.settings, queryFn: () => apiFetch<SettingsView>("/api/staff/settings") });

  const props = q.data ? { settings: q.data.settings, submit, readOnly: !isAdmin } : null;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <PageHeading>{s("heading")}</PageHeading>
        <p className="text-slate-600 dark:text-slate-400">{s("lead")}</p>
        <TimezoneNote tz={tz} />
        {staff && !isAdmin && <p className="pt-1 text-slate-600 dark:text-slate-400">{s("techNote")}</p>}
      </div>

      <div className="lg:grid lg:grid-cols-[11rem_minmax(0,1fr)] lg:items-start lg:gap-8">
        <Contents />
        <div className="space-y-6">
          {q.isPending ? (
            <div className="space-y-6" aria-busy="true">
              <span className="sr-only">{t("web.common.loading")}</span>
              <Skeleton className="h-64" />
              <Skeleton className="h-40" />
              <Skeleton className="h-64" />
            </div>
          ) : q.isError || !props ? (
            <Notice tone="error" className="flex flex-wrap items-center justify-between gap-3">
              {s("loadFailed")}
              <Button variant="secondary" onClick={() => void q.refetch()}>
                {t("web.common.retry")}
              </Button>
            </Notice>
          ) : (
            <>
              <OrgCard {...props} />
              <section id="booking" aria-label={s("booking.title")} className="scroll-mt-36">
                {me.data && <BookingCard enabled={me.data.bookingEnabled} isAdmin={isAdmin} />}
              </section>
              <AppointmentsCard {...props} />
              <WindowCard {...props} />
              <HoursCard {...props} />
              <SectionCard id="holidays" title={t("web.staff.holidays.title")} lead={<HolidaysLead />}>
                <HolidaysEditor tz={tz} canEdit={isAdmin} submit={submit} />
              </SectionCard>
              <ApprovalCard {...props} />
              <RemindersCard {...props} />
              <ReassignCard {...props} />
              <ReschedulingCard {...props} />
            </>
          )}
        </div>
      </div>

      {dialog}
      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}

function HolidaysLead() {
  return (
    <>
      <p>{t("web.staff.holidays.lead")}</p>
      <p className="mt-1 text-sm">{t("web.staff.holidays.precedence")}</p>
    </>
  );
}

/** Section links: a sticky list beside the cards on large screens, a disclosure above them otherwise. */
function Contents() {
  const links = (
    <ul className="space-y-0.5">
      {SECTIONS.map(([id, key]) => (
        <li key={id}>
          <a
            href={`#${id}`}
            className="flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-slate-700 hover:bg-slate-100 hover:text-slate-900 lg:min-h-9 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
          >
            {sectionTitle(id, key)}
          </a>
        </li>
      ))}
    </ul>
  );
  return (
    <>
      <nav aria-label={s("onThisPage")} className="hidden lg:sticky lg:top-36 lg:block">
        <p className="mb-2 px-3 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">{s("onThisPage")}</p>
        {links}
      </nav>
      <details className="group mb-6 rounded-2xl border border-slate-200 bg-white lg:hidden dark:border-slate-800 dark:bg-slate-900">
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-2 rounded-2xl px-4 font-medium [&::-webkit-details-marker]:hidden">
          {s("jumpTo")}
          <svg className="size-5 transition-transform group-open:rotate-180" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </summary>
        <nav aria-label={s("onThisPage")} className="border-t border-slate-200 px-2 py-2 dark:border-slate-800">
          {links}
        </nav>
      </details>
    </>
  );
}

interface CardProps {
  settings: Settings;
  submit: Submit;
  readOnly: boolean;
}

/** Wires a section spec to its card: form, fields (or read-only values) and the save bar. */
function EditableCard<D extends Record<string, unknown>>({
  id,
  title,
  lead,
  spec,
  settings,
  submit,
  readOnly,
  fields,
  values,
  note,
  badge,
}: CardProps & {
  id: string;
  title: string;
  /** May depend on whether the card has unsaved changes. */
  lead?: ReactNode | ((dirty: boolean) => ReactNode);
  spec: SectionSpec<D>;
  fields: (draft: D, update: (fn: (d: D) => D, ...fields: string[]) => void, errors: FieldErrors) => ReactNode;
  values: ReactNode;
  note?: ReactNode;
  badge?: ReactNode;
}) {
  const f = useSection(spec, settings, submit);
  if (readOnly) {
    return (
      <SectionCard id={id} title={title} lead={typeof lead === "function" ? lead(false) : lead} badge={badge}>
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">{values}</dl>
        {note}
      </SectionCard>
    );
  }
  return (
    <SectionForm onSubmit={() => void f.save()} busy={f.busy}>
      <SectionCard
        id={id}
        title={title}
        lead={typeof lead === "function" ? lead(f.dirty) : lead}
        badge={badge}
        headingRef={f.headingRef}
        footer={<SaveBar busy={f.busy} dirty={f.dirty} problem={f.problem} onSave={() => void f.save()} onDiscard={f.discard} />}
      >
        {fields(f.draft, f.update, f.errors)}
        {note}
      </SectionCard>
    </SectionForm>
  );
}

const maxLen = (k: keyof Settings) => (settingsShape[k] as unknown as { maxLength: number }).maxLength;

// ---- Organisation ------------------------------------------------------------------------------------------------

type OrgDraft = Pick<Settings, "orgName" | "supportPhone" | "remoteToolName" | "customerInstructions">;

function OrgCard(p: CardProps) {
  const spec: SectionSpec<OrgDraft> = {
    codecs: { orgName: trimmed, supportPhone: plain(), remoteToolName: trimmed, customerInstructions: plain() },
    summary: s("org.summary"),
    done: s("org.done"),
  };
  const st = p.settings;
  return (
    <EditableCard
      {...p}
      id="org"
      title={s("org.title")}
      lead={s("org.lead")}
      spec={spec}
      values={
        <>
          <ReadValue label={s("org.orgName")} value={st.orgName} />
          <ReadValue label={s("org.supportPhone")} value={st.supportPhone || s("notSet")} />
          <ReadValue label={s("org.remoteToolName")} value={st.remoteToolName} />
          <ReadValue label={s("org.customerInstructions")} value={<span className="whitespace-pre-line">{st.customerInstructions || s("notSet")}</span>} />
        </>
      }
      fields={(d, update, errors) => (
        <div className="grid gap-5 sm:grid-cols-2">
          <TextField field="orgName" label={s("org.orgName")} value={d.orgName} maxLength={maxLen("orgName")} error={errors.orgName} onChange={(v) => update((x) => ({ ...x, orgName: v }), "orgName")} autoComplete="organization" />
          <TextField
            field="supportPhone"
            type="tel"
            label={s("org.supportPhone")}
            hint={s("org.supportPhoneHint")}
            value={d.supportPhone}
            error={errors.supportPhone}
            onChange={(v) => update((x) => ({ ...x, supportPhone: v }), "supportPhone")}
          />
          <TextField
            field="remoteToolName"
            label={s("org.remoteToolName")}
            hint={s("org.remoteToolNameHint")}
            value={d.remoteToolName}
            error={errors.remoteToolName}
            onChange={(v) => update((x) => ({ ...x, remoteToolName: v }), "remoteToolName")}
          />
          <div className="sm:col-span-2">
            <TextField
              field="customerInstructions"
              multiline
              counter
              maxLength={maxLen("customerInstructions")}
              label={s("org.customerInstructions")}
              hint={s("org.customerInstructionsHint")}
              value={d.customerInstructions}
              error={errors.customerInstructions}
              onChange={(v) => update((x) => ({ ...x, customerInstructions: v }), "customerInstructions")}
            />
          </div>
        </div>
      )}
    />
  );
}

// ---- Appointments ------------------------------------------------------------------------------------------------

type ApptDraft = Pick<Settings, "durationMin" | "bufferBeforeMin" | "bufferAfterMin" | "slotStepMin">;

function AppointmentsCard(p: CardProps) {
  const spec: SectionSpec<ApptDraft> = {
    codecs: { durationMin: plain(), bufferBeforeMin: plain(), bufferAfterMin: plain(), slotStepMin: plain() },
    summary: s("appointments.summary"),
    done: s("appointments.done"),
  };
  const example = (d: ApptDraft) => {
    const start = 600;
    return s("appointments.example", { start: fmtMinutes(start), range: fmtMinuteRange(start - d.bufferBeforeMin, start + d.durationMin + d.bufferAfterMin) });
  };
  const st = p.settings;
  return (
    <EditableCard
      {...p}
      id="appointments"
      title={s("appointments.title")}
      lead={s("appointments.lead")}
      spec={spec}
      note={<CardNote>{s("capacityNote")}</CardNote>}
      values={
        <>
          <ReadValue label={s("appointments.durationMin")} value={fmtDuration(st.durationMin)} />
          <ReadValue label={s("appointments.slotStepMin")} value={fmtDuration(st.slotStepMin)} />
          <ReadValue label={s("appointments.bufferBeforeMin")} value={fmtDuration(st.bufferBeforeMin)} />
          <ReadValue label={s("appointments.bufferAfterMin")} value={fmtDuration(st.bufferAfterMin)} />
        </>
      }
      fields={(d, update, errors) => (
        <div className="space-y-4">
          <div className="grid gap-5 sm:grid-cols-2">
            <MinutesSelect field="durationMin" label={s("appointments.durationMin")} value={d.durationMin} from={5} to={480} error={errors.durationMin} onChange={(v) => update((x) => ({ ...x, durationMin: v }), "durationMin")} />
            <MinutesSelect
              field="slotStepMin"
              label={s("appointments.slotStepMin")}
              hint={s("appointments.slotStepHint")}
              value={d.slotStepMin}
              from={5}
              to={1440}
              error={errors.slotStepMin}
              onChange={(v) => update((x) => ({ ...x, slotStepMin: v }), "slotStepMin")}
            />
            <MinutesSelect field="bufferBeforeMin" label={s("appointments.bufferBeforeMin")} value={d.bufferBeforeMin} from={0} to={120} error={errors.bufferBeforeMin} onChange={(v) => update((x) => ({ ...x, bufferBeforeMin: v }), "bufferBeforeMin")} />
            <MinutesSelect
              field="bufferAfterMin"
              label={s("appointments.bufferAfterMin")}
              hint={s("appointments.bufferHint")}
              value={d.bufferAfterMin}
              from={0}
              to={120}
              error={errors.bufferAfterMin}
              onChange={(v) => update((x) => ({ ...x, bufferAfterMin: v }), "bufferAfterMin")}
            />
          </div>
          <p className="text-sm text-slate-700 tabular-nums dark:text-slate-300">{example(d)}</p>
        </div>
      )}
    />
  );
}

// ---- Booking window ----------------------------------------------------------------------------------------------

type WindowDraft = { minNoticeBh: string; bookingHorizonDays: string; cancelCutoffMin: string; maxActivePerAccount: number };

function WindowCard(p: CardProps) {
  const spec: SectionSpec<WindowDraft> = {
    codecs: { minNoticeBh: intText, bookingHorizonDays: intText, cancelCutoffMin: intText, maxActivePerAccount: plain() },
    summary: s("window.summary"),
    done: s("window.done"),
  };
  const st = p.settings;
  const cutoff = (raw: string) => {
    const n = readInt(raw);
    return n === null ? "–" : fmtDuration(n);
  };
  return (
    <EditableCard
      {...p}
      id="window"
      title={s("window.title")}
      lead={s("window.lead")}
      spec={spec}
      note={<CardNote>{s("capacityNote")}</CardNote>}
      values={
        <>
          <ReadValue label={s("window.minNoticeBh")} value={`${st.minNoticeBh} ${s("units.bh")}`} />
          <ReadValue label={s("window.bookingHorizonDays")} value={`${st.bookingHorizonDays} ${s("units.days")}`} />
          <ReadValue label={s("window.cancelCutoffMin")} value={fmtDuration(st.cancelCutoffMin)} />
          <ReadValue label={s("window.maxActivePerAccount")} value={st.maxActivePerAccount} />
        </>
      }
      fields={(d, update, errors) => (
        <div className="grid gap-5 sm:grid-cols-2">
          <IntField field="minNoticeBh" label={s("window.minNoticeBh")} unit={s("units.bh")} hint={s("window.minNoticeHint")} value={d.minNoticeBh} error={errors.minNoticeBh} onChange={(v) => update((x) => ({ ...x, minNoticeBh: v }), "minNoticeBh")} />
          <IntField
            field="bookingHorizonDays"
            label={s("window.bookingHorizonDays")}
            unit={s("units.days")}
            hint={s("window.bookingHorizonHint")}
            value={d.bookingHorizonDays}
            error={errors.bookingHorizonDays}
            onChange={(v) => update((x) => ({ ...x, bookingHorizonDays: v }), "bookingHorizonDays")}
          />
          <IntField
            field="cancelCutoffMin"
            label={s("window.cancelCutoffMin")}
            unit={s("units.minutes")}
            hint={s("window.cancelCutoffHint", { duration: cutoff(d.cancelCutoffMin) })}
            value={d.cancelCutoffMin}
            error={errors.cancelCutoffMin}
            onChange={(v) => update((x) => ({ ...x, cancelCutoffMin: v }), "cancelCutoffMin")}
          />
          <div>
            <label htmlFor={fieldId("maxActivePerAccount")} className="mb-1.5 block font-medium">
              {s("window.maxActivePerAccount")}
            </label>
            <select
              id={fieldId("maxActivePerAccount")}
              value={d.maxActivePerAccount}
              onChange={(e) => update((x) => ({ ...x, maxActivePerAccount: Number(e.target.value) }), "maxActivePerAccount")}
              aria-invalid={Boolean(errors.maxActivePerAccount)}
              aria-describedby={`${errors.maxActivePerAccount ? `${fieldId("maxActivePerAccount")}-error ` : ""}${fieldId("maxActivePerAccount")}-hint`}
              className={`${selectClass} max-w-40`}
            >
              {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            {errors.maxActivePerAccount && (
              <p id={`${fieldId("maxActivePerAccount")}-error`} className="mt-1.5 text-sm font-medium text-red-700 dark:text-red-400">
                {errors.maxActivePerAccount}
              </p>
            )}
            <p id={`${fieldId("maxActivePerAccount")}-hint`} className="mt-1.5 text-sm text-slate-600 dark:text-slate-400">
              {s("window.maxActiveHint")}
            </p>
          </div>
        </div>
      )}
    />
  );
}

// ---- Business hours ----------------------------------------------------------------------------------------------

type Day = { open: boolean; start: number; end: number };

function HoursCard(p: CardProps) {
  const spec: SectionSpec<{ businessHours: Day[] }> = {
    codecs: {
      businessHours: {
        // A closed day keeps the last times shown, so switching it back on restores them.
        toRaw: (v) => (v as Settings["businessHours"]).map((h) => (h ? { open: true, start: h.start, end: h.end } : { open: false, start: 540, end: 1080 })),
        fromRaw: (days) => ({ value: days.map((x) => (x.open ? { start: x.start, end: x.end } : null)) }),
      },
    },
    summary: s("hours.summary"),
    done: s("hours.done"),
  };
  // Following the link would drop unsaved hours: it waits until they are saved or discarded.
  const lead = (dirty: boolean) => (
    <>
      {s("hours.lead")}{" "}
      {dirty ? (
        <span className="text-sm">{s("hours.scheduleLinkLater")}</span>
      ) : (
        <Link to="/staff/schedule" className="font-medium text-blue-700 underline underline-offset-2 dark:text-blue-300">
          {s("hours.scheduleLink")}
        </Link>
      )}
    </>
  );
  const st = p.settings;
  return (
    <EditableCard
      {...p}
      id="hours"
      title={s("hours.title")}
      lead={lead}
      spec={spec}
      values={WEEK.map((day) => {
        const h = st.businessHours[day];
        return <ReadValue key={day} label={fmtWeekday(day)} value={h ? fmtMinuteRange(h.start, h.end) : s("hours.closed")} />;
      })}
      fields={(d, update, errors) => (
        <ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {WEEK.map((day) => (
            <li key={day}>
              <DayRow
                day={day}
                value={d.businessHours[day]!}
                error={errors[`businessHours.${day}`]}
                onChange={(next) => update((x) => ({ businessHours: x.businessHours.map((v, i) => (i === day ? next : v)) }), `businessHours.${day}`)}
              />
            </li>
          ))}
        </ul>
      )}
    />
  );
}

function DayRow({ day, value, error, onChange }: { day: number; value: Day; error?: string; onChange: (d: Day) => void }) {
  const id = fieldId(`businessHours.${day}`);
  const errorId = `${id}-error`;
  return (
    <div className="grid gap-x-4 gap-y-2 py-3 sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-center">
      <Switch
        id={value.open ? undefined : id}
        checked={value.open}
        onChange={(open) => onChange({ ...value, open })}
        label={<span>{fmtWeekday(day)}</span>}
        hint={value.open ? s("hours.open") : s("hours.closed")}
        className="-mx-2 w-auto"
      />
      {value.open ? (
        <div role="group" aria-label={fmtWeekday(day)}>
          <div className="grid max-w-sm grid-cols-2 gap-3">
            <TimeSelect id={id} label={s("hours.opens")} value={value.start} onChange={(start) => onChange({ ...value, start })} invalid={Boolean(error)} describedBy={error ? errorId : undefined} />
            <TimeSelect id={`${id}-end`} label={s("hours.closes")} value={value.end} end onChange={(end) => onChange({ ...value, end })} invalid={Boolean(error)} describedBy={error ? errorId : undefined} />
          </div>
          {error && (
            <p id={errorId} className="mt-1.5 text-sm font-medium text-red-700 dark:text-red-400">
              {error}
            </p>
          )}
        </div>
      ) : (
        <p className="hidden text-slate-500 sm:block dark:text-slate-400">{s("hours.closed")}</p>
      )}
    </div>
  );
}

// ---- Approval deadlines ------------------------------------------------------------------------------------------

type ApprovalDraft = Record<"approvalReminderBh" | "approvalEscalationBh" | "approvalExpiryBh" | "expiryBeforeStartMin", string>;

function ApprovalCard(p: CardProps) {
  const spec: SectionSpec<ApprovalDraft> = {
    codecs: { approvalReminderBh: intText, approvalEscalationBh: intText, approvalExpiryBh: intText, expiryBeforeStartMin: intText },
    summary: s("approval.summary"),
    done: s("approval.done"),
  };
  const st = p.settings;
  return (
    <EditableCard
      {...p}
      id="approval"
      title={s("approval.title")}
      lead={s("approval.lead")}
      spec={spec}
      values={
        <>
          <ReadValue label={s("approval.approvalReminderBh")} value={`${st.approvalReminderBh} ${s("units.bh")}`} />
          <ReadValue label={s("approval.approvalEscalationBh")} value={`${st.approvalEscalationBh} ${s("units.bh")}`} />
          <ReadValue label={s("approval.approvalExpiryBh")} value={`${st.approvalExpiryBh} ${s("units.bh")}`} />
          <ReadValue label={s("approval.expiryBeforeStartMin")} value={fmtDuration(st.expiryBeforeStartMin)} />
        </>
      }
      fields={(d, update, errors) => (
        <div className="space-y-5">
          <Timeline reminder={d.approvalReminderBh} escalation={d.approvalEscalationBh} expiry={d.approvalExpiryBh} />
          <div className="grid gap-5 sm:grid-cols-3 sm:items-end">
            {(["approvalReminderBh", "approvalEscalationBh", "approvalExpiryBh"] as const).map((k) => (
              <IntField key={k} field={k} label={s(`approval.${k}`)} unit={s("units.bh")} value={d[k]} error={errors[k]} onChange={(v) => update((x) => ({ ...x, [k]: v }), k)} />
            ))}
          </div>
          <IntField
            field="expiryBeforeStartMin"
            label={s("approval.expiryBeforeStartMin")}
            unit={s("units.minutes")}
            hint={s("approval.expiryBeforeStartHint")}
            value={d.expiryBeforeStartMin}
            error={errors.expiryBeforeStartMin}
            onChange={(v) => update((x) => ({ ...x, expiryBeforeStartMin: v }), "expiryBeforeStartMin")}
          />
        </div>
      )}
    />
  );
}

/** The three deadlines in order, as they follow a request. */
function Timeline({ reminder, escalation, expiry }: { reminder: string; escalation: string; expiry: string }) {
  const steps = [s("approval.stepIn"), s("approval.stepReminder", { n: reminder || "–" }), s("approval.stepEscalation", { n: escalation || "–" }), s("approval.stepExpiry", { n: expiry || "–" })];
  return (
    <ol aria-label={s("approval.timeline")} className="flex flex-col gap-2 text-sm sm:flex-row sm:items-center sm:gap-0">
      {steps.map((step, i) => (
        <li key={i} className="flex items-center gap-2 sm:flex-1">
          <span className={`size-2.5 shrink-0 rounded-full ${i === steps.length - 1 ? "bg-red-600" : i === 0 ? "bg-slate-400" : "bg-amber-500"}`} aria-hidden="true" />
          <span className="font-medium tabular-nums">{step}</span>
          {i < steps.length - 1 && <span className="mx-2 hidden h-px flex-1 bg-slate-300 sm:block dark:bg-slate-700" aria-hidden="true" />}
        </li>
      ))}
    </ol>
  );
}

// ---- Reminders ---------------------------------------------------------------------------------------------------

const REMINDER_PRESETS = [15, 30, 60, 120, 180, 360, 720, 1440, 2880, 4320, 10080];
const MAX_REMINDERS = 3;

function RemindersCard(p: CardProps) {
  const spec: SectionSpec<{ customerReminderOffsetsMin: number[] }> = {
    codecs: { customerReminderOffsetsMin: { toRaw: (v) => [...(v as number[])].sort((a, b) => b - a), fromRaw: (r) => ({ value: r }) } },
    summary: s("reminders.summary"),
    done: s("reminders.done"),
  };
  return (
    <EditableCard
      {...p}
      id="reminders"
      title={s("reminders.title")}
      lead={s("reminders.lead")}
      spec={spec}
      values={
        <ReadValue
          label={s("reminders.listLabel")}
          value={p.settings.customerReminderOffsetsMin.length === 0 ? s("reminders.none") : [...p.settings.customerReminderOffsetsMin].sort((a, b) => b - a).map((m) => s("reminders.before", { duration: fmtDuration(m) })).join(" · ")}
        />
      }
      fields={(d, update, errors) => <ReminderChips value={d.customerReminderOffsetsMin} error={errors.customerReminderOffsetsMin} onChange={(v) => update(() => ({ customerReminderOffsetsMin: v }), "customerReminderOffsetsMin")} />}
    />
  );
}

function ReminderChips({ value, error, onChange }: { value: number[]; error?: string; onChange: (v: number[]) => void }) {
  const id = fieldId("customerReminderOffsetsMin");
  const listId = useId();
  const available = REMINDER_PRESETS.filter((m) => !value.includes(m));
  const [choice, setChoice] = useState<number>(available[0] ?? 60);
  const chosen = available.includes(choice) ? choice : (available[0] ?? 60);
  const add = () => onChange([...value, chosen].sort((a, b) => b - a));
  const remove = (m: number) => {
    onChange(value.filter((x) => x !== m));
    // The chip is gone; keep focus in the field.
    requestAnimationFrame(() => document.getElementById(id)?.focus());
  };
  return (
    <div className="space-y-3">
      <p id={listId} className="font-medium">
        {s("reminders.listLabel")}
      </p>
      {value.length === 0 ? (
        <p className="text-slate-600 dark:text-slate-400">{s("reminders.none")}</p>
      ) : (
        <ul aria-labelledby={listId} className="flex flex-wrap gap-2">
          {value.map((m) => (
            <li key={m} className="inline-flex min-h-11 items-center gap-0.5 rounded-full border border-blue-300 bg-blue-50 pl-4 font-medium text-blue-900 dark:border-blue-400/40 dark:bg-blue-400/10 dark:text-blue-100">
              {s("reminders.before", { duration: fmtDuration(m) })}
              <button
                type="button"
                onClick={() => remove(m)}
                className="grid size-11 place-items-center rounded-full hover:bg-blue-100 dark:hover:bg-blue-400/20"
                aria-label={s("reminders.remove", { duration: fmtDuration(m) })}
              >
                <svg className="size-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
      {value.length < MAX_REMINDERS ? (
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor={id} className="mb-1.5 block text-sm font-medium">
              {s("reminders.addLabel")}
            </label>
            <select
              id={id}
              value={chosen}
              onChange={(e) => setChoice(Number(e.target.value))}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? `${id}-error` : undefined}
              className={`${selectClass} min-w-44`}
            >
              {available.map((m) => (
                <option key={m} value={m}>
                  {s("reminders.before", { duration: fmtDuration(m) })}
                </option>
              ))}
            </select>
          </div>
          <Button variant="secondary" onClick={add} disabled={available.length === 0}>
            {s("reminders.addButton")}
          </Button>
        </div>
      ) : (
        <p id={id} tabIndex={-1} className="text-sm text-slate-600 outline-none dark:text-slate-400">
          {s("reminders.max")}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-sm font-medium text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

function Soon() {
  return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-300">{s("comingSoon")}</span>;
}

// ---- Reassignment ------------------------------------------------------------------------------------------------

function ReassignCard(p: CardProps) {
  const spec: SectionSpec<{ notifyCustomerOnReassign: boolean }> = {
    codecs: { notifyCustomerOnReassign: plain() },
    summary: s("reassign.summary"),
    done: s("reassign.done"),
  };
  return (
    <EditableCard
      {...p}
      id="reassign"
      title={s("reassign.title")}
      spec={spec}
      values={<ReadValue label={s("reassign.notifyCustomerOnReassign")} value={p.settings.notifyCustomerOnReassign ? s("on") : s("off")} />}
      fields={(d, update) => (
        <Switch
          id={fieldId("notifyCustomerOnReassign")}
          checked={d.notifyCustomerOnReassign}
          onChange={(v) => update(() => ({ notifyCustomerOnReassign: v }), "notifyCustomerOnReassign")}
          label={s("reassign.notifyCustomerOnReassign")}
          hint={s("reassign.notifyHint")}
          className="-mx-2 w-[calc(100%+1rem)]"
        />
      )}
    />
  );
}

// ---- Rescheduling ------------------------------------------------------------------------------------------------

type RescheduleDraft = Record<"proposalExpiryBh" | "proposalExpiryBeforeStartMin", string>;

function ReschedulingCard(p: CardProps) {
  const spec: SectionSpec<RescheduleDraft> = {
    codecs: { proposalExpiryBh: intText, proposalExpiryBeforeStartMin: intText },
    summary: s("rescheduling.summary"),
    done: s("rescheduling.done"),
  };
  const st = p.settings;
  return (
    <EditableCard
      {...p}
      id="rescheduling"
      title={s("rescheduling.title")}
      badge={<Soon />}
      lead={s("rescheduling.lead")}
      spec={spec}
      note={<CardNote tone="soon">{s("rescheduling.note")}</CardNote>}
      values={
        <>
          <ReadValue label={s("rescheduling.proposalExpiryBh")} value={`${st.proposalExpiryBh} ${s("units.bh")}`} />
          <ReadValue label={s("rescheduling.proposalExpiryBeforeStartMin")} value={fmtDuration(st.proposalExpiryBeforeStartMin)} />
        </>
      }
      fields={(d, update, errors) => (
        <div className="grid gap-5 sm:grid-cols-2">
          <IntField field="proposalExpiryBh" label={s("rescheduling.proposalExpiryBh")} unit={s("units.bh")} value={d.proposalExpiryBh} error={errors.proposalExpiryBh} onChange={(v) => update((x) => ({ ...x, proposalExpiryBh: v }), "proposalExpiryBh")} />
          <IntField
            field="proposalExpiryBeforeStartMin"
            label={s("rescheduling.proposalExpiryBeforeStartMin")}
            unit={s("units.minutes")}
            value={d.proposalExpiryBeforeStartMin}
            error={errors.proposalExpiryBeforeStartMin}
            onChange={(v) => update((x) => ({ ...x, proposalExpiryBeforeStartMin: v }), "proposalExpiryBeforeStartMin")}
          />
        </div>
      )}
    />
  );
}
