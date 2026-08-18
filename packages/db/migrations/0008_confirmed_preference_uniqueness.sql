-- Preference writes are an explicit user action. Keep one active value per
-- organization/user/key while retaining any historic duplicate row for audit.
ALTER TABLE memory_records
  ADD COLUMN preference_key varchar(64);

UPDATE memory_records
SET preference_key = metadata ->> 'preferenceKey'
WHERE scope = 'long_term'
  AND visibility = 'private'
  AND user_id IS NOT NULL
  AND retention_policy = 'user_managed'
  AND metadata ->> 'userConfirmed' = 'true'
  AND metadata ->> 'preferenceKey' IN ('valuation_method', 'focus_industries', 'comparison_framework', 'display_unit');

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY organization_id, user_id, preference_key
           ORDER BY created_at DESC, id DESC
         ) AS ordinal
  FROM memory_records
  WHERE preference_key IS NOT NULL
)
UPDATE memory_records AS record
SET preference_key = NULL,
    metadata = jsonb_set(record.metadata, '{userConfirmed}', 'false'::jsonb, true)
FROM ranked
WHERE record.id = ranked.id
  AND ranked.ordinal > 1;

CREATE UNIQUE INDEX memory_active_preference_idx
  ON memory_records(organization_id, user_id, preference_key)
  WHERE preference_key IS NOT NULL;
