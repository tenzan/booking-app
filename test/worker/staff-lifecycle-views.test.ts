import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../helpers";
import { loginCustomer, loginStaff, seedCustomer, seedTeam, seedWeekly, TZ } from "../fixtures";
import { setNow } from "../../src/worker/lib/clock";
import { wallToUtc } from "../../src/domain/time";

/** What the staff UI needs to show the reservation lifecycle: replacement links, who closed it, open proposals, option holds. */

afterEach(() => setNow(null));
vi.setConfig({ testTimeout: 20_000 });

const THU = "2026-10-01";
const FRI = "2026-10-02";
const SAT = "2026-10-03";
const at = (date: string, h: number, m = 0) => wallToUtc(date, h * 60 + m, TZ);

let team: Awaited<ReturnType<typeof seedTeam>>;
let pat: { id: number; cookie: string };
let sam: { id: number; cookie: string };
let adminCookie: string;
let techCookie: string;

beforeEach(async () => {
  setNow(at(THU, 8));
  team = await seedTeam();
  for (const [id, name] of [
    [team.admin, "Ada Admin"],
    [team.a, "Tim Tech"],
    [team.b, "Una Tech"],
  ] as const) {
    await env.DB.prepare("UPDATE staff SET name = ? WHERE id = ?").bind(name, id).run();
  }
  pat = { id: await seedCustomer({ email: "pat@example.test", name: "Pat Co" }), cookie: "" };
  sam = { id: await seedCustomer({ email: "sam@example.test", name: "Sam Co" }), cookie: "" };
  pat.cookie = await loginCustomer("pat@example.test");
  sam.cookie = await loginCustomer("sam@example.test");
  adminCookie = await loginStaff("admin@example.test");
  techCookie = await loginStaff("tech-a@example.test");
  // Friday 10:00–13:00 with technicians a and b.
  await seedWeekly(5, 600, 780, [team.a, team.b]);
});

const submit = async (who: { id: number; cookie: string }, startAt: number, extra: Record<string, unknown> = {}) => {
  const res = await api("POST", "/api/customer/reservations", {
    cookie: who.cookie,
    body: { customerId: who.id, startAt, contactName: "Pat Example", phone: "+81 3-1234-5678", issue: "Printer is offline", idempotencyKey: crypto.randomUUID(), ...extra },
  });
  expect([res.status, res.json.error]).toEqual([201, undefined]);
  return res.json.reservation.id as string;
};
const approve = async (id: string, staffId: number, version = 1) => {
  const res = await api("POST", `/api/staff/reservations/${id}/approve`, { cookie: adminCookie, body: { staffId, version } });
  expect([res.status, res.json.error]).toEqual([200, undefined]);
  return res.json.reservation;
};
const propose = async (id: string, options: Array<{ startAt: number; staffId: number }>, version: number) => {
  const res = await api("POST", `/api/staff/reservations/${id}/propose`, { cookie: adminCookie, body: { options, version } });
  expect([res.status, res.json.error]).toEqual([200, undefined]);
  return res.json.reservation;
};
const detail = async (id: string) => (await api("GET", `/api/staff/reservations/${id}`, { cookie: techCookie })).json.reservation;
const refOf = async (id: string) => (await env.DB.prepare("SELECT ref FROM reservations WHERE id = ?").bind(id).first<{ ref: string }>())!.ref;

describe("staff reservation DTO: replacement links and who closed it", () => {
  it("links an original to its latest replacement request and back, with their statuses", async () => {
    const original = await submit(pat, at(FRI, 10));
    await approve(original, team.a);
    const plain = await detail(original);
    expect(plain).toMatchObject({ replacesId: null, replacesRef: null, replacesStatus: null, replacedById: null, replacedByRef: null, replacedByStatus: null });

    const first = await submit(pat, at(FRI, 11), { replacesId: original });
    expect(await detail(first)).toMatchObject({ replacesId: original, replacesRef: await refOf(original), replacesStatus: "confirmed", replacedById: null });
    expect(await detail(original)).toMatchObject({ replacedById: first, replacedByRef: await refOf(first), replacedByStatus: "pending" });

    // Declined, then another replacement: the original points at the newest one.
    expect((await api("POST", `/api/staff/reservations/${first}/decline`, { cookie: adminCookie, body: { reason: "Full", version: 1 } })).status).toBe(200);
    expect(await detail(original)).toMatchObject({ replacedById: first, replacedByStatus: "declined" });
    const second = await submit(pat, at(FRI, 12), { replacesId: original });
    expect(await detail(original)).toMatchObject({ replacedById: second, replacedByRef: await refOf(second), replacedByStatus: "pending" });

    // Approving the replacement cancels the original (rescheduled), and both links stay.
    await approve(second, team.b);
    expect(await detail(original)).toMatchObject({ status: "cancelled", closeReason: "rescheduled", replacedById: second, replacedByStatus: "confirmed" });
    expect(await detail(second)).toMatchObject({ replacesId: original, replacesStatus: "cancelled" });
  });

  it("says what kind of actor closed it: staff (by name), the customer (by email), or the system", async () => {
    const byStaff = await submit(pat, at(FRI, 10));
    expect(await detail(byStaff)).toMatchObject({ closedByKind: null, closedBy: null });
    await api("POST", `/api/staff/reservations/${byStaff}/cancel`, { cookie: adminCookie, body: { reason: "Duplicate", version: 1 } });
    expect(await detail(byStaff)).toMatchObject({ status: "cancelled", closedByKind: "staff", closedBy: "Ada Admin" });

    const byCustomer = await submit(sam, at(FRI, 11));
    const res = await api("POST", `/api/customer/reservations/${byCustomer}/cancel`, { cookie: sam.cookie, body: { version: 1 } });
    expect(res.status).toBe(200);
    expect(await detail(byCustomer)).toMatchObject({ status: "cancelled", closedByKind: "customer", closedBy: "sam@example.test" });
  });

  it("never adds the staff-only fields to the customer's view (references only)", async () => {
    const original = await submit(pat, at(FRI, 10));
    await approve(original, team.a);
    const replacement = await submit(pat, at(FRI, 11), { replacesId: original });
    for (const id of [original, replacement]) {
      const mine = await api("GET", `/api/customer/reservations/${id}`, { cookie: pat.cookie });
      expect(mine.status).toBe(200);
      const view = mine.json.reservation;
      for (const key of ["replacesId", "replacesStatus", "replacedById", "replacedByStatus", "closedByKind", "closedBy", "assignedStaff", "provisionalStaffId", "confirmedBy"]) {
        expect(view).not.toHaveProperty(key);
      }
      expect(JSON.stringify(view)).not.toMatch(/Tim Tech|Una Tech|Ada Admin/);
    }
    // The customer-safe references are there.
    const mine = (id: string) => api("GET", `/api/customer/reservations/${id}`, { cookie: pat.cookie }).then((r) => r.json.reservation);
    expect(await mine(original)).toMatchObject({ replacedByRef: await refOf(replacement) });
    expect(await mine(replacement)).toMatchObject({ replacesRef: await refOf(original) });
  });
});

