-- Proposals are looked up per reservation (the open one, the latest one) and options per proposal; neither table
-- is ever pruned, so these lookups must not scan.
CREATE INDEX idx_proposals_reservation ON proposals(reservation_id, status);
CREATE INDEX idx_options_proposal ON proposal_options(proposal_id);
