CREATE TABLE model_invocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES research_runs(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  model_id varchar(255) NOT NULL,
  operation varchar(80) NOT NULL,
  invoked_at timestamptz NOT NULL,
  input_tokens integer NOT NULL CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL CHECK (output_tokens >= 0),
  total_tokens integer NOT NULL CHECK (total_tokens >= 0),
  estimated_cost_usd numeric(12,6),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX model_invocations_run_idx ON model_invocations(run_id, invoked_at);
