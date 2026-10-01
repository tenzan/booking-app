// Customer CSV import: plans a file against the customers already stored (pure, no I/O).
//
// One row = one contact of one customer: `customer_number,name,phone,contact_email,contact_name,active`.
// Rows that share a customer number describe one customer with several contacts. The import only ever creates and
// updates: it never deletes or deactivates a contact that the file does not mention, and never renames a number.

import {
  contactNameSchema,
  customerNameSchema,
  customerNumberSchema,
  emailSchema,
  MAX_CUSTOMER_IMPORT_ROWS,
  phoneSchema,
} from "../shared/schemas";
import { CsvError, parseCsv, type CodedMessage, type CsvRecord } from "./csv";

export type { CodedMessage };

export const REQUIRED_COLUMNS = ["customer_number", "name", "contact_email"] as const;
export const OPTIONAL_COLUMNS = ["phone", "contact_name", "active"] as const;
const KNOWN_COLUMNS: readonly string[] = [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS];

export interface ExistingContact {
  name: string | null;
  active: boolean;
}

export interface ExistingCustomer {
  name: string;
  phone: string | null;
  active: boolean;
  /** Keyed by lower-cased email. */
  contacts: ReadonlyMap<string, ExistingContact>;
}

/** Stored customers keyed by customer number (exact, case-sensitive like the database column). */
export type ExistingCustomers = ReadonlyMap<string, ExistingCustomer>;

export type ImportRowAction = "create" | "update" | "unchanged" | "error";

export interface ImportRow {
  /** Line where the record starts in the file. */
  line: number;
  customerNumber: string;
  email: string;
  action: ImportRowAction;
  /** Why the row is an error, or what it does; rendered from the catalog (web.staff.import.messages.<code>). */
  messages: CodedMessage[];
}

/**
 * What to write for a customer. A blank cell in the file means "leave as is", so on an update `phone` and `active`
 * are present only when the file supplied them; a new customer gets null / true for blanks.
 */
export interface PlannedCustomer {
  customerNumber: string;
  name: string;
  phone?: string | null;
  active?: boolean;
  action: "create" | "update";
}

/** `name` undefined (update) leaves the stored name; a new contact with a blank name gets null. */
export interface PlannedContact {
  customerNumber: string;
  email: string;
  name?: string | null;
  action: "add" | "update";
}

export interface ImportSummary {
  customers: { create: number; update: number; unchanged: number };
  contacts: { add: number; update: number; unchanged: number };
  /** Rows with action "error". */
  errors: number;
}

export interface ImportPlan {
  rows: ImportRow[];
  summary: ImportSummary;
  /** File-level notes that do not block the import (unknown columns). */
  warnings: CodedMessage[];
  /** The writes the file implies, sorted canonically. The plan hash covers exactly these. */
  customers: PlannedCustomer[];
  contacts: PlannedContact[];
}

export type ImportFileErrorCode = "invalid_csv" | "invalid_header" | "too_many_rows";

/** The file as a whole is unusable. `code` is the API error; `reason` says why, for the catalog. */
export class CustomerImportError extends Error {
  constructor(
    public code: ImportFileErrorCode,
    public reason: CodedMessage,
    message: string,
    public line?: number,
    public column?: number,
  ) {
    super(message);
  }
}

// ---- Row reading ------------------------------------------------------------------------------------------------

interface CustomerFields {
  name: string;
  /** undefined = blank in the file. */
  phone?: string;
  active?: boolean;
}

interface ParsedRow {
  line: number;
  customerNumber: string;
  email: string;
  errors: CodedMessage[];
  /** Present when customer_number, name, phone and active are all valid. */
  number?: string;
  customer?: CustomerFields;
  contactEmail?: string;
  /** undefined = blank in the file. */
  contactName?: string;
}

const TRUE = /^(true|1|yes)$/i;
const FALSE = /^(false|0|no)$/i;

