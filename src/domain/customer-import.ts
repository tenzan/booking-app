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
import { CsvError, parseCsv, type CsvRecord } from "./csv";

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
  messages: string[];
}

export interface PlannedCustomer {
  customerNumber: string;
  name: string;
  phone: string | null;
  active: boolean;
  action: "create" | "update";
}

export interface PlannedContact {
  customerNumber: string;
  email: string;
  name: string | null;
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
  warnings: string[];
  /** The writes the file implies, sorted canonically. The plan hash covers exactly these. */
  customers: PlannedCustomer[];
  contacts: PlannedContact[];
}

export type ImportFileErrorCode = "invalid_csv" | "invalid_header" | "too_many_rows";

/** The file as a whole is unusable (malformed CSV, bad header, too many rows). */
export class CustomerImportError extends Error {
  constructor(
    public code: ImportFileErrorCode,
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
  phone: string | null;
  active: boolean;
}

interface ParsedRow {
  line: number;
  customerNumber: string;
  email: string;
  errors: string[];
  /** Present when customer_number, name, phone and active are all valid. */
  number?: string;
  customer?: CustomerFields;
  contactEmail?: string;
  contactName?: string | null;
}

const TRUE = /^(true|1|yes)$/i;
const FALSE = /^(false|0|no)$/i;

/** Message for the first issue of a failed parse, prefixed with the column it belongs to. */
function problem(column: string, issues: readonly { message: string }[]): string {
  return `${column}: ${issues[0]?.message ?? "invalid value"}`;
}

function readRow(record: CsvRecord, index: ReadonlyMap<string, number>, width: number): ParsedRow {
  const cell = (column: string) => {
    const i = index.get(column);
    return i === undefined ? "" : (record.fields[i] ?? "").trim();
  };
  const row: ParsedRow = { line: record.line, customerNumber: cell("customer_number"), email: cell("contact_email"), errors: [] };
  if (record.fields.length !== width) {
    row.errors.push(`expected ${width} columns like the header, found ${record.fields.length}`);
    return row;
  }

  let number: string | undefined;
  const numberRaw = cell("customer_number");
  if (numberRaw === "") row.errors.push("customer_number is required");
  else {
    const r = customerNumberSchema.safeParse(numberRaw);
    if (r.success) number = r.data;
    else row.errors.push(problem("customer_number", r.error.issues));
  }

  let name: string | undefined;
  const nameRaw = cell("name");
  if (nameRaw === "") row.errors.push("name is required");
  else {
    const r = customerNameSchema.safeParse(nameRaw);
    if (r.success) name = r.data;
    else row.errors.push(problem("name", r.error.issues));
  }

  let phone: string | null | undefined;
  const phoneRaw = cell("phone");
  if (phoneRaw === "") phone = null;
  else {
    const r = phoneSchema.safeParse(phoneRaw);
    if (r.success) phone = r.data;
    else row.errors.push(problem("phone", r.error.issues));
  }

  let active: boolean | undefined;
  const activeRaw = cell("active");
  if (activeRaw === "" || TRUE.test(activeRaw)) active = true;
  else if (FALSE.test(activeRaw)) active = false;
  else row.errors.push("active: use true or false (also yes/no, 1/0); leave empty for true");

  const emailRaw = cell("contact_email");
  if (emailRaw === "") row.errors.push("contact_email is required");
  else {
    const r = emailSchema.safeParse(emailRaw);
    if (r.success) row.contactEmail = r.data;
    else row.errors.push("contact_email: not a valid email address");
  }

  const contactRaw = cell("contact_name");
  if (contactRaw === "") row.contactName = null;
  else {
    const r = contactNameSchema.safeParse(contactRaw);
    if (r.success) row.contactName = r.data;
    else row.errors.push(problem("contact_name", r.error.issues));
  }

  if (number !== undefined && name !== undefined && phone !== undefined && active !== undefined) {
    row.number = number;
    row.customer = { name, phone, active };
  }
  return row;
}

// ---- Planning ---------------------------------------------------------------------------------------------------

function readHeader(records: CsvRecord[]): { index: Map<string, number>; width: number; warnings: string[] } {
  const header = records[0];
  if (!header) throw new CustomerImportError("invalid_header", "the file is empty: the first line must be the header row", 1);
  const index = new Map<string, number>();
  const warnings: string[] = [];
  header.fields.forEach((raw, i) => {
    const column = raw.trim().toLowerCase();
    if (!KNOWN_COLUMNS.includes(column)) {
      warnings.push(`unknown column "${raw.trim()}" is ignored`);
      return;
    }
    if (index.has(column)) throw new CustomerImportError("invalid_header", `column ${column} appears twice in the header`, header.line);
    index.set(column, i);
  });
  const missing = REQUIRED_COLUMNS.filter((c) => !index.has(c));
  if (missing.length > 0) {
    throw new CustomerImportError("invalid_header", `the header is missing the required column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`, header.line);
  }
  return { index, width: header.fields.length, warnings };
}

interface Group {
  number: string;
  ref: CustomerFields;
  refLine: number;
  rows: ParsedRow[];
}

const same = (a: CustomerFields, b: CustomerFields) => a.name === b.name && a.phone === b.phone && a.active === b.active;

/**
 * Plans an import. Throws CustomerImportError when the file as a whole is unusable; every problem with a single row
 * becomes an "error" row (the preview shows them all; apply refuses a file that has any).
 */
export function planCustomerImport(csv: string, existing: ExistingCustomers): ImportPlan {
  let records: CsvRecord[];
  try {
    records = parseCsv(csv);
  } catch (e) {
    if (e instanceof CsvError) throw new CustomerImportError("invalid_csv", e.message, e.line, e.column);
    throw e;
  }
  const { index, width, warnings } = readHeader(records);
  const dataRecords = records.slice(1).filter((r) => r.fields.some((f) => f.trim() !== ""));
  if (dataRecords.length > MAX_CUSTOMER_IMPORT_ROWS) {
    throw new CustomerImportError("too_many_rows", `at most ${MAX_CUSTOMER_IMPORT_ROWS} rows per import; split the file`);
  }

  const parsed = dataRecords.map((r) => readRow(r, index, width));

  // Rows of one customer must agree on its own fields; the first row with valid customer fields is the reference.
  const groups = new Map<string, Group>();
  const pairs = new Map<string, number>();
  for (const row of parsed) {
    if (row.number !== undefined && row.customer) {
      const g = groups.get(row.number);
      if (!g) groups.set(row.number, { number: row.number, ref: row.customer, refLine: row.line, rows: [row] });
      else {
        g.rows.push(row);
        const diff = (["name", "phone", "active"] as const).filter((k) => row.customer![k] !== g.ref[k]);
        for (const k of diff) {
          const shown = (v: string | boolean | null) => (v === null || v === "" ? "empty" : `"${v}"`);
          row.errors.push(`${k} ${shown(row.customer[k])} differs from ${shown(g.ref[k])} on line ${g.refLine}; rows of one customer must agree`);
        }
      }
    }
    if (row.number !== undefined && row.contactEmail !== undefined) {
      const key = `${row.number}\u0000${row.contactEmail}`;
      const first = pairs.get(key);
      if (first === undefined) pairs.set(key, row.line);
      else row.errors.push(`duplicate of line ${first}: the same customer_number and contact_email appear twice`);
    }
  }

  const summary: ImportSummary = { customers: { create: 0, update: 0, unchanged: 0 }, contacts: { add: 0, update: 0, unchanged: 0 }, errors: 0 };
  const customers: PlannedCustomer[] = [];
  const contacts: PlannedContact[] = [];
  const outcome = new Map<ParsedRow, { action: ImportRowAction; messages: string[] }>();

  for (const g of groups.values()) {
    const ok = g.rows.filter((r) => r.errors.length === 0 && r.contactEmail !== undefined);
    if (ok.length === 0) continue;
    const stored = existing.get(g.number);
    const changed = stored ? (["name", "phone", "active"] as const).filter((k) => stored[k] !== g.ref[k]) : [];
    const customerAction = !stored ? "create" : changed.length > 0 ? "update" : "unchanged";
    summary.customers[customerAction]++;
    if (customerAction !== "unchanged") customers.push({ customerNumber: g.number, ...g.ref, action: customerAction });

    ok.forEach((row, n) => {
      const email = row.contactEmail!;
      const name = row.contactName ?? null;
      const messages: string[] = [];
      let action: ImportRowAction = "unchanged";
      if (n === 0 && customerAction === "create") messages.push("creates the customer");
      if (n === 0 && customerAction === "update") {
        messages.push(`updates the customer: ${changed.map((k) => (k === "active" ? (g.ref.active ? "activates" : "deactivates") : k)).join(", ")}`);
      }
      const current = stored?.contacts.get(email);
      if (!current) {
        summary.contacts.add++;
        contacts.push({ customerNumber: g.number, email, name, action: "add" });
        messages.push("adds the contact");
      } else if (current.name !== name) {
        summary.contacts.update++;
        contacts.push({ customerNumber: g.number, email, name, action: "update" });
        messages.push("updates the contact name");
      } else {
        summary.contacts.unchanged++;
      }
      if (current && !current.active) messages.push("the contact is inactive and stays inactive");
      if (customerAction === "create") action = "create";
      else if (!current || current.name !== name || (n === 0 && customerAction === "update")) action = "update";
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
  const canonical = JSON.stringify({
    customers: plan.customers.map((c) => [c.customerNumber, c.name, c.phone, c.active, c.action]),
    contacts: plan.contacts.map((c) => [c.customerNumber, c.email, c.name, c.action]),
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
