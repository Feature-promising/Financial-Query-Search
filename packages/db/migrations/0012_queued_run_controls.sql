-- A run may be paused only while it is still queued. This preserves the
-- non-replayable boundary: no provider/model/tool work has begun yet.
ALTER TABLE research_runs
  DROP CONSTRAINT research_runs_status_check,
  ADD CONSTRAINT research_runs_status_check
    CHECK (status IN ('queued', 'running', 'paused', 'completed', 'abstained', 'failed'));

CREATE INDEX research_runs_paused_idx
  ON research_runs (organization_id, created_at DESC)
  WHERE status = 'paused';
