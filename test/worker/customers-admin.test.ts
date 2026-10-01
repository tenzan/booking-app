import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../helpers";
import { lastMailTo, loginCustomer, loginStaff, seedCustomer, seedTeam, seedWeekly, TZ } from "../fixtures";
import { setNow } from "../../src/worker/lib/clock";
import { wallToUtc } from "../../src/domain/time";

afterEach(() => setNow(null));

const THU = "2026-10-01";
const FRI = "2026-10-02";
const at = (date: string, h: number, m = 0) => wallToUtc(date, h * 60 + m, TZ);

let team: Awaited<ReturnType<typeof seedTeam>>;
let adminCookie: string;
let techCookie: string;

beforeEach(async () => {
  setNow(at(THU, 8));
  team = await seedTeam();
  await seedWeekly(5, 600, 720, [team.a, team.b]);
  adminCookie = await loginStaff("admin@example.test");
  techCookie = await loginStaff("tech-a@example.test");
});

const count = async (sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;
const version = async () => (await env.DB.prepare("SELECT version FROM schedule_state").first<{ version: number }>())!.version;
const audits = async (like = "customer.%") =>
  (await env.DB.prepare("SELECT actor_kind, actor, action, customer_id, details FROM audit_log WHERE action LIKE ? ORDER BY id").bind(like).all<any>()).results.map((a) => ({
    ...a,
    details: JSON.parse(a.details),
  }));

const list = (qs = "", cookie = adminCookie) => api("GET", `/api/staff/customers${qs}`, { cookie });
const detail = (id: number, cookie = adminCookie) => api("GET", `/api/staff/customers/${id}`, { cookie });
const create = (body: Record<string, unknown>, cookie = adminCookie) => api("POST", "/api/staff/customers", { cookie, body });
const patch = (id: number, body: Record<string, unknown>, cookie = adminCookie) => api("PATCH", `/api/staff/customers/${id}`, { cookie, body });
const setActive = (id: number, active: boolean, cookie = adminCookie) => api("POST", `/api/staff/customers/${id}/active`, { cookie, body: { active } });
const addContact = (id: number, body: Record<string, unknown>, cookie = adminCookie) => api("POST", `/api/staff/customers/${id}/contacts`, { cookie, body });
const patchContact = (id: number, contactId: number, body: Record<string, unknown>, cookie = adminCookie) =>
  api("PATCH", `/api/staff/customers/${id}/contacts/${contactId}`, { cookie, body });
const removeContact = (id: number, contactId: number, cookie = adminCookie) => api("DELETE", `/api/staff/customers/${id}/contacts/${contactId}`, { cookie });
const contactId = async (customerId: number, email: string) =>
  (await env.DB.prepare("SELECT id FROM customer_contacts WHERE customer_id = ? AND email = ?").bind(customerId, email).first<{ id: number }>())!.id;

const submit = async (cookie: string, customerId: number, startAt: number) => {
  const res = await api("POST", "/api/customer/reservations", {
    cookie,
    body: { customerId, startAt, contactName: "Pat Example", phone: "+81 3-1234-5678", issue: "Printer is offline", idempotencyKey: crypto.randomUUID() },
  });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json.reservation.id as string;
};

const newCustomer = { customerNumber: "ACME-001", name: "Acme Test Co", phone: "+81 3-1234-5678", notes: "Secret gate code 1234", contacts: [{ email: "Pat@Example.test", name: "Pat" }, { email: "kim@example.test" }] };

describe("access control", () => {
  it("requires a staff session; technicians read but cannot write", async () => {
    const id = await seedCustomer();
    const cid = await contactId(id, "pat@example.test");
    expect((await api("GET", "/api/staff/customers")).status).toBe(401);
    expect((await list("", techCookie)).status).toBe(200);
    expect((await detail(id, techCookie)).status).toBe(200);

    const writes = [
      create(newCustomer, techCookie),
      patch(id, { name: "Renamed" }, techCookie),
      setActive(id, false, techCookie),
      addContact(id, { email: "new@example.test" }, techCookie),
      patchContact(id, cid, { active: false }, techCookie),
      removeContact(id, cid, techCookie),
    ];
    for (const res of await Promise.all(writes)) expect([res.status, res.json.error]).toEqual([403, "forbidden"]);
    expect(await count("SELECT COUNT(*) AS n FROM customers")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM customer_contacts")).toBe(1);
    expect(await audits()).toEqual([]);
  });

  it("answers 404 for ids that are not customers", async () => {
    expect((await detail(999)).status).toBe(404);
    expect((await detail("abc" as any)).status).toBe(404);
    expect((await patch(999, { name: "x" })).status).toBe(404);
    expect((await setActive(999, false)).status).toBe(404);
    expect((await addContact(999, { email: "a@example.test" })).status).toBe(404);
  });
});

describe("create", () => {
  it("creates the customer with its contacts and one audit row", async () => {
    const res = await create({ ...newCustomer, customerNumber: " ACME-001 " });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.customer).toMatchObject({ customerNumber: "ACME-001", name: "Acme Test Co", phone: "+81 3-1234-5678", notes: "Secret gate code 1234", active: true });
    expect(res.json.contacts.map((c: any) => [c.email, c.name, c.active, c.hasHistory])).toEqual([
      ["pat@example.test", "Pat", true, false],
      ["kim@example.test", null, true, false],
    ]);
    expect(res.json.recentReservations).toEqual([]);

    const a = await audits();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actor_kind: "staff", actor: String(team.admin), action: "customer.create", customer_id: res.json.customer.id });
    expect(a[0].details).toEqual({ customerNumber: "ACME-001", name: "Acme Test Co", phone: "+81 3-1234-5678", contacts: ["pat@example.test", "kim@example.test"] });
    expect(JSON.stringify(a)).not.toContain("gate code");
  });

  it("accepts a customer without contacts, and without phone or notes", async () => {
    const res = await create({ customerNumber: "N1", name: "Solo Co" });
    expect(res.status).toBe(201);
    expect(res.json.customer).toMatchObject({ phone: null, notes: null });
    expect(res.json.contacts).toEqual([]);
  });

  it("rejects a taken number (case-sensitive) with 409 and writes nothing", async () => {
    await seedCustomer({ number: "ACME-001" });
    const before = await count("SELECT COUNT(*) AS n FROM customer_contacts");
    const res = await create(newCustomer);
    expect([res.status, res.json.error]).toEqual([409, "number_taken"]);
    expect(await count("SELECT COUNT(*) AS n FROM customer_contacts")).toBe(before);
    expect(await audits()).toEqual([]);
    expect((await create({ ...newCustomer, customerNumber: "acme-001" })).status).toBe(201);
  });

  it.each([
    ["empty number", { customerNumber: "  " }],
    ["number with a space", { customerNumber: "AC ME" }],
    ["number with a non-ASCII letter", { customerNumber: "ACMÉ" }],
    ["number over 40 characters", { customerNumber: "A".repeat(41) }],
    ["empty name", { name: " " }],
    ["name over 200", { name: "n".repeat(201) }],
    ["bad phone", { phone: "call me" }],
    ["phone over 40", { phone: "1".repeat(41) }],
    ["notes over 1000", { notes: "n".repeat(1001) }],
    ["bad contact email", { contacts: [{ email: "nope" }] }],
    ["contact name over 100", { contacts: [{ email: "a@example.test", name: "n".repeat(101) }] }],
    ["bad contact phone", { contacts: [{ email: "a@example.test", phone: "abc" }] }],
    ["the same contact twice", { contacts: [{ email: "a@example.test" }, { email: "A@example.test" }] }],
  ])("rejects %s", async (_label, override) => {
    const res = await create({ ...newCustomer, ...override });
    expect([res.status, res.json.error]).toEqual([400, "invalid"]);
    expect(await count("SELECT COUNT(*) AS n FROM customers")).toBe(0);
  });

  it("accepts the boundaries: a 40-character number and every allowed character", async () => {
    expect((await create({ customerNumber: "A.b_c-9".padEnd(40, "x"), name: "Edge" })).status).toBe(201);
  });
});

