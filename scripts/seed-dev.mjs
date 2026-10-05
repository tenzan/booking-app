// Seeds the LOCAL D1 database with synthetic data for development and the e2e tests.
//   npm run seed             idempotent and non-destructive: adds the sample staff and the customers in
//                            docs/sample-customers.csv that are missing, and the sample weekly schedule only while there
//                            are no weekly hours at all. Nothing is deleted or rewritten.
//   npm run seed -- --reset  restores the full baseline: deletes reservations, emails, tokens, sessions, rate limits,
//                            the audit log, date overrides, holidays, time off, saved settings and any staff or customer
//                            that is not part of the sample, then restores the sample staff, customers and weekly hours.
// Writes the SQL to .wrangler/seed.sql, then runs it with `wrangler d1 execute DB --local`. Never touches a remote database.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The sample team: [email, name, role]. All are bookable, get notifications and are active. */
const STAFF = [
  ["admin@example.test", "Avery Admin", "admin"],
  ["tech1@example.test", "Blake Tech", "technician"],
  ["tech2@example.test", "Casey Tech", "technician"],
  ["tech3@example.test", "Drew Tech", "technician"],
];

/** Mon–Fri 09:00–12:00 [admin, tech1, tech2] and 13:00–17:00 [tech1, tech2, tech3]. */
const WEEKLY = [
  { start: 540, end: 720, staff: ["admin@example.test", "tech1@example.test", "tech2@example.test"] },
  { start: 780, end: 1020, staff: ["tech1@example.test", "tech2@example.test", "tech3@example.test"] },
];
const WEEKDAYS = [1, 2, 3, 4, 5];

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

const q = (v) => (v === "" || v === undefined || v === null ? "NULL" : `'${String(v).replaceAll("'", "''")}'`);
const list = (values) => values.map(q).join(",");
/** As in the CSV import: blank means active; false/no/0 means inactive. */
const isActive = (v) => !/^(false|0|no)$/i.test(v);

/** Customers (first row per number decides the customer's fields) and their contacts, from the sample CSV. */
function sampleCustomers(csvText) {
  const customers = new Map();
  const contacts = [];
  for (const r of parseCsv(csvText)) {
    if (!customers.has(r.customer_number)) customers.set(r.customer_number, { number: r.customer_number, name: r.name, phone: r.phone, active: isActive(r.active) });
    contacts.push({ number: r.customer_number, email: r.contact_email.toLowerCase(), name: r.contact_name });
  }
  return { customers: [...customers.values()], contacts };
}

/**
 * The SQL for one seed run. Plain runs only insert what is missing (INSERT OR IGNORE; the weekly hours only into an
 * empty weekly schedule). `reset` first deletes everything that is not baseline, then restores the baseline rows in
 * place (baseline staff and customers keep their ids).
 */
export function seedSql({ reset, csvText }) {
  const { customers, contacts } = sampleCustomers(csvText);
  const sql = [];

  if (reset) {
    sql.push(
      // Children first: reservations and what hangs off them.
      "DELETE FROM tech_blocks; DELETE FROM access_tokens; DELETE FROM calendar_tokens; DELETE FROM proposal_options; DELETE FROM proposals; DELETE FROM reservations;",
      "DELETE FROM email_jobs; DELETE FROM dev_mailbox; DELETE FROM audit_log; DELETE FROM rate_limits; DELETE FROM auth_tokens; DELETE FROM sessions;",
      "DELETE FROM staff_unavailability; DELETE FROM availability_window_staff; DELETE FROM availability_windows; DELETE FROM date_overrides; DELETE FROM holidays;",
      // Settings fall back to their defaults (and ORG_NAME) when no row is saved.
      "DELETE FROM settings;",
      "DELETE FROM customer_contacts;",
      `DELETE FROM customers WHERE customer_number NOT IN (${list(customers.map((c) => c.number))});`,
      `DELETE FROM staff WHERE email NOT IN (${list(STAFF.map(([email]) => email))});`,
    );
  }

  // Plain runs never overwrite: INSERT OR IGNORE. A reset puts the sample values back (ids are kept).
  const insert = reset ? "INSERT INTO" : "INSERT OR IGNORE INTO";
  const staffUpsert = reset ? " ON CONFLICT(email) DO UPDATE SET name = excluded.name, role = excluded.role, bookable = 1, notify = 1, active = 1" : "";
  sql.push(
    `${insert} staff (email,name,role,bookable,notify,active,created_at,updated_at) VALUES ${STAFF.map(([email, name, role]) => `(${list([email, name, role])},1,1,1,0,0)`).join(",")}${staffUpsert};`,
  );
  const customerUpsert = reset ? " ON CONFLICT(customer_number) DO UPDATE SET name = excluded.name, phone = excluded.phone, active = excluded.active, notes = NULL" : "";
  for (const c of customers) {
    sql.push(`${insert} customers (customer_number,name,phone,active,created_at,updated_at) VALUES (${list([c.number, c.name, c.phone])},${c.active ? 1 : 0},0,0)${customerUpsert};`);
  }
  for (const k of contacts) {
    sql.push(`INSERT OR IGNORE INTO customer_contacts (customer_id,email,name,active) SELECT id,${list([k.email, k.name])},1 FROM customers WHERE customer_number=${q(k.number)};`);
  }

  // The sample weekly hours, only into an empty weekly schedule (always the case after a reset).
  const rows = WEEKDAYS.flatMap((d) => WEEKLY.map((w) => `(${d},${w.start},${w.end})`)).join(",");
  sql.push(
    `INSERT INTO availability_windows (kind,weekday,start_min,end_min) SELECT 'weekly', column1, column2, column3 FROM (VALUES ${rows}) ` +
      "WHERE NOT EXISTS (SELECT 1 FROM availability_windows WHERE kind = 'weekly');",
  );
  // Staff only for windows that have none, i.e. the ones just added (every saved window has at least one).
  for (const w of WEEKLY) {
    sql.push(
      "INSERT INTO availability_window_staff (window_id,staff_id) SELECT w.id, s.id FROM availability_windows w JOIN staff s " +
        `ON s.email IN (${list(w.staff)}) WHERE w.kind = 'weekly' AND w.start_min = ${w.start} AND w.end_min = ${w.end} ` +
        "AND NOT EXISTS (SELECT 1 FROM availability_window_staff x WHERE x.window_id = w.id);",
    );
  }
  // Any open schedule preview must be re-checked against what the seed may have added.
  sql.push("UPDATE schedule_state SET version = version + 1;");
  return sql.join("\n");
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const reset = process.argv.includes("--reset");
  mkdirSync(".wrangler", { recursive: true });
  writeFileSync(".wrangler/seed.sql", seedSql({ reset, csvText: readFileSync("docs/sample-customers.csv", "utf8") }));
  run(["d1", "migrations", "apply", "DB", "--local"]);
  run(["d1", "execute", "DB", "--local", "--file", ".wrangler/seed.sql"]);
  console.log(
    `Seeded the local database${reset ? " (reset to the sample baseline)" : ""}. Staff: admin@ / tech1@ / tech2@ / tech3@example.test; customers from docs/sample-customers.csv.`,
  );
}
