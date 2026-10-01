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

/** Every account the email is a contact of, active or not (for viewing and cancelling past requests). */
export async function accountIdsForContact(db: D1Database, email: string): Promise<number[]> {
  const { results } = await db
    .prepare("SELECT DISTINCT customer_id FROM customer_contacts WHERE email = ? ORDER BY customer_id")
    .bind(email)
    .all<{ customer_id: number }>();
  return results.map((r) => r.customer_id);
}
