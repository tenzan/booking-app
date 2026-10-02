import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../helpers";
import { loginCustomer, loginStaff, seedCustomer, seedTeam, seedWeekly, TZ } from "../fixtures";
import { setNow } from "../../src/worker/lib/clock";
import { MIN, wallToUtc } from "../../src/domain/time";
import { blockMinutes, rangeBlocks } from "../../src/domain/slots";
import { loadScheduleCtx } from "../../src/worker/scheduling/context";
import { bookableSlots } from "../../src/worker/scheduling/availability";

afterEach(() => setNow(null));

const THU = "2026-10-01";
const FRI = "2026-10-02";
const at = (date: string, h: number, m = 0) => wallToUtc(date, h * 60 + m, TZ);

let team: Awaited<ReturnType<typeof seedTeam>>;
let pat: { id: number; cookie: string };
let sam: { id: number; cookie: string };

beforeEach(async () => {
  setNow(at(THU, 8));
  team = await seedTeam();
  await seedWeekly(5, 600, 660, [team.a, team.b]);
  pat = { id: await seedCustomer({ email: "pat@example.test", name: "Pat Co" }), cookie: "" };
  sam = { id: await seedCustomer({ email: "sam@example.test", name: "Sam Co" }), cookie: "" };
  pat.cookie = await loginCustomer("pat@example.test");
  sam.cookie = await loginCustomer("sam@example.test");
});

const submit = async (who: { id: number; cookie: string }, startAt: number) => {
  const res = await api("POST", "/api/customer/reservations", {
    cookie: who.cookie,
    body: { customerId: who.id, startAt, contactName: "Pat Example", phone: "+81 3-1234-5678", issue: "Printer is offline", idempotencyKey: crypto.randomUUID() },
  });
  expect(res.status).toBe(201);
  return res.json.reservation.id as string;
};
const setSetting = (key: string, value: unknown) =>
  env.DB.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)").bind(key, JSON.stringify(value)).run();
const rangeOf = (id: string) => env.DB.prepare("SELECT occ_start AS s, occ_end AS e FROM reservations WHERE id = ?").bind(id).first<{ s: number; e: number }>();
const blocksOf = async (id: string) =>
  (await env.DB.prepare("SELECT staff_id, block_start FROM tech_blocks WHERE owner_id = ? ORDER BY block_start").bind(id).all<{ staff_id: number; block_start: number }>()).results;
/** How many more bookings fit at `startAt` (the capacity behind the customer's list of times). */
const spots = async (startAt: number) => (await bookableSlots(env, FRI, FRI)).days[0]!.slots.find((s) => s.startAt === startAt)?.spots;

describe("stored occupied ranges", () => {
  it("submit stores the range with the buffers in force", async () => {
    await setSetting("bufferBeforeMin", 5);
    await setSetting("bufferAfterMin", 10);
    const id = await submit(pat, at(FRI, 10, 30));
    expect(await rangeOf(id)).toEqual({ s: at(FRI, 10, 25), e: at(FRI, 11, 10) });
    expect((await blocksOf(id)).map((b) => b.block_start)).toEqual(rangeBlocks(at(FRI, 10, 25), at(FRI, 11, 10)));
  });

  it("a buffer change affects only new requests: existing holds keep their range", async () => {
    const first = await submit(pat, at(FRI, 10));
    expect(await rangeOf(first)).toEqual({ s: at(FRI, 10), e: at(FRI, 10, 40) });
    expect(await spots(at(FRI, 10, 30))).toBe(1); // one technician is held until 10:40

    await setSetting("bufferAfterMin", 0);
    expect(await spots(at(FRI, 10, 30))).toBe(1); // still held until 10:40, not 10:30
    expect(await rangeOf(first)).toEqual({ s: at(FRI, 10), e: at(FRI, 10, 40) });

    const second = await submit(sam, at(FRI, 10, 30));
    expect(await rangeOf(second)).toEqual({ s: at(FRI, 10, 30), e: at(FRI, 11) });
    expect(await rangeOf(first)).toEqual({ s: at(FRI, 10), e: at(FRI, 10, 40) });
  });

  it("approve keeps the stored range: blocks are unchanged after a buffer change", async () => {
    const id = await submit(pat, at(FRI, 10));
    const before = await blocksOf(id);
    expect(before).toHaveLength(8);
    const staffId = before[0]!.staff_id;

    await setSetting("bufferAfterMin", 0);
    await setSetting("bufferBeforeMin", 15);
    const res = await api("POST", `/api/staff/reservations/${id}/approve`, { cookie: await loginStaff("admin@example.test"), body: { staffId, version: 1 } });
    expect(res.status).toBe(200);
    expect(await blocksOf(id)).toEqual(before);
    expect(await rangeOf(id)).toEqual({ s: at(FRI, 10), e: at(FRI, 10, 40) });
  });
});

