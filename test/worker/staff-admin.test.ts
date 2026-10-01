import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/worker/index";
import { api, ORIGIN } from "../helpers";
import { loginCustomer, loginStaff, lastMailTo, seedCustomer, seedTeam, seedWeekly, TZ, withBatchHook } from "../fixtures";
import { setNow } from "../../src/worker/lib/clock";
import { previewChange } from "../../src/worker/scheduling/roster";
import { wallToUtc } from "../../src/domain/time";

afterEach(() => setNow(null));

const THU = "2026-10-01";
const FRI = "2026-10-02";
const at = (date: string, h: number, m = 0) => wallToUtc(date, h * 60 + m, TZ);

let team: Awaited<ReturnType<typeof seedTeam>>;
let adminCookie: string;
let techCookie: string;
let pat: { id: number; cookie: string };
let sam: { id: number; cookie: string };

beforeEach(async () => {
  setNow(at(THU, 8));
  team = await seedTeam();
  for (const [id, name] of [[team.admin, "Ada Admin"], [team.a, "Tim Tech"], [team.b, "Una Tech"], [team.c, "Cy Tech"], [team.d, "Dee Tech"]] as const) {
    await env.DB.prepare("UPDATE staff SET name = ? WHERE id = ?").bind(name, id).run();
  }
  await seedWeekly(5, 600, 660, [team.a, team.b]);
  pat = { id: await seedCustomer({ email: "pat@example.test", name: "Pat Co" }), cookie: "" };
  sam = { id: await seedCustomer({ email: "sam@example.test", name: "Sam Co" }), cookie: "" };
  pat.cookie = await loginCustomer("pat@example.test");
  sam.cookie = await loginCustomer("sam@example.test");
  adminCookie = await loginStaff("admin@example.test");
  techCookie = await loginStaff("tech-a@example.test");
});

