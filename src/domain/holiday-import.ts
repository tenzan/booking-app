// Holiday CSV import: `date,name` rows (header optional) planned against the holidays already stored.

import { holidayNameSchema, isoDateSchema, MAX_HOLIDAY_IMPORT_ROWS } from "../shared/schemas";
import { parseCsv } from "./csv";

export type HolidayRowStatus = "new" | "changed" | "unchanged" | "error";

export interface HolidayImportRow {
  /** Line in the file, for pointing at the row. */
  line: number;
  date: string;
  name: string;
  status: HolidayRowStatus;
  /** Name stored today, for "changed" rows. */
  previousName?: string;
  /** Why an "error" row cannot be imported. */
  error?: string;
}

export class HolidayImportError extends Error {
  constructor(public code: "too_many_rows" | "invalid_csv", message: string, public line?: number) {
    super(message);
  }
}

/**
 * Plans an import. Throws HolidayImportError when the file as a whole is unusable (malformed CSV, more than 400 rows);
 * problems with single rows (bad date, bad name, wrong column count, a date listed twice) become "error" rows.
 * A date listed twice marks every occurrence, since nobody knows which name was meant.
 */
export function planHolidayImport(csv: string, existing: ReadonlyMap<string, string>): HolidayImportRow[] {
  let records;
  try {
    records = parseCsv(csv);
  } catch (e) {
    throw new HolidayImportError("invalid_csv", e instanceof Error ? e.message : "invalid csv", (e as { line?: number }).line);
  }
  // The header is optional: a first row whose first field reads "date" is one.
  if (records[0]?.fields[0]?.trim().toLowerCase() === "date") records = records.slice(1);
  records = records.filter((r) => r.fields.some((f) => f.trim() !== ""));
  if (records.length > MAX_HOLIDAY_IMPORT_ROWS) throw new HolidayImportError("too_many_rows", `at most ${MAX_HOLIDAY_IMPORT_ROWS} rows`);

  const rows: HolidayImportRow[] = records.map((r) => {
    const date = (r.fields[0] ?? "").trim();
    const name = (r.fields[1] ?? "").trim();
    const fail = (error: string): HolidayImportRow => ({ line: r.line, date, name, status: "error", error });
    if (r.fields.length !== 2) return fail(r.fields.length < 2 ? "missing_name" : "too_many_columns");
    if (!isoDateSchema.safeParse(date).success) return fail("invalid_date");
    if (!holidayNameSchema.safeParse(name).success) return fail(name === "" ? "missing_name" : "name_too_long");
    const previous = existing.get(date);
    if (previous === undefined) return { line: r.line, date, name, status: "new" };
    if (previous === name) return { line: r.line, date, name, status: "unchanged" };
    return { line: r.line, date, name, status: "changed", previousName: previous };
  });

  const validDate = (d: string) => isoDateSchema.safeParse(d).success;
  const count = new Map<string, number>();
  for (const r of rows) if (validDate(r.date)) count.set(r.date, (count.get(r.date) ?? 0) + 1);
  for (const r of rows) {
    if (validDate(r.date) && count.get(r.date)! > 1) {
      r.status = "error";
      r.error = "duplicate_date";
      delete r.previousName;
    }
  }
  return rows;
}
