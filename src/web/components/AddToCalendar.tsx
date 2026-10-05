import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CalendarLinks } from "../../shared/types";
import { isApiError } from "../api";
import { t } from "../i18n";
import { Button } from "./Button";
import { Spinner } from "./Spinner";

type Option = "apple" | "google" | "office365" | "outlook" | "other";
const OPTIONS: Option[] = ["apple", "google", "office365", "outlook", "other"];
/** The calendar chosen last on this device: the one-click button offers it next time. */
const CHOICE_KEY = "calendar-choice";

/** The likeliest calendar before anything was chosen: Apple on iPhone, iPad and Mac, Google everywhere else. */
export function deviceDefault(ua: string, platform = ""): Option {
  return /iPhone|iPad|iPod|Macintosh|Mac OS X/.test(ua) || /^(Mac|iPhone|iPad)/.test(platform) ? "apple" : "google";
}

function readChoice(): Option | null {
  try {
    const v = localStorage.getItem(CHOICE_KEY);
    return OPTIONS.includes(v as Option) ? (v as Option) : null;
  } catch {
    return null;
  }
}

function saveChoice(o: Option) {
  try {
    localStorage.setItem(CHOICE_KEY, o);
  } catch {
    // Private mode: the device default is offered again next time.
  }
}

const isWeb = (o: Option) => o === "google" || o === "office365" || o === "outlook";
const hrefOf = (links: CalendarLinks, o: Option) => (o === "apple" || o === "other" ? links.ics : links[o]);
const linkProps = (o: Option) => (isWeb(o) ? { target: "_blank", rel: "noopener noreferrer" } : {});

/**
 * True once the element is laid out anywhere on the page, scrolled into view or not: a reservation's collapsed details
 * (display: none) don't count, so links are only made for appointments someone has opened. The huge root margin turns
 * "intersects the viewport" into "is rendered".
 */
function useSeen(ref: RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: "100000px" });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, seen]);
  return seen;
}

const fallbackError = (e: unknown): ReactNode =>
  isApiError(e, 429) ? t("web.errors.rateLimited") : isApiError(e, 0) ? t("web.errors.network") : t("web.errors.generic");

const SEGMENT = "inline-flex min-h-11 items-center gap-2 border border-slate-300 bg-white font-semibold text-slate-900 hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800";

/**
 * "Add to calendar" for a confirmed appointment, as a split button: the main part adds to the chosen calendar in one
 * click (the last one used on this device, else the device's likely one), and "More calendars" opens a menu of all
 * five with what each does. Web calendars open their own "new event" page in a new tab; Apple Calendar and the
 * .ics file open the file, which on an iPhone shows the Add to Calendar sheet. The menu floats: the page doesn't move.
 */
export function AddToCalendar({
  queryKey,
  load,
  note,
  prompt,
  onPicked,
  errorContent = fallbackError,
}: {
  queryKey: readonly unknown[];
  load: () => Promise<CalendarLinks>;
  /** One line under the button: that the event is a snapshot of the appointment now. */
  note: string;
  /** A line above the button saying what it is for (an email's "Add to calendar" link opened this page). */
  prompt?: string;
  /** A calendar was chosen. */
  onPicked?: () => void;
  errorContent?: (e: unknown) => ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const noteId = useId();
  const seen = useSeen(rootRef);
  const q = useQuery({
    queryKey,
    queryFn: load,
    enabled: seen,
    retry: false,
    // Customer file links last an hour; ask again well before that.
    staleTime: 30 * 60_000,
  });
  const [choice, setChoice] = useState<Option>(() => readChoice() ?? deviceDefault(navigator.userAgent, navigator.platform));
  const [open, setOpen] = useState(false);

  const items = () => [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  const close = (focusToggle: boolean) => {
    setOpen(false);
    if (focusToggle) toggleRef.current?.focus();
  };

  // Focus the first choice when the menu opens; close it on a click or tap anywhere else.
  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const away = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const onMenuKey = (e: KeyboardEvent) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => list[(i + list.length) % list.length]?.focus();
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(list.length - 1);
    else if (e.key === "Escape") close(true);
    else if (e.key === "Tab") setOpen(false);
    else return;
    if (e.key !== "Tab") e.preventDefault();
  };

  const pick = (o: Option) => {
    saveChoice(o);
    setChoice(o);
    setOpen(false);
    onPicked?.();
  };

  const notConfirmed = isApiError(q.error, 409, "not_confirmed");
  const icon = (
    <svg className="size-5 shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="15" rx="2" stroke="currentColor" strokeWidth="1.75" />
      <path d="M3.5 9.5h17M8 3v4M16 3v4M12 12.5v5M9.5 15h5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );

  return (
    <div ref={rootRef} className="space-y-2">
      {prompt && <p className="font-medium">{prompt}</p>}
      <div className="relative flex">
        {q.data ? (
          <a
            href={hrefOf(q.data, choice)}
            {...linkProps(choice)}
            aria-describedby={noteId}
            onClick={() => pick(choice)}
            className={`${SEGMENT} min-w-0 flex-1 justify-center rounded-l-xl px-4`}
          >
            {icon}
            <span className="truncate">{t(`web.calendar.add.${choice}`)}</span>
          </a>
        ) : (
          <span aria-disabled="true" className={`${SEGMENT} min-w-0 flex-1 cursor-default justify-center rounded-l-xl px-4 opacity-70`}>
            {q.isPending && seen ? <Spinner /> : icon}
            <span className="truncate">{t(`web.calendar.add.${choice}`)}</span>
            {q.isPending && seen && <span className="sr-only">{t("web.calendar.loading")}</span>}
          </span>
        )}
        <button
          ref={toggleRef}
          type="button"
          aria-label={t("web.calendar.more")}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          disabled={!q.data}
          onClick={() => setOpen((v) => !v)}
          className={`${SEGMENT} -ml-px shrink-0 justify-center rounded-r-xl px-3 disabled:cursor-default disabled:opacity-70`}
        >
          <svg className={`size-5 transition-transform ${open ? "rotate-180" : ""}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {open && q.data && (
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={t("web.calendar.more")}
            onKeyDown={onMenuKey}
            className="absolute top-full right-0 z-30 mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
          >
            {OPTIONS.map((o) => (
              <a
                key={o}
                role="menuitem"
                href={hrefOf(q.data, o)}
                {...linkProps(o)}
                onClick={() => pick(o)}
                className="flex items-start justify-between gap-3 px-4 py-2.5 hover:bg-slate-100 focus-visible:bg-slate-100 focus-visible:outline-none dark:hover:bg-slate-800 dark:focus-visible:bg-slate-800"
              >
                <span className="min-w-0">
                  <span className="block font-medium text-slate-900 dark:text-slate-100">
                    {t(`calendar.${o}`)}
                  </span>
                  <span className="block text-sm text-slate-600 dark:text-slate-400">{t(`web.calendar.hint.${o}`)}</span>
                  {isWeb(o) && <span className="sr-only">{t("web.calendar.newTab")}</span>}
                </span>
                {o === choice && (
                  <svg className="mt-0.5 size-5 shrink-0 text-blue-700 dark:text-blue-300" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="m5 12 5 5 9-10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </a>
            ))}
          </div>
        )}
      </div>
      <p id={noteId} className="text-sm text-slate-600 dark:text-slate-400">
        {note}
      </p>
      {q.isError && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-red-800 dark:text-red-300">
          <span>{notConfirmed ? t("web.calendar.notConfirmed") : errorContent(q.error)}</span>
          {!notConfirmed && (
            <Button variant="secondary" onClick={() => void q.refetch()}>
              {t("web.common.retry")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
