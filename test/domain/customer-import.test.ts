import { describe, expect, it } from "vitest";
import sampleCsv from "../../docs/sample-customers.csv?raw";
import {
  CustomerImportError,
  planCustomerImport,
  planHash,
  type CodedMessage,
  type ExistingCustomer,
  type ExistingCustomers,
} from "../../src/domain/customer-import";
import { t } from "../../src/shared/i18n/i18n";

const HEADER = "customer_number,name,phone,contact_email,contact_name,active";
const NONE: ExistingCustomers = new Map();
const stored = (name: string, o: { phone?: string | null; active?: boolean; contacts?: Record<string, string | null> } = {}): ExistingCustomer => ({
  name,
  phone: o.phone ?? null,
  active: o.active ?? true,
  contacts: new Map(Object.entries(o.contacts ?? {}).map(([e, n]) => [e, { name: n, active: true }])),
});
const plan = (rows: string[], existing: ExistingCustomers = NONE, header = HEADER) => planCustomerImport([header, ...rows].join("\n"), existing);
const fileError = (csv: string) => {
  try {
    planCustomerImport(csv, NONE);
  } catch (e) {
    expect(e).toBeInstanceOf(CustomerImportError);
    return e as CustomerImportError;
  }
  throw new Error("expected CustomerImportError");
};
const codes = (m: CodedMessage[]) => m.map((x) => x.code);

describe("planCustomerImport: the file", () => {
  it("requires a header with customer_number, name and contact_email (case and spacing ignored)", () => {
    expect(fileError("").code).toBe("invalid_header");
    expect(fileError("").reason).toEqual({ code: "header_empty" });
    expect(fileError("customer_number,name\nC-1,Acme").reason).toEqual({ code: "header_missing_columns", params: { columns: "contact_email" } });
    expect(fileError("name,phone\nAcme,1").reason).toEqual({ code: "header_missing_columns", params: { columns: "customer_number, contact_email" } });
    expect(plan(["C-1,Acme,,a@example.test,,"], NONE, " Customer_Number , NAME ,Phone,Contact_Email,Contact_Name,ACTIVE ").summary.errors).toBe(0);
    expect(plan(["C-1,Acme,a@example.test"], NONE, "customer_number,name,contact_email").summary.customers.create).toBe(1);
  });

  it("warns about unknown columns and rejects duplicates", () => {
    const p = plan(["C-1,Acme,,a@example.test,,,x"], NONE, `${HEADER},Region`);
    expect(p.warnings).toEqual([{ code: "unknown_column", params: { column: "Region" } }]);
    expect(p.summary.errors).toBe(0);
    expect(fileError("customer_number,name,contact_email,Name\nC-1,A,a@example.test,B").reason).toEqual({ code: "header_duplicate_column", params: { column: "name" } });
  });

  it("reports malformed CSV with a code, line and column", () => {
    const e = fileError(`${HEADER}\nC-1,Say "hi",,a@example.test`);
    expect(e.code).toBe("invalid_csv");
    expect(e.reason).toEqual({ code: "csv_stray_quote", params: { line: 2, column: 9 } });
    expect([e.line, e.column]).toEqual([2, 9]);
    expect(e.message).toContain("wrap the field in double quotes");
  });

  it("allows 5000 data rows and rejects 5001", () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => `C-${i},Name ${i},,c${i}@example.test,,`);
    expect(plan(rows(5000)).summary.customers.create).toBe(5000);
    const e = fileError([HEADER, ...rows(5001)].join("\n"));
    expect(e.code).toBe("too_many_rows");
    expect(e.reason).toEqual({ code: "too_many_rows", params: { max: 5000 } });
  });

  it("skips blank lines and accepts BOM and CRLF", () => {
    const p = planCustomerImport(`﻿${HEADER}\r\n\r\nC-1,Acme,,a@example.test,,\r\n,,,,,\r\n`, NONE);
    expect(p.rows.map((r) => r.line)).toEqual([3]);
  });
});

