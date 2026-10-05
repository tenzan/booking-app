-- "Add to calendar" links: each token can only read one reservation's calendar file (the customer's or the staff
-- version), never act on it, so it may sit in a URL. Kept apart from access_tokens, which also allow cancelling.
CREATE TABLE calendar_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  reservation_id TEXT NOT NULL REFERENCES reservations(id),
  audience TEXT NOT NULL CHECK (audience IN ('customer','staff')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_calendar_tokens_expires ON calendar_tokens(expires_at);
