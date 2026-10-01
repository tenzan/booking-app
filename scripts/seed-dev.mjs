// Seeds the LOCAL D1 database with synthetic data for development and the e2e test.
//   npm run seed            idempotent: adds staff, customers and the weekly schedule
//   npm run seed -- --reset also clears reservations, emails, sessions, rate limits and the audit log
// Writes the SQL to .wrangler/seed.sql, then runs it with `wrangler d1 execute DB --local`. Never touches a remote database.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const reset = process.argv.includes("--reset");

// Staff, the customers in the sample CSV, and weekly windows Mon–Fri 09:00–12:00 [admin, tech1, tech2]
// and 13:00–17:00 [tech1, tech2, tech3]. The windows are rewritten on every run.
const BASE_SQL = `
INSERT OR IGNORE INTO staff (email,name,role,bookable,notify,active,created_at,updated_at) VALUES
 ('admin@example.test','Avery Admin','admin',1,1,1,0,0),
 ('tech1@example.test','Blake Tech','technician',1,1,1,0,0),
 ('tech2@example.test','Casey Tech','technician',1,1,1,0,0),
 ('tech3@example.test','Drew Tech','technician',1,1,1,0,0);
INSERT OR IGNORE INTO customers (customer_number,name,phone,active,created_at,updated_at) VALUES
 ('C-1001','Example Dental Clinic','+1-555-0100',1,0,0),
 ('C-1002','Sample Eye Care','+1-555-0101',1,0,0),
 ('C-1003','Demo Family Practice',NULL,1,0,0),
 ('C-1004','Demo Family Practice West',NULL,1,0,0);
INSERT OR IGNORE INTO customer_contacts (customer_id,email,name,active) SELECT id,'frontdesk@example.test','Jamie Doe',1 FROM customers WHERE customer_number='C-1001';
INSERT OR IGNORE INTO customer_contacts (customer_id,email,name,active) SELECT id,'office@example.test','Sam Poe',1 FROM customers WHERE customer_number='C-1002';
INSERT OR IGNORE INTO customer_contacts (customer_id,email,name,active) SELECT id,'shared@example.test','Alex Moe',1 FROM customers WHERE customer_number IN ('C-1003','C-1004');
DELETE FROM availability_window_staff; DELETE FROM availability_windows;
INSERT INTO availability_windows (id,kind,weekday,start_min,end_min) VALUES
 (1,'weekly',1,540,720),(2,'weekly',2,540,720),(3,'weekly',3,540,720),(4,'weekly',4,540,720),(5,'weekly',5,540,720),
 (6,'weekly',1,780,1020),(7,'weekly',2,780,1020),(8,'weekly',3,780,1020),(9,'weekly',4,780,1020),(10,'weekly',5,780,1020);
INSERT INTO availability_window_staff (window_id,staff_id) SELECT w.id, s.id FROM availability_windows w JOIN staff s ON s.email IN ('admin@example.test','tech1@example.test','tech2@example.test') WHERE w.start_min=540;
INSERT INTO availability_window_staff (window_id,staff_id) SELECT w.id, s.id FROM availability_windows w JOIN staff s ON s.email IN ('tech1@example.test','tech2@example.test','tech3@example.test') WHERE w.start_min=780;
UPDATE schedule_state SET version = version + 1;
`;

// Transactional data only (children first); staff, customers and settings stay.
const RESET_SQL = `
DELETE FROM tech_blocks; DELETE FROM access_tokens; DELETE FROM proposal_options; DELETE FROM proposals;
DELETE FROM reservations; DELETE FROM email_jobs; DELETE FROM dev_mailbox; DELETE FROM audit_log;
DELETE FROM rate_limits; DELETE FROM auth_tokens; DELETE FROM sessions;
`;

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, CRLF. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") row.push(field), (field = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field), rows.push(row), (row = []), (field = "");
    } else field += ch;
  }
  if (field !== "" || row.length > 0) row.push(field), rows.push(row);
  const [header, ...data] = rows.filter((r) => r.some((f) => f.trim() !== ""));
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

const q = (v) => (v === "" || v === undefined ? "NULL" : `'${String(v).replaceAll("'", "''")}'`);
const truthy = (v) => /^(true|1|yes)$/i.test(v);

function csvSql(path) {
  const lines = [];
  for (const r of parseCsv(readFileSync(path, "utf8"))) {
    lines.push(
      `INSERT OR IGNORE INTO customers (customer_number,name,phone,active,created_at,updated_at) VALUES (${q(r.customer_number)},${q(r.name)},${q(r.phone)},${truthy(r.active) ? 1 : 0},0,0);`,
      `INSERT OR IGNORE INTO customer_contacts (customer_id,email,name,active) SELECT id,${q(r.contact_email.toLowerCase())},${q(r.contact_name)},1 FROM customers WHERE customer_number=${q(r.customer_number)};`,
    );
  }
  return lines.join("\n");
}

/** Runs wrangler quietly; its output is shown only when it fails. */
function run(args) {
  const res = spawnSync("npx", ["wrangler", ...args], { encoding: "utf8" });
  if (res.status !== 0) {
    process.stdout.write(res.stdout ?? "");
    process.stderr.write(res.stderr ?? "");
    process.exit(res.status ?? 1);
  }
}

const sql = [reset ? RESET_SQL : "", BASE_SQL, csvSql("docs/sample-customers.csv")].join("\n");
mkdirSync(".wrangler", { recursive: true });
writeFileSync(".wrangler/seed.sql", sql);

run(["d1", "migrations", "apply", "DB", "--local"]);
run(["d1", "execute", "DB", "--local", "--file", ".wrangler/seed.sql"]);
console.log(`Seeded the local database${reset ? " (transactional data cleared)" : ""}. Staff: admin@ / tech1@ / tech2@ / tech3@example.test`);