describe("planCustomerImport: rows", () => {
  it("validates each field with the shared schemas and reports a code for every problem", () => {
    const p = plan([
      ",Acme,,a@example.test,,",
      "C 1,Acme,,a@example.test,,",
      "C-2,,,a@example.test,,",
      "C-3,Acme,abc,a@example.test,,",
      "C-4,Acme,,not-an-email,,",
      "C-5,Acme,,a@example.test,,maybe",
      "C-6,Acme,,,,",
      ",,,,,",
      "C-7,Acme,,a@example.test",
      "C-8,Acme,,a@example.test,,,extra",
      `${"N".repeat(41)},Acme,,a@example.test,,`,
      `C-9,${"n".repeat(201)},,a@example.test,,`,
      `C-10,Acme,${"1".repeat(41)},a@example.test,,`,
      `C-11,Acme,,a@example.test,${"c".repeat(101)},`,
      `C-12,Acme,,${"a".repeat(250)}@example.test,,`,
    ]);
    expect(p.rows.map((r) => r.action)).toEqual(Array(14).fill("error"));
    expect(p.rows.map((r) => r.messages)).toEqual([
      [{ code: "required", params: { field: "customer_number" } }],
      [{ code: "invalid_customer_number" }],
      [{ code: "required", params: { field: "name" } }],
      [{ code: "invalid_phone" }],
      [{ code: "invalid_email" }],
      [{ code: "invalid_active" }],
      [{ code: "required", params: { field: "contact_email" } }],
      [{ code: "column_count", params: { expected: 6, found: 4 } }],
      [{ code: "column_count", params: { expected: 6, found: 7 } }],
      [{ code: "too_long", params: { field: "customer_number", max: 40 } }],
      [{ code: "too_long", params: { field: "name", max: 200 } }],
      [{ code: "too_long", params: { field: "phone", max: 40 } }],
      [{ code: "too_long", params: { field: "contact_name", max: 100 } }],
      [{ code: "too_long", params: { field: "contact_email", max: 254 } }],
    ]);
    expect(p.summary.errors).toBe(14);
    expect(p.customers).toEqual([]);
  });

  it("every code the planner emits has English catalog text", () => {
    const messages = [
      "csv_stray_quote", "csv_text_after_quote", "csv_unterminated_quote", "header_empty", "header_missing_columns", "header_duplicate_column", "too_many_rows",
      "unknown_column", "column_count", "required", "invalid_customer_number", "invalid_email", "invalid_phone", "invalid_active", "too_long", "invalid_value",
      "field_differs", "duplicate_pair", "creates_customer", "updates_customer", "activates_customer", "deactivates_customer", "adds_contact",
      "updates_contact_name", "contact_stays_inactive",
    ];
    for (const code of messages) expect(t(`web.staff.import.messages.${code}`), code).not.toBe(`web.staff.import.messages.${code}`);
    expect(t("web.staff.import.messages.field_differs", { field: "name", value: "B", other: "A", line: 2 })).toBe('name "B" differs from "A" on line 2. Rows of one customer must agree.');
  });

  it("reads active as true/false/1/0/yes/no in any case; empty means true for a new customer", () => {
    const p = plan([
      "C-1,A,,a@example.test,,TRUE",
      "C-2,A,,a@example.test,,No",
      "C-3,A,,a@example.test,,1",
      "C-4,A,,a@example.test,,0",
      "C-5,A,,a@example.test,,YES",
      "C-6,A,,a@example.test,,false",
      "C-7,A,,a@example.test,,",
    ]);
    expect(p.customers.map((c) => c.active)).toEqual([true, false, true, false, true, false, true]);
  });

  it("lower-cases emails and trims every field; blank phone and contact name on a new customer are null", () => {
    const p = plan(["  C-1 , Acme  Co ,  +1 555 , Pat@Example.TEST , Pat ,", "C-2,Blank,,b@example.test,,"]);
    expect(p.contacts).toEqual([
      { customerNumber: "C-1", email: "pat@example.test", name: "Pat", action: "add" },
      { customerNumber: "C-2", email: "b@example.test", name: null, action: "add" },
    ]);
    expect(p.customers[0]).toMatchObject({ name: "Acme  Co", phone: "+1 555" });
    expect(p.customers[1]).toMatchObject({ phone: null, active: true });
  });

  it("merges rows of one customer into one customer with several contacts", () => {
    const p = plan(["C-1,Acme,+1 555,a@example.test,A,", "C-2,Other,,b@example.test,B,", "C-1,Acme,+1 555,c@example.test,C,true"]);
    expect(p.summary).toEqual({ customers: { create: 2, update: 0, unchanged: 0 }, contacts: { add: 3, update: 0, unchanged: 0 }, errors: 0 });
    expect(p.customers.map((c) => c.customerNumber)).toEqual(["C-1", "C-2"]);
    expect(p.rows.map((r) => r.action)).toEqual(["create", "create", "create"]);
    expect(codes(p.rows[0]!.messages)).toEqual(["creates_customer", "adds_contact"]);
    expect(codes(p.rows[2]!.messages)).toEqual(["adds_contact"]);
  });

  it("flags later rows that disagree on name, phone or active, and keeps the first stated value as the reference", () => {
    const p = plan(["C-1,Acme,+1 555,a@example.test,,", "C-1,Acme Two,+1 555,b@example.test,,", "C-1,Acme,+1 556,c@example.test,,", "C-1,Acme,+1 555,d@example.test,,no"]);
    // The last row states active=false where the first row left it blank: compatible, and it sets the value.
    expect(p.rows.map((r) => r.action)).toEqual(["create", "error", "error", "create"]);
    expect(p.rows[1]!.messages).toEqual([{ code: "field_differs", params: { field: "name", value: "Acme Two", other: "Acme", line: 2 } }]);
    expect(p.rows[2]!.messages).toEqual([{ code: "field_differs", params: { field: "phone", value: "+1 556", other: "+1 555", line: 2 } }]);
    expect(p.customers).toEqual([{ customerNumber: "C-1", name: "Acme", phone: "+1 555", active: false, action: "create" }]);
    const clash = plan(["C-1,Acme,,a@example.test,,yes", "C-1,Acme,,b@example.test,,no"]);
    expect(clash.rows[1]!.messages).toEqual([{ code: "field_differs", params: { field: "active", value: "false", other: "true", line: 2 } }]);
  });

  it("a blank phone or active on a row of a merged customer is compatible with a stated one", () => {
    const p = plan(["C-1,Acme,,a@example.test,,", "C-1,Acme,+1 555,b@example.test,,", "C-1,Acme,,c@example.test,,", "C-1,Acme,+1 555,d@example.test,,"]);
    expect(p.summary.errors).toBe(0);
    expect(p.customers).toEqual([{ customerNumber: "C-1", name: "Acme", phone: "+1 555", active: true, action: "create" }]);
    expect(plan(["C-1,Acme,+1 555,a@example.test,,", "C-1,Acme,+1 556,b@example.test,,"]).summary.errors).toBe(1);
  });

  it("flags a repeated (number, email) pair on the later row", () => {
    const p = plan(["C-1,Acme,,a@example.test,,", "C-1,Acme,,A@Example.test,Other,"]);
    expect(p.rows.map((r) => r.action)).toEqual(["create", "error"]);
    expect(p.rows[1]!.messages).toEqual([{ code: "duplicate_pair", params: { line: 2 } }]);
    // The same email under another customer is fine.
    expect(plan(["C-1,Acme,,a@example.test,,", "C-2,Other,,a@example.test,,"]).summary.errors).toBe(0);
  });

  it("treats customer numbers as case-sensitive, like the database", () => {
    expect(plan(["C-1,Acme,,a@example.test,,", "c-1,Acme,,a@example.test,,"]).summary.customers.create).toBe(2);
  });
});

