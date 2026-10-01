import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../helpers";
import { loginCustomer, loginStaff, seedCustomer, seedTeam, seedWeekly, TZ } from "../fixtures";
import { setNow } from "../../src/worker/lib/clock";
import { retryFailedEmail } from "../../src/worker/mail/outbox";
import { MIN, wallToUtc } from "../../src/domain/time";

afterEach(() => setNow(null));

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
    [team.c, "Cy Tech"],
    [team.d, "Dee Tech"],
  ] as const) {
    await env.DB.prepare("UPDATE staff SET name = ? WHERE id = ?").bind(name, id).run();
  }
  pat = { id: await seedCustomer({ email: "pat@example.test", name: "Pat Co" }), cookie: "" };
  sam = { id: await seedCustomer({ email: "sam@example.test", name: "Sam Co" }), cookie: "" };
  pat.cookie = await loginCustomer("pat@example.test");
  sam.cookie = await loginCustomer("sam@example.test");
  adminCookie = await loginStaff("admin@example.test");
  techCookie = await loginStaff("tech-a@example.test");
});

const get = (cookie: string | undefined, path: string) => api("GET", path, { cookie });
const ids = (list: any[]) => list.map((r) => r.id);

const submit = async (who: { id: number; cookie: string }, startAt: number) => {
  const res = await api("POST", "/api/customer/reservations", {
    cookie: who.cookie,
    body: { customerId: who.id, startAt, contactName: "Pat Example", phone: "+81 3-1234-5678", issue: "Printer is offline", idempotencyKey: crypto.randomUUID() },
  });
  expect(res.status).toBe(201);
  return res.json.reservation.id as string;
};
const confirmedWith = async (who: { id: number; cookie: string }, startAt: number, staffId: number) => {
  const id = await submit(who, startAt);
  const res = await api("POST", `/api/staff/reservations/${id}/approve`, { cookie: adminCookie, body: { staffId, version: 1 } });
  expect(res.status).toBe(200);
  return id;
};

