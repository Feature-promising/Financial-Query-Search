CREATE TABLE research_run_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES research_runs(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  phase varchar(40) NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX research_run_checkpoints_run_idx ON research_run_checkpoints(run_id, created_at);