describe("detail", () => {
  it("shows contacts with their history and the ten newest reservations", async () => {
    const id = await seedCustomer({ email: "pat@example.test", name: "Pat Co" });
    await addContact(id, { email: "kim@example.test" });
    const ids: string[] = [];
    // Twelve reservations on distinct days, inserted oldest first.
    for (let i = 0; i < 12; i++) {
      ids.push(`res-${i}`);
      await env.DB.prepare(
        `INSERT INTO reservations(id, ref, customer_id, contact_email, contact_name, phone, issue, start_at, end_at, status, idempotency_key, created_at, updated_at, occ_start, occ_end)
         VALUES (?, ?, ?, 'pat@example.test', 'Pat Example', '03-1111', 'x', ?, ?, 'cancelled', ?, 0, 0, ?, ?)`,
      )
        .bind(ids[i], `REF-${i}`, id, at("2026-11-02", 10) + i * 86_400_000, at("2026-11-02", 11) + i * 86_400_000, `key-${i}`, at("2026-11-02", 10) + i * 86_400_000, at("2026-11-02", 11) + i * 86_400_000)
        .run();
    }

    const res = await detail(id);
    expect(res.status).toBe(200);
    expect(res.json.customer).toMatchObject({ id, name: "Pat Co", active: true });
    expect(res.json.contacts.map((c: any) => [c.email, c.hasHistory])).toEqual([["pat@example.test", true], ["kim@example.test", false]]);
    expect(res.json.recentReservations).toHaveLength(10);
    expect(res.json.recentReservations.map((r: any) => r.id)).toEqual(ids.slice(2).reverse());
    expect(Object.keys(res.json.recentReservations[0]).sort()).toEqual(["contactName", "endAt", "id", "ref", "startAt", "status"]);
  });
});

