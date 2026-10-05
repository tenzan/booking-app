import { useId, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CalendarLinks } from "../../shared/types";
import { isApiError } from "../api";
import { t } from "../i18n";
import { Button } from "./Button";
import { Notice } from "./Card";
import { Skeleton } from "./Spinner";

type Option = "apple" | "google" | "outlook" | "office365" | "other";

/** The likeliest calendar first: Apple on iPhone, iPad and Mac, Google everywhere else. Only the order changes. */
export function calendarOrder(ua: string, platform = ""): Option[] {
  const apple = /iPhone|iPad|iPod|Macintosh|Mac OS X/.test(ua) || /^(Mac|iPhone|iPad)/.test(platform);
  return apple ? ["apple", "google", "outlook", "office365", "other"] : ["google", "outlook", "office365", "apple", "other"];
}

const deviceOrder = (): Option[] => (typeof navigator === "undefined" ? calendarOrder("") : calendarOrder(navigator.userAgent, navigator.platform));

const fallbackError = (e: unknown): ReactNode =>
  isApiError(e, 429) ? t("web.errors.rateLimited") : isApiError(e, 0) ? t("web.errors.network") : t("web.errors.generic");

/**
 * "Add to calendar" for a confirmed appointment: a disclosure listing Apple Calendar, Google Calendar, Outlook.com,
 * Microsoft 365 and any other calendar (.ics). The links are asked for when it is first opened (`load`), so a list of
 * reservations costs nothing until someone wants one. Web calendars open in a new tab; the .ics opens in place, which on
 * an iPhone shows the Add to Calendar sheet.
 */
export function AddToCalendar({
  queryKey,
  load,
  note,
  prompt,
  initiallyOpen = false,
  onPicked,
  errorContent = fallbackError,
}: {
  queryKey: readonly unknown[];
  load: () => Promise<CalendarLinks>;
  /** Shown under the button: that the event is a snapshot of the appointment now. */
  note: string;
  /** A line above the button saying what it is for (an email's "Add to calendar" link opened this page). */
  prompt?: string;
  initiallyOpen?: boolean;
  /** A calendar was chosen. */
  onPicked?: () => void;
  errorContent?: (e: unknown) => ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const panelId = useId();
  const noteId = useId();
  const q = useQuery({
    queryKey,
    queryFn: load,
    enabled: open,
    retry: false,
    // Customer file links last an hour; ask again well before that.
    staleTime: 30 * 60_000,
  });
  const notConfirmed = isApiError(q.error, 409, "not_confirmed");

  const labels: Record<Option, string> = {
    apple: t("calendar.apple"),
    google: t("calendar.google"),
    outlook: t("calendar.outlook"),
    office365: t("calendar.office365"),
    other: t("calendar.other"),
  };
  const hrefOf = (links: CalendarLinks, o: Option) => (o === "apple" || o === "other" ? links.ics : links[o]);

  return (
    <div className="space-y-2">
      {prompt && <p className="font-medium">{prompt}</p>}
      <Button
        variant="secondary"
        block
        aria-expanded={open}
        aria-controls={panelId}
        aria-describedby={noteId}
        onClick={() => setOpen((v) => !v)}
      >
        <svg className="size-5 shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="3.5" y="5" width="17" height="15" rx="2" stroke="currentColor" strokeWidth="1.75" />
          <path d="M3.5 9.5h17M8 3v4M16 3v4M12 12.5v5M9.5 15h5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
        </svg>
        {t("calendar.heading")}
        <svg className={`size-5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Button>
      <div id={panelId} hidden={!open}>
        {q.isPending ? (
          <div className="space-y-2" aria-busy="true">
            <span className="sr-only">{t("web.calendar.loading")}</span>
            <Skeleton className="h-11" />
            <Skeleton className="h-11" />
            <Skeleton className="h-11" />
          </div>
        ) : q.isError ? (
          <Notice tone="error" role="alert" className="flex flex-wrap items-center justify-between gap-3">
            <span>{notConfirmed ? t("web.calendar.notConfirmed") : errorContent(q.error)}</span>
            {!notConfirmed && (
              <Button variant="secondary" onClick={() => void q.refetch()}>
                {t("web.common.retry")}
              </Button>
            )}
          </Notice>
        ) : (
          <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-300 bg-white dark:divide-slate-800 dark:border-slate-600 dark:bg-slate-900">
            {deviceOrder().map((o) => {
              const web = o === "google" || o === "outlook" || o === "office365";
              return (
                <li key={o}>
                  <a
                    href={hrefOf(q.data, o)}
                    {...(web ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                    onClick={() => onPicked?.()}
                    className="flex min-h-12 items-center justify-between gap-3 px-4 font-medium text-slate-900 hover:bg-slate-100 focus-visible:bg-slate-100 dark:text-slate-100 dark:hover:bg-slate-800 dark:focus-visible:bg-slate-800"
                  >
                    {labels[o]}
                    {web ? (
                      <>
                        <span className="sr-only">{t("web.calendar.newTab")}</span>
                        <svg className="size-4 shrink-0 text-slate-500" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </>
                    ) : (
                      <svg className="size-4 shrink-0 text-slate-500" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path d="M12 4v11m-4.5-4.5L12 15l4.5-4.5M5 20h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <p id={noteId} className="text-sm text-slate-600 dark:text-slate-400">
        {note}
      </p>
    </div>
  );
}
