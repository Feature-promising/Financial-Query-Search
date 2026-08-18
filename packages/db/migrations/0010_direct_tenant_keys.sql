-- Keep every user- or run-derived transaction record directly tenant scoped.
-- Parent joins are still useful for authorization, but direct keys let RLS,
-- retention, and audit tooling filter records without relying on application
-- joins. The backfills deliberately fail on orphaned legacy data rather than
-- assigning a tenant by guesswork.

ALTER TABLE messages
  ADD COLUMN organization_id uuid;

UPDATE messages AS message
SET organization_id = conversation.organization_id
FROM conversations AS conversation
WHERE conversation.id = message.conversation_id;

ALTER TABLE messages
  ALTER COLUMN organization_id SET NOT NULL,
  ADD CONSTRAINT messages_conversation_organization_fkey
    FOREIGN KEY (conversation_id, organization_id)
    REFERENCES conversations (id, organization_id);

CREATE INDEX messages_organization_conversation_idx
  ON messages (organization_id, conversation_id, created_at);

ALTER TABLE run_events
  ADD COLUMN organization_id uuid;

UPDATE run_events AS event
SET organization_id = run.organization_id
FROM research_runs AS run
WHERE run.id = event.run_id;

ALTER TABLE run_events
  ALTER COLUMN organization_id SET NOT NULL,
  ADD CONSTRAINT run_events_run_organization_fkey
    FOREIGN KEY (run_id, organization_id)
    REFERENCES research_runs (id, organization_id);

CREATE INDEX run_events_organization_run_idx
  ON run_events (organization_id, run_id, sequence);

ALTER TABLE outbox_events
  ADD COLUMN organization_id uuid;

UPDATE outbox_events AS event
SET organization_id = run.organization_id
FROM research_runs AS run
WHERE event.event_type = 'research_run_requested'
  AND run.id = event.aggregate_id;

ALTER TABLE outbox_events
  ALTER COLUMN organization_id SET NOT NULL,
  ADD CONSTRAINT outbox_events_organization_fkey
    FOREIGN KEY (organization_id)
    REFERENCES organizations (id);

CREATE INDEX outbox_events_organization_unpublished_idx
  ON outbox_events (organization_id, occurred_at)
  WHERE published_at IS NULL;
