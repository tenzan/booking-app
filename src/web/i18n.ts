import { Fragment, createElement, type ReactNode } from "react";
import { t } from "../shared/i18n/i18n";

/** The SPA's single entry to the shared catalog: every user-facing string goes through `t`. */
export { t, fmtDateTime, tzLabel } from "../shared/i18n/i18n";

export const LOCALE = "en";

/** Like `t`, but `{name}` params may be React nodes (e.g. a bold email address). Text params stay escaped as usual. */
export function tNodes(key: string, params: Record<string, ReactNode>): ReactNode {
  const marks: Record<string, string> = {};
  for (const name of Object.keys(params)) marks[name] = `\u0000${name}\u0000`;
  const parts = t(key, marks).split("\u0000");
  // Odd indexes are param names.
  return parts.map((part, i) => createElement(Fragment, { key: i }, i % 2 === 1 ? params[part] : part));
}
