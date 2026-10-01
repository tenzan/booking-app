// RFC 4180 CSV reader shared by the holiday and customer imports (pure, no I/O).
// Fields may be quoted ("" escapes a quote; commas and line breaks are allowed inside quotes). Records end at CRLF,
// LF or CR. A leading byte-order mark is dropped, and lines with no content at all are skipped.

export interface CsvRecord {
  /** 1-based line where the record starts (for error messages). */
  line: number;
  fields: string[];
}

export class CsvError extends Error {
  /** `line` and `column` are 1-based and also written into the message, so callers may show the message alone. */
  constructor(message: string, public line: number, public column?: number) {
    super(message);
  }
}

export function parseCsv(text: string): CsvRecord[] {
  const src = text.startsWith("﻿") ? text.slice(1) : text;
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false; // the current field began with a quote (so "" is an empty value, not a blank line)
  let inQuotes = false;
  let afterQuote = false; // just closed a quoted field: only a delimiter or line end may follow
  let line = 1;
  let recordLine = 1;
  let lineStart = 0; // index in src where the current physical line begins (columns count from here)
  let quoteLine = 1; // where the quote that opened the current quoted field sits
  let quoteColumn = 1;

  const endField = () => {
    fields.push(field);
    field = "";
    quoted = false;
    afterQuote = false;
  };
  const endRecord = () => {
    const blank = fields.length === 0 && field === "" && !quoted;
    if (!blank) {
      endField();
      records.push({ line: recordLine, fields });
    }
    fields = [];
  };

  const at = (what: string, i: number) => {
    const column = i - lineStart + 1;
    return new CsvError(
      `${what} (line ${line}, column ${column}): wrap the field in double quotes and write each quote inside it as ""`,
      line,
      column,
    );
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else {
        if (ch === "\n") {
          line++;
          lineStart = i + 1;
        }
        field += ch;
      }
    } else if (ch === ",") {
      endField();
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      endRecord();
      line++;
      lineStart = i + 1;
      recordLine = line;
    } else if (afterQuote) {
      throw at("unexpected text after a closing quote", i);
    } else if (ch === '"') {
      if (field !== "") throw at("a quote inside an unquoted field", i);
      inQuotes = true;
      quoted = true;
      quoteLine = line;
      quoteColumn = i - lineStart + 1;
    } else {
      field += ch;
    }
  }
  if (inQuotes) {
    throw new CsvError(
      `unterminated quoted field that starts at line ${quoteLine}, column ${quoteColumn}: add the closing double quote`,
      quoteLine,
      quoteColumn,
    );
  }
  endRecord();
  return records;
}
