-- Staff calendar subscriptions: one token per staff member, read by GET /api/feed/<token>/{mine,team}.ics. Stored in
-- plain text so the links can be shown again (a hash would force a reset, breaking calendars already subscribed); the
-- token only reads confirmed appointments, can be reset, and stops working when its owner is deactivated.
CREATE TABLE calendar_feeds (
  staff_id INTEGER PRIMARY KEY REFERENCES staff(id),
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
