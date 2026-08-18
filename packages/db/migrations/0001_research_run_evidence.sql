-- Evidence can be reused by multiple runs.  Keep this append-only link so
-- audit/replay history is not overwritten when an existing evidence UUID is
-- cited again.
CREATE TABLE research_run_evidence (
  run_id uuid NOT NULL REFERENCES research_runs(id),
  evidence_id uuid NOT NULL REFERENCES evidence_items(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, evidence_id)
);

CREATE INDEX research_run_evidence_run_idx ON research_run_evidence(run_id);
CREATE INDEX research_run_evidence_evidence_idx ON research_run_evidence(evidence_id);
