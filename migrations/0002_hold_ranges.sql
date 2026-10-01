-- Each hold carries the occupied range (buffers included, epoch ms) it was created with, so later
-- changes to duration/buffer settings only affect new requests and never disagree with tech_blocks.
ALTER TABLE reservations ADD COLUMN occ_start INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reservations ADD COLUMN occ_end INTEGER NOT NULL DEFAULT 0;
ALTER TABLE proposal_options ADD COLUMN occ_start INTEGER NOT NULL DEFAULT 0;
ALTER TABLE proposal_options ADD COLUMN occ_end INTEGER NOT NULL DEFAULT 0;

-- Backfill exactly from the blocks written at creation (5-minute grid, epoch minutes).
UPDATE reservations SET
  occ_start = (SELECT MIN(b.block_start) * 60000 FROM tech_blocks b WHERE b.owner_kind = 'reservation' AND b.owner_id = reservations.id),
  occ_end = (SELECT (MAX(b.block_start) + 5) * 60000 FROM tech_blocks b WHERE b.owner_kind = 'reservation' AND b.owner_id = reservations.id)
WHERE EXISTS (SELECT 1 FROM tech_blocks b WHERE b.owner_kind = 'reservation' AND b.owner_id = reservations.id);
UPDATE proposal_options SET
  occ_start = (SELECT MIN(b.block_start) * 60000 FROM tech_blocks b WHERE b.owner_kind = 'option' AND b.owner_id = proposal_options.id),
  occ_end = (SELECT (MAX(b.block_start) + 5) * 60000 FROM tech_blocks b WHERE b.owner_kind = 'option' AND b.owner_id = proposal_options.id)
WHERE EXISTS (SELECT 1 FROM tech_blocks b WHERE b.owner_kind = 'option' AND b.owner_id = proposal_options.id);

-- Rows without blocks (terminal reservations, closed options) hold nothing: zero buffers.
UPDATE reservations SET occ_start = start_at, occ_end = end_at WHERE occ_start = 0 AND occ_end = 0;
UPDATE proposal_options SET occ_start = start_at, occ_end = end_at WHERE occ_start = 0 AND occ_end = 0;