const row = (id: number) => env.DB.prepare("SELECT email, name, role, bookable, notify, active FROM staff WHERE id = ?").bind(id).first<any>();
const count = async (sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;
const version = async () => (await env.DB.prepare("SELECT version FROM schedule_state").first<{ version: number }>())!.version;
const audits = async (like = "%") =>
  (await env.DB.prepare("SELECT actor_kind, actor, action, details FROM audit_log WHERE action LIKE ? ORDER BY id").bind(like).all<any>()).results.map((a) => ({ ...a, details: JSON.parse(a.details) }));

const create = (cookie: string, body: Record<string, unknown>) => api("POST", "/api/staff/team", { cookie, body });
const patch = (cookie: string, id: number, body: Record<string, unknown>) => api("PATCH", `/api/staff/team/${id}`, { cookie, body });
const preview = (cookie: string, id: number, body: Record<string, unknown>) => api("POST", `/api/staff/team/${id}/preview`, { cookie, body });
const applyTo = (cookie: string, id: number, body: Record<string, unknown>, v: number) => api("POST", `/api/staff/team/${id}/apply`, { cookie, body: { ...body, version: v } });
const change = async (cookie: string, id: number, body: Record<string, unknown>) => {
  const p = await preview(cookie, id, body);
  expect(p.status, JSON.stringify(p.json)).toBe(200);
  return applyTo(cookie, id, body, p.json.version);
};
const newPerson = { email: "new.person@example.test", name: "New Person", role: "technician", bookable: true, notify: false };

const submit = async (who: { id: number; cookie: string }, startAt: number) => {
  const res = await api("POST", "/api/customer/reservations", {
    cookie: who.cookie,
    body: { customerId: who.id, startAt, contactName: "Pat Example", phone: "+81 3-1234-5678", issue: "Printer is offline", idempotencyKey: crypto.randomUUID() },
  });
  expect(res.status).toBe(201);
  return res.json.reservation as { id: string; ref: string };
};
const approve = async (id: string, staffId: number) => {
  const res = await api("POST", `/api/staff/reservations/${id}/approve`, { cookie: adminCookie, body: { staffId, version: 1 } });
  expect(res.status).toBe(200);
};

/** The app with a hooked DB: `hook` runs right before the first batch of this request commits. */
async function apiHooked(hook: () => Promise<void>, method: string, path: string, cookie: string, body: unknown) {
  const { env: hooked, calls } = withBatchHook(hook);
  const ctx = createExecutionContext();
  const res = await worker.fetch!(
    new Request(`${ORIGIN}${path}`, { method, headers: { "content-type": "application/json", origin: ORIGIN, "x-requested-with": "fetch", cookie }, body: JSON.stringify(body) }) as any,
    hooked as any,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: (await res.json()) as any, calls };
}

describe("listing", () => {
  it("any staff member sees the whole team; customers and visitors do not", async () => {
    await env.DB.prepare("UPDATE staff SET active = 0, notify = 0 WHERE id = ?").bind(team.d).run();
    for (const cookie of [adminCookie, techCookie]) {
      const res = await api("GET", "/api/staff/team", { cookie });
      expect(res.status).toBe(200);
      expect(res.json.staff).toHaveLength(5);
      expect(res.json.staff[0]).toEqual({ id: team.admin, email: "admin@example.test", name: "Ada Admin", role: "admin", bookable: true, notify: true, active: true });
      expect(res.json.staff.find((s: any) => s.id === team.d)).toMatchObject({ active: false, notify: false });
    }
    expect((await api("GET", "/api/staff/team")).status).toBe(401);
    expect((await api("GET", "/api/staff/team", { cookie: pat.cookie })).status).toBe(401);
  });
});

describe("create", () => {
  it("adds a staff member with a lowercased, trimmed email, audited", async () => {
    const res = await create(adminCookie, { ...newPerson, email: "  New.Person@Example.TEST " });
    expect(res.status).toBe(201);
    expect(res.json.staff).toEqual({ id: expect.any(Number), email: "new.person@example.test", name: "New Person", role: "technician", bookable: true, notify: false, active: true });
    expect(await row(res.json.staff.id)).toMatchObject({ email: "new.person@example.test", active: 1, bookable: 1, notify: 0 });
    expect(await audits("staff.%")).toEqual([
      { actor_kind: "staff", actor: String(team.admin), action: "staff.create", details: { email: "new.person@example.test", name: "New Person", role: "technician", bookable: true, notify: false } },
    ]);
    // The new person can sign in right away.
    expect(await loginStaff("new.person@example.test")).toContain("__Host-staff=");
    const list = await api("GET", "/api/staff/team", { cookie: adminCookie });
    expect(list.json.staff).toHaveLength(6);
  });

  it("rejects a taken email (any case) with 409 email_taken and writes nothing", async () => {
    const before = await count("SELECT COUNT(*) AS n FROM audit_log");
    for (const email of ["tech-a@example.test", "TECH-A@Example.Test"]) {
      const res = await create(adminCookie, { ...newPerson, email });
      expect([res.status, res.json.error]).toEqual([409, "email_taken"]);
    }
    expect(await count("SELECT COUNT(*) AS n FROM staff")).toBe(5);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log")).toBe(before);
  });

  it("validates the body", async () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ["no email", { ...newPerson, email: undefined }],
      ["bad email", { ...newPerson, email: "not-an-email" }],
      ["empty name", { ...newPerson, name: "   " }],
      ["long name", { ...newPerson, name: "x".repeat(101) }],
      ["bad role", { ...newPerson, role: "owner" }],
      ["no bookable", { ...newPerson, bookable: undefined }],
      ["no notify", { ...newPerson, notify: undefined }],
      ["string flag", { ...newPerson, bookable: "yes" }],
    ];
    for (const [label, body] of bad) {
      const res = await create(adminCookie, body);
      expect([res.status, res.json.error], label).toEqual([400, "invalid"]);
    }
    expect(await count("SELECT COUNT(*) AS n FROM staff")).toBe(5);
  });
});

