# Production Operations Runbook

This runbook applies to the US-equity Interactive Research Agent. It preserves
the evidence-first boundary: a recovery may restore service availability, but
may never reconstruct claims, citations, or licensed data from logs.

## Service objectives and ownership

- Baseline recovery objectives: **RPO ≤ 24 hours** and **RTO ≤ 4 hours**. The
  platform owner must record a stricter approved objective where a tenant,
  license, or regulatory obligation requires one.
- The application team owns application images, migrations, runtime recovery,
  evidence/citation correctness, and this runbook.
- The platform team owns RDS backups/PITR, S3 versioning and retention, Redshift
  snapshots, OpenSearch snapshots, Neo4j backups, network controls, IAM roles,
  and the EventBridge consumer rules.
- Redis Streams are an SSE wake-up optimization only. They are not a source of
  truth and do not contribute to RPO.

## Release and rollback

1. Run `pnpm check`, `pnpm -r test`, `pnpm check:openapi`, `pnpm check:infra`,
   `pnpm check:container`, `pnpm check:runtime-profiles`, and
   `pnpm eval:golden` from the candidate commit.
2. Provision the five dedicated Terraform task roles before deployment: API,
   Worker, SEC ingestion, memory retention, and migration. Do not reuse a
   broad application role or attach an application task role to Web. Verify the
   Worker task role has least-privilege `events:PutEvents` access to the
   Terraform output `research_domain_event_bus_arn`; it must not publish to the
   default bus or use an account-wide wildcard. The migration role may access
   only database migration facilities; the API role may receive only the
   narrowly scoped embedding, evidence-lake/index, and graph permissions
   required to propagate an authorized memory deletion. It must not receive
   chat-model, filing-source, market-data, or warehouse privileges. Provide
   the five matching
   Terraform secret maps with exactly their declared keys: `api_secrets`,
   `worker_secrets`, `sec_ingestion_secrets`, `memory_retention_secrets`, and
   `migration_secrets`. Never make a maintenance task inherit
   `worker_secrets`; its process environment is an authorization boundary even
   when the ECS task role is separately scoped.
3. Review and version the administrator-approved `TOOL_MANIFEST_CATALOG_JSON`
   secret before deployment. Inject the identical secret into both API and
   Worker through the Terraform secret maps. It may contain only trusted,
   agent-visible manifests with matching IDs, versions and entitlements; a
   missing, malformed, expanded, or provider-drifted catalog must fail the
   deployment rather than disable a guardrail.
   Inject the approved `REDSHIFT_SECRET_ARN` into the Worker secret map as
   well. The Redshift Serverless Data API must use this database credential;
   do not replace it with broad cluster or account credentials.
4. Run the dedicated database-migration ECS task exactly once and wait for a
   successful exit. The tenant-integrity migration validates legacy
   cross-organization links; resolve any reported data mismatch before retrying
   rather than disabling a foreign key. Its dedicated `migration_secrets` map
   must contain only `DATABASE_URL`; it must not inherit the Worker secret map
   or model/data-provider credentials. Do not start API or Worker migration
   code on application startup.
5. Deploy the Worker, then API, then Web. Verify `/ready`, an OIDC-authenticated
   conversation creation, a persisted empty run, SSE reconnection, and the
   Worker/queue alarm state without using production financial questions.
6. Roll back only application images/configuration. Migrations are append-only:
   never alter an applied migration or roll back schema by deleting rows. Use a
   forward corrective migration after incident review.

### Conversation lifecycle migration and support behavior

- Apply `0011_conversation_lifecycle.sql` as an append-only migration before a release that exposes the conversation sidebar. It adds archive state and soft-delete provenance without cascading into research records.
- A user-facing deletion only makes the conversation unavailable through normal APIs. Do not manually remove its runs, evidence, report versions, citations, tool invocations, or audit records to satisfy a support request; handle retention or legal requests through the approved data-governance process.
- Browser “pause display” buffers SSE events locally. It does not stop a queued or running Worker. For a user who closes a browser, direct them to reopen the conversation or run and let SSE resume from its persisted cursor; do not cancel or replay a run merely because its display was paused.

## Queue, run, and EventBridge incidents

