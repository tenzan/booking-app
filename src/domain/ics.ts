/** RFC 5545 iCalendar output: pure, no I/O, no clock. */

export interface IcsEvent {
  /** Stable across updates of the same appointment, so a re-imported file replaces the earlier event. */
  uid: string;
  /** Revision of the event; calendars apply a file only when it is newer than what they hold. */
  sequence: number;
  method: "PUBLISH";
  status: "CONFIRMED" | "CANCELLED";
  /** Epoch ms. */
  startAt: number;
  endAt: number;
  /** DTSTAMP, epoch ms: when the file was produced. */
  stamp: number;
  summary: string;
  description: string;
  location?: string;
  url: string;
}

const PRODID = "-//Remote Support Booking//EN";
const MAX_LINE_OCTETS = 75;
const encoder = new TextEncoder();

/** `YYYYMMDDTHHMMSSZ` in UTC. */
export const formatUtc = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");

/** TEXT value escaping (RFC 5545 3.3.11). CR, LF and CRLF all become `\n`; other control characters are dropped. */
export const escapeText = (s: string): string =>
  s
    .replace(/\r\n|\r|\n/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, (ch) => (ch === "\t" ? ch : ""))
    .replace(/[\\;,]/g, "\\$&")
    .replace(/\n/g, "\\n");

/**
 * Fold a content line so no physical line exceeds 75 octets (UTF-8 bytes, CRLF excluded). Continuation lines start
 * with one space, which counts toward their 75. Splits only between code points, never inside a multi-byte character.
 */
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= MAX_LINE_OCTETS) return line;
  const out: string[] = [];
  let cur = "";
  let used = 0;
  for (const ch of line) {
    const n = encoder.encode(ch).length;
    // Continuation lines spend one octet on their leading space.
    const limit = out.length === 0 ? MAX_LINE_OCTETS : MAX_LINE_OCTETS - 1;
    if (used + n > limit) {
      out.push(cur);
      cur = "";
      used = 0;
    }
    cur += ch;
    used += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

/** A VCALENDAR with one VEVENT. CRLF-terminated; no alarms. */
export function buildIcs(e: IcsEvent): string {
  const content = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    `METHOD:${e.method}`,
    "BEGIN:VEVENT",
    `UID:${escapeText(e.uid)}`,
    `DTSTAMP:${formatUtc(e.stamp)}`,
    `DTSTART:${formatUtc(e.startAt)}`,
    `DTEND:${formatUtc(e.endAt)}`,
    `SEQUENCE:${e.sequence}`,
    `STATUS:${e.status}`,
    `SUMMARY:${escapeText(e.summary)}`,
    `DESCRIPTION:${escapeText(e.description)}`,
    ...(e.location ? [`LOCATION:${escapeText(e.location)}`] : []),
    // URI value: no TEXT escaping, but never let a line break through.
    `URL:${e.url.replace(/[\r\n]/g, "")}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return content.map(foldLine).join("\r\n") + "\r\n";
}
