import { CustomerImportError, planCustomerImport, planHash, type ExistingContact, type ExistingCustomer, type ImportPlan } from "../../domain/customer-import";
import { clock } from "../lib/clock";
import { audit } from "../lib/db";
import { HttpError } from "../lib/http";

/** Statements per D1 batch (one batch is one transaction; D1 caps the size of a batch). */
export const IMPORT_CHUNK = 100;

/** Every stored customer with its contacts, keyed by customer number. */
async function loadExisting(db: D1Database): Promise<Map<string, ExistingCustomer>> {
  const [customers, contacts] = await Promise.all([
    db.prepare("SELECT customer_number AS number, name, phone, active FROM customers").all<{ number: string; name: string; phone: string | null; active: number }>(),
    db
      .prepare("SELECT c.customer_number AS number, cc.email AS email, cc.name AS name, cc.active AS active FROM customer_contacts cc JOIN customers c ON c.id = cc.customer_id")
      .all<{ number: string; email: string; name: string | null; active: number }>(),
  ]);
  const byNumber = new Map<string, Map<string, ExistingContact>>();
  for (const k of contacts.results) {
    const m = byNumber.get(k.number) ?? new Map<string, ExistingContact>();
    m.set(k.email.toLowerCase(), { name: k.name, active: k.active === 1 });
    byNumber.set(k.number, m);
  }
  return new Map(
    customers.results.map((c) => [c.number, { name: c.name, phone: c.phone, active: c.active === 1, contacts: byNumber.get(c.number) ?? new Map() }]),
  );
}

/** Plans `csv` against the stored customers. A file-level problem is a 400 with the reason in `details`. */
export async function planFromCsv(db: D1Database, csv: string): Promise<ImportPlan & { planHash: string }> {
  let plan: ImportPlan;
  try {
    plan = planCustomerImport(csv, await loadExisting(db));
  } catch (e) {
    if (e instanceof CustomerImportError) throw new HttpError(400, e.code, { message: e.message, line: e.line, column: e.column });
    throw e;
  }
  return { ...plan, planHash: await planHash(plan) };
}

/**
 * Writes the plan: customers first, then contacts, in chunks of at most IMPORT_CHUNK statements per db.batch, with the
 * audit row as the very last statement. Every statement is an upsert, so a file whose import stopped half way
 * converges when the same file is imported again.
 */
export async function applyPlan(db: D1Database, actor: string, plan: ImportPlan): Promise<{ chunks: number }> {
  const now = clock.now();
  const statements: D1PreparedStatement[] = [
    ...plan.customers.map((c) =>
      db
        .prepare(
          `INSERT INTO customers(customer_number, name, phone, notes, active, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?)
           ON CONFLICT(customer_number) DO UPDATE SET name = excluded.name, phone = excluded.phone, active = excluded.active, updated_at = excluded.updated_at`,
        )
        .bind(c.customerNumber, c.name, c.phone, c.active ? 1 : 0, now, now),
    ),
    ...plan.contacts.map((k) =>
      db
        .prepare(
          `INSERT INTO customer_contacts(customer_id, email, name, phone, active) SELECT id, ?, ?, NULL, 1 FROM customers WHERE customer_number = ?
           ON CONFLICT(customer_id, email) DO UPDATE SET name = excluded.name`,
        )
        .bind(k.email, k.name, k.customerNumber),
    ),
    audit(db, {
      actorKind: "staff",
      actor,
      action: "customers.import",
      details: {
        created: plan.summary.customers.create,
        updated: plan.summary.customers.update,
        unchanged: plan.summary.customers.unchanged,
        contactsAdded: plan.summary.contacts.add,
        contactsUpdated: plan.summary.contacts.update,
      },
    }),
  ];

  const chunks: D1PreparedStatement[][] = [];
  for (let i = 0; i < statements.length; i += IMPORT_CHUNK) chunks.push(statements.slice(i, i + IMPORT_CHUNK));
  let committed = 0;
  for (const chunk of chunks) {
    try {
      await db.batch(chunk);
    } catch (e) {
      console.error("customer import chunk failed:", e instanceof Error ? e.message : e);
      // Earlier chunks stay committed; importing the same file again finishes the job.
      throw new HttpError(500, "import_failed", { committedChunks: committed, totalChunks: chunks.length });
    }
    committed++;
  }
  return { chunks: chunks.length };
}