describe("reservation list: proposal=open", () => {
  it("lists only reservations with an open proposal", async () => {
    const pending = await submit(pat, at(FRI, 10));
    const confirmed = await submit(sam, at(FRI, 10, 30));
    await approve(confirmed, team.a);
    const lee = { id: await seedCustomer({ email: "lee@example.test", name: "Lee Co" }), cookie: await loginCustomer("lee@example.test") };
    await submit(lee, at(FRI, 11));
    await propose(pending, [{ startAt: at(FRI, 12), staffId: team.a }], 1);
    const withdrawnOn = await propose(confirmed, [{ startAt: at(FRI, 12, 30), staffId: team.b }], 2);
    expect(
      (await api("POST", `/api/staff/reservations/${confirmed}/proposal/withdraw`, { cookie: adminCookie, body: { proposalId: withdrawnOn.proposal.id } })).status,
    ).toBe(200);

    const res = await api("GET", "/api/staff/reservations?proposal=open", { cookie: techCookie });
    expect(res.status).toBe(200);
    expect(res.json.reservations.map((r: any) => r.id)).toEqual([pending]);
    expect(res.json.reservations[0].proposal.status).toBe("open");

    // Combines with the other filters; anything but "open" (or blank) is refused.
    expect((await api("GET", "/api/staff/reservations?proposal=open&status=confirmed", { cookie: techCookie })).json.reservations).toEqual([]);
    expect((await api("GET", "/api/staff/reservations?proposal=", { cookie: techCookie })).json.reservations).toHaveLength(3);
    expect((await api("GET", "/api/staff/reservations?proposal=closed", { cookie: techCookie })).status).toBe(400);
  });
});

describe("calendar feed: proposal holds", () => {
  const day = `from=${at(FRI, 0)}&to=${at(SAT, 0)}`;

  it("lists open proposals' options in the range with their reservation, technician and expiry", async () => {
    const pending = await submit(pat, at(FRI, 10));
    const r = await propose(pending, [{ startAt: at(FRI, 12), staffId: team.b }, { startAt: at(FRI, 11), staffId: team.a }], 1);
    const ref = await refOf(pending);
    const byStart = [...r.proposal.options].sort((a: any, b: any) => a.startAt - b.startAt);

    const res = await api("GET", `/api/staff/calendar?${day}`, { cookie: techCookie });
    expect(res.status).toBe(200);
    expect(res.json.proposalHolds).toEqual([
      {
        reservationId: pending,
        ref,
        proposalId: r.proposal.id,
        optionId: byStart[0].id,
        startAt: at(FRI, 11),
        endAt: at(FRI, 11, 30),
        staffId: team.a,
        staffName: "Tim Tech",
        customerName: "Pat Co",
        expiresAt: r.proposal.expiresAt,
      },
      expect.objectContaining({ optionId: byStart[1].id, startAt: at(FRI, 12), staffId: team.b, staffName: "Una Tech" }),
    ]);

    // Filtered to one technician: only their holds.
    const tims = await api("GET", `/api/staff/calendar?${day}&staffId=${team.a}`, { cookie: techCookie });
    expect(tims.json.proposalHolds.map((h: any) => h.staffId)).toEqual([team.a]);
    // Outside the range: none.
    const morning = await api("GET", `/api/staff/calendar?from=${at(FRI, 0)}&to=${at(FRI, 11)}`, { cookie: techCookie });
    expect(morning.json.proposalHolds).toEqual([]);
  });

  it("drops a proposal's holds once it is no longer open", async () => {
    const pending = await submit(pat, at(FRI, 10));
    const r = await propose(pending, [{ startAt: at(FRI, 12), staffId: team.b }], 1);
    await api("POST", `/api/staff/reservations/${pending}/proposal/withdraw`, { cookie: adminCookie, body: { proposalId: r.proposal.id } });
    expect((await api("GET", `/api/staff/calendar?${day}`, { cookie: techCookie })).json.proposalHolds).toEqual([]);
  });
});