interface Issue {
  code: string;
  maximum?: unknown;
}

/** Maps a failed schema parse to a message code for `field`; the schemas stay the single source of the rules. */
function problem(field: string, issues: readonly Issue[], format: CodedMessage): CodedMessage {
  const i = issues[0];
  if (i?.code === "too_big") return { code: "too_long", params: { field, max: Number(i.maximum) } };
  if (i?.code === "invalid_format" || i?.code === "invalid_string") return format;
  return { code: "invalid_value", params: { field } };
}

function readRow(record: CsvRecord, index: ReadonlyMap<string, number>, width: number): ParsedRow {
  const cell = (column: string) => {
    const i = index.get(column);
    return i === undefined ? "" : (record.fields[i] ?? "").trim();
  };
  const row: ParsedRow = { line: record.line, customerNumber: cell("customer_number"), email: cell("contact_email"), errors: [] };
  if (record.fields.length !== width) {
    row.errors.push({ code: "column_count", params: { expected: width, found: record.fields.length } });
    return row;
  }
  const required = (field: string): CodedMessage => ({ code: "required", params: { field } });

  let number: string | undefined;
  const numberRaw = cell("customer_number");
  if (numberRaw === "") row.errors.push(required("customer_number"));
  else {
    const r = customerNumberSchema.safeParse(numberRaw);
    if (r.success) number = r.data;
    else row.errors.push(problem("customer_number", r.error.issues, { code: "invalid_customer_number" }));
  }

  let name: string | undefined;
  const nameRaw = cell("name");
  if (nameRaw === "") row.errors.push(required("name"));
  else {
    const r = customerNameSchema.safeParse(nameRaw);
    if (r.success) name = r.data;
    else row.errors.push(problem("name", r.error.issues, { code: "invalid_value", params: { field: "name" } }));
  }

  let phone: string | undefined;
  let phoneOk = true;
  const phoneRaw = cell("phone");
  if (phoneRaw !== "") {
    const r = phoneSchema.safeParse(phoneRaw);
    if (r.success) phone = r.data;
    else {
      phoneOk = false;
      row.errors.push(problem("phone", r.error.issues, { code: "invalid_phone" }));
    }
  }

  let active: boolean | undefined;
  let activeOk = true;
  const activeRaw = cell("active");
  if (TRUE.test(activeRaw)) active = true;
  else if (FALSE.test(activeRaw)) active = false;
  else if (activeRaw !== "") {
    activeOk = false;
    row.errors.push({ code: "invalid_active" });
  }

  const emailRaw = cell("contact_email");
  if (emailRaw === "") row.errors.push(required("contact_email"));
  else {
    const r = emailSchema.safeParse(emailRaw);
    if (r.success) row.contactEmail = r.data;
    else {
      const p = problem("contact_email", r.error.issues, { code: "invalid_email" });
      row.errors.push(p.code === "too_long" ? p : { code: "invalid_email" });
    }
  }

  const contactRaw = cell("contact_name");
  if (contactRaw !== "") {
    const r = contactNameSchema.safeParse(contactRaw);
    if (r.success) row.contactName = r.data;
    else row.errors.push(problem("contact_name", r.error.issues, { code: "invalid_value", params: { field: "contact_name" } }));
  }

  if (number !== undefined && name !== undefined && phoneOk && activeOk) {
    row.number = number;
    row.customer = { name, ...(phone !== undefined ? { phone } : {}), ...(active !== undefined ? { active } : {}) };
  }
  return row;
}

// ---- Planning ---------------------------------------------------------------------------------------------------

