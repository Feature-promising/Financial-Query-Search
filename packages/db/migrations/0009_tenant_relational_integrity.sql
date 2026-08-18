-- Enforce organization ownership at the relational boundary. Application
-- predicates remain necessary for authorization, but they must not be the only
-- protection against an accidental cross-tenant foreign-key association.

ALTER TABLE users
  ADD CONSTRAINT users_id_organization_key UNIQUE (id, organization_id);

ALTER TABLE conversations
  ADD CONSTRAINT conversations_id_organization_key UNIQUE (id, organization_id);

ALTER TABLE research_runs
  ADD CONSTRAINT research_runs_id_organization_key UNIQUE (id, organization_id),
  ADD CONSTRAINT research_runs_id_conversation_key UNIQUE (id, conversation_id);

ALTER TABLE evidence_items
  ADD CONSTRAINT evidence_items_id_organization_key UNIQUE (id, organization_id);

ALTER TABLE memory_records
  ADD CONSTRAINT memory_records_id_organization_key UNIQUE (id, organization_id);

ALTER TABLE conversations
  DROP CONSTRAINT conversations_created_by_fkey,
  ADD CONSTRAINT conversations_owner_organization_fkey
    FOREIGN KEY (created_by, organization_id)
    REFERENCES users (id, organization_id);

ALTER TABLE research_runs
  DROP CONSTRAINT research_runs_conversation_id_fkey,
  ADD CONSTRAINT research_runs_conversation_organization_fkey
    FOREIGN KEY (conversation_id, organization_id)
    REFERENCES conversations (id, organization_id);

ALTER TABLE messages
  ADD CONSTRAINT messages_run_conversation_fkey
    FOREIGN KEY (run_id, conversation_id)
    REFERENCES research_runs (id, conversation_id);

ALTER TABLE evidence_items
  DROP CONSTRAINT evidence_items_run_id_fkey,
  ADD CONSTRAINT evidence_items_run_organization_fkey
    FOREIGN KEY (run_id, organization_id)
    REFERENCES research_runs (id, organization_id);

ALTER TABLE tool_invocations
  DROP CONSTRAINT tool_invocations_run_id_fkey,
  ADD CONSTRAINT tool_invocations_run_organization_fkey
    FOREIGN KEY (run_id, organization_id)
    REFERENCES research_runs (id, organization_id);

ALTER TABLE model_invocations
  DROP CONSTRAINT model_invocations_run_id_fkey,
  ADD CONSTRAINT model_invocations_run_organization_fkey
    FOREIGN KEY (run_id, organization_id)
    REFERENCES research_runs (id, organization_id);

ALTER TABLE research_run_checkpoints
  DROP CONSTRAINT research_run_checkpoints_run_id_fkey,
  ADD CONSTRAINT research_run_checkpoints_run_organization_fkey
    FOREIGN KEY (run_id, organization_id)
    REFERENCES research_runs (id, organization_id);

ALTER TABLE research_reports
  DROP CONSTRAINT research_reports_run_id_fkey,
  ADD CONSTRAINT research_reports_run_organization_fkey
    FOREIGN KEY (run_id, organization_id)
    REFERENCES research_runs (id, organization_id);

ALTER TABLE memory_records
  DROP CONSTRAINT memory_records_user_id_fkey,
  DROP CONSTRAINT memory_records_conversation_id_fkey,
  DROP CONSTRAINT memory_records_source_run_id_fkey,
  ADD CONSTRAINT memory_records_user_organization_fkey
    FOREIGN KEY (user_id, organization_id)
    REFERENCES users (id, organization_id),
  ADD CONSTRAINT memory_records_conversation_organization_fkey
    FOREIGN KEY (conversation_id, organization_id)
    REFERENCES conversations (id, organization_id),
  ADD CONSTRAINT memory_records_source_run_organization_fkey
    FOREIGN KEY (source_run_id, organization_id)
    REFERENCES research_runs (id, organization_id);

ALTER TABLE memory_deletion_audit_events
  ADD CONSTRAINT memory_deletion_audit_actor_organization_fkey
    FOREIGN KEY (actor_user_id, organization_id)
    REFERENCES users (id, organization_id),
  ADD CONSTRAINT memory_deletion_audit_source_run_organization_fkey
    FOREIGN KEY (source_run_id, organization_id)
    REFERENCES research_runs (id, organization_id);

-- The bridge can legally reuse evidence across runs, but never across
-- organizations. Backfill its tenant key from the run first; the following
-- two composite foreign keys reject any historical mismatch during migration.
ALTER TABLE research_run_evidence
  ADD COLUMN organization_id uuid;

UPDATE research_run_evidence AS link
SET organization_id = run.organization_id
FROM research_runs AS run
WHERE run.id = link.run_id;

ALTER TABLE research_run_evidence
  ALTER COLUMN organization_id SET NOT NULL,
  DROP CONSTRAINT research_run_evidence_run_id_fkey,
  DROP CONSTRAINT research_run_evidence_evidence_id_fkey,
  ADD CONSTRAINT research_run_evidence_run_organization_fkey
    FOREIGN KEY (run_id, organization_id)
    REFERENCES research_runs (id, organization_id),
  ADD CONSTRAINT research_run_evidence_evidence_organization_fkey
    FOREIGN KEY (evidence_id, organization_id)
    REFERENCES evidence_items (id, organization_id);

CREATE INDEX research_run_evidence_organization_idx
  ON research_run_evidence (organization_id, run_id);
