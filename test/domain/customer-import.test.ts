import sampleCsv from "../../docs/sample-customers.csv?raw";
import { describe, expect, it } from "vitest";
import {
  CustomerImportError,
  planCustomerImport,
  planHash,
  type ExistingCustomer,
  type ExistingCustomers,
} from "../../src/domain/customer-import";

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

describe("planCustomerImport: the file", () => {
  it("requires a header with customer_number, name and contact_email (case and spacing ignored)", () => {
    expect(fileError("").code).toBe("invalid_header");
    expect(fileError("customer_number,name\nC-1,Acme").message).toContain("contact_email");
    expect(fileError("name,phone\nAcme,1").message).toMatch(/customer_number, contact_email/);
    expect(plan(["C-1,Acme,,a@example.test,,"], NONE, " Customer_Number , NAME ,Phone,Contact_Email,Contact_Name,ACTIVE ").summary.errors).toBe(0);
    expect(plan(["C-1,Acme,a@example.test"], NONE, "customer_number,name,contact_email").summary.customers.create).toBe(1);
  });

  it("warns about unknown columns and rejects duplicates", () => {
    const p = plan(["C-1,Acme,,a@example.test,,,x"], NONE, `${HEADER},Region`);
    expect(p.warnings).toEqual(['unknown column "Region" is ignored']);
    expect(p.summary.errors).toBe(0);
    expect(fileError("customer_number,name,contact_email,Name\nC-1,A,a@example.test,B").message).toContain("twice");
  });

  it("reports malformed CSV with line and column", () => {
    const e = fileError(`${HEADER}\nC-1,Say "hi",,a@example.test`);
    expect(e.code).toBe("invalid_csv");
    expect([e.line, e.column]).toEqual([2, 9]);
    expect(e.message).toContain("wrap the field in double quotes");
  });

  it("allows 5000 data rows and rejects 5001", () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => `C-${i},Name ${i},,c${i}@example.test,,`);
    expect(plan(rows(5000)).summary.customers.create).toBe(5000);
    const e = fileError([HEADER, ...rows(5001)].join("\n"));
    expect(e.code).toBe("too_many_rows");
  });

  it("skips blank lines and accepts BOM and CRLF", () => {
    const p = planCustomerImport(`﻿${HEADER}\r\n\r\nC-1,Acme,,a@example.test,,\r\n,,,,,\r\n`, NONE);
    expect(p.rows.map((r) => r.line)).toEqual([3]);
  });
});