describe("planCustomerImport: against stored customers", () => {
  const existing: ExistingCustomers = new Map([
    ["C-1", stored("Acme", { phone: "+1 555", contacts: { "a@example.test": "A", "b@example.test": null } })],
    ["C-2", stored("Gone Co", { active: false, contacts: { "z@example.test": "Z" } })],
  ]);

  it("marks an identical file unchanged and plans no writes", () => {
    const p = plan(["C-1,Acme,+1 555,a@example.test,A,", "C-1,Acme,+1 555,b@example.test,,"], existing);
    expect(p.rows.map((r) => [r.action, r.messages])).toEqual([["unchanged", []], ["unchanged", []]]);
    expect(p.summary).toEqual({ customers: { create: 0, update: 0, unchanged: 1 }, contacts: { add: 0, update: 0, unchanged: 2 }, errors: 0 });
    expect(p.customers).toEqual([]);
    expect(p.contacts).toEqual([]);
  });

  it("a blank phone, contact name or active leaves the stored value: unchanged, no write", () => {
    const p = plan(["C-1,Acme,,a@example.test,,", "C-2,Gone Co,,z@example.test,,"], existing);
    expect(p.rows.map((r) => [r.action, r.messages])).toEqual([["unchanged", []], ["unchanged", []]]);
    expect(p.summary).toEqual({ customers: { create: 0, update: 0, unchanged: 2 }, contacts: { add: 0, update: 0, unchanged: 2 }, errors: 0 });
    expect(p.customers).toEqual([]);
    expect(p.contacts).toEqual([]);
    // A file without the optional columns at all behaves the same, and does not reactivate C-2.
    const bare = planCustomerImport("customer_number,name,contact_email\nC-1,Acme,a@example.test\nC-2,Gone Co,z@example.test", existing);
    expect(bare.customers).toEqual([]);
    expect(bare.summary.customers).toEqual({ create: 0, update: 0, unchanged: 2 });
  });

  it("updates changed fields, sending only what the file states; adds new contacts; never deletes the rest", () => {
    const p = plan(["C-1,Acme Corp,,a@example.test,Alice,", "C-1,Acme Corp,,new@example.test,New,", "C-2,Gone Co,,z@example.test,Z,true"], existing);
    expect(p.summary).toEqual({ customers: { create: 0, update: 2, unchanged: 0 }, contacts: { add: 1, update: 1, unchanged: 1 }, errors: 0 });
    expect(p.customers).toEqual([
      { customerNumber: "C-1", name: "Acme Corp", action: "update" },
      { customerNumber: "C-2", name: "Gone Co", active: true, action: "update" },
    ]);
    expect(p.contacts.map((c) => [c.email, c.action])).toEqual([["a@example.test", "update"], ["new@example.test", "add"]]);
    expect(p.rows[0]!.messages).toEqual([{ code: "updates_customer", params: { fields: "name" } }, { code: "updates_contact_name" }]);
    expect(codes(p.rows[2]!.messages)).toEqual(["activates_customer"]);
  });

  it("an existing customer that gets only a new contact is an update; an inactive flag deactivates", () => {
    const a = plan(["C-1,Acme,+1 555,c@example.test,C,"], existing);
    expect([a.rows[0]!.action, a.summary.customers]).toEqual(["update", { create: 0, update: 0, unchanged: 1 }]);
    expect(codes(a.rows[0]!.messages)).toEqual(["adds_contact"]);
    const d = plan(["C-1,Acme,+1 555,a@example.test,A,false"], existing);
    expect(d.rows[0]!.action).toBe("update");
    expect(codes(d.rows[0]!.messages)).toEqual(["deactivates_customer"]);
    expect(d.customers[0]).toMatchObject({ active: false, action: "update" });
  });

  it("notes an inactive contact that the import leaves inactive", () => {
    const inactive: ExistingCustomers = new Map([["C-1", { ...stored("Acme"), contacts: new Map([["a@example.test", { name: null, active: false }]]) }]]);
    expect(plan(["C-1,Acme,,a@example.test,,"], inactive).rows[0]).toMatchObject({ action: "unchanged", messages: [{ code: "contact_stays_inactive" }] });
  });
});

