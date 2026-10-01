import { CUSTOMER_RECENT_LIMIT, CUSTOMERS_PAGE_SIZE } from "../../shared/schemas";
import type {
  CustomerContactDTO,
  CustomerDetailDTO,
  CustomerDTO,
  CustomerListDTO,
  CustomerListItemDTO,
  CustomerReservationSummaryDTO,
  ReservationStatus,
} from "../../shared/types";
import { decodeCursor, encodeCursor } from "../lib/cursor";

export interface EligibleAccount {
  id: number;
  customerNumber: string;
  name: string;
  contactName: string | null;
  contactPhone: string | null;
  customerPhone: string | null;
}

/** Accounts this email may sign in for / book on: an ACTIVE contact on an ACTIVE customer. */
export async function eligibleAccountsForEmail(db: D1Database, email: string): Promise<EligibleAccount[]> {
  const { results } = await db
    .prepare(
      `SELECT c.id AS id, c.customer_number AS customerNumber, c.name AS name,
              cc.name AS contactName, cc.phone AS contactPhone, c.phone AS customerPhone
       FROM customer_contacts cc JOIN customers c ON c.id = cc.customer_id
       WHERE cc.email = ? AND cc.active = 1 AND c.active = 1
       ORDER BY c.id`,
    )
    .bind(email)
    .all<EligibleAccount>();
  return results;
}

/**
 * Accounts whose reservations this email may see through a session: an ACTIVE contact row, even when the customer
 * itself is inactive. A deactivated contact keeps only the per-reservation access links from its emails.
 */
export async function accountIdsForContact(db: D1Database, email: string): Promise<number[]> {
  const { results } = await db
    .prepare("SELECT DISTINCT customer_id FROM customer_contacts WHERE email = ? AND active = 1 ORDER BY customer_id")
    .bind(email)
    .all<{ customer_id: number }>();
  return results.map((r) => r.customer_id);
}

/** Most recent reservation phone per account for bookings made by `email`. */
export async function lastPhonesForEmail(db: D1Database, email: string): Promise<Map<number, string>> {
  const { results } = await db
    .prepare("SELECT customer_id AS customerId, phone FROM reservations WHERE contact_email = ? ORDER BY created_at DESC, rowid DESC")
    .bind(email)
    .all<{ customerId: number; phone: string }>();
  const out = new Map<number, string>();
  for (const r of results) if (!out.has(r.customerId)) out.set(r.customerId, r.phone);
  return out;
}

// ---- Administration reads ---------------------------------------------------------------------------------------

interface ListRow {
  id: number;
  customerNumber: string;
  name: string;
  phone: string | null;
  active: number;
  contactsCount: number;
  activeContactsCount: number;
}

/** Customers ordered by number (then id), a page after `cursor`. `query` matches number, name or any contact email. */
export async function listCustomers(
  db: D1Database,
  f: { query: string; status: "active" | "inactive" | "all"; cursor?: string },
): Promise<CustomerListDTO> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (f.status !== "all") {
    where.push("c.active = ?");
    binds.push(f.status === "active" ? 1 : 0);
  }
  if (f.query !== "") {
    // Substring match. ASCII letters match case-insensitively; other scripts match exactly (SQLite's lower() only folds ASCII, and
    // CJK has no case). instr has no wildcards to escape and no pattern length limit (unlike LIKE on D1).
    where.push(
      `(instr(lower(c.customer_number), ?) > 0 OR instr(lower(c.name), ?) > 0
        OR EXISTS (SELECT 1 FROM customer_contacts m WHERE m.customer_id = c.id AND instr(lower(m.email), ?) > 0))`,
    );
    // Fold exactly what SQLite's lower() folds, so both sides of the comparison agree.
    const needle = f.query.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
    binds.push(needle, needle, needle);
  }
  if (f.cursor !== undefined) {
    const [number, id] = decodeCursor(f.cursor, ["string", "number"]);
    where.push("(c.customer_number > ? OR (c.customer_number = ? AND c.id > ?))");
    binds.push(number, number, id);
  }
  const { results } = await db
    .prepare(
      `SELECT c.id AS id, c.customer_number AS customerNumber, c.name AS name, c.phone AS phone, c.active AS active,
              (SELECT COUNT(*) FROM customer_contacts m WHERE m.customer_id = c.id) AS contactsCount,
              (SELECT COUNT(*) FROM customer_contacts m WHERE m.customer_id = c.id AND m.active = 1) AS activeContactsCount
       FROM customers c${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""}
       ORDER BY c.customer_number, c.id LIMIT ?`,
    )
    .bind(...binds, CUSTOMERS_PAGE_SIZE + 1)
    .all<ListRow>();
  const page = results.slice(0, CUSTOMERS_PAGE_SIZE);
  const last = page.at(-1);
  const customers: CustomerListItemDTO[] = page.map((r) => ({ ...r, active: r.active === 1 }));
  return { customers, nextCursor: results.length > CUSTOMERS_PAGE_SIZE && last ? encodeCursor([last.customerNumber, last.id]) : null };
}

export async function getCustomer(db: D1Database, id: number): Promise<CustomerDTO | null> {
  const r = await db
    .prepare("SELECT id, customer_number AS customerNumber, name, phone, notes, active FROM customers WHERE id = ?")
    .bind(id)
    .first<Omit<CustomerDTO, "active"> & { active: number }>();
  return r ? { ...r, active: r.active === 1 } : null;
}

const CONTACT_SELECT = `SELECT cc.id AS id, cc.email AS email, cc.name AS name, cc.phone AS phone, cc.active AS active,
    EXISTS (SELECT 1 FROM reservations r WHERE r.customer_id = cc.customer_id AND r.contact_email = cc.email) AS hasHistory
  FROM customer_contacts cc`;

type ContactRow = Omit<CustomerContactDTO, "active" | "hasHistory"> & { active: number; hasHistory: number };
const toContact = (r: ContactRow): CustomerContactDTO => ({ ...r, active: r.active === 1, hasHistory: r.hasHistory === 1 });

export async function listContacts(db: D1Database, customerId: number): Promise<CustomerContactDTO[]> {
  const { results } = await db.prepare(`${CONTACT_SELECT} WHERE cc.customer_id = ? ORDER BY cc.id`).bind(customerId).all<ContactRow>();
  return results.map(toContact);
}

export async function getContact(db: D1Database, customerId: number, contactId: number): Promise<CustomerContactDTO | null> {
  const r = await db.prepare(`${CONTACT_SELECT} WHERE cc.customer_id = ? AND cc.id = ?`).bind(customerId, contactId).first<ContactRow>();
  return r ? toContact(r) : null;
}

/** The customer's newest reservations by start time. */
export async function recentReservations(db: D1Database, customerId: number, limit = CUSTOMER_RECENT_LIMIT): Promise<CustomerReservationSummaryDTO[]> {
  const { results } = await db
    .prepare(
      `SELECT id, ref, status, start_at AS startAt, end_at AS endAt, contact_name AS contactName FROM reservations
       WHERE customer_id = ? ORDER BY start_at DESC, created_at DESC, id LIMIT ?`,
    )
    .bind(customerId, limit)
    .all<Omit<CustomerReservationSummaryDTO, "status"> & { status: ReservationStatus }>();
  return results;
}

export async function getCustomerDetail(db: D1Database, id: number): Promise<CustomerDetailDTO | null> {
  const customer = await getCustomer(db, id);
  if (!customer) return null;
  const [contacts, recent] = await Promise.all([listContacts(db, id), recentReservations(db, id)]);
  return { customer, contacts, recentReservations: recent };
}
