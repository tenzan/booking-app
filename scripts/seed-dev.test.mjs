// Plain-node tests for the SQL that scripts/seed-dev.mjs runs, against an in-memory SQLite with the real migrations.
// Run with: npm run test:scripts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { seedSql } from "./seed-dev.mjs";

const MIGRATIONS = new URL("../migrations/", import.meta.url);
const CSV = readFileSync(new URL("../docs/sample-customers.csv", import.meta.url), "utf8");

/** A fresh database with every migration applied and foreign keys enforced (as on D1). */
function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
  return db;
}

const seed = (db, reset = false) => db.exec(seedSql({ reset, csvText: CSV }));
const all = (db, sql) => db.prepare(sql).all().map((r) => ({ ...r }));
const count = (db, table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;

/** The weekly schedule as "weekday start-end: staff emails", sorted. */
function weekly(db) {
  return all(
    db,
    `SELECT w.weekday || ' ' || w.start_min || '-' || w.end_min || ': ' ||
            coalesce((SELECT group_concat(email, ',') FROM (SELECT s.email FROM availability_window_staff ws JOIN staff s ON s.id = ws.staff_id
                       WHERE ws.window_id = w.id ORDER BY s.email)), '') AS line
       FROM availability_windows w WHERE w.kind = 'weekly' ORDER BY w.weekday, w.start_min`,
  ).map((r) => r.line);
}

const BASELINE_WEEKLY = [1, 2, 3, 4, 5].flatMap((d) => [
  `${d} 540-720: admin@example.test,tech1@example.test,tech2@example.test`,
  `${d} 780-1020: tech1@example.test,tech2@example.test,tech3@example.test`,
]);

test("a fresh database gets the staff, the sample CSV's customers and the weekly schedule", () => {
  const db = freshDb();
  seed(db);
  assert.deepEqual(
    all(db, "SELECT email, role FROM staff ORDER BY email").map((r) => `${r.email}:${r.role}`),
    ["admin@example.test:admin", "tech1@example.test:technician", "tech2@example.test:technician", "tech3@example.test:technician"],
  );
  assert.deepEqual(
    all(db, "SELECT customer_number, name, phone, active FROM customers ORDER BY customer_number").map((r) => [r.customer_number, r.name, r.phone, r.active]),
    [
      ["C-1001", "Example Dental Clinic", "+1-555-0100", 1],
      ["C-1002", "Sample Eye Care", "+1-555-0101", 1],
      ["C-1003", "Demo Family Practice", null, 1],
      ["C-1004", "Demo Family Practice West", null, 1],
      ["C-1005", "Inactive Example Co", null, 0],
    ],
  );
  assert.deepEqual(
    all(db, "SELECT c.customer_number AS n, k.email FROM customer_contacts k JOIN customers c ON c.id = k.customer_id ORDER BY n, k.email").map((r) => `${r.n} ${r.email}`),
    ["C-1001 frontdesk@example.test", "C-1001 manager@example.test", "C-1002 office@example.test", "C-1003 shared@example.test", "C-1004 shared@example.test", "C-1005 former@example.test"],
  );
  assert.deepEqual(weekly(db), BASELINE_WEEKLY);
  assert.equal(db.prepare("SELECT version FROM schedule_state").get().version, 1);
});

test("a plain re-run is idempotent and leaves edited schedule, settings and data alone", () => {
  const db = freshDb();
  seed(db);
  // What an administrator might have changed since.
  db.exec(`
    DELETE FROM availability_window_staff WHERE staff_id = (SELECT id FROM staff WHERE email = 'tech3@example.test');
    INSERT INTO availability_window_staff (window_id, staff_id)
      SELECT id, (SELECT id FROM staff WHERE email = 'tech3@example.test') FROM availability_windows WHERE weekday = 1 AND start_min = 540;
    DELETE FROM availability_windows WHERE weekday = 5 AND start_min = 780;
    INSERT INTO settings (key, value) VALUES ('supportPhone', '"+1 555 0199"');
    INSERT INTO holidays (date, name) VALUES ('2026-12-25', 'Holiday');
    UPDATE staff SET name = 'Renamed Admin' WHERE email = 'admin@example.test';
    UPDATE customers SET name = 'Renamed Clinic' WHERE customer_number = 'C-1001';
    INSERT INTO customers (customer_number, name, active, created_at, updated_at) VALUES ('X-1', 'Extra Co', 1, 0, 0);
    INSERT INTO staff (email, name, role, created_at, updated_at) VALUES ('extra@example.test', 'Extra Tech', 'technician', 0, 0);
  `);
  const before = { weekly: weekly(db), staff: count(db, "staff"), customers: count(db, "customers"), contacts: count(db, "customer_contacts") };

  seed(db);
  seed(db);

  assert.deepEqual(weekly(db), before.weekly);
  assert.equal(count(db, "staff"), before.staff);
  assert.equal(count(db, "customers"), before.customers);
  assert.equal(count(db, "customer_contacts"), before.contacts);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'supportPhone'").get().value, '"+1 555 0199"');
  assert.equal(count(db, "holidays"), 1);
  assert.equal(db.prepare("SELECT name FROM staff WHERE email = 'admin@example.test'").get().name, "Renamed Admin");
  assert.equal(db.prepare("SELECT name FROM customers WHERE customer_number = 'C-1001'").get().name, "Renamed Clinic");
});

test("a plain run adds missing sample rows without touching an existing schedule", () => {
  const db = freshDb();
  seed(db);
  db.exec("DELETE FROM customer_contacts WHERE email = 'manager@example.test'");
  db.exec("DELETE FROM availability_window_staff; DELETE FROM availability_windows WHERE NOT (weekday = 2 AND start_min = 540)");
  db.exec("INSERT INTO availability_window_staff (window_id, staff_id) SELECT w.id, s.id FROM availability_windows w, staff s WHERE s.email = 'tech1@example.test'");
  seed(db);
  assert.equal(count(db, "customer_contacts"), 6);
  assert.deepEqual(weekly(db), ["2 540-720: tech1@example.test"]);
});

test("--reset restores the baseline and clears everything else", () => {
  const db = freshDb();
  seed(db);
  const staffIds = all(db, "SELECT email, id FROM staff ORDER BY email");
  db.exec(`
    DELETE FROM availability_window_staff; DELETE FROM availability_windows;
    INSERT INTO availability_windows (kind, weekday, start_min, end_min) VALUES ('weekly', 6, 600, 660);
    INSERT INTO availability_window_staff (window_id, staff_id) SELECT max(id), (SELECT id FROM staff WHERE email = 'tech1@example.test') FROM availability_windows;
    INSERT INTO availability_windows (kind, date, start_min, end_min) VALUES ('date', '2026-12-24', 540, 600);
    INSERT INTO date_overrides (date, note) VALUES ('2026-12-24', 'Short day');
    INSERT INTO holidays (date, name) VALUES ('2026-12-25', 'Holiday');
    INSERT INTO settings (key, value) VALUES ('bookingEnabled', 'false'), ('supportPhone', '"+1 555 0199"');
    INSERT INTO staff_unavailability (staff_id, start_at, end_at) SELECT id, 0, 1 FROM staff WHERE email = 'tech2@example.test';
    UPDATE staff SET name = 'Renamed', role = 'admin', active = 0, bookable = 0, notify = 0 WHERE email = 'tech3@example.test';
    INSERT INTO staff (email, name, role, created_at, updated_at) VALUES ('extra@example.test', 'Extra Tech', 'technician', 0, 0);
    UPDATE customers SET name = 'Renamed Clinic', phone = NULL, active = 0, notes = 'note' WHERE customer_number = 'C-1001';
    UPDATE customer_contacts SET name = 'Someone', active = 0 WHERE email = 'frontdesk@example.test';
    INSERT INTO customer_contacts (customer_id, email, name, active) SELECT id, 'added@example.test', 'Added', 1 FROM customers WHERE customer_number = 'C-1002';
    INSERT INTO customers (customer_number, name, active, created_at, updated_at) VALUES ('X-1', 'Extra Co', 1, 0, 0);
    INSERT INTO customer_contacts (customer_id, email, active) SELECT id, 'extra@example.test', 1 FROM customers WHERE customer_number = 'X-1';
    INSERT INTO reservations (id, ref, customer_id, contact_email, contact_name, phone, issue, start_at, end_at, occ_start, occ_end, status,
                              assigned_staff_id, idempotency_key, created_at, updated_at)
      SELECT 'r1', 'R-1', c.id, 'extra@example.test', 'X', '+1 555', 'x', 0, 1, 0, 1, 'confirmed', s.id, 'k1', 0, 0
        FROM customers c, staff s WHERE c.customer_number = 'X-1' AND s.email = 'extra@example.test';
    INSERT INTO tech_blocks (staff_id, block_start, owner_kind, owner_id) SELECT id, 0, 'reservation', 'r1' FROM staff WHERE email = 'extra@example.test';
    INSERT INTO access_tokens (token_hash, reservation_id, created_at, expires_at) VALUES ('h', 'r1', 0, 1);
    INSERT INTO calendar_tokens (token_hash, reservation_id, audience, created_at, expires_at) VALUES ('c', 'r1', 'customer', 0, 1);
    INSERT INTO proposals (id, reservation_id, status, created_at, expires_at) VALUES ('p1', 'r1', 'open', 0, 1);
    INSERT INTO email_jobs (id, dedupe_key, template, to_email, status, send_after, created_at) VALUES ('e1', 'd1', 't', 'x@example.test', 'queued', 0, 0);
    INSERT INTO dev_mailbox (to_email, subject, html, text, created_at) VALUES ('x@example.test', 's', 'h', 't', 0);
    INSERT INTO audit_log (at, actor_kind, action) VALUES (0, 'system', 'x');
    INSERT INTO rate_limits (key, window_start, count) VALUES ('k', 0, 1);
    INSERT INTO auth_tokens (token_hash, kind, email, created_at, expires_at) VALUES ('t', 'staff', 'extra@example.test', 0, 1);
    INSERT INTO sessions (id_hash, kind, email, staff_id, created_at, expires_at, last_seen_at)
      SELECT 's', 'staff', email, id, 0, 1, 0 FROM staff WHERE email = 'extra@example.test';
  `);
  const optionCols = all(db, "PRAGMA table_info(proposal_options)").map((c) => c.name);
  db.exec(
    `INSERT INTO proposal_options (${optionCols.join(", ")}) SELECT ${optionCols
      .map((c) =>
        c === "id" ? "'o1'" : c === "proposal_id" ? "'p1'" : c === "staff_id" ? "(SELECT id FROM staff WHERE email = 'extra@example.test')" : /end/.test(c) ? "1" : "0",
      )
      .join(", ")}`,
  );
  const version = db.prepare("SELECT version FROM schedule_state").get().version;

  seed(db, true);

  for (const table of [
    "reservations", "tech_blocks", "access_tokens", "calendar_tokens", "proposals", "proposal_options", "email_jobs", "dev_mailbox", "audit_log", "rate_limits",
    "auth_tokens", "sessions", "date_overrides", "holidays", "staff_unavailability", "settings",
  ]) {
    assert.equal(count(db, table), 0, `${table} is cleared`);
  }
  assert.equal(count(db, "availability_windows"), 10);
  assert.deepEqual(weekly(db), BASELINE_WEEKLY);
  assert.ok(db.prepare("SELECT version FROM schedule_state").get().version > version);
  // Baseline staff keep their ids (and are restored); anyone else is gone.
  assert.deepEqual(all(db, "SELECT email, id FROM staff ORDER BY email"), staffIds);
  assert.deepEqual(
    all(db, "SELECT name, role, active, bookable, notify FROM staff WHERE email = 'tech3@example.test'")[0],
    { name: "Drew Tech", role: "technician", active: 1, bookable: 1, notify: 1 },
  );
  assert.deepEqual(all(db, "SELECT customer_number FROM customers ORDER BY customer_number").map((r) => r.customer_number), ["C-1001", "C-1002", "C-1003", "C-1004", "C-1005"]);
  assert.deepEqual(all(db, "SELECT name, phone, active, notes FROM customers WHERE customer_number = 'C-1001'")[0], {
    name: "Example Dental Clinic",
    phone: "+1-555-0100",
    active: 1,
    notes: null,
  });
  assert.deepEqual(all(db, "SELECT email, name, active FROM customer_contacts ORDER BY email, customer_id").map((r) => `${r.email} ${r.name} ${r.active}`), [
    "former@example.test Pat Loe 1",
    "frontdesk@example.test Jamie Doe 1",
    "manager@example.test Riley Roe 1",
    "office@example.test Sam Poe 1",
    "shared@example.test Alex Moe 1",
    "shared@example.test Alex Moe 1",
  ]);

  // And it is repeatable.
  seed(db, true);
  assert.deepEqual(weekly(db), BASELINE_WEEKLY);
  assert.equal(count(db, "customer_contacts"), 6);
});

test("only the local database is ever used", () => {
  const src = readFileSync(new URL("./seed-dev.mjs", import.meta.url), "utf8");
  for (const m of src.matchAll(/\["d1",[^\]]*\]/g)) assert.match(m[0], /"--local"/, m[0]);
  assert.doesNotMatch(src, /--remote/);
});