describe("list and search", () => {
  const names = async () => (await list("?status=all")).json.customers.map((c: any) => c.customerNumber);

  it("lists by customer number with contact counts, active customers by default", async () => {
    await seedCustomer({ number: "B-2", name: "Beta", email: "b@example.test" });
    const a = await seedCustomer({ number: "A-1", name: "Alpha", email: "a@example.test" });
    await addContact(a, { email: "a2@example.test" });
    await patchContact(a, await contactId(a, "a2@example.test"), { active: false });
    await seedCustomer({ number: "C-3", name: "Gamma", email: "c@example.test", active: false });

    const res = await list();
    expect(res.json.customers).toEqual([
      { id: a, customerNumber: "A-1", name: "Alpha", phone: null, active: true, contactsCount: 2, activeContactsCount: 1 },
      expect.objectContaining({ customerNumber: "B-2", contactsCount: 1, activeContactsCount: 1 }),
    ]);
    expect(res.json.nextCursor).toBeNull();
    expect(await names()).toEqual(["A-1", "B-2", "C-3"]);
    expect((await list("?status=inactive")).json.customers.map((c: any) => c.customerNumber)).toEqual(["C-3"]);
    expect((await list("?status=bogus")).status).toBe(400);
  });

  it("searches number, name and any contact email, case-insensitively", async () => {
    const a = await seedCustomer({ number: "AB-100", name: "Harbour Bakery", email: "owner@example.test" });
    await addContact(a, { email: "Night.Shift@example.test" });
    await seedCustomer({ number: "XY-200", name: "Mountain Hut", email: "hut@example.test" });
    const q = async (text: string) => (await list(`?status=all&query=${encodeURIComponent(text)}`)).json.customers.map((c: any) => c.customerNumber);
    expect(await q("ab-1")).toEqual(["AB-100"]);
    expect(await q("BAKERY")).toEqual(["AB-100"]);
    expect(await q("night.shift")).toEqual(["AB-100"]);
    expect(await q("EXAMPLE.test")).toEqual(["AB-100", "XY-200"]);
    expect(await q("  hut  ")).toEqual(["XY-200"]);
    expect(await q("nothing")).toEqual([]);
    expect(await q("")).toEqual(["AB-100", "XY-200"]);
  });

  it("matches % _ and \\ in the search text as literal characters", async () => {
    await seedCustomer({ number: "P-1", name: "100% Pure", email: "p1@example.test" });
    await seedCustomer({ number: "P-2", name: "1000 Pure", email: "p2@example.test" });
    await seedCustomer({ number: "U_1", name: "Under_score", email: "u1@example.test" });
    await seedCustomer({ number: "UX1", name: "UnderXscore", email: "u2@example.test" });
    await seedCustomer({ number: "B-1", name: "Back\\slash", email: "b1@example.test" });
    await seedCustomer({ number: "B-2", name: "Backslash", email: "b2@example.test" });
    const q = async (text: string) => (await list(`?status=all&query=${encodeURIComponent(text)}`)).json.customers.map((c: any) => c.customerNumber);
    expect(await q("%")).toEqual(["P-1"]);
    expect(await q("100%")).toEqual(["P-1"]);
    expect(await q("_")).toEqual(["U_1"]);
    expect(await q("r_s")).toEqual(["U_1"]);
    expect(await q("\\")).toEqual(["B-1"]);
    expect(await q("k\\s")).toEqual(["B-1"]);
    expect(await q("\\%")).toEqual([]);
  });

  it("folds only ASCII case: accented capitals and Japanese names are found by their exact spelling", async () => {
    await seedCustomer({ number: "J-1", name: "サンプル歯科", email: "dental@example.test" });
    await seedCustomer({ number: "J-2", name: "Émile Café", email: "emile@example.test" });
    const q = async (text: string) => (await list(`?status=all&query=${encodeURIComponent(text)}`)).json.customers.map((c: any) => c.customerNumber);
    expect(await q("Émile")).toEqual(["J-2"]);
    expect(await q("Émile Café")).toEqual(["J-2"]);
    expect(await q("émile")).toEqual([]); // SQLite cannot fold non-ASCII capitals
    expect(await q("ÉMILE")).toEqual(["J-2"]); // only the ASCII letters fold, so the capital É still matches itself
    expect(await q("EMILE")).toEqual(["J-2"]); // the ASCII e-mail address still folds
    expect(await q("プル歯")).toEqual(["J-1"]);
    expect(await q("サンプル歯科")).toEqual(["J-1"]);
  });

  it("finds a customer by a contact email longer than 48 characters, and caps the search text at 200", async () => {
    const email = `${"long.mailbox.name".repeat(3)}@subdomain.example.test`;
    expect(email.length).toBeGreaterThan(48);
    await seedCustomer({ number: "L-1", name: "Long Mail", email });
    await seedCustomer({ number: "L-2", name: "Other", email: "other@example.test" });
    const q = async (text: string) => (await list(`?status=all&query=${encodeURIComponent(text)}`)).json.customers.map((c: any) => c.customerNumber);
    expect(await q(email)).toEqual(["L-1"]);
    expect(await q(email.toUpperCase())).toEqual(["L-1"]);
    expect(await q("%".repeat(60))).toEqual([]);
    expect((await list(`?query=${"a".repeat(200)}`)).status).toBe(200);
    const res = await list(`?query=${"a".repeat(201)}`);
    expect([res.status, res.json.error]).toEqual([400, "invalid"]);
  });

  it("pages by 50 with a cursor that stays stable when customers are added or removed between pages", async () => {
    const stmts = Array.from({ length: 120 }, (_, i) =>
      env.DB.prepare("INSERT INTO customers(customer_number, name, created_at, updated_at) VALUES (?, ?, 0, 0)").bind(`K-${String(i).padStart(3, "0")}`, `Customer ${i}`),
    );
    await env.DB.batch(stmts);
    const p1 = await list();
    expect(p1.json.customers).toHaveLength(50);
    expect(p1.json.customers[0].customerNumber).toBe("K-000");
    expect(p1.json.nextCursor).toEqual(expect.any(String));
    expect(p1.json.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);

    // Customers appear and disappear around the cursor between the requests.
    await env.DB.prepare("INSERT INTO customers(customer_number, name, created_at, updated_at) VALUES ('K-000a', 'Early', 0, 0), ('K-055a', 'Middle', 0, 0)").run();
    await env.DB.prepare("DELETE FROM customers WHERE customer_number IN ('K-010', 'K-060')").run();

    const p2 = await list(`?cursor=${p1.json.nextCursor}`);
    expect(p2.json.customers).toHaveLength(50);
    expect(p2.json.customers[0].customerNumber).toBe("K-050");
    const p3 = await list(`?cursor=${p2.json.nextCursor}`);
    expect(p3.json.nextCursor).toBeNull();

    const seen = [...p1.json.customers, ...p2.json.customers, ...p3.json.customers].map((c: any) => c.customerNumber);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual([...seen].sort());
    expect(seen).toContain("K-055a");
    expect(seen).not.toContain("K-000a"); // behind the cursor already
    expect(seen).toHaveLength(50 + 50 + p3.json.customers.length);
  });

  it("pages unpadded numbers in plain string order across a page boundary", async () => {
    await env.DB.batch(
      Array.from({ length: 49 }, (_, i) => env.DB.prepare("INSERT INTO customers(customer_number, name, created_at, updated_at) VALUES (?, 'Filler', 0, 0)").bind(`A-${String(i).padStart(2, "0")}`)),
    );
    for (const n of ["C-9", "C-10", "C-100"]) await env.DB.prepare("INSERT INTO customers(customer_number, name, created_at, updated_at) VALUES (?, 'Unpadded', 0, 0)").bind(n).run();
    const p1 = await list();
    expect(p1.json.customers.at(-1).customerNumber).toBe("C-10");
    const p2 = await list(`?cursor=${p1.json.nextCursor}`);
    expect(p2.json.customers.map((c: any) => c.customerNumber)).toEqual(["C-100", "C-9"]);
    expect(p2.json.nextCursor).toBeNull();
  });

  it("combines the cursor with a search and the status filter, and ends exactly on a full page", async () => {
    await env.DB.batch(
      Array.from({ length: 50 }, (_, i) => env.DB.prepare("INSERT INTO customers(customer_number, name, created_at, updated_at) VALUES (?, 'Fifty', 0, 0)").bind(`F-${String(i).padStart(2, "0")}`)),
    );
    const full = await list("?query=fifty");
    expect(full.json.customers).toHaveLength(50);
    expect(full.json.nextCursor).toBeNull();
    await env.DB.prepare("INSERT INTO customers(customer_number, name, created_at, updated_at) VALUES ('F-99', 'Fifty', 0, 0)").run();
    const first = await list("?query=fifty");
    const next = await list(`?query=fifty&cursor=${first.json.nextCursor}`);
    expect(next.json.customers.map((c: any) => c.customerNumber)).toEqual(["F-99"]);
  });

  it("rejects a cursor that is not ours", async () => {
    for (const cursor of ["!!!", "bm90LWpzb24", btoa("[1,2]"), btoa('["a","b"]')]) {
      const res = await list(`?cursor=${cursor}`);
      expect([res.status, res.json.error], cursor).toEqual([400, "invalid_cursor"]);
    }
  });
});