describe("planCustomerImport: rows", () => {
  it("validates each field with the shared schemas and reports every problem of a row", () => {
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
    ]);
    // The all-empty line is skipped like a blank one; the rest each fail.
    expect(p.rows.map((r) => r.action)).toEqual(Array(9).fill("error"));
    expect(p.rows[0]!.messages).toEqual(["customer_number is required"]);
    expect(p.rows[1]!.messages[0]).toMatch(/^customer_number: /);
    expect(p.rows[2]!.messages).toEqual(["name is required"]);
    expect(p.rows[3]!.messages[0]).toMatch(/^phone: /);
    expect(p.rows[4]!.messages).toEqual(["contact_email: not a valid email address"]);
    expect(p.rows[5]!.messages[0]).toMatch(/^active: /);
    expect(p.rows[6]!.messages).toEqual(["contact_email is required"]);
    expect(p.rows[7]!.messages[0]).toMatch(/expected 6 columns/);
    expect(p.rows[8]!.messages[0]).toMatch(/found 7/);
    expect(p.summary.errors).toBe(9);
    expect(p.customers).toEqual([]);
  });

  it("reads active as true/false/1/0/yes/no in any case; empty means true", () => {
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

  it("lower-cases emails and trims every field", () => {
    const p = plan(["  C-1 , Acme  Co ,  +1 555 , Pat@Example.TEST , Pat ,"]);
    expect(p.contacts).toEqual([{ customerNumber: "C-1", email: "pat@example.test", name: "Pat", action: "add" }]);
    expect(p.customers[0]).toMatchObject({ name: "Acme  Co", phone: "+1 555" });
  });

  it("merges rows of one customer into one customer with several contacts", () => {
    const p = plan(["C-1,Acme,+1 555,a@example.test,A,", "C-2,Other,,b@example.test,B,", "C-1,Acme,+1 555,c@example.test,C,true"]);
    expect(p.summary).toEqual({ customers: { create: 2, update: 0, unchanged: 0 }, contacts: { add: 3, update: 0, unchanged: 0 }, errors: 0 });
    expect(p.customers.map((c) => c.customerNumber)).toEqual(["C-1", "C-2"]);
    expect(p.rows.map((r) => r.action)).toEqual(["create", "create", "create"]);
    expect(p.rows[0]!.messages).toEqual(["creates the customer", "adds the contact"]);
    expect(p.rows[2]!.messages).toEqual(["adds the contact"]);
  });

  it("flags later rows that disagree on name, phone or active, and keeps the first row as the reference", () => {
    const p = plan(["C-1,Acme,+1 555,a@example.test,,", "C-1,Acme Two,+1 555,b@example.test,,", "C-1,Acme,,c@example.test,,", "C-1,Acme,+1 555,d@example.test,,no"]);
    expect(p.rows.map((r) => r.action)).toEqual(["create", "error", "error", "error"]);
    expect(p.rows[1]!.messages[0]).toBe('name "Acme Two" differs from "Acme" on line 2; rows of one customer must agree');
    expect(p.rows[2]!.messages[0]).toContain("phone empty differs");
    expect(p.rows[3]!.messages[0]).toContain('active "false" differs');
    expect(p.customers).toEqual([{ customerNumber: "C-1", name: "Acme", phone: "+1 555", active: true, action: "create" }]);
  });

  it("flags a repeated (number, email) pair on the later row", () => {
    const p = plan(["C-1,Acme,,a@example.test,,", "C-1,Acme,,A@Example.test,Other,"]);
    expect(p.rows.map((r) => r.action)).toEqual(["create", "error"]);
    expect(p.rows[1]!.messages).toEqual(["duplicate of line 2: the same customer_number and contact_email appear twice"]);
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

  it("marks an identical file unchanged and plans no writes", async () => {
    const p = plan(["C-1,Acme,+1 555,a@example.test,A,", "C-1,Acme,+1 555,b@example.test,,"], existing);
    expect(p.rows.map((r) => [r.action, r.messages])).toEqual([["unchanged", []], ["unchanged", []]]);
    expect(p.summary).toEqual({ customers: { create: 0, update: 0, unchanged: 1 }, contacts: { add: 0, update: 0, unchanged: 2 }, errors: 0 });
    expect(p.customers).toEqual([]);
    expect(p.contacts).toEqual([]);
  });

  it("updates changed customer fields and contact names, adds new contacts, never deletes the rest", () => {
    const p = plan(["C-1,Acme Corp,,a@example.test,Alice,", "C-1,Acme Corp,,new@example.test,New,", "C-2,Gone Co,,z@example.test,Z,true"], existing);
    expect(p.summary).toEqual({ customers: { create: 0, update: 2, unchanged: 0 }, contacts: { add: 1, update: 1, unchanged: 1 }, errors: 0 });
    expect(p.customers).toEqual([
      { customerNumber: "C-1", name: "Acme Corp", phone: null, active: true, action: "update" },
      { customerNumber: "C-2", name: "Gone Co", phone: null, active: true, action: "update" },
    ]);
    expect(p.contacts.map((c) => [c.email, c.action])).toEqual([["a@example.test", "update"], ["new@example.test", "add"]]);
    expect(p.rows[0]!.messages).toEqual(["updates the customer: name, phone", "updates the contact name"]);
    expect(p.rows[2]!.messages).toEqual(["updates the customer: activates"]);
  });

  it("an existing customer that gets only a new contact is an update; an inactive flag deactivates", () => {
    const a = plan(["C-1,Acme,+1 555,c@example.test,C,"], existing);
    expect([a.rows[0]!.action, a.summary.customers]).toEqual(["update", { create: 0, update: 0, unchanged: 1 }]);
    expect(a.rows[0]!.messages).toEqual(["adds the contact"]);
    const d = plan(["C-1,Acme,+1 555,a@example.test,A,false"], existing);
    expect(d.rows[0]!.action).toBe("update");
    expect(d.rows[0]!.messages).toEqual(["updates the customer: deactivates"]);
    expect(d.customers[0]).toMatchObject({ active: false, action: "update" });
  });

  it("notes an inactive contact that the import leaves inactive", () => {
    const inactive: ExistingCustomers = new Map([["C-1", { ...stored("Acme"), contacts: new Map([["a@example.test", { name: null, active: false }]]) }]]);
    expect(plan(["C-1,Acme,,a@example.test,,"], inactive).rows[0]).toMatchObject({ action: "unchanged", messages: ["the contact is inactive and stays inactive"] });
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
