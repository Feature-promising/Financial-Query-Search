CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(200) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  oidc_subject varchar(255) NOT NULL,
  email varchar(320) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, oidc_subject)
);

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  created_by uuid NOT NULL REFERENCES users(id),
  title varchar(140) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_organization_idx ON conversations(organization_id);

CREATE TABLE research_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  status varchar(20) NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'abstained', 'failed')),
  question text NOT NULL,
  budget jsonb NOT NULL,
  state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX research_runs_conversation_idx ON research_runs(conversation_id);
CREATE INDEX research_runs_organization_idx ON research_runs(organization_id);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  role varchar(16) NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  run_id uuid REFERENCES research_runs(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_idx ON messages(conversation_id, created_at);

CREATE TABLE run_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES research_runs(id),
  sequence bigint NOT NULL,
  type varchar(40) NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, sequence)
);
CREATE INDEX run_events_run_idx ON run_events(run_id, sequence);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY,
  event_type varchar(80) NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  published_at timestamptz
);
CREATE INDEX outbox_unpublished_idx ON outbox_events(occurred_at) WHERE published_at IS NULL;

CREATE TABLE evidence_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES research_runs(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  source_type varchar(40) NOT NULL,
  authority varchar(20) NOT NULL,
  source_url text,
  locator text NOT NULL,
  content_hash varchar(128) NOT NULL,
  content text NOT NULL,
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, content_hash)
);
CREATE INDEX evidence_run_idx ON evidence_items(run_id);

CREATE TABLE tool_invocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES research_runs(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  tool_id varchar(120) NOT NULL,
  invoked_at timestamptz NOT NULL,
  ok boolean NOT NULL,
  input_hash varchar(128) NOT NULL,
  output_hash varchar(128),
  evidence_ids jsonb NOT NULL,
  estimated_cost_usd numeric(12,6) NOT NULL,
  duration_ms integer NOT NULL,
  failure_code varchar(40)
);
CREATE INDEX tool_invocations_run_idx ON tool_invocations(run_id, invoked_at);

CREATE TABLE research_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES research_runs(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  version integer NOT NULL,
  markdown text NOT NULL,
  citations jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id, version)
);
CREATE INDEX research_reports_organization_idx ON research_reports(organization_id, created_at DESC);

CREATE TABLE memory_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid REFERENCES users(id),
  scope varchar(20) NOT NULL CHECK (scope IN ('short_term', 'long_term', 'research')),
  visibility varchar(20) NOT NULL CHECK (visibility IN ('private', 'organization')),
  content text NOT NULL,
  source_run_id uuid REFERENCES research_runs(id),
  expires_at timestamptz,
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memory_scope_idx ON memory_records(organization_id, user_id, scope);
