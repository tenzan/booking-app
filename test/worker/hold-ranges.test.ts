import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../helpers";
import { loginCustomer, loginStaff, seedCustomer, seedTeam, seedWeekly, TZ } from "../fixtures";
import { setNow } from "../../src/worker/lib/clock";
import { MIN, wallToUtc } from "../../src/domain/time";
import { blockMinutes, rangeBlocks } from "../../src/domain/slots";

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
const spots = async (startAt: number) => {
  const res = await api("GET", `/api/customer/availability?from=${FRI}&to=${FRI}`, { cookie: sam.cookie });
  return res.json.days.find((d: any) => d.date === FRI).slots.find((s: any) => s.startAt === startAt)?.spots;
};

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