function readHeader(records: CsvRecord[]): { index: Map<string, number>; width: number; warnings: CodedMessage[] } {
  const header = records[0];
  if (!header) throw new CustomerImportError("invalid_header", { code: "header_empty" }, "the file is empty: the first line must be the header row", 1);
  const index = new Map<string, number>();
  const warnings: CodedMessage[] = [];
  header.fields.forEach((raw, i) => {
    const column = raw.trim().toLowerCase();
    if (!KNOWN_COLUMNS.includes(column)) {
      warnings.push({ code: "unknown_column", params: { column: raw.trim() } });
      return;
    }
    if (index.has(column)) {
      throw new CustomerImportError("invalid_header", { code: "header_duplicate_column", params: { column } }, `column ${column} appears twice in the header`, header.line);
    }
    index.set(column, i);
  });
  const missing = REQUIRED_COLUMNS.filter((c) => !index.has(c));
  if (missing.length > 0) {
    throw new CustomerImportError(
      "invalid_header",
      { code: "header_missing_columns", params: { columns: missing.join(", ") } },
      `the header is missing the required column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`,
      header.line,
    );
  }
  return { index, width: header.fields.length, warnings };
}

type Field = "name" | "phone" | "active";

interface Group {
  number: string;
  /** What the file says about the customer: the first non-blank value of each field, and the line it came from. */
  ref: Partial<CustomerFields>;
  refLine: Partial<Record<Field, number>>;
  rows: ParsedRow[];
}

const FIELDS: readonly Field[] = ["name", "phone", "active"];

/**
 * Plans an import. Throws CustomerImportError when the file as a whole is unusable; every problem with a single row
 * becomes an "error" row (the preview shows them all; apply refuses a file that has any).
 * A blank phone, contact_name or active means "leave as is" (blank on a new customer: no phone, no contact name, active).
 */
