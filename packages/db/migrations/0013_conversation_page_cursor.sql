-- Supports the tenant-filtered, archive-filtered keyset pagination used by
-- the conversation workspace without scanning all historical sessions.
CREATE INDEX IF NOT EXISTS conversations_visible_page_idx
  ON conversations (organization_id, archived_at, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;