/** A reservation row inserted directly: listing tests need exact starts, statuses and technicians. */
let seq = 0;
const insertRes = async (o: { id: string; startAt: number; status?: string; assigned?: number | null; provisional?: number | null; createdAt?: number }) => {
  seq++;
  await env.DB.prepare(
    `INSERT INTO reservations(id, ref, customer_id, contact_email, contact_name, phone, issue, start_at, end_at, occ_start, occ_end, status,
       assigned_staff_id, provisional_staff_id, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, 'sam@example.test', 'Sam', '000', 'issue', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  )
    .bind(o.id, `R-${seq}`, sam.id, o.startAt, o.startAt + 30 * MIN, o.startAt, o.startAt + 40 * MIN, o.status ?? "pending", o.assigned ?? null, o.provisional ?? null, `k-${o.id}`, o.createdAt ?? 0)
    .run();
};

describe("reservation list: paging and filters", () => {
  it("pages by start time then id with an opaque cursor, without gaps or repeats", async () => {
    // r-c and r-b share a start: creation time breaks the tie (r-c is older), and r-d / r-e tie on both, so the id decides.
    await insertRes({ id: "r-e", startAt: at(FRI, 12) });
    await insertRes({ id: "r-b", startAt: at(FRI, 11), createdAt: 20 });
    await insertRes({ id: "r-a", startAt: at(FRI, 10) });
    await insertRes({ id: "r-c", startAt: at(FRI, 11), createdAt: 10 });
    await insertRes({ id: "r-d", startAt: at(FRI, 12) });

    const p1 = await get(techCookie, "/api/staff/reservations?limit=2");
    expect(ids(p1.json.reservations)).toEqual(["r-a", "r-c"]);
    expect(typeof p1.json.nextCursor).toBe("string");
    const p2 = await get(techCookie, `/api/staff/reservations?limit=2&cursor=${p1.json.nextCursor}`);
    expect(ids(p2.json.reservations)).toEqual(["r-b", "r-d"]);
    const p3 = await get(techCookie, `/api/staff/reservations?limit=2&cursor=${p2.json.nextCursor}`);
    expect(ids(p3.json.reservations)).toEqual(["r-e"]);
    expect(p3.json.nextCursor).toBeNull();

    // An exactly-full last page has no cursor either.
    const exact = await get(techCookie, "/api/staff/reservations?limit=5");
    expect(exact.json.reservations).toHaveLength(5);
    expect(exact.json.nextCursor).toBeNull();
    // Default page size holds all five.
    expect((await get(techCookie, "/api/staff/reservations")).json.reservations).toHaveLength(5);
  });

  it("rejects out-of-range limits and malformed cursors", async () => {
    expect((await get(techCookie, "/api/staff/reservations?limit=201")).status).toBe(400);
    expect((await get(techCookie, "/api/staff/reservations?limit=0")).status).toBe(400);
    expect((await get(techCookie, "/api/staff/reservations?limit=200")).status).toBe(200);
    const bad = await get(techCookie, "/api/staff/reservations?cursor=not-a-cursor");
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("invalid_cursor");
  });

  it("ignores empty query parameters", async () => {
    await insertRes({ id: "r-a", startAt: at(FRI, 10) });
    await insertRes({ id: "r-b", startAt: at(FRI, 11), status: "confirmed", assigned: team.a });
    const res = await get(techCookie, "/api/staff/reservations?status=&from=&to=&staffId=&cursor=&limit=");
    expect(res.status).toBe(200);
    expect(ids(res.json.reservations)).toEqual(["r-a", "r-b"]);
  });

  it("staffId matches the assigned technician only, not a provisional one", async () => {
    await insertRes({ id: "r-pending", startAt: at(FRI, 10), provisional: team.a });
    await insertRes({ id: "r-mine", startAt: at(FRI, 11), status: "confirmed", assigned: team.a });
    await insertRes({ id: "r-other", startAt: at(FRI, 12), status: "confirmed", assigned: team.b });
    const res = await get(techCookie, `/api/staff/reservations?staffId=${team.a}`);
    expect(ids(res.json.reservations)).toEqual(["r-mine"]);
  });

  it("still requires staff", async () => {
    expect((await get(undefined, "/api/staff/reservations")).status).toBe(401);
    expect((await get(pat.cookie, "/api/staff/reservations")).status).toBe(401);
  });
});

describe("calendar feed", () => {
  beforeEach(async () => {
    await seedWeekly(5, 600, 660, [team.admin, team.a, team.b]); // Fri 10:00-11:00: slots 10:00 and 10:30
    await seedWeekly(5, 840, 900, [team.admin, team.a, team.b]); // Fri 14:00-15:00: slots 14:00 and 14:30
  });
  const cal = (cookie: string | undefined, qs: string) => get(cookie, `/api/staff/calendar?${qs}`);
  const day = `from=${at(FRI, 0)}&to=${at(SAT, 0)}`;

  it("returns pending and confirmed reservations plus per-day slot capacity with who is booked", async () => {
    const confirmed = await confirmedWith(pat, at(FRI, 10), team.a);
    const pending = await submit(sam, at(FRI, 10, 30));
    // An open proposal option on 14:00 holds Una Tech.
    await env.DB.prepare("INSERT INTO proposals(id, reservation_id, status, created_at, expires_at) VALUES ('p1', ?, 'open', 0, ?)").bind(pending, at(FRI, 23)).run();
    await env.DB.prepare("INSERT INTO proposal_options(id, proposal_id, start_at, end_at, staff_id, occ_start, occ_end) VALUES ('o1', 'p1', ?, ?, ?, ?, ?)")
      .bind(at(FRI, 14), at(FRI, 14, 30), team.b, at(FRI, 14), at(FRI, 14, 40))
      .run();

    const res = await cal(techCookie, day);
    expect(res.status).toBe(200);
    expect(res.json.timezone).toBe(TZ);
    expect(res.json.truncated).toBe(false);
    expect(ids(res.json.reservations)).toEqual([confirmed, pending]);
    expect(res.json.reservations[0]).toMatchObject({ status: "confirmed", assignedStaff: { id: team.a } });
    expect(res.json.reservations[0]).not.toHaveProperty("provisionalForFilteredStaff");

    const all = [team.admin, team.a, team.b];
    expect(res.json.slots).toEqual([
      {
        date: FRI,
        slots: [
          // Tim's confirmed 10:00 (occupying until 10:40) blocks both starts; the pending request overlaps both too.
          { startAt: at(FRI, 10), endAt: at(FRI, 10, 30), staffIds: all, bookedStaffIds: [team.a], pendingCount: 1 },
          { startAt: at(FRI, 10, 30), endAt: at(FRI, 11), staffIds: all, bookedStaffIds: [team.a], pendingCount: 1 },
          { startAt: at(FRI, 14), endAt: at(FRI, 14, 30), staffIds: all, bookedStaffIds: [team.b], pendingCount: 0 },
          // 14:30 starts at the option's occupied end (14:40 > 14:30): still overlapping through the after-buffer.
          { startAt: at(FRI, 14, 30), endAt: at(FRI, 15), staffIds: all, bookedStaffIds: [team.b], pendingCount: 0 },
        ],
      },
    ]);
  });

  it("filters by status (comma list) and keeps only slots whose start is inside the range", async () => {
    const confirmed = await confirmedWith(pat, at(FRI, 10), team.a);
    const pending = await submit(sam, at(FRI, 14));
    expect(ids((await cal(techCookie, `${day}&status=confirmed`)).json.reservations)).toEqual([confirmed]);
    expect(ids((await cal(techCookie, `${day}&status=pending`)).json.reservations)).toEqual([pending]);
    expect(ids((await cal(techCookie, `${day}&status=pending,confirmed`)).json.reservations)).toEqual([confirmed, pending]);
    expect(ids((await cal(techCookie, `${day}&status=`)).json.reservations)).toEqual([confirmed, pending]);
    expect((await cal(techCookie, `${day}&status=bogus`)).status).toBe(400);

    const afternoon = await cal(techCookie, `from=${at(FRI, 14)}&to=${at(FRI, 15)}`);
    expect(afternoon.json.slots).toHaveLength(1);
    expect(afternoon.json.slots[0].slots.map((s: any) => s.startAt)).toEqual([at(FRI, 14), at(FRI, 14, 30)]);
    expect(ids(afternoon.json.reservations)).toEqual([pending]);
  });

  it("staffId shows that technician's appointments, plus requests provisionally on them flagged but never their id elsewhere", async () => {
    const confirmed = await confirmedWith(pat, at(FRI, 10), team.a);
    const pending = await submit(sam, at(FRI, 14));
    const provisional = (await env.DB.prepare("SELECT provisional_staff_id AS p FROM reservations WHERE id = ?").bind(pending).first<{ p: number }>())!.p;
    expect([team.admin, team.a, team.b]).toContain(provisional);

    const theirs = await cal(techCookie, `${day}&staffId=${provisional}`);
    const pendingRow = theirs.json.reservations.find((r: any) => r.id === pending);
    expect(pendingRow.provisionalForFilteredStaff).toBe(true);
    expect(theirs.json.reservations.filter((r: any) => r.id !== pending && r.provisionalForFilteredStaff !== false)).toEqual([]);

    // A technician with nothing provisional or assigned sees nothing.
    const none = await cal(techCookie, `${day}&staffId=${team.d}`);
    expect(none.json.reservations).toEqual([]);
    // The assigned technician's own appointment is not flagged.
    const tims = await cal(techCookie, `${day}&staffId=${team.a}`);
    expect(tims.json.reservations.find((r: any) => r.id === confirmed).provisionalForFilteredStaff).toBe(false);
    // Another technician's confirmed appointment never appears under the filter.
    expect(ids((await cal(techCookie, `${day}&staffId=${team.b}`)).json.reservations)).not.toContain(confirmed);
  });

  it("an unfiltered feed does not flag provisional technicians", async () => {
    await submit(sam, at(FRI, 14));
    const res = await cal(adminCookie, day);
    for (const r of res.json.reservations) expect(r).not.toHaveProperty("provisionalForFilteredStaff");
  });

  it("validates the range: both ends required, ascending, at most 42 days", async () => {
    const from = at(FRI, 0);
    expect((await cal(techCookie, `from=${from}`)).status).toBe(400);
    expect((await cal(techCookie, `to=${from + MIN}`)).status).toBe(400);
    for (const qs of [`from=&to=${from + MIN}`, `from=${from}&to=`, `from=abc&to=${from + MIN}`, `from=${from}&to=1.5`, `from=&to=`]) {
      const bad = await cal(techCookie, qs);
      expect(bad.status).toBe(400);
      expect(bad.json.error).toBe("invalid");
    }
    expect((await cal(techCookie, `from=${from}&to=${from}`)).json.error).toBe("invalid_range");
    expect((await cal(techCookie, `from=${from}&to=${from - MIN}`)).status).toBe(400);
    const DAY = 24 * 60 * MIN;
    expect((await cal(techCookie, `from=${from}&to=${from + 42 * DAY}`)).status).toBe(200);
    const long = await cal(techCookie, `from=${from}&to=${from + 42 * DAY + 1}`);
    expect(long.status).toBe(400);
    expect(long.json.error).toBe("range_too_long");
  });

  it("requires staff", async () => {
    expect((await cal(undefined, day)).status).toBe(401);
    expect((await cal(pat.cookie, day)).status).toBe(401);
  });
});

describe("audit log", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM audit_log").run(); // sign-ins from the shared setup
  });

  it("lists newest first, 100 per page, with actor names and prefix filters", async () => {
    await seedWeekly(5, 600, 660, [team.admin, team.a, team.b]);
    const id = await confirmedWith(pat, at(FRI, 10), team.a);
    await api("POST", `/api/staff/reservations/${id}/cancel`, { cookie: techCookie, body: { reason: "No longer needed", version: 2 } });

    const res = await get(techCookie, "/api/staff/audit");
    expect(res.status).toBe(200);
    const rows = res.json.entries as any[];
    const forRes = rows.filter((r) => r.reservationId === id).map((r) => r.action);
    expect(forRes).toEqual(["reservation.cancelled", "reservation.approved", "reservation.requested"]);
    expect(rows.every((r, i) => i === 0 || (rows[i - 1].at > r.at) || (rows[i - 1].at === r.at && rows[i - 1].id > r.id))).toBe(true);
    const approved = rows.find((r) => r.action === "reservation.approved");
    expect(approved).toMatchObject({ actorKind: "staff", actor: "Ada Admin", actorId: String(team.admin), reservationId: id });
    expect(approved.reservationRef).toMatch(/\S/);
    expect(rows.find((r) => r.action === "reservation.requested")).toMatchObject({ actorKind: "customer", actor: "pat@example.test", actorId: "pat@example.test" });
  });

  it("filters by reservation, customer, actor and action (exact or `prefix.`)", async () => {
    const adminId = String(team.admin);
    const ins = (at_: number, actor: string, kind: string, action: string, reservationId: string | null, customerId: number | null) =>
      env.DB.prepare("INSERT INTO audit_log(at, actor_kind, actor, action, reservation_id, customer_id, details) VALUES (?, ?, ?, ?, ?, ?, '{}')")
        .bind(at_, kind, actor, action, reservationId, customerId)
        .run();
    await ins(1, adminId, "staff", "reservation.approved", "r1", pat.id);
    await ins(2, String(team.a), "staff", "reservation.cancelled", "r1", pat.id);
    await ins(3, adminId, "staff", "customer.update", null, pat.id);
    await ins(4, adminId, "staff", "email.retry", "r2", null);
    await ins(5, "pat@example.test", "customer", "reservation.requested", "r2", sam.id);
    const actions = async (qs: string) => ((await get(techCookie, `/api/staff/audit?${qs}`)).json.entries as any[]).map((r) => r.action);

    expect(await actions("")).toEqual(["reservation.requested", "email.retry", "customer.update", "reservation.cancelled", "reservation.approved"]);
    expect(await actions("reservationId=r1")).toEqual(["reservation.cancelled", "reservation.approved"]);
    expect(await actions(`customerId=${pat.id}`)).toEqual(["customer.update", "reservation.cancelled", "reservation.approved"]);
    expect(await actions(`actor=${adminId}`)).toEqual(["email.retry", "customer.update", "reservation.approved"]);
    expect(await actions("actor=pat@example.test")).toEqual(["reservation.requested"]);
    expect(await actions("action=reservation.")).toEqual(["reservation.requested", "reservation.cancelled", "reservation.approved"]);
    expect(await actions("action=reservation.approved")).toEqual(["reservation.approved"]);
    // A bare prefix without the dot is an exact match; `%` and `_` are literal.
    expect(await actions("action=reservation")).toEqual([]);
    expect(await actions("action=%25")).toEqual([]);
    expect(await actions(`reservationId=r1&action=reservation.&actor=${adminId}`)).toEqual(["reservation.approved"]);
    // Empty params are ignored.
    expect(await actions("reservationId=&customerId=&actor=&action=&cursor=")).toHaveLength(5);
    // Staff actors are shown by name.
    const named = (await get(techCookie, `/api/staff/audit?actor=${adminId}`)).json.entries as any[];
    expect(new Set(named.map((r) => r.actor))).toEqual(new Set(["Ada Admin"]));
  });

  it("matches any of several comma-separated action terms (each exact or `prefix.`)", async () => {
    const ins = (at_: number, action: string) =>
      env.DB.prepare("INSERT INTO audit_log(at, actor_kind, actor, action, details) VALUES (?, 'staff', '1', ?, '{}')").bind(at_, action).run();
    await ins(1, "settings.booking");
    await ins(2, "schedule.settings.update");
    await ins(3, "schedule.window.create");
    await ins(4, "customer.update");
    await ins(5, "customers.import");
    await ins(6, "reservation.approved");
    const actions = async (qs: string) => ((await get(techCookie, `/api/staff/audit?${qs}`)).json.entries as any[]).map((r) => r.action);

    expect(await actions(`action=${encodeURIComponent("settings.,schedule.settings.")}`)).toEqual(["schedule.settings.update", "settings.booking"]);
    expect(await actions(`action=${encodeURIComponent("customer.,customers.")}`)).toEqual(["customers.import", "customer.update"]);
    expect(await actions(`action=${encodeURIComponent("reservation.approved,schedule.window.create")}`)).toEqual(["reservation.approved", "schedule.window.create"]);
    // Blank terms are ignored; a list of only blanks is no filter.
    expect(await actions(`action=${encodeURIComponent("customers.,,")}`)).toEqual(["customers.import"]);
    expect(await actions(`action=${encodeURIComponent(",")}`)).toHaveLength(6);
    // At most 10 terms.
    const many = Array.from({ length: 11 }, (_, i) => `a${i}.`).join(",");
    expect((await get(techCookie, `/api/staff/audit?action=${encodeURIComponent(many)}`)).status).toBe(400);
  });

  it("pages 100 at a time without gaps", async () => {
    const stmts = Array.from({ length: 230 }, (_, i) =>
      env.DB.prepare("INSERT INTO audit_log(at, actor_kind, actor, action, details) VALUES (?, 'system', NULL, 'system.tick', '{}')").bind(1000 + (i % 7)),
    );
    await env.DB.batch(stmts);
    const seen: number[] = [];
    let cursor: string | null = null;
    const sizes: number[] = [];
    do {
      const res: any = await get(techCookie, `/api/staff/audit${cursor ? `?cursor=${cursor}` : ""}`);
      sizes.push(res.json.entries.length);
      seen.push(...res.json.entries.map((r: any) => r.id));
      cursor = res.json.nextCursor;
    } while (cursor);
    expect(sizes).toEqual([100, 100, 30]);
    expect(new Set(seen).size).toBe(230);
    expect((await get(techCookie, "/api/staff/audit?cursor=garbage")).json.error).toBe("invalid_cursor");
  });

  it("requires staff", async () => {
    expect((await get(undefined, "/api/staff/audit")).status).toBe(401);
    expect((await get(pat.cookie, "/api/staff/audit")).status).toBe(401);
  });
});

describe("email failures", () => {
  const job = async (o: { id: string; status: string; to?: string; template?: string; reservationId?: string | null; createdAt?: number; attempts?: number; lastError?: string | null; lockedUntil?: number | null }) => {
    await env.DB.prepare(
      `INSERT INTO email_jobs(id, dedupe_key, template, to_email, reservation_id, payload, status, attempts, send_after, locked_until, last_error, created_at, sent_at)
       VALUES (?, ?, ?, ?, ?, '{}', ?, ?, 5000, ?, ?, ?, NULL)`,
    )
      .bind(o.id, `dk-${o.id}`, o.template ?? "confirmed", o.to ?? "jordan@example.test", o.reservationId ?? null, o.status, o.attempts ?? 0, o.lockedUntil ?? null, o.lastError ?? null, o.createdAt ?? 100)
      .run();
  };
  const jobRow = (id: string) => env.DB.prepare("SELECT * FROM email_jobs WHERE id = ?").bind(id).first<any>();
  const retry = (cookie: string, id: string) => api("POST", `/api/staff/emails/${id}/retry`, { cookie });

  beforeEach(async () => {
    // The outbox is quiet: anything queued here must stay queued unless a test kicks it.
    await env.DB.prepare("DELETE FROM email_jobs").run();
    await env.DB.prepare("DELETE FROM audit_log").run();
  });

  it("lists failed jobs by default, other statuses on request, newest first, with the reservation ref", async () => {
    await insertRes({ id: "r1", startAt: at(FRI, 10) });
    const ref = (await env.DB.prepare("SELECT ref FROM reservations WHERE id = 'r1'").first<string>("ref"))!;
    await job({ id: "f1", status: "failed", createdAt: 100, attempts: 6, lastError: "smtp 550", reservationId: "r1" });
    await job({ id: "f2", status: "failed", createdAt: 200 });
    await job({ id: "q1", status: "queued", createdAt: 300 });
    await job({ id: "s1", status: "sent", createdAt: 400 });
    await job({ id: "k1", status: "skipped", createdAt: 500 });
    await job({ id: "c1", status: "cancelled", createdAt: 600 });

    const failed = await get(adminCookie, "/api/staff/emails");
    expect(failed.status).toBe(200);
    expect(ids(failed.json.emails)).toEqual(["f2", "f1"]);
    expect(failed.json.nextCursor).toBeNull();
    expect(failed.json.emails[1]).toEqual({
      id: "f1",
      template: "confirmed",
      to: "jordan@example.test",
      reservationId: "r1",
      ref,
      status: "failed",
      attempts: 6,
      lastError: "smtp 550",
      createdAt: 100,
      sentAt: null,
      sendAfter: 5000,
    });
    for (const [status, want] of [["queued", "q1"], ["sent", "s1"], ["skipped", "k1"], ["cancelled", "c1"]] as const) {
      expect(ids((await get(adminCookie, `/api/staff/emails?status=${status}`)).json.emails)).toEqual([want]);
    }
    expect(ids((await get(adminCookie, "/api/staff/emails?status=")).json.emails)).toEqual(["f2", "f1"]);
    expect((await get(adminCookie, "/api/staff/emails?status=sending")).status).toBe(400);
    expect((await get(adminCookie, "/api/staff/emails?status=nope")).status).toBe(400);
  });

  it("pages with a cursor", async () => {
    await env.DB.batch(
      Array.from({ length: 60 }, (_, i) =>
        env.DB.prepare("INSERT INTO email_jobs(id, dedupe_key, template, to_email, payload, status, send_after, created_at) VALUES (?, ?, 'confirmed', 'x@example.test', '{}', 'failed', 0, ?)")
          .bind(`j${String(i).padStart(2, "0")}`, `d${i}`, 1000 + Math.floor(i / 2)),
      ),
    );
    const p1 = await get(adminCookie, "/api/staff/emails");
    expect(p1.json.emails).toHaveLength(50);
    const p2 = await get(adminCookie, `/api/staff/emails?cursor=${p1.json.nextCursor}`);
    expect(p2.json.emails).toHaveLength(10);
    expect(p2.json.nextCursor).toBeNull();
    expect(new Set([...ids(p1.json.emails), ...ids(p2.json.emails)]).size).toBe(60);
    expect((await get(adminCookie, "/api/staff/emails?cursor=zzz")).json.error).toBe("invalid_cursor");
  });

  it("masks recipients for technicians and shows them in full to admins", async () => {
    await job({ id: "f1", status: "failed", to: "jordan@example.test" });
    await job({ id: "f2", status: "failed", to: "Pat.Lee@sub.example.test", createdAt: 200 });
    const tech = await get(techCookie, "/api/staff/emails");
    expect(tech.status).toBe(200);
    expect(tech.json.emails.map((e: any) => e.to)).toEqual(["P***@sub.example.test", "j***@example.test"]);
    expect(JSON.stringify(tech.json)).not.toContain("jordan");
    const admin = await get(adminCookie, "/api/staff/emails");
    expect(admin.json.emails.map((e: any) => e.to)).toEqual(["Pat.Lee@sub.example.test", "jordan@example.test"]);
  });

  it("masks recipient addresses echoed in lastError for technicians, not for admins", async () => {
    await job({ id: "f1", status: "failed", to: "jordan@example.test", lastError: "550 <jordan@example.test> user unknown; cc other.person@mail.example.test" });
    const tech = await get(techCookie, "/api/staff/emails");
    expect(tech.json.emails[0].lastError).toBe("550 <j***@example.test> user unknown; cc o***@mail.example.test");
    expect(JSON.stringify(tech.json)).not.toContain("jordan");
    expect(JSON.stringify(tech.json)).not.toContain("other.person");
    expect((await get(adminCookie, "/api/staff/emails")).json.emails[0].lastError).toBe(
      "550 <jordan@example.test> user unknown; cc other.person@mail.example.test",
    );
  });

  it("never exposes a login token or URL through lastError", async () => {
    await job({ id: "f1", status: "failed", lastError: "bad link https://app.example.test/login#t=SECRETTOKEN123 rejected" });
    const res = await get(adminCookie, "/api/staff/emails");
    expect(JSON.stringify(res.json)).not.toContain("SECRETTOKEN123");
    expect(JSON.stringify(res.json)).not.toContain("https://");
  });

  it("summarises failed and queued counts for any staff", async () => {
    await job({ id: "f1", status: "failed" });
    await job({ id: "f2", status: "failed" });
    await job({ id: "q1", status: "queued" });
    await job({ id: "s1", status: "sent" });
    await job({ id: "g1", status: "sending" });
    for (const cookie of [adminCookie, techCookie]) {
      const res = await get(cookie, "/api/staff/emails/summary");
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ failed: 2, queued: 1 });
    }
    await env.DB.prepare("DELETE FROM email_jobs").run();
    expect((await get(adminCookie, "/api/staff/emails/summary")).json).toEqual({ failed: 0, queued: 0 });
  });

  it("retry puts a failed job back in the queue: attempts reset, due now, error kept, lock cleared, audited", async () => {
    await insertRes({ id: "r1", startAt: at(FRI, 10) });
    await job({ id: "f1", status: "failed", attempts: 6, lastError: "smtp 550", lockedUntil: 99_999, reservationId: "r1", template: "declined" });
    await retryFailedEmail(env.DB, "f1", team.admin);
    expect(await jobRow("f1")).toMatchObject({ status: "queued", attempts: 0, send_after: at(THU, 8), locked_until: null, last_error: "smtp 550" });
    const rows = (await env.DB.prepare("SELECT * FROM audit_log").all<any>()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_kind: "staff", actor: String(team.admin), action: "email.retry", reservation_id: "r1", at: at(THU, 8) });
    expect(JSON.parse(rows[0].details)).toEqual({ id: "f1", template: "declined" });
  });

  it("retry through the API (admin) re-queues and kicks the outbox", async () => {
    await job({ id: "f1", status: "failed", attempts: 6, lastError: "smtp 550", template: "staff_login", to: "tech-a@example.test" });
    const mails = () => env.DB.prepare("SELECT COUNT(*) AS n FROM dev_mailbox WHERE to_email = 'tech-a@example.test'").first<{ n: number }>().then((r) => r!.n);
    const before = await mails(); // the test's own staff login mail is already there
    const res = await retry(adminCookie, "f1");
    expect(res.status).toBe(200);
    // The kicked outbox delivered it (MAIL_MODE=dev writes the message to the dev mailbox).
    expect(env.MAIL_MODE).toBe("dev");
    const after = await jobRow("f1");
    expect(after).toMatchObject({ status: "sent", attempts: 0, locked_until: null });
    expect(after.sent_at).not.toBeNull();
    expect(await mails()).toBe(before + 1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'email.retry'").first<{ n: number }>())!.n).toBe(1);
    expect((await get(adminCookie, "/api/staff/emails/summary")).json.failed).toBe(0);
  });

  it("refuses to retry anything that is not failed (409 not_failed) and unknown ids (404), without writing", async () => {
    for (const status of ["queued", "sending", "sent", "skipped", "cancelled"]) {
      await job({ id: `j-${status}`, status, attempts: 2, lastError: "old" });
      const res = await retry(adminCookie, `j-${status}`);
      expect(res.status).toBe(409);
      expect(res.json.error).toBe("not_failed");
      expect(await jobRow(`j-${status}`)).toMatchObject({ status, attempts: 2, send_after: 5000, last_error: "old" });
    }
    expect((await retry(adminCookie, "missing")).status).toBe(404);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>())!.n).toBe(0);
  });

  it("a job that stops being failed between the read and the write is refused and not audited", async () => {
    await job({ id: "f1", status: "failed" });
    const real = env.DB;
    const racing = {
      prepare: (q: string) => real.prepare(q),
      batch: async (stmts: D1PreparedStatement[]) => {
        await real.prepare("UPDATE email_jobs SET status = 'sent' WHERE id = 'f1'").run();
        return real.batch(stmts);
      },
    } as unknown as D1Database;
    await expect(retryFailedEmail(racing, "f1", team.admin)).rejects.toMatchObject({ status: 409, code: "not_failed" });
    expect((await jobRow("f1")).status).toBe("sent");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>())!.n).toBe(0);
  });

  it("technicians cannot retry (403) and the job is untouched", async () => {
    await job({ id: "f1", status: "failed", attempts: 6 });
    const res = await retry(techCookie, "f1");
    expect(res.status).toBe(403);
    expect(await jobRow("f1")).toMatchObject({ status: "failed", attempts: 6 });
  });

  it("requires staff, and a mutating call needs the usual headers", async () => {
    await job({ id: "f1", status: "failed" });
    expect((await get(undefined, "/api/staff/emails")).status).toBe(401);
    expect((await get(undefined, "/api/staff/emails/summary")).status).toBe(401);
    expect((await api("POST", "/api/staff/emails/f1/retry")).status).toBe(401);
    expect((await api("POST", "/api/staff/emails/f1/retry", { cookie: adminCookie, xrw: false })).status).toBe(403);
    expect((await jobRow("f1")).status).toBe("failed");
  });
});