- **Active-run quota rejection:** `429 RUN_LIMIT_EXCEEDED` means the
  transactionally counted `queued`/`running` limit for the submitting user or
  organization has been reached. Check active runs and Worker capacity before
  changing Terraform quota variables; do not retry requests in a tight loop or
  bypass the submission outbox.
- **Queued run pause/resume:** `POST /v1/runs/{id}/pause` is valid only while
  status is `queued`; it records a `run_paused` event before any Worker can
  claim the command. `resume` records `run_resumed` and adds the immutable
  command to the same transactional outbox path as a fresh submission. A
  running run must return `409 RUN_PAUSE_UNAVAILABLE`; do not kill a Worker or
  delete an SQS message to approximate a user pause after model/tool work may
  have started.
- **DLQ arrival:** investigate the persisted `ResearchRun`, its checkpoints,
  tool audit rows, and the immutable command snapshot before any action. A run
  after `tasks_executed` is never automatically replayed because a licensed or
  billed tool may already have run. Create an audited new run only after the
  root cause is resolved.
- **Worker scale or shutdown:** each Worker process receives exactly one run at
  a time because an individual run may take five minutes. Scale ECS task count,
  not the per-process receive batch, unless a reviewed visibility-heartbeat and
  bounded-concurrency design is deployed. SIGTERM/SIGINT cancels an idle SQS
  long poll. For a received run it cancels model/tool work, persists the
  `worker_shutdown` critic result and an abstention, then acknowledges normally.
  Do not manually replay a shutdown-abstained run that may have reached tool
  execution; create an audited new run after checking the tool audit ledger.
  Terraform configures a 120-second Fargate `stopTimeout` and a 100/200 rolling
  deployment policy so replacement Worker capacity is started before a task is
  drained. Do not reduce this timeout below the documented 30-second minimum
  without a shutdown-path load test.
- **Stale run lease:** the Worker may recover only a checkpoint before tool
  execution and only once. Later phases remain failed and require the same
  audited new-run process. If a failure-event write is itself unavailable, the
  Worker still marks the active run as failed rather than leaving it running
  until lease expiry; inspect the queue delivery and application logs because
  the normal terminal event may be absent.
- **EventBridge delivery failure:** EventBridge is non-authoritative. The
  committed metadata-only record remains in `domain_event_outbox`; check the
  Worker IAM permission, bus name and consumer rule, then allow the Worker to
  retry. Do not synthesize an event from questions, claims, logs, or evidence.
  Consumers must deduplicate on the event ID.
- **Domain-event outbox alarm:** investigate `DomainEventOutboxPending` and
  `DomainEventOutboxOldestAgeSeconds` before clearing an alert. The Worker logs
  these aggregate-only values once a minute. Check EventBridge permissions,
  bus availability and Worker health; do not delete pending rows or replay
  events from logs. Once delivery recovers, the durable outbox retries them.
- **Redis failure:** SSE falls back to querying persisted PostgreSQL events.
  Restore Redis without replaying evidence or changing run status.
- **Memory deletion reconciliation (503):** `MEMORY_DELETION_INCOMPLETE` or
  `MEMORY_DELETION_AUDIT_UNAVAILABLE` means the API cannot prove one terminal
  cross-store state. Do not ask the caller to retry automatically. Use the
  request ID and protected application log's deletion phase to determine
  whether the relational record was deleted, inspect the append-only deletion
  audit ledger, and reconcile only explicit `memoryArtifactEvidenceIds` / URIs.
  Shared cited source evidence is intentionally retained. If the completion
  audit is absent after a committed record delete, create an operator-approved,
  content-free corrective audit event; record the incident and the evidence
  cleanup verification. Do not reconstruct or delete source evidence from a
  model output, access log, or citation list.
- **Memory legal hold (409):** `MEMORY_RETENTION_LOCKED` is an expected
  compliance control, including for organization administrators. Do not alter
  the retention policy or delete the row through database access to unblock a
  researcher. Process a separately approved legal-hold release, then retain
  its approval record before the normal user deletion workflow is used.
- **Scheduled memory retention:** the daily Fargate task selects at most the
  configured `MEMORY_RETENTION_BATCH_SIZE` expired records and excludes every
  `legal_hold` record in both SQL and service logic. It invokes the same
  cross-store cleanup and content-free audit workflow as a user deletion. An
  aggregate task result with `failed > 0` requires investigation before the
  next schedule; do not bulk-delete rows to make the alarm disappear. Reruns
  are safe only because successful deletes are absent from the next batch.
