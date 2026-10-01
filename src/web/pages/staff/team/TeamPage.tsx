import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { StaffDTO } from "../../../../shared/types";
import { apiFetch, handleSignedOut, isApiError, queryKeys, useMe, type Previewed, type TeamList } from "../../../api";
import { Button } from "../../../components/Button";
import { Notice } from "../../../components/Card";
import { focusWhenReady } from "../../../components/Dialog";
import { PageHeading, usePageTitle } from "../../../components/Layout";
import { Skeleton } from "../../../components/Spinner";
import { Switch } from "../../../components/Switch";
import { Toast, useToast } from "../../../components/Toast";
import { t } from "../../../i18n";
import { useImpactFlow, type ChangeRequest, type Submit } from "../schedule/ImpactDialog";
import { AddStaffForm, EditStaffForm, teamErrorText, tm } from "./StaffEditor";

const byName = (a: StaffDTO, b: StaffDTO) => a.name.localeCompare(b.name) || a.id - b.id;

/** `/staff/team` — who is on the team. Administrators add and change members; technicians see the list. */
export default function TeamPage() {
  usePageTitle(tm("heading"));
  const me = useMe();
  const tz = me.data?.timezone ?? "UTC";
  const myId = me.data?.staff?.id ?? null;
  const isAdmin = me.data?.staff?.role === "admin";
  const { toast, show, dismiss } = useToast();
  const { submit, dialog } = useImpactFlow({ tz, onDone: show, refresh: [queryKeys.team] });
  const q = useQuery({ queryKey: queryKeys.team, queryFn: () => apiFetch<TeamList>("/api/staff/team") });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const restoreFocus = useRef<string | null>(null);

  useEffect(() => {
    if (!adding && editing === null && restoreFocus.current) {
      document.getElementById(restoreFocus.current)?.focus();
      restoreFocus.current = null;
    }
  }, [adding, editing]);

  const members = q.data ? [...q.data.staff.filter((m) => m.active).sort(byName), ...q.data.staff.filter((m) => !m.active).sort(byName)] : [];
  const active = members.filter((m) => m.active);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <PageHeading>{tm("heading")}</PageHeading>
          <p className="text-slate-600 dark:text-slate-400">{tm("lead")}</p>
          {q.data && (
            <p className="text-sm text-slate-600 dark:text-slate-400">
              {tm("counts", { total: members.length, active: active.length, bookable: active.filter((m) => m.bookable).length })}
            </p>
          )}
          {me.data?.staff && !isAdmin && <p className="pt-1 text-slate-600 dark:text-slate-400">{tm("techNote")}</p>}
        </div>
        {isAdmin && !adding && (
          <Button id="add-member" onClick={() => setAdding(true)} disabled={editing !== null}>
            <svg className="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            {tm("add")}
          </Button>
        )}
      </div>

      {adding && (
        <AddStaffForm
          onClose={() => {
            restoreFocus.current = "add-member";
            setAdding(false);
          }}
          onDone={(text, member) => {
            show(text);
            restoreFocus.current = `member-${member.id}-edit`;
            setAdding(false);
          }}
        />
      )}

      {q.isPending ? (
        <div className="space-y-3" aria-busy="true">
          <span className="sr-only">{t("web.common.loading")}</span>
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      ) : q.isError ? (
        <Notice tone="error" className="flex flex-wrap items-center justify-between gap-3">
          {tm("loadFailed")}
          <Button variant="secondary" onClick={() => void q.refetch()}>
            {t("web.common.retry")}
          </Button>
        </Notice>
      ) : (
        <ul className="space-y-3" aria-label={tm("listLabel")}>
          {members.map((m) =>
            editing === m.id ? (
              <li key={m.id}>
                <EditStaffForm
                  member={m}
                  isSelf={m.id === myId}
                  onClose={() => {
                    restoreFocus.current = `member-${m.id}-edit`;
                    setEditing(null);
                  }}
                  onDone={(text) => {
                    show(text);
                    restoreFocus.current = `member-${m.id}-edit`;
                    setEditing(null);
                  }}
                />
              </li>
            ) : (
              <li key={m.id}>
                <MemberRow m={m} isSelf={m.id === myId} canEdit={isAdmin} formOpen={adding || editing !== null} onEdit={() => setEditing(m.id)} submit={submit} onDone={show} />
              </li>
            ),
          )}
        </ul>
      )}

      {dialog}
      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

function Badge({ tone, children }: { tone: "admin" | "tech" | "inactive" | "plain"; children: string }) {
  const cls = {
    admin: "bg-violet-100 text-violet-900 ring-violet-300 dark:bg-violet-400/15 dark:text-violet-200 dark:ring-violet-400/40",
    tech: "bg-slate-100 text-slate-700 ring-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-600",
    inactive: "bg-zinc-200 text-zinc-800 ring-zinc-300 dark:bg-zinc-700 dark:text-zinc-100 dark:ring-zinc-600",
    plain: "bg-green-100 text-green-900 ring-green-300 dark:bg-green-400/15 dark:text-green-200 dark:ring-green-400/40",
  }[tone];
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${cls}`}>{children}</span>;
}

type Field = "bookable" | "notify" | "active";

/** A team member: who they are, and (for administrators) switches for bookings, emails and access. */
function MemberRow({
  m,
  isSelf,
  canEdit,
  formOpen,
  onEdit,
  submit,
  onDone,
}: {
  m: StaffDTO;
  isSelf: boolean;
  canEdit: boolean;
  formOpen: boolean;
  onEdit: () => void;
  submit: Submit;
  onDone: (text: string) => void;
}) {
  const qc = useQueryClient();
  const id = useId();
  const [busy, setBusy] = useState<Field | null>(null);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const switchId = (f: Field) => `member-${m.id}-${f}`;
  const focusSwitch = (f: Field) => focusWhenReady(() => document.getElementById(switchId(f)));

  useEffect(() => {
    if (asking) keepRef.current?.focus();
  }, [asking]);

  async function setNotify(notify: boolean) {
    setBusy("notify");
    setProblem(null);
    try {
      await apiFetch(`/api/staff/team/${m.id}`, { method: "PATCH", body: { notify } });
      await qc.invalidateQueries({ queryKey: queryKeys.team });
      onDone(tm(notify ? "done.notifyOn" : "done.notifyOff", { name: m.name }));
    } catch (e) {
      if (handleSignedOut(qc, e)) return;
      if (isApiError(e, 404)) void qc.invalidateQueries({ queryKey: queryKeys.team });
      setProblem(teamErrorText(e));
    } finally {
      setBusy(null);
    }
  }

  /** Bookable and active change capacity: preview, and review the impact when bookings are affected. */
  async function setCapacity(field: "bookable" | "active", value: boolean) {
    setBusy(field);
    setProblem(null);
    const body = { [field]: value };
    const texts =
      field === "bookable"
        ? { summary: tm(value ? "summary.bookableOn" : "summary.bookableOff", { name: m.name }), done: tm(value ? "done.bookableOn" : "done.bookableOff", { name: m.name }) }
        : { summary: tm(value ? "summary.activate" : "summary.deactivate", { name: m.name }), done: tm(value ? "done.activated" : "done.deactivated", { name: m.name }) };
    const req: ChangeRequest = {
      ...texts,
      preview: () => apiFetch<Previewed>(`/api/staff/team/${m.id}/preview`, { method: "POST", body }),
      apply: (version) => apiFetch(`/api/staff/team/${m.id}/apply`, { method: "POST", body: { ...body, version } }),
      onApplied: () => {
        setAsking(false);
        focusSwitch(field);
      },
      errorText: (e) => teamErrorText(e),
    };
    const result = await submit(req);
    setBusy(null);
    if (result.status === "failed") {
      setAsking(false);
      setProblem(result.message);
      focusSwitch(field);
    }
  }

  const stopAsking = () => {
    setAsking(false);
    focusSwitch("active");
  };

  return (
    <article
      aria-labelledby={`${id}-name`}
      className={`rounded-2xl border p-4 sm:p-5 ${m.active ? "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900" : "border-dashed border-slate-300 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/50"}`}
    >
      <div className="flex items-start gap-3">
        <span
          className={`grid size-10 shrink-0 place-items-center rounded-full text-sm font-bold ${m.active ? "bg-blue-100 text-blue-800 dark:bg-blue-400/20 dark:text-blue-200" : "bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-400"}`}
          aria-hidden="true"
        >
          {initials(m.name)}
        </span>
        <div className="min-w-0 flex-1">
          <h3 id={`${id}-name`} className="flex flex-wrap items-center gap-x-2 gap-y-1 font-semibold">
            <span className="break-words">
              {m.name}
              {isSelf && <span className="font-normal text-slate-500 dark:text-slate-400"> ({tm("you")})</span>}
            </span>
            <Badge tone={m.role === "admin" ? "admin" : "tech"}>{m.role === "admin" ? tm("admin") : tm("technician")}</Badge>
            {!m.active && <Badge tone="inactive">{tm("inactive")}</Badge>}
          </h3>
          <p className="text-sm break-all text-slate-600 dark:text-slate-400">{m.email}</p>
          {!canEdit && (
            <ul className="mt-2 flex flex-wrap gap-1.5 text-sm">
              {m.active && m.bookable && (
                <li>
                  <Badge tone="plain">{tm("bookable")}</Badge>
                </li>
              )}
              {m.notify && (
                <li>
                  <Badge tone="tech">{tm("notify")}</Badge>
                </li>
              )}
              {!m.active && <li className="text-slate-600 dark:text-slate-400">{tm("inactiveHint")}</li>}
            </ul>
          )}
        </div>
        {canEdit && (
          <Button id={`member-${m.id}-edit`} variant="ghost" onClick={onEdit} disabled={formOpen || busy !== null || asking} className="-mt-1 -mr-2 shrink-0">
            {tm("edit")}
            <span className="sr-only"> {m.name}</span>
          </Button>
        )}
      </div>

      {canEdit && (
        <div role="group" aria-labelledby={`${id}-name`} className="mt-3 grid gap-1 border-t border-slate-200 pt-3 sm:grid-cols-3 dark:border-slate-800">
          <Switch
            id={switchId("bookable")}
            checked={m.bookable}
            busy={busy === "bookable"}
            disabled={busy !== null && busy !== "bookable"}
            onChange={(v) => void setCapacity("bookable", v)}
            label={tm("bookable")}
            className="-mx-2 w-auto"
          />
          <Switch
            id={switchId("notify")}
            checked={m.notify}
            busy={busy === "notify"}
            disabled={busy !== null && busy !== "notify"}
            onChange={(v) => void setNotify(v)}
            label={tm("notify")}
            className="-mx-2 w-auto"
          />
          <Switch
            id={switchId("active")}
            checked={m.active}
            busy={busy === "active"}
            // Your own access can only be ended by another administrator: locked, with the reason shown.
            disabled={isSelf || (busy !== null && busy !== "active") || asking}
            onChange={(v) => (v ? void setCapacity("active", true) : setAsking(true))}
            label={tm("active")}
            hint={isSelf ? tm("selfActive") : m.active ? undefined : tm("inactiveHint")}
            className="-mx-2 w-auto"
          />
        </div>
      )}

      <div aria-live="polite" className="empty:mb-0">
        {problem && (
          <Notice tone="error" className="mt-3">
            {problem}
          </Notice>
        )}
      </div>

      {canEdit && asking && (
        <div
          role="group"
          aria-labelledby={`${id}-ask`}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              if (busy === null) stopAsking();
            }
          }}
          className="mt-3 space-y-3 rounded-xl border border-red-300 bg-red-50/60 p-3 dark:border-red-400/40 dark:bg-red-400/5"
        >
          <p id={`${id}-ask`} className="text-sm font-medium">
            {tm("deactivateAsk", { name: m.name })}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="danger" loading={busy === "active"} onClick={() => void setCapacity("active", false)}>
              {busy === "active" ? tm("working") : tm("deactivateConfirm")}
            </Button>
            <Button ref={keepRef} variant="secondary" disabled={busy !== null} onClick={stopAsking}>
              {tm("keepActive")}
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}
