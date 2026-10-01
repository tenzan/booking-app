import { describe, expect, it } from "vitest";
import { HolidayImportError, planHolidayImport } from "../../src/domain/holiday-import";
import { t } from "../../src/shared/i18n/i18n";

const none = new Map<string, string>();

describe("planHolidayImport", () => {
  it("classifies rows against the stored holidays", () => {
    const existing = new Map([["2026-01-01", "New Year"], ["2026-02-11", "Old"]]);
    const rows = planHolidayImport("date,name\n2026-01-01,New Year\n2026-02-11,Foundation Day\n2026-04-29,Showa Day", existing);
    expect(rows.map((r) => [r.line, r.status, r.previousName])).toEqual([[2, "unchanged", undefined], [3, "changed", "Old"], [4, "new", undefined]]);
  });

  it("accepts a header in any case, or none", () => {
    expect(planHolidayImport("DATE , Name\n2026-01-01,A", none)).toHaveLength(1);
    expect(planHolidayImport("2026-01-01,A", none)).toHaveLength(1);
    expect(planHolidayImport("", none)).toEqual([]);
  });

  it("turns row problems into error rows with a coded message", () => {
    const rows = planHolidayImport(`2026-01-01\n2026-01-02,A,B\nnope,A\n2026-01-03, \n2026-01-04,x\n,Nameless\n2026-01-05,${"n".repeat(101)}`, none);
    expect(rows.map((r) => r.error ?? r.status)).toEqual([
      { code: "required", params: { field: "name" } },
      { code: "holiday_column_count", params: { found: 3 } },
      { code: "invalid_date" },
      { code: "required", params: { field: "name" } },
      "new",
      { code: "required", params: { field: "date" } },
      { code: "too_long", params: { field: "name", max: 100 } },
    ]);
  });

  it("marks every occurrence of a repeated date, naming the lines", () => {
    const rows = planHolidayImport("2026-01-01,A\n2026-01-01,B\n2026-01-02,C", new Map([["2026-01-01", "A"]]));
    const dup = { code: "duplicate_date", params: { date: "2026-01-01", lines: "1, 2" } };
    expect(rows.map((r) => [r.status, r.error, r.previousName])).toEqual([["error", dup, undefined], ["error", dup, undefined], ["new", undefined, undefined]]);
  });

  it("fails the file with a coded reason the catalog can render", () => {
    const quote = (() => {
      try {
        planHolidayImport('2026-01-01,"A', none);
      } catch (e) {
        return e;
      }
    })() as HolidayImportError;
    expect([quote.code, quote.reason, quote.line, quote.column]).toEqual(["invalid_csv", { code: "csv_unterminated_quote", params: { line: 1, column: 12 } }, 1, 12]);
    const many = Array.from({ length: 401 }, (_, i) => `${new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)},D${i}`).join("\n");
    expect(() => planHolidayImport(many, none)).toThrowError(expect.objectContaining({ code: "too_many_rows", reason: { code: "too_many_rows", params: { max: 400 } } }));
  });

  it("every code the planner emits has English catalog text", () => {
    const codes = ["csv_stray_quote", "csv_text_after_quote", "csv_unterminated_quote", "too_many_rows", "required", "too_long", "invalid_date", "holiday_column_count", "duplicate_date"];
    for (const code of codes) expect(t(`web.staff.import.messages.${code}`), code).not.toBe(`web.staff.import.messages.${code}`);
    expect(t("web.staff.import.messages.duplicate_date", { date: "2026-01-01", lines: "1, 2" })).toBe("2026-01-01 is listed more than once (lines 1, 2). Keep one row per date.");
  });

  it("allows exactly 400 rows and fails the file beyond that or on broken quoting", () => {
    const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => `${new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)},D${i}`).join("\n");
    expect(planHolidayImport(rowsOf(400), none)).toHaveLength(400);
    expect(() => planHolidayImport(rowsOf(401), none)).toThrowError(expect.objectContaining({ code: "too_many_rows" }));
    expect(() => planHolidayImport('2026-01-01,"A', none)).toThrowError(HolidayImportError);
  });
});
