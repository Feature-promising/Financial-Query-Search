-- Conversation lifecycle is intentionally a tombstone, not a cascading delete:
-- research runs, evidence, citations, and audit rows remain reproducible while
-- a deleted conversation is no longer visible through the user API.
ALTER TABLE conversations
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by uuid,
  ADD CONSTRAINT conversations_deleted_state_check
    CHECK (
      (deleted_at IS NULL AND deleted_by IS NULL)
      OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL)
    ),
  ADD CONSTRAINT conversations_deleted_by_organization_fkey
    FOREIGN KEY (deleted_by, organization_id)
    REFERENCES users (id, organization_id);

CREATE INDEX conversations_active_visible_idx
  ON conversations (organization_id, created_by, updated_at DESC)
  WHERE deleted_at IS NULL AND archived_at IS NULL;

CREATE INDEX conversations_archived_visible_idx
  ON conversations (organization_id, created_by, updated_at DESC)
  WHERE deleted_at IS NULL AND archived_at IS NOT NULL;