export function planCustomerImport(csv: string, existing: ExistingCustomers): ImportPlan {
  let records: CsvRecord[];
  try {
    records = parseCsv(csv);
  } catch (e) {
    if (e instanceof CsvError) throw new CustomerImportError("invalid_csv", { code: e.code, params: e.params }, e.message, e.line, e.column);
    throw e;
  }
  const { index, width, warnings } = readHeader(records);
  const dataRecords = records.slice(1).filter((r) => r.fields.some((f) => f.trim() !== ""));
  if (dataRecords.length > MAX_CUSTOMER_IMPORT_ROWS) {
    throw new CustomerImportError("too_many_rows", { code: "too_many_rows", params: { max: MAX_CUSTOMER_IMPORT_ROWS } }, `at most ${MAX_CUSTOMER_IMPORT_ROWS} rows per import; split the file`);
  }

  const parsed = dataRecords.map((r) => readRow(r, index, width));

  // Rows of one customer must agree on every field they all state; a blank is compatible with anything.
  const groups = new Map<string, Group>();
  const pairs = new Map<string, number>();
  for (const row of parsed) {
    if (row.number !== undefined && row.customer) {
      const customer = row.customer;
      let g = groups.get(row.number);
      if (!g) {
        g = { number: row.number, ref: {}, refLine: {}, rows: [] };
        groups.set(row.number, g);
      }
      g.rows.push(row);
      for (const k of FIELDS) {
        const value = customer[k];
        if (value === undefined) continue;
        const known = g.ref[k];
        if (known === undefined) {
          (g.ref as Record<Field, unknown>)[k] = value;
          g.refLine[k] = row.line;
        } else if (known !== value) {
          row.errors.push({ code: "field_differs", params: { field: k, value: String(value), other: String(known), line: g.refLine[k]! } });
        }
      }
    }
    if (row.number !== undefined && row.contactEmail !== undefined) {
      const key = `${row.number}\u0000${row.contactEmail}`;
      const first = pairs.get(key);
      if (first === undefined) pairs.set(key, row.line);
      else row.errors.push({ code: "duplicate_pair", params: { line: first } });
    }
  }

  const summary: ImportSummary = { customers: { create: 0, update: 0, unchanged: 0 }, contacts: { add: 0, update: 0, unchanged: 0 }, errors: 0 };
  const customers: PlannedCustomer[] = [];
  const contacts: PlannedContact[] = [];
  const outcome = new Map<ParsedRow, { action: ImportRowAction; messages: CodedMessage[] }>();

  for (const g of groups.values()) {
    const ok = g.rows.filter((r) => r.errors.length === 0 && r.contactEmail !== undefined);
    if (ok.length === 0) continue;
    const stored = existing.get(g.number);
    // Only what the file states and differs from what is stored.
    const nameChanged = !!stored && stored.name !== g.ref.name!;
    const phoneChanged = !!stored && g.ref.phone !== undefined && stored.phone !== g.ref.phone;
    const activeChanged = !!stored && g.ref.active !== undefined && stored.active !== g.ref.active;
    const customerAction = !stored ? "create" : nameChanged || phoneChanged || activeChanged ? "update" : "unchanged";
    summary.customers[customerAction]++;
    if (customerAction === "create") customers.push({ customerNumber: g.number, name: g.ref.name!, phone: g.ref.phone ?? null, active: g.ref.active ?? true, action: "create" });
    else if (customerAction === "update") {
      customers.push({
        customerNumber: g.number,
        name: g.ref.name!,
        ...(phoneChanged ? { phone: g.ref.phone } : {}),
        ...(activeChanged ? { active: g.ref.active } : {}),
        action: "update",
      });
    }

    ok.forEach((row, n) => {
      const email = row.contactEmail!;
      const name = row.contactName;
      const messages: CodedMessage[] = [];
      let action: ImportRowAction = "unchanged";
      if (n === 0 && customerAction === "create") messages.push({ code: "creates_customer" });
      if (n === 0 && customerAction === "update") {
        const fields = [nameChanged ? "name" : "", phoneChanged ? "phone" : ""].filter(Boolean);
        if (fields.length > 0) messages.push({ code: "updates_customer", params: { fields: fields.join(", ") } });
        if (activeChanged) messages.push({ code: g.ref.active ? "activates_customer" : "deactivates_customer" });
      }
      const current = stored?.contacts.get(email);
      if (!current) {
        summary.contacts.add++;
        contacts.push({ customerNumber: g.number, email, name: name ?? null, action: "add" });
        messages.push({ code: "adds_contact" });
      } else if (name !== undefined && current.name !== name) {
        summary.contacts.update++;
        contacts.push({ customerNumber: g.number, email, name, action: "update" });
        messages.push({ code: "updates_contact_name" });
      } else {
        summary.contacts.unchanged++;
      }
      if (current && !current.active) messages.push({ code: "contact_stays_inactive" });
      const contactChanged = !current || (name !== undefined && current.name !== name);
      if (customerAction === "create") action = "create";
      else if (contactChanged || (n === 0 && customerAction === "update")) action = "update";
      outcome.set(row, { action, messages });
    });
  }

  const rows: ImportRow[] = parsed.map((row) => {
    const base = { line: row.line, customerNumber: row.customerNumber, email: row.email };
    if (row.errors.length > 0) {
      summary.errors++;
      return { ...base, action: "error", messages: row.errors };
    }
    const o = outcome.get(row)!;
    return { ...base, ...o };
  });

  const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  customers.sort((a, b) => byKey(a.customerNumber, b.customerNumber));
  contacts.sort((a, b) => byKey(a.customerNumber, b.customerNumber) || byKey(a.email, b.email));
  return { rows, summary, warnings, customers, contacts };
}

/** SHA-256 (hex) of the canonical JSON of the planned writes, not of the raw text: edits that change nothing keep the hash. */
export async function planHash(plan: Pick<ImportPlan, "customers" | "contacts">): Promise<string> {
  // Fixed key order; fields the plan leaves alone are omitted by JSON.stringify.
  const canonical = JSON.stringify({
    customers: plan.customers.map((c) => ({ n: c.customerNumber, name: c.name, phone: c.phone, active: c.active, action: c.action })),
    contacts: plan.contacts.map((c) => ({ n: c.customerNumber, email: c.email, name: c.name, action: c.action })),
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