describe("update name, role, notify", () => {
  it("changes only what was sent, audits the changed fields, does not touch capacity", async () => {
    const v0 = await version();
    const res = await patch(adminCookie, team.b, { name: "  Una T.  ", notify: false });
    expect(res.status).toBe(200);
    expect(res.json.staff).toEqual({ id: team.b, email: "tech-b@example.test", name: "Una T.", role: "technician", bookable: true, notify: false, active: true });
    expect(await version()).toBe(v0);
    const promote = await patch(adminCookie, team.b, { role: "admin" });
    expect(promote.json.staff.role).toBe("admin");
    expect(await audits("staff.%")).toEqual([
      { actor_kind: "staff", actor: String(team.admin), action: "staff.update", details: { id: team.b, name: "Una T.", notify: false } },
      { actor_kind: "staff", actor: String(team.admin), action: "staff.update", details: { id: team.b, role: "admin" } },
    ]);
  });

  it("a no-op patch succeeds without an audit row", async () => {
    const res = await patch(adminCookie, team.b, { name: "Una Tech" });
    expect(res.status).toBe(200);
    expect(await audits("staff.%")).toEqual([]);
  });

  it("rejects email changes, capacity fields, empty patches and bad values with 400; unknown staff 404", async () => {
    for (const body of [{ email: "other@example.test" }, { active: false }, { bookable: false }, {}, { name: "" }, { role: "boss" }, { name: "Ok", extra: 1 }]) {
      const res = await patch(adminCookie, team.b, body);
      expect([res.status, res.json.error], JSON.stringify(body)).toEqual([400, "invalid"]);
    }
    expect((await row(team.b)).email).toBe("tech-b@example.test");
    expect((await patch(adminCookie, 9999, { name: "Ghost" })).status).toBe(404);
    expect((await patch(adminCookie, "abc" as any, { name: "Ghost" })).status).toBe(404);
  });
});

describe("last admin and self rules", () => {
  it("an admin cannot demote themselves (409 self), even when another admin exists", async () => {
    await patch(adminCookie, team.a, { role: "admin" });
    const res = await patch(adminCookie, team.admin, { role: "technician" });
    expect([res.status, res.json.error]).toEqual([409, "self"]);
    expect((await row(team.admin)).role).toBe("admin");
  });

  it("an admin cannot deactivate themselves (409 self), in preview and apply", async () => {
    await patch(adminCookie, team.a, { role: "admin" });
    const v = await version();
    for (const res of [await preview(adminCookie, team.admin, { active: false }), await applyTo(adminCookie, team.admin, { active: false }, v)]) {
      expect([res.status, res.json.error]).toEqual([409, "self"]);
    }
    expect((await row(team.admin)).active).toBe(1);
    expect(await version()).toBe(v);
    // Their own bookable flag is theirs to change.
    expect((await change(adminCookie, team.admin, { bookable: false })).status).toBe(200);
  });

  it("another admin may demote or deactivate an admin while one else stays", async () => {
    await patch(adminCookie, team.a, { role: "admin" });
    const a = await loginStaff("tech-a@example.test");
    expect((await patch(a, team.admin, { role: "technician" })).json.staff.role).toBe("technician");
    expect((await patch(adminCookie, team.b, { name: "Nope" })).status).toBe(403); // Ada is a technician now: no writes
    await patch(a, team.b, { role: "admin" });
    expect((await change(a, team.b, { active: false })).status).toBe(200);
  });

  it("deactivating or demoting an inactive admin never trips the rule", async () => {
    await patch(adminCookie, team.a, { role: "admin" });
    await change(adminCookie, team.a, { active: false });
    expect((await patch(adminCookie, team.a, { role: "technician" })).status).toBe(200);
  });

  it("the roster bridge itself refuses to deactivate the only active admin (409 last_admin)", async () => {
    await expect(previewChange(env, { type: "staff.update", id: team.admin, active: false })).rejects.toMatchObject({ status: 409, code: "last_admin" });
    await patch(adminCookie, team.a, { role: "admin" });
    await expect(previewChange(env, { type: "staff.update", id: team.admin, active: false })).resolves.toBeTruthy();
    await env.DB.prepare("UPDATE staff SET active = 0 WHERE id = ?").bind(team.admin).run();
    await expect(previewChange(env, { type: "staff.update", id: team.a, active: false })).rejects.toMatchObject({ status: 409, code: "last_admin" });
  });

  it("concurrent demotions cannot both succeed (PATCH): the in-batch guard turns the loser into 409 last_admin", async () => {
    await patch(adminCookie, team.a, { role: "admin" }); // admins: Ada (admin) and Tim (a)
    const aCookie = await loginStaff("tech-a@example.test");
    const res = await apiHooked(
      async () => {
        // Between Ada's read and her commit, Tim demotes Ada.
        expect((await patch(aCookie, team.admin, { role: "technician" })).status).toBe(200);
      },
      "PATCH", `/api/staff/team/${team.a}`, adminCookie, { role: "technician" },
    );
    expect([res.status, res.json.error]).toEqual([409, "last_admin"]);
    expect(res.calls.batches).toBe(1);
    expect((await row(team.a)).role).toBe("admin");
    expect((await row(team.admin)).role).toBe("technician");
    expect(await count("SELECT COUNT(*) AS n FROM staff WHERE role = 'admin' AND active = 1")).toBe(1);
  });

  it("a demotion racing a deactivation cannot leave zero admins (apply): 409 last_admin after the retry", async () => {
    await patch(adminCookie, team.a, { role: "admin" });
    const aCookie = await loginStaff("tech-a@example.test");
    const v = await version();
    const res = await apiHooked(
      async () => {
        expect((await patch(aCookie, team.admin, { role: "technician" })).status).toBe(200);
      },
      "POST", `/api/staff/team/${team.a}/apply`, adminCookie, { active: false, version: v },
    );
    expect([res.status, res.json.error]).toEqual([409, "last_admin"]);
    expect(res.calls.batches).toBe(1); // the guarded batch failed; the retry re-read the roster and refused before writing
    expect(await row(team.a)).toMatchObject({ role: "admin", active: 1 });
    expect(await count("SELECT COUNT(*) AS n FROM staff WHERE role = 'admin' AND active = 1")).toBe(1);
    expect(await audits("schedule.%")).toEqual([]);
  });
});

