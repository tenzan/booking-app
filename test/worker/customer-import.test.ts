import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import sampleCsv from "../../docs/sample-customers.csv?raw";
import { api } from "../helpers";
import { loginStaff, seedCustomer, seedTeam } from "../fixtures";

const HEADER = "customer_number,name,phone,contact_email,contact_name,active";
let adminCookie: string;
let techCookie: string;

beforeEach(async () => {
  await seedTeam();
  adminCookie = await loginStaff("admin@example.test");
  techCookie = await loginStaff("tech-a@example.test");
});

const preview = (csv: string, cookie = adminCookie) => api("POST", "/api/staff/customers/import/preview", { cookie, body: { csv } });
const apply = (csv: string, planHash: string, cookie = adminCookie) => api("POST", "/api/staff/customers/import/apply", { cookie, body: { csv, planHash } });
/** Preview, then apply with the previewed hash. */
const run = async (csv: string) => {
  const p = await preview(csv);
  expect(p.status, JSON.stringify(p.json)).toBe(200);
  return apply(csv, p.json.planHash);
};
const file = (...rows: string[]) => [HEADER, ...rows].join("\n");
const count = async (sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;
const customerRow = (number: string) =>
  env.DB.prepare("SELECT id, name, phone, notes, active, created_at AS createdAt FROM customers WHERE customer_number = ?").bind(number).first<any>();
const contactsOf = async (number: string) =>
  (
    await env.DB.prepare(
      "SELECT cc.email AS email, cc.name AS name, cc.active AS active FROM customer_contacts cc JOIN customers c ON c.id = cc.customer_id WHERE c.customer_number = ? ORDER BY cc.id",
    )
      .bind(number)
      .all<any>()
  ).results;
const importAudits = async () =>
  (await env.DB.prepare("SELECT actor_kind, actor, action, customer_id, details FROM audit_log WHERE action = 'customers.import' ORDER BY id").all<any>()).results.map((a) => ({
    ...a,
    details: JSON.parse(a.details),
  }));

describe("access and validation", () => {
  it("is admin-only and needs a session", async () => {
    const csv = file("C-1,Acme,,a@example.test,,");
    expect((await preview(csv, techCookie)).status).toBe(403);
    expect((await apply(csv, "0".repeat(64), techCookie)).status).toBe(403);
    expect((await api("POST", "/api/staff/customers/import/preview", { body: { csv } })).status).toBe(401);
    expect(await count("SELECT COUNT(*) AS n FROM customers")).toBe(0);
  });

  it("rejects malformed bodies", async () => {
    expect((await api("POST", "/api/staff/customers/import/preview", { cookie: adminCookie, body: {} })).status).toBe(400);
    expect((await api("POST", "/api/staff/customers/import/apply", { cookie: adminCookie, body: { csv: file(), planHash: "nope" } })).status).toBe(400);
  });

  it("answers file-level problems with 400 and the reason", async () => {
    const bad = await preview(`${HEADER}\nC-1,Say "hi",,a@example.test,,`);
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("invalid_csv");
    expect(bad.json.details).toMatchObject({ line: 2, column: 9 });
    expect(bad.json.details.message).toContain("wrap the field in double quotes");

    const noHeader = await preview("customer_number,name\nC-1,Acme");
    expect([noHeader.status, noHeader.json.error]).toEqual([400, "invalid_header"]);
    expect(noHeader.json.details.message).toContain("contact_email");

    const many = await preview(file(...Array.from({ length: 5001 }, (_, i) => `C-${i},N,,c${i}@example.test,,`)));
    expect([many.status, many.json.error]).toEqual([400, "too_many_rows"]);
  });
});

describe("preview", () => {
  it("plans the sample file without writing anything", async () => {
    const res = await preview(sampleCsv);
    expect(res.status).toBe(200);
    expect(res.json.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.json.summary).toEqual({ customers: { create: 5, update: 0, unchanged: 0 }, contacts: { add: 6, update: 0, unchanged: 0 }, errors: 0 });
    expect(res.json.warnings).toEqual([]);
    expect(res.json.rows).toHaveLength(6);
    expect(res.json.rows[0]).toEqual({ line: 2, customerNumber: "C-1001", email: "frontdesk@example.test", action: "create", messages: ["creates the customer", "adds the contact"] });
    expect(res.json.rows[1]).toMatchObject({ line: 3, email: "manager@example.test", action: "create", messages: ["adds the contact"] });
    expect(res.json.rows[5]).toMatchObject({ customerNumber: "C-1005", action: "create" });
    expect(await count("SELECT COUNT(*) AS n FROM customers")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'customers.import'")).toBe(0);
  });

  it("returns the same hash for an equivalent file", async () => {
    const a = await preview(file("C-1,Acme,,a@example.test,A,", "C-2,Two,,b@example.test,,"));
    const b = await preview(`${HEADER}\r\n\r\n C-2 ,Two,,B@Example.test,,TRUE\r\n C-1 ,Acme,,a@example.test,A,\r\n`);
    expect(b.json.planHash).toBe(a.json.planHash);
  });

  it("lists every error row and still previews the valid ones", async () => {
    const res = await preview(file("C-1,Acme,,a@example.test,,", "C-2,,,b@example.test,,", "C-1,Other,,c@example.test,,"));
    expect(res.status).toBe(200);
    expect(res.json.rows.map((r: any) => r.action)).toEqual(["create", "error", "error"]);
    expect(res.json.summary.errors).toBe(2);
    expect(res.json.rows[1].messages).toEqual(["name is required"]);
    expect(res.json.rows[2].messages[0]).toContain("differs");
  });
});

describe("apply", () => {
  it("imports the sample file: customers, contacts, inactive flag, audit", async () => {
    const res = await run(sampleCsv);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toEqual({ created: 5, updated: 0, unchanged: 0, contactsAdded: 6, contactsUpdated: 0, chunks: 1 });
    expect(await count("SELECT COUNT(*) AS n FROM customers")).toBe(5);
    expect(await count("SELECT COUNT(*) AS n FROM customer_contacts")).toBe(6);
    expect((await contactsOf("C-1001")).map((k) => [k.email, k.name, k.active])).toEqual([["frontdesk@example.test", "Jamie Doe", 1], ["manager@example.test", "Riley Roe", 1]]);
    expect(await customerRow("C-1001")).toMatchObject({ name: "Example Dental Clinic", phone: "+1-555-0100", notes: null, active: 1 });
    expect(await customerRow("C-1003")).toMatchObject({ phone: null });
    expect((await customerRow("C-1005")).active).toBe(0);
    expect(await importAudits()).toEqual([
      {
        actor_kind: "staff",
        actor: String((await env.DB.prepare("SELECT id FROM staff WHERE email = 'admin@example.test'").first<{ id: number }>())!.id),
        action: "customers.import",
        customer_id: null,
        details: { created: 5, updated: 0, unchanged: 0, contactsAdded: 6, contactsUpdated: 0 },
      },
    ]);
  });

  it("re-importing the same file changes nothing and is refused as nothing_to_import", async () => {
    expect((await run(sampleCsv)).status).toBe(200);
    const again = await preview(sampleCsv);
    expect(again.json.summary).toEqual({ customers: { create: 0, update: 0, unchanged: 5 }, contacts: { add: 0, update: 0, unchanged: 6 }, errors: 0 });
    expect(again.json.rows.every((r: any) => r.action === "unchanged" && r.messages.length === 0)).toBe(true);
    const res = await apply(sampleCsv, again.json.planHash);
    expect([res.status, res.json.error]).toEqual([400, "nothing_to_import"]);
    expect((await importAudits()).length).toBe(1);
  });

  it("one customer with two contacts across rows; the contacts share the customer", async () => {
    const res = await run(file("C-9,Acme,+1 555,a@example.test,Alice,", "C-9,Acme,+1 555,b@example.test,Bob,yes"));
    expect(res.json).toMatchObject({ created: 1, contactsAdded: 2 });
    expect(await count("SELECT COUNT(*) AS n FROM customers")).toBe(1);
    expect((await contactsOf("C-9")).map((k) => k.email)).toEqual(["a@example.test", "b@example.test"]);
  });

  it("disagreeing names for one number block the apply and write nothing", async () => {
    const csv = file("C-9,Acme,,a@example.test,,", "C-9,Acme Two,,b@example.test,,");
    const p = await preview(csv);
    expect(p.json.rows.map((r: any) => r.action)).toEqual(["create", "error"]);
    const res = await apply(csv, p.json.planHash);
    expect([res.status, res.json.error]).toEqual([400, "invalid_rows"]);
    expect(res.json.details.rows).toHaveLength(1);
    expect(res.json.details.rows[0]).toMatchObject({ line: 3, action: "error" });
    expect(await count("SELECT COUNT(*) AS n FROM customers")).toBe(0);
  });

  it("refuses a stale plan: 409 stale_import when the data changed after the preview", async () => {
    const csv = file("C-1,Acme,,a@example.test,,", "C-2,Two,,b@example.test,,");
    const p = await preview(csv);
    await seedCustomer({ number: "C-2", name: "Two", email: "b@example.test" }); // C-2 now exists: that row becomes a no-op
    const res = await apply(csv, p.json.planHash);
    expect([res.status, res.json.error]).toEqual([409, "stale_import"]);
    expect(await count("SELECT COUNT(*) AS n FROM customers WHERE customer_number = 'C-1'")).toBe(0);
    // A hash from a different file is stale too.
    const other = await preview(file("C-5,Five,,e@example.test,,"));
    expect((await apply(csv, other.json.planHash)).status).toBe(409);
  });

  it("an existing customer gets a new contact; its notes, created_at and other contacts are untouched", async () => {
    const id = await seedCustomer({ number: "C-1", name: "Acme", email: "old@example.test" });
    await env.DB.prepare("UPDATE customers SET notes = 'keep me', created_at = 123 WHERE id = ?").bind(id).run();
    const csv = file("C-1,Acme,,new@example.test,New,");
    const p = await preview(csv);
    expect(p.json.rows[0]).toMatchObject({ action: "update", messages: ["adds the contact"] });
    expect(p.json.summary).toMatchObject({ customers: { unchanged: 1 }, contacts: { add: 1 } });
    const res = await apply(csv, p.json.planHash);
    expect(res.json).toMatchObject({ created: 0, updated: 0, unchanged: 1, contactsAdded: 1 });
    expect((await contactsOf("C-1")).map((k) => k.email)).toEqual(["old@example.test", "new@example.test"]);
    expect(await customerRow("C-1")).toMatchObject({ id, notes: "keep me", createdAt: 123, name: "Acme" });
  });

  it("updates name, phone and contact name; an inactive customer in the file deactivates", async () => {
    const id = await seedCustomer({ number: "C-1", name: "Acme", email: "a@example.test" });
    const res = await run(file("C-1,Acme Corp,+1 555,a@example.test,Alice,false"));
    expect(res.json).toMatchObject({ created: 0, updated: 1, contactsUpdated: 1 });
    expect(await customerRow("C-1")).toMatchObject({ id, name: "Acme Corp", phone: "+1 555", active: 0 });
    expect(await contactsOf("C-1")).toEqual([{ email: "a@example.test", name: "Alice", active: 1 }]);
    expect((await importAudits())[0]!.details).toEqual({ created: 0, updated: 1, unchanged: 0, contactsAdded: 0, contactsUpdated: 1 });
  });

  it("never deletes or deactivates what the file does not mention", async () => {
    await seedCustomer({ number: "C-1", name: "Acme", email: "a@example.test" });
    await seedCustomer({ number: "C-2", name: "Two", email: "b@example.test" });
    await run(file("C-1,Acme,,new@example.test,,"));
    expect(await count("SELECT COUNT(*) AS n FROM customers WHERE active = 1")).toBe(2);
    expect(await count("SELECT COUNT(*) AS n FROM customer_contacts WHERE active = 1")).toBe(3);
  });

  it("leaves an inactive contact inactive", async () => {
    await seedCustomer({ number: "C-1", name: "Acme", email: "a@example.test", contactActive: false });
    const p = await preview(file("C-1,Acme,,a@example.test,Alice,"));
    expect(p.json.rows[0].messages).toContain("the contact is inactive and stays inactive");
    await apply(file("C-1,Acme,,a@example.test,Alice,"), p.json.planHash);
    expect(await contactsOf("C-1")).toEqual([{ email: "a@example.test", name: "Alice", active: 0 }]);
  });
});

describe("chunking", () => {
  const many = (n: number) => file(...Array.from({ length: n }, (_, i) => `C-${String(i).padStart(4, "0")},Customer ${i},,c${i}@example.test,Contact ${i},`));

  it("writes 300 customers and 300 contacts in chunks of at most 100 statements, the audit row last", async () => {
    const csv = many(300);
    const p = await preview(csv);
    expect(p.json.summary).toMatchObject({ customers: { create: 300 }, contacts: { add: 300 } });
    const res = await apply(csv, p.json.planHash);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    // 600 writes + 1 audit statement = 601 statements = 7 chunks.
    expect(res.json).toMatchObject({ created: 300, contactsAdded: 300, chunks: 7 });
    expect(await count("SELECT COUNT(*) AS n FROM customers")).toBe(300);
    expect(await count("SELECT COUNT(*) AS n FROM customer_contacts")).toBe(300);
    expect(await count("SELECT COUNT(*) AS n FROM customers c WHERE EXISTS (SELECT 1 FROM customer_contacts k WHERE k.customer_id = c.id)")).toBe(300);
    expect(await importAudits()).toHaveLength(1);
  });

  it("reports how many chunks committed when a later one fails, and re-running the same file converges", async () => {
    const csv = many(250);
    const p = await preview(csv);
    // The third chunk (statements 201-300) holds customers 200-249 and the first contacts; fail on customer 220.
    await env.DB.prepare(
      "CREATE TRIGGER fail_import BEFORE INSERT ON customers WHEN NEW.customer_number = 'C-0220' BEGIN SELECT RAISE(ABORT, 'boom'); END",
    ).run();
    const failed = await apply(csv, p.json.planHash);
    expect([failed.status, failed.json.error]).toEqual([500, "import_failed"]);
    expect(failed.json.details).toEqual({ committedChunks: 2, totalChunks: 6 });
    expect(await count("SELECT COUNT(*) AS n FROM customers")).toBe(200);
    expect(await importAudits()).toHaveLength(0);

    await env.DB.prepare("DROP TRIGGER fail_import").run();
    // The earlier preview is stale now (200 customers exist); preview again and re-run the same file.
    const again = await preview(csv);
    expect(again.json.summary).toMatchObject({ customers: { create: 50, unchanged: 200 }, contacts: { add: 250 } });
    const done = await apply(csv, again.json.planHash);
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM customers")).toBe(250);
    expect(await count("SELECT COUNT(*) AS n FROM customer_contacts")).toBe(250);
    expect((await preview(csv)).json.summary).toMatchObject({ customers: { unchanged: 250 }, contacts: { unchanged: 250 } });
    expect(await importAudits()).toHaveLength(1);
  });
});
