CREATE TABLE guard (ok INTEGER NOT NULL);
CREATE TABLE schedule_state (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
INSERT INTO schedule_state (id, version) VALUES (1, 0);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE holidays (date TEXT PRIMARY KEY, name TEXT NOT NULL);

CREATE TABLE staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','technician')),
  bookable INTEGER NOT NULL DEFAULT 1,
  notify INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_number TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  phone TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE customer_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  email TEXT NOT NULL COLLATE NOCASE,
  name TEXT,
  phone TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (customer_id, email)
);
CREATE INDEX idx_contacts_email ON customer_contacts(email);

CREATE TABLE auth_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('customer','staff')),
  email TEXT NOT NULL COLLATE NOCASE,
  redirect_path TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('customer','staff')),
  email TEXT NOT NULL COLLATE NOCASE,
  staff_id INTEGER REFERENCES staff(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE access_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  reservation_id TEXT NOT NULL REFERENCES reservations(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE availability_windows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('weekly','date')),
  weekday INTEGER CHECK (weekday BETWEEN 0 AND 6),
  date TEXT,
  start_min INTEGER NOT NULL,
  end_min INTEGER NOT NULL CHECK (end_min > start_min)
);
CREATE TABLE availability_window_staff (
  window_id INTEGER NOT NULL REFERENCES availability_windows(id) ON DELETE CASCADE,
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  PRIMARY KEY (window_id, staff_id)
);
CREATE TABLE date_overrides (date TEXT PRIMARY KEY, note TEXT);
CREATE TABLE staff_unavailability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  reason TEXT
);

CREATE TABLE reservations (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  contact_email TEXT NOT NULL COLLATE NOCASE,
  contact_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  issue TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','confirmed','declined','expired','cancelled','completed')),
  assigned_staff_id INTEGER REFERENCES staff(id),
  provisional_staff_id INTEGER REFERENCES staff(id),
  version INTEGER NOT NULL DEFAULT 1,
  replaces_id TEXT REFERENCES reservations(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  approval_reminder_at INTEGER,
  escalation_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  confirmed_by INTEGER REFERENCES staff(id),
  closed_at INTEGER,
  closed_by_kind TEXT,
  closed_by TEXT,
  close_reason TEXT
);
CREATE INDEX idx_res_status_start ON reservations(status, start_at);
CREATE INDEX idx_res_customer ON reservations(customer_id);

CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL REFERENCES reservations(id),
  status TEXT NOT NULL CHECK (status IN ('open','accepted','rejected','expired','superseded','withdrawn')),
  message TEXT,
  created_by INTEGER REFERENCES staff(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE TABLE proposal_options (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  staff_id INTEGER NOT NULL REFERENCES staff(id)
);

CREATE TABLE tech_blocks (
  staff_id INTEGER NOT NULL,
  block_start INTEGER NOT NULL,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('reservation','option')),
  owner_id TEXT NOT NULL,
  PRIMARY KEY (staff_id, block_start)
);
CREATE INDEX idx_blocks_owner ON tech_blocks(owner_kind, owner_id);

CREATE TABLE email_jobs (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  template TEXT NOT NULL,
  to_email TEXT NOT NULL,
  reservation_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('queued','sending','sent','failed','skipped','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  send_after INTEGER NOT NULL,
  locked_until INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX idx_jobs_due ON email_jobs(status, send_after);

CREATE TABLE dev_mailbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('customer','staff','system')),
  actor TEXT,
  action TEXT NOT NULL,
  reservation_id TEXT,
  customer_id INTEGER,
  details TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_audit_res ON audit_log(reservation_id);

CREATE TABLE rate_limits (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);
