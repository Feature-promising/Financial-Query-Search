-- Append-only evidence of each deletion attempt. The memory row itself is not
-- referenced because it is intentionally removed by the completed workflow.
CREATE TABLE memory_deletion_audit_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  memory_id uuid NOT NULL,
  actor_user_id uuid,
  memory_scope varchar(20) NOT NULL CHECK (memory_scope IN ('short_term', 'long_term', 'research')),
  source_run_id uuid,
  evidence_ids jsonb NOT NULL,
  event_type varchar(16) NOT NULL CHECK (event_type IN ('requested', 'completed', 'failed')),
  occurred_at timestamptz NOT NULL
);
CREATE INDEX memory_deletion_audit_organization_idx
  ON memory_deletion_audit_events(organization_id, occurred_at DESC);