describe("planHash", () => {
  const rows = ["C-1,Acme,+1 555,a@example.test,A,", "C-2,Other,,b@example.test,B,"];

  it("is a SHA-256 hex digest of the planned writes: formatting and row order do not matter, content does", async () => {
    const base = await planHash(plan(rows));
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(await planHash(plan([...rows].reverse()))).toBe(base);
    expect(await planHash(plan(["C-1 , Acme , +1 555 , A@EXAMPLE.test , A , TRUE", ...rows.slice(1), ""]))).toBe(base);
    expect(await planHash(plan(["C-1,Acme,+1 555,a@example.test,A2,", rows[1]!]))).not.toBe(base);
  });

  it("changes when the stored data changes the plan", async () => {
    const created = await planHash(plan(rows));
    const existing: ExistingCustomers = new Map([["C-1", stored("Acme", { phone: "+1 555", contacts: { "a@example.test": "A" } })]]);
    expect(await planHash(plan(rows, existing))).not.toBe(created);
  });
});

describe("sample file", () => {
  it("docs/sample-customers.csv previews as documented", () => {
    const p = planCustomerImport(sampleCsv, NONE);
    expect(p.summary).toEqual({ customers: { create: 5, update: 0, unchanged: 0 }, contacts: { add: 6, update: 0, unchanged: 0 }, errors: 0 });
    expect(p.customers.filter((c) => !c.active).map((c) => c.customerNumber)).toEqual(["C-1005"]);
    expect(p.customers.find((c) => c.customerNumber === "C-1003")!.phone).toBeNull();
    expect(p.rows.map((r) => r.action)).toEqual(Array(6).fill("create"));
  });
});
