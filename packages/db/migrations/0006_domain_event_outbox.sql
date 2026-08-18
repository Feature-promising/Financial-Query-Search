CREATE TABLE domain_event_outbox (
  id uuid PRIMARY KEY,
  event_type varchar(120) NOT NULL,
  aggregate_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  occurred_at timestamptz NOT NULL,
  locked_until timestamptz,
  published_at timestamptz
);

CREATE INDEX domain_event_outbox_unpublished_idx
  ON domain_event_outbox(occurred_at)
  WHERE published_at IS NULL;
