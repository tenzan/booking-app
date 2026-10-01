import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { apiFetch, queryKeys, useMe, type Holiday, type ScheduleWindows } from "../../../api";
import { Button } from "../../../components/Button";
import { Notice } from "../../../components/Card";
import { PageHeading, usePageTitle } from "../../../components/Layout";
import { Skeleton } from "../../../components/Spinner";
import { Toast, useToast } from "../../../components/Toast";
import { TimezoneNote } from "../../../components/TimezoneNote";
import { todayIn } from "../../../format";
import { t } from "../../../i18n";
import { useImpactFlow } from "./ImpactDialog";
import { OverridesEditor } from "./OverridesEditor";
import { k } from "./shared";
import { UnavailabilityEditor } from "./UnavailabilityEditor";
import { WeeklyEditor } from "./WeeklyEditor";

const TABS = ["weekly", "dates", "time-off"] as const;
type Tab = (typeof TABS)[number];
const asTab = (s: string | null): Tab => ((TABS as readonly (string | null)[]).includes(s) ? (s as Tab) : "weekly");

/** `/staff/schedule[?tab=weekly|dates|time-off]` — when the team works. Everyone can look; admins change it. */
export default function SchedulePage() {
  usePageTitle(k("heading"));
  const me = useMe();
  const tz = me.data?.timezone ?? "UTC";
  const staff = me.data?.staff ?? null;
  const isAdmin = staff?.role === "admin";
  const myId = staff?.id ?? null;
  const today = todayIn(tz);
  const [params, setParams] = useSearchParams();
  const tab = asTab(params.get("tab"));
  const { toast, show, dismiss } = useToast();
  const { submit, dialog } = useImpactFlow({ tz, onDone: show });

  const windows = useQuery({
    queryKey: queryKeys.scheduleWindows,
    queryFn: () => apiFetch<ScheduleWindows>("/api/staff/schedule/windows"),
  });
  // This year's and next year's holidays, so the date list covers the months ahead.
  const year = Number(today.slice(0, 4));
  const holidaysNow = useQuery({ queryKey: queryKeys.holidays(year), queryFn: () => apiFetch<Holiday[]>(`/api/staff/holidays?year=${year}`) });
  const holidaysNext = useQuery({ queryKey: queryKeys.holidays(year + 1), queryFn: () => apiFetch<Holiday[]>(`/api/staff/holidays?year=${year + 1}`) });
  const holidays = [...(holidaysNow.data ?? []), ...(holidaysNext.data ?? [])];

  const select = (next: Tab) => setParams(next === "weekly" ? {} : { tab: next }, { replace: true });

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <PageHeading>{k("heading")}</PageHeading>
        <TimezoneNote tz={tz} />
        {!isAdmin && staff && <p className="pt-1 text-slate-600 dark:text-slate-400">{k("techNote")}</p>}
      </div>

      <Tabs tab={tab} onSelect={select}>
        {(panelProps) => (
          <div {...panelProps} className="outline-none">
            {tab === "time-off" ? (
              windows.data || windows.isError ? (
                <UnavailabilityEditor staff={windows.data?.staff ?? []} isAdmin={isAdmin} myId={myId} tz={tz} today={today} submit={submit} />
              ) : (
                <Loading />
              )
            ) : windows.isPending ? (
              <Loading />
            ) : windows.isError ? (
              <Notice tone="error" className="flex flex-wrap items-center justify-between gap-3">
                {k("loadFailed")}
                <Button variant="secondary" onClick={() => void windows.refetch()}>
                  {t("web.common.retry")}
                </Button>
              </Notice>
            ) : tab === "weekly" ? (
              <WeeklyEditor data={windows.data} canEdit={isAdmin} myId={myId} submit={submit} />
            ) : (
              <OverridesEditor data={windows.data} holidays={holidays} today={today} canEdit={isAdmin} myId={myId} submit={submit} />
            )}
          </div>
        )}
      </Tabs>

      {dialog}
      <Toast toast={toast} onDismiss={dismiss} />
    </div>
  );
}

function Loading() {
  return (
    <div className="space-y-3" aria-busy="true">
      <span className="sr-only">{t("web.common.loading")}</span>
      <Skeleton className="h-10 w-2/3" />
      <Skeleton className="h-64" />
    </div>
  );
}

/** ARIA tabs: arrow keys move between them (and select), Home/End jump to the ends. */
function Tabs({
  tab,
  onSelect,
  children,
}: {
  tab: Tab;
  onSelect: (t: Tab) => void;
  children: (panel: { id: string; role: "tabpanel"; "aria-labelledby": string; tabIndex: number }) => ReactNode;
}) {
  const base = useId();
  const refs = useRef(new Map<Tab, HTMLButtonElement>());
  const tabId = (t: Tab) => `${base}-tab-${t}`;
  const panelId = `${base}-panel`;

  function onKeyDown(e: KeyboardEvent) {
    const i = TABS.indexOf(tab);
    const next =
      e.key === "ArrowRight" ? TABS[(i + 1) % TABS.length] : e.key === "ArrowLeft" ? TABS[(i - 1 + TABS.length) % TABS.length] : e.key === "Home" ? TABS[0] : e.key === "End" ? TABS[TABS.length - 1] : null;
    if (!next) return;
    e.preventDefault();
    onSelect(next);
    refs.current.get(next)?.focus();
  }

  return (
    <div className="space-y-5">
      <div
        role="tablist"
        aria-label={k("sections")}
        onKeyDown={onKeyDown}
        className="grid grid-cols-3 gap-1 rounded-xl bg-slate-200/70 p-1 sm:inline-grid sm:w-auto dark:bg-slate-800"
      >
        {TABS.map((t) => {
          const active = t === tab;
          return (
            <button
              key={t}
              ref={(el) => void (el ? refs.current.set(t, el) : refs.current.delete(t))}
              id={tabId(t)}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={panelId}
              tabIndex={active ? 0 : -1}
              onClick={() => onSelect(t)}
              className={`min-h-11 rounded-lg px-2 text-sm font-semibold transition-colors sm:px-5 ${
                active
                  ? "bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-white"
                  : "text-slate-600 hover:bg-white/60 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-700/60 dark:hover:text-white"
              }`}
            >
              {k(`tabs.${t === "time-off" ? "timeOff" : t}`)}
            </button>
          );
        })}
      </div>
      {children({ id: panelId, role: "tabpanel", "aria-labelledby": tabId(tab), tabIndex: 0 })}
    </div>
  );
}
