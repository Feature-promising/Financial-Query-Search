ALTER TABLE tool_invocations
  ADD COLUMN idempotency_key varchar(200);

UPDATE tool_invocations
  SET idempotency_key = 'legacy:' || id::text
  WHERE idempotency_key IS NULL;

ALTER TABLE tool_invocations
  ALTER COLUMN idempotency_key SET NOT NULL;

CREATE UNIQUE INDEX tool_invocations_run_idempotency_idx
  ON tool_invocations(run_id, idempotency_key);
