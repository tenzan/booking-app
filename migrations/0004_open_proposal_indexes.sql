-- Open proposals are few, but the table keeps every proposal ever made: the option-hold scan (every schedule load) and the
-- proposal-expiry sweep find the open ones through this partial index instead of scanning; options by their occupied start.
-- Indexes only: backward compatible.
CREATE INDEX idx_proposals_open ON proposals(expires_at) WHERE status = 'open';
CREATE INDEX idx_options_occ ON proposal_options(occ_start);