describe("eligibility of existing pending holds", () => {
  it("keeps time off against the stored range after a buffer change", async () => {
    // B is on leave from 10:35: the 10:00-10:30 request (occupied until 10:40) can only go to A.
    await env.DB.prepare("INSERT INTO staff_unavailability(staff_id, start_at, end_at) VALUES (?, ?, ?)").bind(team.b, at(FRI, 10, 35), at(FRI, 12)).run();
    const id = await submit(pat, at(FRI, 10));
    expect((await rangeOf(id))!.e).toBe(at(FRI, 10, 40));
    expect((await env.DB.prepare("SELECT provisional_staff_id AS p FROM reservations WHERE id = ?").bind(id).first<{ p: number }>())!.p).toBe(team.a);

    await setSetting("bufferAfterMin", 0); // today's buffers would end at 10:30 and free B
    const ctx = await loadScheduleCtx(env, at(FRI, 10), at(FRI, 10, 30));
    expect(ctx.holds.find((h) => h.id === id)!.eligible).toEqual([team.a]);

    const admin = await loginStaff("admin@example.test");
    const d = await api("GET", `/api/staff/reservations/${id}`, { cookie: admin });
    expect(d.json.techOptions.find((o: any) => o.id === team.b)).toMatchObject({ assignable: false, reason: "unavailable" });
    const res = await api("POST", `/api/staff/reservations/${id}/approve`, { cookie: admin, body: { staffId: team.b, version: 1 } });
    expect([res.status, res.json.error]).toEqual([409, "tech_unavailable"]);
  });

  it("stays eligible when a longer duration no longer fits the window", async () => {
    const id = await submit(pat, at(FRI, 10));
    await setSetting("durationMin", 90); // the 10:00-11:00 window can no longer fit a slot at all
    const ctx = await loadScheduleCtx(env, at(FRI, 10), at(FRI, 10, 30));
    expect(ctx.slots).toEqual([]);
    expect(ctx.holds.find((h) => h.id === id)!.eligible).toEqual([team.a, team.b]);
    const d = await api("GET", `/api/staff/reservations/${id}`, { cookie: await loginStaff("admin@example.test") });
    expect(d.json.techOptions.filter((o: any) => o.assignable).map((o: any) => o.id).sort()).toEqual([team.a, team.b].sort());
  });
});

describe("occupied range guard", () => {
  it("rejects inserts without a real range", async () => {
    const id = await submit(pat, at(FRI, 10));
    const insert = (occ: [number, number]) =>
      env.DB.prepare(
        `INSERT INTO reservations(id, ref, customer_id, contact_email, contact_name, phone, issue, start_at, end_at, occ_start, occ_end, status,
           idempotency_key, created_at, updated_at)
         VALUES ('x1', 'R-X-1', ?, 'pat@example.test', 'Pat', '0', 'i', 1, 2, ?, ?, 'completed', 'kx', 0, 0)`,
      ).bind(pat.id, ...occ).run();
    await expect(insert([0, 0])).rejects.toThrow(/occupied range required/);
    await expect(insert([1, 2])).resolves.toBeDefined();
    await expect(
      env.DB.prepare("INSERT INTO proposal_options(id, proposal_id, start_at, end_at, staff_id) VALUES ('o9', 'nope', 1, 2, ?)").bind(team.a).run(),
    ).rejects.toThrow(/occupied range required/);
    expect(id).toBeTruthy();
  });
});

describe("rangeBlocks", () => {
  const T = Date.parse("2026-10-01T01:00:00Z");
  it("floors a start that is off the grid to its block", () => {
    expect(rangeBlocks(T + 2 * MIN, T + 12 * MIN).map((m) => m * MIN - T)).toEqual([0, 5 * MIN, 10 * MIN]);
  });
  it("excludes the block that starts exactly at the end", () => {
    expect(rangeBlocks(T, T + 10 * MIN).map((m) => m * MIN - T)).toEqual([0, 5 * MIN]);
    expect(rangeBlocks(T, T + 11 * MIN)).toHaveLength(3);
  });
  it("is what blockMinutes is built from", () => {
    const cfg = { bufferBeforeMin: 5, bufferAfterMin: 10 };
    expect(blockMinutes(T, T + 30 * MIN, cfg)).toEqual(rangeBlocks(T - 5 * MIN, T + 40 * MIN));
  });
});
