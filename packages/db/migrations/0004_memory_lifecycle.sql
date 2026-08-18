ALTER TABLE memory_records
  ADD COLUMN conversation_id uuid REFERENCES conversations(id),
  ADD COLUMN retention_policy varchar(32) NOT NULL DEFAULT 'organization_default',
  ADD CONSTRAINT memory_retention_policy_check
    CHECK (retention_policy IN ('session', 'user_managed', 'organization_default', 'legal_hold'));

CREATE INDEX memory_conversation_idx
  ON memory_records(organization_id, conversation_id, scope);

ALTER TABLE memory_records
  ADD CONSTRAINT memory_short_term_session_check
    CHECK (
      scope <> 'short_term'
      OR (conversation_id IS NOT NULL AND user_id IS NOT NULL AND visibility = 'private' AND retention_policy = 'session')
    ) NOT VALID;
