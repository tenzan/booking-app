import { describe, expect, it } from "vitest";
import { HolidayImportError, planHolidayImport } from "../../src/domain/holiday-import";

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

  it("turns row problems into error rows with a code", () => {
    const rows = planHolidayImport("2026-01-01\n2026-01-02,A,B\nnope,A\n2026-01-03, \n2026-01-04,x", none);
    expect(rows.map((r) => r.error ?? r.status)).toEqual(["missing_name", "too_many_columns", "invalid_date", "missing_name", "new"]);
  });

  it("marks every occurrence of a repeated date", () => {
    const rows = planHolidayImport("2026-01-01,A\n2026-01-01,B\n2026-01-02,C", new Map([["2026-01-01", "A"]]));
    expect(rows.map((r) => [r.status, r.error, r.previousName])).toEqual([["error", "duplicate_date", undefined], ["error", "duplicate_date", undefined], ["new", undefined, undefined]]);
  });

  it("allows exactly 400 rows and fails the file beyond that or on broken quoting", () => {
    const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => `${new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)},D${i}`).join("\n");
    expect(planHolidayImport(rowsOf(400), none)).toHaveLength(400);
    expect(() => planHolidayImport(rowsOf(401), none)).toThrowError(expect.objectContaining({ code: "too_many_rows" }));
    expect(() => planHolidayImport('2026-01-01,"A', none)).toThrowError(HolidayImportError);
  });
});
