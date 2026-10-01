import { describe, expect, it } from "vitest";
import { CsvError, parseCsv } from "../../src/domain/csv";

const fields = (text: string) => parseCsv(text).map((r) => r.fields);

describe("parseCsv", () => {
  it("reads plain records with LF, CRLF and CR line ends, with or without a final newline", () => {
    const want = [["a", "b"], ["c", "d"]];
    expect(fields("a,b\nc,d")).toEqual(want);
    expect(fields("a,b\r\nc,d\r\n")).toEqual(want);
    expect(fields("a,b\rc,d\r")).toEqual(want);
  });

  it("keeps empty fields, including trailing ones", () => {
    expect(fields("a,,c\n,\nx,")).toEqual([["a", "", "c"], ["", ""], ["x", ""]]);
  });

  it("reads quoted fields: commas, doubled quotes and line breaks inside", () => {
    expect(fields('"a,b","say ""hi""","line1\nline2"\n"x"')).toEqual([["a,b", 'say "hi"', "line1\nline2"], ["x"]]);
    expect(fields('"a\r\nb",c')).toEqual([["a\r\nb", "c"]]);
  });

  it("distinguishes an empty quoted value from a blank line", () => {
    expect(fields('""\n\n,\n')).toEqual([[""], ["", ""]]);
  });

  it("skips blank lines and drops a byte-order mark", () => {
    expect(fields("﻿date,name\n\n\n2026-01-01,New Year\n\n")).toEqual([["date", "name"], ["2026-01-01", "New Year"]]);
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("\n\r\n")).toEqual([]);
  });

  it("reports the line where each record starts, counting line breaks inside quotes", () => {
    const rows = parseCsv('a\n"x\ny"\n\nb');
    expect(rows.map((r) => r.line)).toEqual([1, 2, 5]);
  });

  it("keeps whitespace as is (callers trim)", () => {
    expect(fields(" a , b \n")).toEqual([[" a ", " b "]]);
  });

  it("rejects malformed quoting with the offending line", () => {
    const bad = (text: string) => {
      try {
        parseCsv(text);
      } catch (e) {
        expect(e).toBeInstanceOf(CsvError);
        return (e as CsvError).line;
      }
      throw new Error("expected CsvError");
    };
    expect(bad('a,"open\nstill')).toBe(1);
    expect(bad('ok\n"x"y')).toBe(2);
    expect(bad('ok\nab"c"')).toBe(2);
    expect(bad('"a""')).toBe(1);
  });
});
