import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../helpers";
import { loginCustomer, loginStaff, seedCustomer, seedTeam, seedWeekly, TZ } from "../fixtures";
import { setNow } from "../../src/worker/lib/clock";
import { wallToUtc, MIN } from "../../src/domain/time";

afterEach(() => setNow(null));

const THU = "2026-10-01";
const FRI = "2026-10-02";
const at = (date: string, h: number, m = 0) => wallToUtc(date, h * 60 + m, TZ);

let team: Awaited<ReturnType<typeof seedTeam>>;
let customerId: number;
let cookie: string;

beforeEach(async () => {
  setNow(at(THU, 8)); // Thu 08:00 Tokyo
  team = await seedTeam();
  await seedWeekly(4, 600, 660, [team.a, team.b]);
  await seedWeekly(5, 600, 660, [team.a, team.b]);
  customerId = await seedCustomer({ email: "pat@example.test" });
  cookie = await loginCustomer("pat@example.test");
});

const availability = (from: string, to: string, c: string | null = cookie) =>
  api("GET", `/api/customer/availability?from=${from}&to=${to}`, { cookie: c ?? undefined });
const day = (json: any, date: string) => json.days.find((d: any) => d.date === date);

describe("GET /api/customer/availability", () => {
  it("hides slots inside the minimum notice and shows spots for later days", async () => {
    const res = await availability(THU, FRI);
    expect(res.status).toBe(200);
    expect(res.json.timezone).toBe(TZ);
    // earliest = 08:00 + 3 business hours = 12:00 Thursday, so the 10:00 Thursday slots are gone
    expect(day(res.json, THU)).toEqual({ date: THU, slots: [] });
    expect(day(res.json, FRI).slots).toEqual([
      { startAt: at(FRI, 10), endAt: at(FRI, 10, 30), spots: 2 },
      { startAt: at(FRI, 10, 30), endAt: at(FRI, 11), spots: 2 },
    ]);
  });

  it("requires a session", async () => {
    const res = await availability(THU, FRI, null);
    expect(res.status).toBe(401);
  });

  it("is not available to a staff session alone", async () => {
    const staffCookie = await loginStaff("tech-a@example.test");
    expect((await api("GET", "/api/staff/me", { cookie: staffCookie })).status).toBe(200);
    expect((await availability(THU, FRI, staffCookie)).status).toBe(401);
  });

  it("reduces spots for an existing pending request, including through its buffer", async () => {
    const start = at(FRI, 10);
    await env.DB.prepare(
      `INSERT INTO reservations(id, ref, customer_id, contact_email, contact_name, phone, issue, start_at, end_at, status,
         provisional_staff_id, idempotency_key, created_at, updated_at)
       VALUES ('r1', 'RS-TEST1', ?, 'pat@example.test', 'Pat', '000', 'issue', ?, ?, 'pending', ?, 'k1', 0, 0)`,
    )
      .bind(customerId, start, start + 30 * MIN, team.a)
      .run();
    for (let ms = start; ms < start + 40 * MIN; ms += 5 * MIN) {
      await env.DB.prepare("INSERT INTO tech_blocks(staff_id, block_start, owner_kind, owner_id) VALUES (?, ?, 'reservation', 'r1')")
        .bind(team.a, ms / MIN)
        .run();
    }
    const res = await availability(FRI, FRI);
    expect(day(res.json, FRI).slots.map((s: any) => [s.startAt, s.spots])).toEqual([
      [at(FRI, 10), 1],
      [at(FRI, 10, 30), 1], // the 10:00 hold plus its 10-minute buffer occupies a until 10:40
    ]);
  });

  it("drops fully booked slots", async () => {
    for (const [id, staff] of [["r1", team.a], ["r2", team.b]] as const) {
      await env.DB.prepare(
        `INSERT INTO reservations(id, ref, customer_id, contact_email, contact_name, phone, issue, start_at, end_at, status,
           assigned_staff_id, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, 'pat@example.test', 'Pat', '000', 'issue', ?, ?, 'confirmed', ?, ?, 0, 0)`,
      )
        .bind(id, `RS-${id}`, customerId, at(FRI, 10), at(FRI, 10, 30), staff, `k-${id}`)
        .run();
    }
    const res = await availability(FRI, FRI);
    // both technicians are busy until 10:40, so neither 10:00 nor 10:30 has a spot left
    expect(day(res.json, FRI)).toEqual({ date: FRI, slots: [] });
  });

  it("omits past days and days beyond the booking horizon", async () => {
    const past = await availability("2026-09-29", "2026-10-02");
    expect(past.json.days.map((d: any) => d.date)).toEqual([THU, FRI]);
    await env.DB.prepare("INSERT INTO settings(key, value) VALUES ('bookingHorizonDays', '2')").run();
    const far = await availability("2026-10-02", "2026-10-10");
    expect(far.json.days.map((d: any) => d.date)).toEqual([FRI, "2026-10-03"]);
  });

  it("rejects a malformed, reversed or over-long range with 400", async () => {
    for (const q of ["from=2026-10-01", "from=2026-10-01&to=2026-9-02", "from=2026-10-05&to=2026-10-01", "from=2026-10-01&to=2026-11-15", "from=2026-02-30&to=2026-03-02"]) {
      const res = await api("GET", `/api/customer/availability?${q}`, { cookie });
      expect(res.status, q).toBe(400);
      expect(res.json.error, q).toBe("invalid");
    }
  });
});

describe("GET /api/customer/accounts", () => {
  it("lists eligible accounts with the most recent phone used by this email", async () => {
    const other = await seedCustomer({ email: "pat@example.test", name: "Second Co" });
    const insert = (id: string, cust: number, email: string, phone: string, created: number) =>
      env.DB.prepare(
        `INSERT INTO reservations(id, ref, customer_id, contact_email, contact_name, phone, issue, start_at, end_at, status,
           idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'Pat', ?, 'issue', 1, 2, 'completed', ?, ?, ?)`,
      )
        .bind(id, `RS-${id}`, cust, email, phone, `k-${id}`, created, created)
        .run();
    await insert("p1", customerId, "pat@example.test", "111", 100);
    await insert("p2", customerId, "pat@example.test", "222", 200);
    await insert("p3", customerId, "someone-else@example.test", "333", 300);
    const res = await api("GET", "/api/customer/accounts", { cookie });
    expect(res.status).toBe(200);
    expect(res.json.accounts).toHaveLength(2);
    expect(res.json.accounts[0]).toMatchObject({ id: customerId, name: "Acme Test Co", lastPhone: "222" });
    expect(res.json.accounts[1]).toMatchObject({ id: other, name: "Second Co", lastPhone: null });
  });

  it("requires a customer session", async () => {
    expect((await api("GET", "/api/customer/accounts")).status).toBe(401);
  });
});
