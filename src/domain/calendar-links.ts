/** "Add to calendar" links for web calendars: pure, no I/O. Each opens a pre-filled new-event form at the provider. */

import { formatUtc } from "./ics";

export interface CalendarLinkEvent {
  /** Epoch ms. */
  startAt: number;
  endAt: number;
  summary: string;
  /** Plain text; `\n` separates lines. */
  description: string;
}

export interface CalendarWebLinks {
  google: string;
  /** Outlook.com (personal Microsoft accounts). */
  outlook: string;
  /** Microsoft 365 (work or school Outlook). */
  office365: string;
}

/** Description length (UTF-16 units, ellipsis included) in a link; the .ics file always carries the full text. */
export const LINK_DESCRIPTION_MAX = 1000;

function shorten(s: string): string {
  if (s.length <= LINK_DESCRIPTION_MAX) return s;
  let cut = s.slice(0, LINK_DESCRIPTION_MAX - 1);
  // Never leave half of a surrogate pair at the end.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** `YYYY-MM-DDTHH:MM:SSZ`, the form Outlook's compose link reads as UTC. */
const isoUtc = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function googleCalendarUrl(e: CalendarLinkEvent): string {
  const q = new URLSearchParams({
    action: "TEMPLATE",
    text: e.summary,
    dates: `${formatUtc(e.startAt)}/${formatUtc(e.endAt)}`,
    details: shorten(e.description),
  });
  return `https://calendar.google.com/calendar/render?${q}`;
}

/** Outlook on the web: outlook.live.com for personal accounts, outlook.office.com for Microsoft 365. Its body is HTML. */
export function outlookUrl(e: CalendarLinkEvent, kind: "outlook" | "office365"): string {
  const host = kind === "outlook" ? "outlook.live.com" : "outlook.office.com";
  const q = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: e.summary,
    startdt: isoUtc(e.startAt),
    enddt: isoUtc(e.endAt),
    body: escapeHtml(shorten(e.description)).replace(/\r\n|\r|\n/g, "<br>"),
  });
  return `https://${host}/calendar/0/action/compose?${q}`;
}

export function calendarWebLinks(e: CalendarLinkEvent): CalendarWebLinks {
  return { google: googleCalendarUrl(e), outlook: outlookUrl(e, "outlook"), office365: outlookUrl(e, "office365") };
}
