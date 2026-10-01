import type { CodedMessage } from "../../../domain/csv";
import { t } from "../../i18n";

/**
 * Catalog text for a coded import message (a row's error or note, or a file problem): web.staff.import.messages.<code>
 * with its params. `fallback` when the catalog has no text for the code.
 */
export function codedText(m: CodedMessage | undefined, fallback: string): string {
  if (!m) return fallback;
  const key = `web.staff.import.messages.${m.code}`;
  const text = t(key, m.params);
  return text === key ? fallback : text;
}
