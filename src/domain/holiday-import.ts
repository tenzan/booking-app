// Holiday CSV import: `date,name` rows (header optional) planned against the holidays already stored.

import { holidayNameSchema, isoDateSchema, MAX_HOLIDAY_IMPORT_ROWS } from "../shared/schemas";
import { CsvError, parseCsv, type CodedMessage } from "./csv";

export type HolidayRowStatus = "new" | "changed" | "unchanged" | "error";

export interface HolidayImportRow {
  /** Line in the file, for pointing at the row. */
  line: number;
  date: string;
  name: string;
  status: HolidayRowStatus;
  /** Name stored today, for "changed" rows. */
  previousName?: string;
  /** Why an "error" row cannot be imported; rendered from the catalog (web.staff.import.messages.<code>). */
  error?: CodedMessage;
}

/** The file as a whole is unusable. `code` is the API error; `reason` says why, for the catalog. */
export class HolidayImportError extends Error {
  constructor(
    public code: "too_many_rows" | "invalid_csv",
    public reason: CodedMessage,
    message: string,
    public line?: number,
    public column?: number,
  ) {
    super(message);
  }
}

/** The name's problem: blank, or longer than the schema allows. */
function nameProblem(name: string): CodedMessage | null {
  const parsed = holidayNameSchema.safeParse(name);
  if (parsed.success) return null;
  const big = parsed.error.issues.find((i) => i.code === "too_big");
  return big ? { code: "too_long", params: { field: "name", max: Number(big.maximum) } } : { code: "required", params: { field: "name" } };
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
    if (e instanceof CsvError) throw new HolidayImportError("invalid_csv", { code: e.code, params: e.params }, e.message, e.line, e.column);
    throw e;
  }
  // The header is optional: a first row whose first field reads "date" is one.
  if (records[0]?.fields[0]?.trim().toLowerCase() === "date") records = records.slice(1);
  records = records.filter((r) => r.fields.some((f) => f.trim() !== ""));
  if (records.length > MAX_HOLIDAY_IMPORT_ROWS) {
    throw new HolidayImportError("too_many_rows", { code: "too_many_rows", params: { max: MAX_HOLIDAY_IMPORT_ROWS } }, `at most ${MAX_HOLIDAY_IMPORT_ROWS} rows`);
  }

  const rows: HolidayImportRow[] = records.map((r) => {
    const date = (r.fields[0] ?? "").trim();
    const name = (r.fields[1] ?? "").trim();
    const fail = (error: CodedMessage): HolidayImportRow => ({ line: r.line, date, name, status: "error", error });
    if (r.fields.length > 2) return fail({ code: "holiday_column_count", params: { found: r.fields.length } });
    if (date === "") return fail({ code: "required", params: { field: "date" } });
    if (!isoDateSchema.safeParse(date).success) return fail({ code: "invalid_date" });
    const problem = nameProblem(name);
    if (problem) return fail(problem);
    const previous = existing.get(date);
    if (previous === undefined) return { line: r.line, date, name, status: "new" };
    if (previous === name) return { line: r.line, date, name, status: "unchanged" };
    return { line: r.line, date, name, status: "changed", previousName: previous };
  });

  const validDate = (d: string) => isoDateSchema.safeParse(d).success;
  const lines = new Map<string, number[]>();
  for (const r of rows) if (validDate(r.date)) lines.set(r.date, [...(lines.get(r.date) ?? []), r.line]);
  for (const r of rows) {
    const seen = validDate(r.date) ? lines.get(r.date)! : [];
    if (seen.length > 1) {
      r.status = "error";
      r.error = { code: "duplicate_date", params: { date: r.date, lines: seen.join(", ") } };
      delete r.previousName;
    }
  }
  return rows;
}
