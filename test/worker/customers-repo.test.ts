import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { lastPhonesForEmail } from "../../src/worker/repos/customers";
import { seedCustomer } from "../fixtures";

let seq = 0;
async function reservation(customerId: number, phone: string, createdAt: number, email = "pat@example.test") {
  const n = ++seq;
  await env.DB.prepare(
    `INSERT INTO reservations(id, ref, customer_id, contact_email, contact_name, phone, issue, start_at, end_at, status, idempotency_key, created_at, updated_at, occ_start, occ_end)
     VALUES (?, ?, ?, ?, 'Pat Example', ?, 'x', 0, 1, 'cancelled', ?, ?, ?, 0, 1)`,
  )
    .bind(`res-${n}`, `REF-${n}`, customerId, email, phone, `key-${n}`, createdAt, createdAt)
    .run();
}

describe("lastPhonesForEmail", () => {
  it("gives each account its newest phone, looking at the newest 20 reservations only", async () => {
    const a = await seedCustomer({ email: "pat@example.test", name: "A Co" });
    const b = await seedCustomer({ email: "pat@example.test", name: "B Co" });
    const old = await seedCustomer({ email: "pat@example.test", name: "Old Co" });
    await reservation(old, "000", 1); // older than the newest 20: not looked at
    await reservation(b, "111", 2);
    for (let i = 0; i < 24; i++) await reservation(i % 2 ? a : b, `${i % 2 ? "a" : "b"}-${i}`, 100 + i);
    await reservation(b, "999", 500, "kim@example.test"); // someone else's booking

    const phones = await lastPhonesForEmail(env.DB, "pat@example.test");
    expect([...phones.entries()]).toEqual([
      [a, "a-23"],
      [b, "b-22"],
    ]);
  });

  it("matches the email case-insensitively and returns at most 5 phones, the newest accounts'", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 7; i++) {
      ids.push(await seedCustomer({ email: "pat@example.test", name: `Co ${i}` }));
      await reservation(ids[i]!, `phone-${i}`, 10 + i, i % 2 ? "PAT@example.test" : "pat@example.test");
    }
    const phones = await lastPhonesForEmail(env.DB, "Pat@Example.test");
    expect([...phones.entries()]).toEqual([6, 5, 4, 3, 2].map((i) => [ids[i], `phone-${i}`]));
  });

  it("is empty for an email with no bookings", async () => {
    expect((await lastPhonesForEmail(env.DB, "nobody@example.test")).size).toBe(0);
  });
});
