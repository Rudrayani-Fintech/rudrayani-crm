-- Up Migration

-- X1 production incident: seed_disposition_codes.ts never wrote `channel`.
-- It was re-run against production after 1785600000000_add-disposition-channel.sql
-- had already backfilled + expanded the OC/FV codes, so every one of the 70
-- master-list rows now exists twice: once correctly channel-tagged (from the
-- migration's one-time backfill) and once again at channel = NULL (from the
-- re-seed). Both clients filter strictly on channel, so the NULL-channel
-- copies are invisible everywhere but still `is_active`, and any *new*
-- agency seeded fresh gets channel = NULL for every single code -- an empty
-- Result Code picker on both clients.
--
-- This migration is the "one-off backfill" for existing data; the seeder
-- itself is fixed separately (seed_disposition_codes.ts now derives channel
-- at insert time and is idempotent). Running this migration is safe to do
-- more than once -- every WHERE clause below only matches rows still at
-- channel IS NULL, so a second run is a no-op.

-- Step 1: plain single-channel codes (OC, FV, LG, PIOC, PIFV).
--
-- 1a. A NULL-channel row is a re-seed duplicate, not new data, when an
-- otherwise-identical row already has a channel. Deactivate it rather than
-- assign it a channel -- assigning one would create a second active copy of
-- the same code in the picker.
UPDATE disposition_codes d
   SET is_active = false
 WHERE d.channel IS NULL
   AND d.action_code = ANY (ARRAY['OC', 'FV', 'LG', 'PIOC', 'PIFV'])
   AND EXISTS (
     SELECT 1 FROM disposition_codes o
      WHERE o.agency_id = d.agency_id
        AND o.action_code = d.action_code
        AND o.result_code IS NOT DISTINCT FROM d.result_code
        AND o.description IS NOT DISTINCT FROM d.description
        AND o.remark_template IS NOT DISTINCT FROM d.remark_template
        AND o.channel IS NOT NULL
        AND o.id <> d.id
   );

-- 1b. Anything still active at channel IS NULL for these action codes (1a
-- only flips is_active, never channel, so its rows are excluded here by the
-- is_active = true filter) has no existing channel-tagged twin -- e.g. a
-- custom code added straight to the DB after the original migration ran.
-- Derive its channel directly.
UPDATE disposition_codes
   SET channel = CASE
         WHEN action_code IN ('FV', 'PIFV') THEN 'FV'
         WHEN action_code IN ('OC', 'LG', 'PIOC') THEN 'OC'
       END
 WHERE channel IS NULL
   AND is_active = true
   AND action_code = ANY (ARRAY['OC', 'FV', 'LG', 'PIOC', 'PIFV']);

-- Step 2: ambiguous "OC/FV" codes, same idea but the channel-tagged
-- equivalent is a *pair* of rows (one FV clone, one OC clone -- see
-- 1785600000000).
--
-- 2a. Deactivate NULL-channel OC/FV duplicates that already have both
-- clones present and active.
UPDATE disposition_codes d
   SET is_active = false
 WHERE d.channel IS NULL
   AND d.action_code = 'OC/FV'
   AND EXISTS (
     SELECT 1 FROM disposition_codes o
      WHERE o.agency_id = d.agency_id AND o.action_code = 'OC/FV' AND o.channel = 'FV'
        AND o.result_code IS NOT DISTINCT FROM d.result_code
        AND o.description IS NOT DISTINCT FROM d.description
        AND o.remark_template IS NOT DISTINCT FROM d.remark_template
   )
   AND EXISTS (
     SELECT 1 FROM disposition_codes o
      WHERE o.agency_id = d.agency_id AND o.action_code = 'OC/FV' AND o.channel = 'OC'
        AND o.result_code IS NOT DISTINCT FROM d.result_code
        AND o.description IS NOT DISTINCT FROM d.description
        AND o.remark_template IS NOT DISTINCT FROM d.remark_template
   );

-- 2b. Whatever is still active at channel IS NULL, action_code = 'OC/FV' is
-- genuinely new (no existing FV/OC pair) -- 2a only flips is_active, never
-- channel, so its rows are excluded here by the is_active = true filter.
-- Clone the rest into both channels and retire the original, exactly like
-- 1785600000000 did for the first batch.
INSERT INTO disposition_codes
    (agency_id, action_code, category, result_code, description, remark_template,
     needs_amount, needs_date, needs_time, needs_mode, needs_reason, needs_name_relation,
     is_active, channel)
SELECT agency_id, action_code, category, result_code, description, remark_template,
       needs_amount, needs_date, needs_time, needs_mode, needs_reason, needs_name_relation,
       is_active, 'FV'
  FROM disposition_codes
 WHERE action_code = 'OC/FV' AND channel IS NULL AND is_active = true;

INSERT INTO disposition_codes
    (agency_id, action_code, category, result_code, description, remark_template,
     needs_amount, needs_date, needs_time, needs_mode, needs_reason, needs_name_relation,
     is_active, channel)
SELECT agency_id, action_code, category, result_code, description, remark_template,
       needs_amount, needs_date, needs_time, needs_mode, needs_reason, needs_name_relation,
       is_active, 'OC'
  FROM disposition_codes
 WHERE action_code = 'OC/FV' AND channel IS NULL AND is_active = true;

UPDATE disposition_codes
   SET is_active = false
 WHERE action_code = 'OC/FV' AND channel IS NULL AND is_active = true;

-- Step 3: prevent this from recurring. Every deactivated duplicate above
-- keeps channel = NULL (distinct from any other row in a unique index, so
-- this index creation cannot conflict with them), and the rewritten seeder
-- always supplies a channel on insert and relies on this exact index for its
-- ON CONFLICT DO NOTHING. remark_template is part of the key because some
-- codes (e.g. Call Back) have several rows sharing action_code/result_code/
-- description that differ only by remark_template. result_code,
-- description and remark_template are wrapped in COALESCE(..., '') because
-- a plain unique index never treats two NULLs as equal -- without it, the
-- one sheet row that has all three columns NULL (action_code OC, category
-- RNR, no result_code/description/remark) would silently re-duplicate on
-- every reseed, the exact bug this index exists to prevent.
CREATE UNIQUE INDEX IF NOT EXISTS uq_disposition_codes_natural_key
    ON disposition_codes (
      agency_id, action_code, COALESCE(result_code, ''), COALESCE(description, ''),
      COALESCE(remark_template, ''), channel
    );

-- Down Migration
DROP INDEX IF EXISTS uq_disposition_codes_natural_key;
-- Data changes (dedup/backfill) are not reversed -- same best-effort
-- rationale as 1785600000000: distinguishing an admin's later edits from
-- migration-created rows isn't safely possible, and reactivating known
-- duplicates would just reintroduce X1.