- **Scheduled SEC ingestion partial failure:** the task always writes a
  content-free lifecycle event with requested, ingested, and failed counts.
  A nonzero failed count intentionally exits the task nonzero after that
  durable event is written. Investigate protected task diagnostics and retry
  only failed source ingestion through the next scheduled execution; do not
  add ticker, URL, parser, or provider-error details to EventBridge or logs.
- **Report-render failure:** the internal `report.compose` tool is invoked only
  after Critic approval and is audited like every other tool. Its failure turns
  the run into an abstention; investigate its tool-audit record and cited
  evidence authorization. Do not bypass it by writing Markdown directly to
  `research_reports`.

## Disaster recovery procedure

1. Declare the incident, freeze destructive operational changes, record the
   incident timestamp, affected tenants and the last verified backup/snapshot.
2. Restore PostgreSQL to the approved point in time. Validate migration
   checksums in `schema_migrations`, tenant isolation, run/event sequence
   uniqueness, audit ledgers, and `domain_event_outbox` before accepting traffic.
3. Restore S3 evidence objects and versions, OpenSearch snapshots, Neo4j backup,
   and Redshift snapshot in that order. Re-index only from restored source
   objects; graph edges must continue to reference valid evidence and retain the
   source's `requiredEntitlements` plus `requiredEntitlementCount` marker. An
   edge without that marker is legacy data and is intentionally unreadable: re-
   ingest it from authorized source evidence or use an approved, audited migration
   before enabling graph reads. Do not lower the read filter to make legacy edges
   visible.
4. Redeploy API/Worker/Web with the approved immutable images and secrets. Keep
   consumers disabled until EventBridge, database access controls, data-source
   license entitlements, and OIDC validation pass smoke tests.
5. Re-enable consumers and scheduled SEC ingestion. Reconcile queued runs and
   lifecycle outbox events from PostgreSQL; never infer missing research facts
   from queues, Redis, logs, or model outputs.
6. Record actual RPO/RTO, missing records, provider status, evidence integrity
   checks, tenant access checks, and corrective actions in the incident record.

## Data licensing, security, and drills

- Quarterly, test one point-in-time restore in an isolated account and prove
  tenant filtering, evidence entitlement checks, citations, model audit rows,
  tool audit rows, and EventBridge event deduplication. Attach the drill result
  to the release record.
- Review every commercial provider's current license, permitted users, data
  latency, redistribution terms, retention period, and entitlement mapping
  before renewal or a provider change. Revoke a user/license entitlement at
  API, retrieval, tool, and evidence-download layers; do not rely on a Web-only
  control.
- **SEC network-boundary failure:** a rejected redirect, non-SEC URL, or
  response-size-limit failure is an expected fail-closed outcome. Do not add a
  host, private IP, arbitrary redirect, or larger limit to restore a single
  filing. Confirm the SEC source URL and document size through the approved
  ingestion process, then make an audited configuration change only when the
  platform security owner approves it.
- Perform a security review before production release and after material changes
  to OIDC claims, IAM, tools, data providers, prompts, retrieval, or memory.
  Cover SSRF, prompt injection, tenant isolation, secret rotation, logging
  redaction, model-context sensitive-data redaction, dependency vulnerability
  remediation, and recovery authorization. The original evidence lake is not
  redacted in place: validate the model-safe copy and separately validate that
  authorized evidence retrieval still preserves citation locators.
- Do not copy provider, database, queue, or tool exception messages into a
  `RunEvent`, SSE stream, EventBridge event, or rate-limited operational log.
  The platform records stable public failure codes and error types only. Use the
  protected trace correlation and provider-side diagnostics for root-cause work;
  never paste raw error text into a report, replay event, or incident summary.
- If a persisted historical event fails the current `RunEvent` contract during
  replay, treat it as a schema-compatibility incident. Do not bypass parsing or
  return its raw payload to a browser. Add an approved, versioned migration or
  read adapter that maps it to a safe current event shape, and regression-test
  that mapping before restoring replay access.