describe("deactivate and reactivate", () => {
  it("revokes the member's sessions in the same commit: their cookie turns 401, and reactivation does not restore it", async () => {
    const tech2 = await loginStaff("tech-a@example.test"); // a second session of the same person
    expect((await api("GET", "/api/staff/team", { cookie: techCookie })).status).toBe(200);
    const otherCookie = await loginStaff("tech-b@example.test");

    const res = await change(adminCookie, team.a, { active: false });
    expect(res.status).toBe(200);
    for (const cookie of [techCookie, tech2]) expect((await api("GET", "/api/staff/team", { cookie })).status).toBe(401);
    expect(await count("SELECT COUNT(*) AS n FROM sessions WHERE staff_id = ? AND revoked_at IS NULL", team.a)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM sessions WHERE staff_id = ? AND revoked_at = ?", team.a, at(THU, 8))).toBe(2);
    // Others are unaffected.
    expect((await api("GET", "/api/staff/team", { cookie: otherCookie })).status).toBe(200);
    expect((await api("GET", "/api/staff/team", { cookie: adminCookie })).status).toBe(200);

    expect((await change(adminCookie, team.a, { active: true })).status).toBe(200);
    expect((await api("GET", "/api/staff/team", { cookie: techCookie })).status).toBe(401);
    const fresh = await loginStaff("tech-a@example.test");
    expect((await api("GET", "/api/staff/team", { cookie: fresh })).status).toBe(200);
  });

  it("a deactivated member cannot sign in again", async () => {
    await change(adminCookie, team.b, { active: false });
    await api("POST", "/api/auth/staff/request", { body: { email: "tech-b@example.test" } });
    expect(await lastMailTo("tech-b@example.test")).toBeNull();
  });

  it("makes the member's windows unbookable: capacity version bumps and the audit is the roster's schedule.staff.update only", async () => {
    const v0 = await version();
    const res = await change(adminCookie, team.b, { active: false });
    expect(res.json.version).toBe(v0 + 1);
    expect(await version()).toBe(v0 + 1);
    expect(await row(team.b)).toMatchObject({ active: 0, bookable: 1 });
    expect(await audits()).toContainEqual({ actor_kind: "staff", actor: String(team.admin), action: "schedule.staff.update", details: { id: team.b, active: false, moved: [] } });
    expect(await audits("staff.%")).toEqual([]); // no double audit
  });

  it("a stale preview is refused with 409 stale_preview and nothing changes", async () => {
    const p = await preview(adminCookie, team.b, { bookable: false });
    await change(adminCookie, team.c, { bookable: false });
    const res = await applyTo(adminCookie, team.b, { bookable: false }, p.json.version);
    expect([res.status, res.json.error]).toEqual([409, "stale_preview"]);
    expect((await row(team.b)).bookable).toBe(1);
  });

  it("rejects an empty change, a missing version and unknown staff", async () => {
    expect((await preview(adminCookie, team.b, {})).status).toBe(400);
    expect((await api("POST", `/api/staff/team/${team.b}/apply`, { cookie: adminCookie, body: { active: false } })).status).toBe(400);
    expect((await preview(adminCookie, 9999, { active: false })).status).toBe(404);
    expect((await applyTo(adminCookie, 9999, { active: false }, await version())).status).toBe(404);
  });
});

describe("conflicts", () => {
  it("deactivating a technician with a confirmed appointment is a conflict that blocks the change (preview shows it, apply refuses)", async () => {
    const r = await submit(pat, at(FRI, 10));
    await approve(r.id, team.a);
    const p = await preview(adminCookie, team.a, { active: false });
    expect(p.status).toBe(200);
    expect(p.json.impact.conflicts).toEqual([
      expect.objectContaining({ id: r.id, status: "confirmed", reason: "tech_removed", staffName: "Tim Tech", customerName: "Pat Co", alternatives: [{ id: team.b, name: "Una Tech", displaces: [] }] }),
    ]);
    const res = await applyTo(adminCookie, team.a, { active: false }, p.json.version);
    expect([res.status, res.json.error]).toEqual([409, "conflicts"]);
    expect(res.json.details.impact.conflicts).toHaveLength(1);
    expect(await row(team.a)).toMatchObject({ active: 1 });
    expect(await count("SELECT COUNT(*) AS n FROM sessions WHERE staff_id = ? AND revoked_at IS NULL", team.a)).toBe(1); // still signed in
    expect(await version()).toBe(p.json.version);
  });

  it("making them unbookable conflicts the same way, and so does an open option hold", async () => {
    const r = await submit(pat, at(FRI, 10));
    await approve(r.id, team.a);
    expect((await preview(adminCookie, team.a, { bookable: false })).json.impact.conflicts).toEqual([expect.objectContaining({ id: r.id, reason: "tech_removed" })]);

    const s = await submit(sam, at(FRI, 10));
    await env.DB.batch([
      env.DB.prepare("INSERT INTO proposals(id, reservation_id, status, created_at, expires_at) VALUES ('p1', ?, 'open', 0, ?)").bind(s.id, at(FRI, 8)),
      env.DB.prepare("INSERT INTO proposal_options(id, proposal_id, start_at, end_at, occ_start, occ_end, staff_id) VALUES ('o1', 'p1', ?, ?, ?, ?, ?)").bind(
        at(FRI, 10, 30), at(FRI, 11), at(FRI, 10, 30), at(FRI, 11, 10), team.b,
      ),
    ]);
    const p = await preview(adminCookie, team.b, { active: false });
    expect(p.json.impact.conflicts).toContainEqual(expect.objectContaining({ id: "o1", kind: "option", reason: "tech_removed", staffName: "Una Tech" }));
  });

  it("pending requests move to another technician automatically when possible", async () => {
    const r = await submit(pat, at(FRI, 10)); // provisionally a
    const before = await env.DB.prepare("SELECT provisional_staff_id AS s FROM reservations WHERE id = ?").bind(r.id).first<{ s: number }>();
    const gone = before!.s;
    const other = gone === team.a ? team.b : team.a;
    const res = await change(adminCookie, gone, { active: false });
    expect(res.status).toBe(200);
    expect(res.json.impact.moved).toEqual([expect.objectContaining({ id: r.id })]);
    expect((await env.DB.prepare("SELECT provisional_staff_id AS s FROM reservations WHERE id = ?").bind(r.id).first<{ s: number }>())!.s).toBe(other);
  });
});

describe("permissions", () => {
  it("technicians get 403 on every write; visitors and customers 401", async () => {
    const v = await version();
    const calls: Array<[string, () => Promise<{ status: number }>]> = [
      ["create", () => create(techCookie, newPerson)],
      ["patch", () => patch(techCookie, team.b, { name: "Nope" })],
      ["preview", () => preview(techCookie, team.b, { active: false })],
      ["apply", () => applyTo(techCookie, team.b, { active: false }, v)],
    ];
    for (const [label, call] of calls) expect((await call()).status, label).toBe(403);
    expect(await row(team.b)).toMatchObject({ name: "Una Tech", active: 1 });
    expect(await count("SELECT COUNT(*) AS n FROM staff")).toBe(5);
    expect((await create("", newPerson)).status).toBe(401);
    expect((await create(pat.cookie, newPerson)).status).toBe(401);
  });

  it("writes need Origin and X-Requested-With like every mutation", async () => {
    const res = await api("POST", "/api/staff/team", { cookie: adminCookie, body: newPerson, xrw: false });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await count("SELECT COUNT(*) AS n FROM staff")).toBe(5);
  });
});