describe("patch", () => {
  it("changes name, phone and notes, clears with null, and audits the fields without the notes text", async () => {
    const res0 = await create(newCustomer);
    const id = res0.json.customer.id;
    const res = await patch(id, { name: " Acme Renamed ", phone: null, notes: "Moved to the new office" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.customer).toMatchObject({ name: "Acme Renamed", phone: null, notes: "Moved to the new office" });
    const a = (await audits("customer.update"))[0];
    expect(a).toMatchObject({ actor: String(team.admin), customer_id: id });
    expect(a.details).toEqual({ fields: ["name", "phone", "notes"], name: "Acme Renamed", phone: null, from: { name: "Acme Test Co" } });
    expect(JSON.stringify(a)).not.toContain("new office");

    expect((await patch(id, { notes: "" })).json.customer.notes).toBeNull();
  });

  it("does nothing, and audits nothing, when no field changes", async () => {
    const id = (await create(newCustomer)).json.customer.id;
    const before = (await audits()).length;
    const res = await patch(id, { name: "Acme Test Co", customerNumber: "ACME-001", phone: "+81 3-1234-5678" });
    expect(res.status).toBe(200);
    expect((await audits()).length).toBe(before);
  });

  it("renumbers a customer without reservations; the new number must be free", async () => {
    const id = await seedCustomer({ number: "OLD-1" });
    await seedCustomer({ number: "TAKEN" });
    const clash = await patch(id, { customerNumber: "TAKEN" });
    expect([clash.status, clash.json.error]).toEqual([409, "number_taken"]);
    const res = await patch(id, { customerNumber: " NEW-1 " });
    expect(res.json.customer.customerNumber).toBe("NEW-1");
    expect((await audits("customer.update"))[0].details).toEqual({ fields: ["customerNumber"], customerNumber: "NEW-1", from: { customerNumber: "OLD-1" } });
  });

  it("locks the number once the customer has any reservation, even a cancelled one", async () => {
    const id = await seedCustomer({ number: "LOCK-1", email: "pat@example.test" });
    const pat = await loginCustomer("pat@example.test");
    const rid = await submit(pat, id, at(FRI, 10));
    const locked = await patch(id, { customerNumber: "LOCK-2" });
    expect([locked.status, locked.json.error]).toEqual([409, "number_locked"]);
    await env.DB.prepare("UPDATE reservations SET status = 'cancelled' WHERE id = ?").bind(rid).run();
    expect((await patch(id, { customerNumber: "LOCK-2" })).status).toBe(409);
    // Other fields stay editable, and sending the unchanged number is not a renumbering.
    expect((await patch(id, { customerNumber: "LOCK-1", name: "Still editable" })).json.customer.name).toBe("Still editable");
    expect((await detail(id)).json.customer.customerNumber).toBe("LOCK-1");
  });

  it("refuses unknown or identity fields and empty patches", async () => {
    const id = await seedCustomer();
    for (const body of [{}, { active: false }, { email: "x@example.test" }, { name: "" }, { customerNumber: "bad number" }, { phone: "abc" }]) {
      expect((await patch(id, body)).status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe("contacts", () => {
  it("adds a contact (email lowercased), refuses a duplicate on the same customer only", async () => {
    const a = await seedCustomer({ number: "A", email: "pat@example.test" });
    const b = await seedCustomer({ number: "B", email: "other@example.test" });
    const res = await addContact(a, { email: " KIM@Example.test ", name: " Kim ", phone: "090-1234" });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.contact).toMatchObject({ email: "kim@example.test", name: "Kim", phone: "090-1234", active: true, hasHistory: false });
    expect((await audits("customer.contact.add"))[0]).toMatchObject({ customer_id: a, details: { email: "kim@example.test" } });

    const dup = await addContact(a, { email: "Kim@example.test" });
    expect([dup.status, dup.json.error]).toEqual([409, "contact_exists"]);
    expect((await addContact(a, { email: "pat@example.test" })).status).toBe(409);
    // The same email may belong to several customers; accounts are never merged.
    expect((await addContact(b, { email: "kim@example.test" })).status).toBe(201);
    expect(await count("SELECT COUNT(*) AS n FROM customer_contacts WHERE email = 'kim@example.test'")).toBe(2);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'customer.contact.add'")).toBe(2);
    expect((await addContact(a, { email: "not-an-email" })).status).toBe(400);
  });

  it("updates name, phone and active; the email cannot change", async () => {
    const id = await seedCustomer({ email: "pat@example.test" });
    const cid = await contactId(id, "pat@example.test");
    const res = await patchContact(id, cid, { name: "Pat", phone: "03-1111", active: false });
    expect(res.status).toBe(200);
    expect(res.json.contact).toMatchObject({ id: cid, email: "pat@example.test", name: "Pat", phone: "03-1111", active: false });
    expect((await audits("customer.contact.update"))[0]).toMatchObject({ customer_id: id, details: { contactId: cid, email: "pat@example.test", name: "Pat", phone: "03-1111", active: false } });

    expect((await patchContact(id, cid, { phone: null })).json.contact.phone).toBeNull();
    const before = (await audits()).length;
    expect((await patchContact(id, cid, { active: false })).status).toBe(200);
    expect((await audits()).length).toBe(before); // a no-op writes no audit row
    for (const body of [{}, { email: "new@example.test" }, { phone: "abc" }]) expect((await patchContact(id, cid, body)).status).toBe(400);
  });

  it("404s a contact that belongs to another customer", async () => {
    const a = await seedCustomer({ number: "A", email: "pat@example.test" });
    const b = await seedCustomer({ number: "B", email: "sam@example.test" });
    const cidOfB = await contactId(b, "sam@example.test");
    expect((await patchContact(a, cidOfB, { active: false })).status).toBe(404);
    expect((await removeContact(a, cidOfB)).status).toBe(404);
    expect(await count("SELECT COUNT(*) AS n FROM customer_contacts WHERE id = ? AND active = 1", cidOfB)).toBe(1);
  });

  it("deletes a contact that never booked; refuses (has_history) one that did, which can be deactivated instead", async () => {
    const id = await seedCustomer({ email: "pat@example.test" });
    await addContact(id, { email: "kim@example.test" });
    const pat = await loginCustomer("pat@example.test");
    await submit(pat, id, at(FRI, 10));

    const refused = await removeContact(id, await contactId(id, "pat@example.test"));
    expect([refused.status, refused.json.error]).toEqual([409, "has_history"]);
    expect(await count("SELECT COUNT(*) AS n FROM customer_contacts WHERE customer_id = ?", id)).toBe(2);

    const kimId = await contactId(id, "kim@example.test");
    const ok = await removeContact(id, kimId);
    expect(ok.status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM customer_contacts WHERE id = ?", kimId)).toBe(0);
    expect((await audits("customer.contact.remove"))[0]).toMatchObject({ customer_id: id, details: { contactId: kimId, email: "kim@example.test" } });
    expect((await removeContact(id, kimId)).status).toBe(404);

    expect((await patchContact(id, await contactId(id, "pat@example.test"), { active: false })).status).toBe(200);
  });

  it("history is per customer: the same email booked for another customer does not block deleting here", async () => {
    const a = await seedCustomer({ number: "A", email: "pat@example.test" });
    const b = await seedCustomer({ number: "B", email: "pat@example.test" });
    await submit(await loginCustomer("pat@example.test"), a, at(FRI, 10));
    expect((await removeContact(b, await contactId(b, "pat@example.test"))).status).toBe(200);
    expect((await removeContact(a, await contactId(a, "pat@example.test"))).status).toBe(409);
  });
});

describe("activation", () => {
  it("deactivates and reactivates with audit rows, without touching reservations or the schedule version", async () => {
    const id = await seedCustomer({ number: "ACT-1", email: "pat@example.test" });
    const pat = await loginCustomer("pat@example.test");
    const rid = await submit(pat, id, at(FRI, 10));
    const v = await version();

    const off = await setActive(id, false);
    expect(off.status).toBe(200);
    expect(off.json.customer.active).toBe(false);
    expect((await setActive(id, false)).status).toBe(200); // idempotent, no second audit row
    expect((await setActive(id, true)).json.customer.active).toBe(true);
    expect((await audits()).map((a) => [a.action, a.customer_id])).toEqual([["customer.deactivate", id], ["customer.activate", id]]);
    expect(await version()).toBe(v);
    expect(await count("SELECT COUNT(*) AS n FROM reservations WHERE id = ? AND status = 'pending'", rid)).toBe(1);
    expect((await api("POST", "/api/staff/customers/1/active", { cookie: adminCookie, body: { active: "no" } })).status).toBe(400);
  });

  it("blocks new sign-in links for a deactivated customer, while existing access links still work", async () => {
    const id = await seedCustomer({ email: "pat@example.test" });
    const pat = await loginCustomer("pat@example.test");
    const rid = await submit(pat, id, at(FRI, 10));
    const token = await lastMailTo("pat@example.test");
    expect(token).not.toBeNull();

    await setActive(id, false);
    const mails = await count("SELECT COUNT(*) AS n FROM email_jobs WHERE to_email = 'pat@example.test'");
    await api("POST", "/api/auth/customer/request", { body: { email: "pat@example.test" } });
    expect(await count("SELECT COUNT(*) AS n FROM email_jobs WHERE to_email = 'pat@example.test'")).toBe(mails);
    const booking = await api("POST", "/api/customer/reservations", {
      cookie: pat,
      body: { customerId: id, startAt: at(FRI, 11), contactName: "Pat", phone: "03-1111", issue: "x", idempotencyKey: crypto.randomUUID() },
    });
    expect([booking.status, booking.json.error]).toEqual([403, expect.any(String)]);

    const viaLink = await api("POST", "/api/access/reservation", { body: { token } });
    expect(viaLink.status).toBe(200);
    expect(viaLink.json.reservation.id).toBe(rid);

    await setActive(id, true);
    await api("POST", "/api/auth/customer/request", { body: { email: "pat@example.test" } });
    expect(await count("SELECT COUNT(*) AS n FROM email_jobs WHERE to_email = 'pat@example.test'")).toBeGreaterThan(mails);
  });

  it("a deactivated contact loses the reservation in /my, but its access links still work", async () => {
    const id = await seedCustomer({ email: "pat@example.test" });
    await addContact(id, { email: "kim@example.test" });
    const pat = await loginCustomer("pat@example.test");
    const kim = await loginCustomer("kim@example.test");
    const rid = await submit(pat, id, at(FRI, 10));
    const token = await lastMailTo("pat@example.test");

    const listIds = async (cookie: string) => (await api("GET", "/api/customer/reservations", { cookie })).json.reservations.map((r: any) => r.id);
    expect(await listIds(pat)).toEqual([rid]);
    expect(await listIds(kim)).toEqual([rid]);

    expect((await patchContact(id, await contactId(id, "pat@example.test"), { active: false })).status).toBe(200);
    expect((await api("GET", `/api/customer/reservations/${rid}`, { cookie: pat })).status).toBe(404);
    expect(await listIds(pat)).toEqual([]);
    expect(await listIds(kim)).toEqual([rid]);
    const viaLink = await api("POST", "/api/access/reservation", { body: { token } });
    expect([viaLink.status, viaLink.json.reservation.id]).toEqual([200, rid]);

    await patchContact(id, await contactId(id, "pat@example.test"), { active: true });
    expect(await listIds(pat)).toEqual([rid]);
  });
});

describe("request body limits", () => {
  const big = (n: number) => "x".repeat(n);

  it("answers 413 payload_too_large above 256 KB on ordinary routes, before any handler runs", async () => {
    const res = await create({ customerNumber: "BIG-1", name: "Big", notes: big(300_000) });
    expect([res.status, res.json]).toEqual([413, { error: "payload_too_large" }]);
    expect(await count("SELECT COUNT(*) AS n FROM customers")).toBe(0);
    // Also for unauthenticated routes.
    expect((await api("POST", "/api/auth/customer/request", { body: { email: `${big(300_000)}@example.test` } })).status).toBe(413);
    // Just under the limit reaches the handler (which rejects the content, not the size).
    expect((await create({ customerNumber: "BIG-1", name: "Big", notes: big(200_000) })).status).toBe(400);
  });

  it("answers 413 when the size is only known while streaming (no content-length)", async () => {
    const payload = new TextEncoder().encode(JSON.stringify({ customerNumber: "S-1", name: "Stream", notes: big(300_000) }));
    const res = await (await import("../../src/worker/index")).default.fetch!(
      new Request("http://localhost:5173/api/staff/customers", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:5173", "x-requested-with": "fetch", cookie: adminCookie, "transfer-encoding": "chunked" },
        body: new ReadableStream({ start: (c) => { c.enqueue(payload); c.close(); } }),
        duplex: "half",
      } as RequestInit) as any,
      env as any,
      { waitUntil() {}, passThroughException() {} } as any,
    );
    expect([res.status, await res.json()]).toEqual([413, { error: "payload_too_large" }]);
  });

  it("allows 1 MB on the CSV import paths and refuses more", async () => {
    // Holidays import: 300 KB is over the ordinary limit but within the import limit (the handler's own 100 KB cap answers 400).
    const mid = await api("POST", "/api/staff/holidays/import/preview", { cookie: adminCookie, body: { csv: big(300_000) } });
    expect([mid.status, mid.json.error]).toEqual([400, "invalid"]);
    const over = await api("POST", "/api/staff/holidays/import/preview", { cookie: adminCookie, body: { csv: big(1_100_000) } });
    expect([over.status, over.json]).toEqual([413, { error: "payload_too_large" }]);
    // The customers import mounts under the same prefix and gets the same limit (300 KB of junk reaches the parser: no header).
    const custMid = await api("POST", "/api/staff/customers/import/preview", { cookie: adminCookie, body: { csv: big(300_000) } });
    expect([custMid.status, custMid.json.error]).toEqual([400, "invalid_header"]);
    expect((await api("POST", "/api/staff/customers/import/preview", { cookie: adminCookie, body: { csv: big(1_100_000) } })).status).toBe(413);
  });
});
