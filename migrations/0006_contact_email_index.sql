-- A contact's recent bookings are looked up by email, newest first (the phone numbers they used last): an index instead
-- of a scan of every reservation. Index only: backward compatible.
CREATE INDEX IF NOT EXISTS idx_res_contact_email_created ON reservations(contact_email, created_at DESC);
