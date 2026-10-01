import { en } from "./en";

export type Catalog = typeof en;

/** Look up a dot-path key in the catalog and interpolate `{name}` params. Missing key -> the key itself. */
export function t(key: string, params?: Record<string, string | number>): string {
  let node: unknown = en;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null || !Object.hasOwn(node, part)) return key;
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node !== "string") return key;
  if (!params) return node;
  return node.replace(/\{(\w+)\}/g, (m, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : m));
}

/** e.g. "Thu, Oct 1, 2026, 10:00" in the given IANA time zone (24-hour clock). */
export function fmtDateTime(ms: number, tz: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(ms);
}

/** e.g. "Asia/Tokyo (GMT+9)"; the offset is the one in effect at `atMs`. */
export function tzLabel(tz: string, atMs: number, locale: string): string {
  const parts = new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(atMs);
  const offset = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  return `${tz} (${offset})`;
}
