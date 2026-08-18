# Interactive Research Agent

Evidence-driven, TypeScript financial research platform for US-equity research.

The former Python proof-of-concept is isolated under `legacy/python-prototype/`
as behavior-reference code and test samples. It is not a dependency of this
workspace and must not be used in production request paths or container builds.

## Workspace

- `apps/api`: Fastify API and Server-Sent Events boundary
- `apps/web`: Next.js research workspace
- `apps/worker`: asynchronous research-run worker entrypoint
- `packages/contracts`: Zod-validated domain and API contracts
- `packages/agent-runtime`: bounded research orchestration
- `packages/live-events`: bounded Redis Stream live-event fan-out; PostgreSQL remains replay authority
- `packages/memory`: multi-tier memory interfaces and development store
- `packages/knowledge`: S3 evidence lake, OpenSearch hybrid index boundary, Neo4j fixed-query boundary, RAG and citation safety gates
- `packages/tools`: registry, policy enforcement, durable invocation audit, SEC/financial/retrieval/graph/analysis tools, and the internal controlled report renderer
- `packages/reports`: evidence-bound Markdown reports and versioned report stores
- `packages/evaluation`: golden-case metrics and release quality gates

完整的生产架构、运行不变量和演进规则见
[docs/architecture/system-design.md](docs/architecture/system-design.md)。
面向研究人员的会话、流式、暂停、编辑与引用交互规范见
[docs/product/research-workbench.md](docs/product/research-workbench.md)；本地已完成能力与需要目标环境验收的边界见
[docs/architecture/local-completion-audit.md](docs/architecture/local-completion-audit.md)。

## Local development

Use Node.js `22.23.2` (the repository's [`.node-version`](.node-version)) and
pnpm `9.15.0` (locked by `packageManager`). Corepack is the supported pnpm
installer; do not use an arbitrary global pnpm release. Verify the active
toolchain, then run:

```bash
node --version
pnpm --version
pnpm install
cp .env.example .env
docker compose up -d
pnpm check
pnpm test
pnpm dev:api
```

The API and Worker now load the nearest local `.env` automatically in
development, without overriding environment variables already supplied by your
shell. They never load `.env` when `NODE_ENV=production`; production settings
must come from the deployment configuration.

Financial-data and filing providers intentionally start disabled. A run with no
configured verified evidence finishes as `abstained`; it never fabricates a
research conclusion.

SEC retrieval is configured with `SEC_USER_AGENT` and the bounded
`SEC_MAX_RESPONSE_BYTES` (default 5 MiB). The client accepts only HTTPS
`data.sec.gov` / `www.sec.gov` URLs, follows at most two same-allowlist
redirects, and stops streaming a response once the configured limit is reached.
Production requires a valid SEC user-agent identifier; do not replace this
fixed-source boundary with arbitrary user-provided URLs.

Every SEC filing result is split into bounded, deterministic disclosure
excerpts. A citation records the SEC accession, primary document, normalized
character interval, excerpt ordinal, and the full normalized-document hash.
This makes a cited passage reproducible without treating an entire filing as a
single opaque source. Canonical warehouse data is additionally checked for
conflicting values with the same entity, period, source-as-of date, metric,
currency, and unit; a Claim relying on such a conflict is refused.

An explicit calendar/fiscal-year constraint is propagated to the SEC filing
tool. It selects disclosures by EDGAR `reportDate`, and may read up to ten
SEC-listed historical submission shards when the requested year is not in the
recent feed. It never substitutes the newest filing for an unmatched period.

DCF is also fail-closed. A valuation run first requests the fixed
`valuation_inputs` warehouse template, whose sole row supplies free cash flow,
growth, terminal growth, discount rate, forecast years, fiscal period, and a
source date. The runtime accepts exactly one licensed, entitlement-authorized
record for the selected ticker and preserves its evidence ID in the `dcf-v1`
input/output audit. Missing, ambiguous, invalid-format, or non-source-bound
assumptions leave the valuation task failed rather than allowing an LLM to
invent inputs. The data platform must maintain the approved
`financial_valuation_inputs` view before enabling this capability. Every
warehouse record must include a source date, ISO currency and explicit unit;
fundamental, industry and valuation rows must additionally include a fiscal
period. The DCF gate checks those fields both in the source-bound row and in
evidence metadata, preventing silent unit or currency ambiguity.

Development runs execute in-process. Production submissions are durable:

```text
API transaction (message + run + outbox) -> SQS -> Worker atomic claim -> run events/report
```

After evidence is durably linked to a run, the production Worker uses a
PostgreSQL publication finalizer to create the report, append the assistant
message, append its terminal audit/lifecycle event, and set the terminal run
state in one database statement. The Worker defers `completed`/`abstained`
SSE publication until this commit succeeds; a failed publication instead emits
only the controlled failure event. This avoids an orphaned report or visible
terminal status when a process fails during the last publication steps. The
in-memory development adapters retain their simple sequential implementation.

The authorization scope in that command is a validated submission-time snapshot:
it is the reproducible authority for the bounded, five-minute run, not a later
browser token. The API writes it to both the run snapshot and transactional
outbox. In production the Worker resolves it again from the durable run snapshot
by `runId` (falling back to the outbox only for pre-rollout records) and ignores
mutable SQS fields, so queue delivery cannot grant a different role or data
entitlement. Immediate revocation must
also cancel or prevent submission through the identity/data-entitlement control
plane; it is not deferred to a long-lived queue message.

The same command includes the API-approved, agent-visible tool manifest list.
The Worker checks the complete manifest (ID, provider/formula version,
entitlements, timeout, cost limit, enablement and visibility) before every
external tool call. A deployment drift or a newly registered tool therefore
produces a controlled unavailable result rather than changing an in-flight or
recovered research run. The internal report renderer is intentionally outside
this LLM-visible snapshot and remains callable only by trusted runtime code.
The Planner receives only the snapshot's agent tool IDs; Runtime then applies a
second deterministic intersection before execution (and before a Critic repair
task). This prevents an LLM from planning an internal, unlicensed, or newly
deployed capability even before `ToolRegistry` enforces the final invocation
boundary.

Production also requires `TOOL_MANIFEST_CATALOG_JSON`, injected into both API
and Worker from Secrets Manager through the Terraform `api_secrets` and
`worker_secrets` maps. It is a JSON array of administrator-approved,
agent-visible manifests. The catalog can retain only trusted code-owned tool
IDs and matching versions/capabilities/entitlements; it may lower a timeout or
cost cap, but cannot add a tool, expand permissions, expose `report.compose`,
or relax a provider guardrail. The API uses it only to make the immutable
submission snapshot; the Worker revalidates it against its actual provider
adapters on startup. An omitted, malformed, or drifted catalog fails closed.
Terraform additionally rejects a deployment plan whose `api_secrets` or
`worker_secrets` map omits this key.

Each executable has a separate production configuration profile and exact
Terraform secret map: `api_secrets`, `worker_secrets`,
`sec_ingestion_secrets`, `memory_retention_secrets`, and
`migration_secrets`. SEC ingestion and retention never inherit Agent Worker
credentials, while the migration task receives only `DATABASE_URL`. The ECS
definitions also inject `AWS_REGION` explicitly, so a non-`us-east-1`
deployment cannot silently use the development default. `pnpm
check:runtime-profiles` prevents these boundaries from regressing in CI.
Use [the non-secret Terraform parameter template](infra/terraform/terraform.tfvars.example)
to prepare the five scoped secret maps and immutable image references for a
candidate environment.

Production submission is also quota-bound before an outbox command is created.
The API supplies `MAX_ACTIVE_RUNS_PER_USER` (default `2`) and
`MAX_ACTIVE_RUNS_PER_ORGANIZATION` (default `10`); PostgreSQL serializes each
organization's submission decision and counts only `queued`/`running` runs.
Quota rejection returns `429 RUN_LIMIT_EXCEEDED` without creating a message,
run, or queue record. Terraform exposes the matching
`api_max_active_runs_per_user` and `api_max_active_runs_per_organization`
variables for approved capacity changes.

Each worker turn enters the LangGraph research boundary before invoking the
bounded runtime. PostgreSQL domain checkpoints remain the recovery authority:
they record completed phases and deliberately prohibit automatic replay after
any tool-execution phase, where a general graph replay could duplicate a
licensed or billed call.

The Worker process is started with `pnpm --filter @research/worker start`.
`GET /health` is a process-liveness probe; `GET /ready` verifies the configured
PostgreSQL persistence dependency and returns a safe `503` until it is usable.
Configure deployment readiness checks to use `/ready` and keep `/health` for
liveness/restart checks.
`SQS_RESEARCH_RUN_VISIBILITY_TIMEOUT_SECONDS` defaults to 360 seconds, exceeding
the five-minute runtime budget so a healthy worker is not duplicate-delivered
while it is still executing a research run.
Each Worker process intentionally receives one research run at a time. A run
can consume its full five-minute lease, so prefetching a batch for sequential
handling could let later messages reappear before execution begins. Increase
ECS Worker task count for throughput; do not raise local queue batch size
without also implementing visibility-heartbeat and bounded concurrency.
On SIGTERM/SIGINT, the Worker first cancels an idle long poll. If a run is
already claimed, the same drain signal reaches its model and tool calls; the
LangGraph runtime writes a distinct `worker_shutdown` critic result and an
auditable abstention before the message is acknowledged. It never publishes a
partial report or automatically replays a run that may have called a licensed
or billable provider.
Terraform gives the Worker container a configurable 120-second Fargate stop
window and rolls out replacement capacity before draining an existing Worker.
This is a shutdown-flush allowance, not permission to extend the immutable
five-minute research runtime budget.
Each claimed production run also has a six-minute database execution lease. If
the worker dies, the next delivery atomically marks an expired lease as failed
and records the failure. Only a checkpoint before task execution can then use
the existing one-time automatic recovery; later checkpoints remain failed for
an audited replay, preventing a duplicated licensed or billed tool call.
The API's SSE stream reconnects from persisted event sequence using the
`Last-Event-ID` header.
In production, after the worker persists an event it appends a bounded copy to
the configured Redis Stream. A single API-side tailer uses that Stream only to
wake SSE connections; each connection always re-reads tenant-authorized events
from PostgreSQL. Redis outages therefore fall back to durable polling/replay
instead of losing, inventing, or exposing research evidence.
The same PostgreSQL transaction writes a metadata-only lifecycle event to the
domain-event outbox. The Worker asynchronously sends it to the configured
EventBridge bus (`EVENTBRIDGE_EVENT_BUS_NAME`); failures are rate-limited in
logs and retried from the durable outbox without blocking a research run. Event
details contain only tenant ID, run ID, sequence and event type—never questions,
claims, evidence text, prompts or licensed data. EventBridge consumers must
deduplicate by event ID and fetch any authorized detail through the platform.
The Worker also emits one aggregate-only `domain_event_outbox_health` log record
per minute. Terraform turns its pending count and oldest-event age into
CloudWatch alarms, so an EventBridge outage cannot remain invisible while the
durable outbox protects research execution.
Scheduled SEC ingestion writes a separate `knowledge.sec_ingestion.completed`
metadata event (requested ticker count and ingested evidence count) to the same
outbox after its evidence writes succeed.

Commercial market data is never fetched by the Agent or configured with a
provider API key. A procurement-approved ingestion pipeline must first land
versioned, license-tagged records in S3/Glue/Redshift; `FinancialDataTool` can
then read only the four static Redshift views with a source-as-of constraint.
The deployment needs `MARKET_DATA_LICENSE`, Redshift access, and the caller's
`market-data` entitlement. Supplier credentials, field mappings, delivery
latency, and backfill policy belong to that separate ingestion deployment, not
to the research-runtime environment.
Trusted ingestion may also write a fixed, source-bound graph relation only after
the immutable evidence object and its retrieval index entry have succeeded. Each
Neo4j relationship is one evidence-bound edge and retains its originating
evidence ID and the source's required entitlements. Graph reads apply both the
`graph-read` capability and those source entitlements; relationships derived from
licensed data are not visible to callers lacking that license. Legacy edges that
do not carry the entitlement-count marker fail closed until they are re-ingested
or migrated through an approved procedure. Graph reads are merely retrieval leads
and never replace the underlying filing or licensed-data citation. The Agent
cannot write graph facts or construct Cypher.
Tool and Bedrock audit ledgers each write an accompanying metadata-only event in
the same SQL statement (`audit.tool_invocation.recorded` and
`audit.model_invocation.recorded`). These expose identifiers, outcome, duration,
cost and token counts only; hashes and detailed audit records remain in the
authorized PostgreSQL ledger.
Each bounded runtime phase also appends a PostgreSQL checkpoint containing the
validated plan, task state, evidence IDs, claims, and critic result. Checkpoints
intentionally reference evidence rather than duplicating source text.
Automatic recovery is deliberately limited to checkpoints before task execution;
later failures require an audited replay because a tool may already have used a
licensed or billed external capability. A successful safe reclaim is persisted
and streamed as a `run_recovered` event with its checkpoint phase and reason.
The Critic may request at most one supplementary-evidence retry. That retry can
only clone a previously failed task and its already-authorized tool allowlist;
it shares the original run's task, time, tool-call, and cost budgets. Initial
and post-repair critic decisions are persisted as `critic_result` events and
the repair task is included in the checkpoint snapshot.

Each production run creates one shared cost ledger for tool and Bedrock usage.
Before either a billable tool attempt, Bedrock generation request, or
Bedrock embedding request, its adapter reserves
the registered maximum cost and settles it with validated provider accounting.
Missing model usage, timeouts, aborts, SDK failures, and malformed tool results
are charged at that maximum, because an external request may already have been
accepted. A provider cost above its tool manifest ceiling rejects the result and
its evidence. An insufficient reservation prevents the request, and a
cost-budget exhaustion causes an audited abstention rather than further model
or tool work.

The same immutable run budget creates one cancellation signal for the full
five-minute execution window. It is propagated through LangGraph phases,
Bedrock intent/planning/claim/entailment requests, and tool invocations; tools
also stop retrying when that enclosing signal fires. A deadline expiry takes a
separate `run_deadline_exceeded` graph terminal branch, records a
`critic_result`, and emits only an abstention. It cannot publish a partial
report after a delayed provider response.

Before any Bedrock intent, plan, claim, or citation-entailment request, known
sensitive credentials and personal identifiers are redacted from the
model-bound question and evidence copy. Claim context is additionally rebuilt
from only tenant-authorized, prompt-injection-safe evidence within a fixed
token budget. Redaction never overwrites the evidence lake or citation record:
the original source remains available only through the tenant- and
entitlement-authorized evidence endpoint.
Unexpected API/Worker failures and `tool_completed` SSE events follow the same
boundary: they expose stable failure codes and safe descriptions, never raw
provider, database, queue, or tool exception text. Detailed failures are for
the protected operational trace and audit process, not the research timeline.
Every persisted/streamed `RunEvent` is additionally a discriminated, bounded
contract: its event type selects a finite payload schema, validated at runtime
before SQL persistence, Redis fan-out, and browser rendering. New event fields
require a versioned contract change rather than arbitrary JSON.
Memory retention is a separate scheduled Worker task, not a request-path side
effect. It selects bounded expired non-held records and calls the same
coordinated deletion path used by the API, so derived vector/graph/S3 artifacts
and append-only deletion audit records remain aligned.
After the deterministic citation, period, and numeric checks, a separate
structured citation-entailment pass must return an explicit verdict for every
claim. A missing or negative verdict refuses publication; it cannot degrade
into an uncited partial answer.

## Production configuration

Set `NODE_ENV=production`, `PERSISTENCE_MODE=postgres`, and configure
PostgreSQL, Redis, SQS, Bedrock generation + embedding models, OpenSearch and
OIDC values. Production fails startup when a required control-plane dependency
is absent. AWS OpenSearch requests use the workload's IAM credentials through
SigV4; no static search credential is configured in the application.

The Agent Worker also requires `EVENTBRIDGE_EVENT_BUS_NAME`. Terraform creates
the dedicated `${name}-domain-events` bus and injects its name into the Worker
task. The platform-managed Worker task role must grant `events:PutEvents` only
to that bus ARN; do not use the default bus or an account-wide EventBridge
permission. Keep the API role free of Bedrock, data-lake, graph, warehouse and EventBridge permissions; keep the migration role limited to migration database access. Supply all five distinct role ARNs to Terraform before `apply`.

The Agent Worker also requires `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, an HTTP(S)
OTLP collector endpoint. It starts the Node OpenTelemetry SDK before a run and
flushes it on graceful shutdown; no endpoint means no implicit localhost export
in local development. Supply the same endpoint through Terraform's
`worker_otlp_traces_endpoint` variable in production.

Set `CORS_ALLOWED_ORIGINS` to a comma-separated list of exact HTTPS origins
for the deployed research web application (for example,
`https://research.internal.example`). Wildcards, paths, localhost, and HTTP
origins are rejected in production. This setting is non-secret configuration,
but must be supplied as Terraform `api_cors_allowed_origins` alongside the API
task’s secret map.

The research web application uses OIDC authorization code + PKCE and attaches
the resulting access token as a Bearer token for every API request and SSE
stream. Supply `NEXT_PUBLIC_OIDC_AUTHORITY`,
`NEXT_PUBLIC_OIDC_CLIENT_ID`, optional `NEXT_PUBLIC_OIDC_SCOPE`, and its
registered `NEXT_PUBLIC_OIDC_REDIRECT_URI` when building the Web image. These
are public client metadata, never a client secret; production rejects HTTP or
localhost values. Register the same deployed Web origin in both the identity
provider redirect allowlist and API `CORS_ALLOWED_ORIGINS`.

The Web workspace renders the research timeline separately from the final
report. Citation markers in a report are derived from streamed `claim_delta`
events using the same first-occurrence order as the report composer; selecting
one performs an authorized `GET /v1/evidence/{id}` request and shows the
original locator, source metadata, license, and content. SSE messages include
standard event IDs. If the initial stream ends before a terminal event, the Web
client resumes the authorized event endpoint from the last sequence and
deduplicates replayed events.

Tool invocation applies a shared reliability policy: a bounded retry is allowed
only for transient read-only failures, repeated transient failures open a
per-worker circuit for a cooldown period, and the manifest timeout aborts the
tool's signal. SEC HTTP and Redshift Data API adapters consume that signal, so
the registry does not merely stop waiting while those requests continue in the
background. Before any result can enter run state, the registry validates the
declared output, every evidence item, failure envelope and finite non-negative
cost. It also requires returned evidence to match the invoking tenant and its
entitlements; malformed, cross-tenant or unentitled provider output fails
closed and contributes no evidence IDs to the audit record. Every final result,
including a circuit-open refusal, remains in the existing tool audit ledger with
a deterministic per-run/task idempotency key. The database enforces that key as
unique per run; future side-effecting or billable adapters must forward it to
their providers instead of retrying with a new operation identity.

`report.compose` is a single, zero-cost internal tool invoked only after the
Critic has approved the claim set. Its manifest is intentionally hidden from
Agent discovery, so the Planner cannot request it. It validates the same
evidence authorization and citations as the final report, emits a standard tool
audit record with a stable run key, and returns a document for the Worker to
persist as a versioned report. The one deterministic render is bounded by its
own timeout and the run deadline; it does not consume the Executor's autonomous
external-tool-call budget.

Next.js public variables are compiled into browser JavaScript. When building a
Web image, pass them as Docker build arguments (never pass a client secret):

```bash
docker build --target web \
  --build-arg NEXT_PUBLIC_API_URL=https://api.research.internal.example \
  --build-arg NEXT_PUBLIC_OIDC_AUTHORITY=https://identity.internal.example \
  --build-arg NEXT_PUBLIC_OIDC_CLIENT_ID=research-web \
  --build-arg NEXT_PUBLIC_OIDC_REDIRECT_URI=https://research.internal.example/auth/callback \
  --build-arg 'NEXT_PUBLIC_OIDC_SCOPE=openid profile email' \
  -t research-web .
```

Before every production service rollout, run the dedicated database-migration
ECS task once and wait for a successful exit. It applies every ordered file in
`packages/db/migrations/` under a PostgreSQL advisory lock, records each
checksum in `schema_migrations`, and fails closed if an applied file changes.
For a direct controlled execution from a built workspace, use
`pnpm --filter @research/worker migrate`. Do not run migrations from API or
Worker service startup. In the local Docker environment, use
`docker compose --profile maintenance run --rm migrate` after the Postgres
container is healthy.

CI also starts PostgreSQL 16, runs the immutable migration runner, and verifies
the atomic publication path against the real database. It covers both a
successful abstention publication and a duplicate terminal-event constraint
failure, which must roll back the report, message and terminal transition as
one unit.
The OIDC organization claim must resolve to the platform's internal UUID
organization. The OIDC subject may be opaque: PostgreSQL maps it through the
unique `(organization_id, oidc_subject)` principal record and replaces it with
the stable internal user UUID before any conversation, run, queue command, or
memory write. Configure only licensed market-data adapters and grant their
corresponding entitlements; unconfigured tools return `UNAVAILABLE`.

Conversation-derived resources are private by default: a conversation creator
may read or append its messages and access its runs, event stream and reports;
another researcher in the same organization receives `404`. An organization
`admin` is the explicit audit/support exception. PostgreSQL enforces this rule
through the owning conversation in every run/report query and durable run
submission, rather than relying on API checks alone. Evidence remains a
tenant-scoped research asset and is additionally protected by its data-license
entitlements.

Every evidence item can declare `requiredEntitlements`. The runtime injects
entitlements only from the verified OIDC scope, then enforces them in the
OpenSearch filter, model context builder, citation gate, and evidence-download
store. For example, warehouse evidence produced by `FinancialDataTool` requires
the `market-data` entitlement; a user without it receives an indistinguishable
`404` rather than the licensed content.

Licensed and secondary evidence must explicitly declare their required grants
before it can enter OpenSearch. During this control's rollout, older licensed
or secondary records without the field fail closed; re-ingest them with the
approved entitlement before relying on them in research runs.

## API contract

The versioned production API contract is [docs/openapi/v1.json](docs/openapi/v1.json).
Run `pnpm check:openapi` to validate its route inventory, bearer authentication
definition, and reconnectable SSE event vocabulary before release.

## Quality gate

GitHub Actions runs `pnpm check` and `pnpm -r test` for every pull request and
change to `main`. Deployment credentials, OIDC secrets, commercial-data keys,
and database passwords are intentionally supplied only through the target
platform's secret manager.
It also verifies OpenAPI, Terraform, container, and production-operations
contracts before executing the golden evaluation gate.

`pnpm eval:golden` is an explicit release gate run in CI before the full test
suite. It exercises controlled Agent Runtime fixtures for cited company facts,
earnings, competitive comparison, valuation sensitivity, explicit reporting
period conflicts, missing evidence, entitlement denial, and prompt injection.
It also verifies that a cited claim is still withheld when any required planned
research task remains incomplete.
All fixture answers must have complete valid citations and every numeric claim
must match cited source text; every unsafe case must abstain. The suite has no external-provider dependency and does not use live
market data. The gate also fails if any required category is missing, duplicated,
or replaced with an unknown category, so a fixture-count change cannot silently
weaken release coverage.

## Memory lifecycle

Memory is deliberately layered rather than treated as an unbounded chat
transcript. The runtime keeps the current question as the controlling input,
then loads only the current conversation's short-term facts, followed by
research assets and user-approved preferences. Research assets remain retrieval
leads, never stand-alone evidence for a new claim.

On a completed report the runtime stores a versioned Research Memory record
with the originating question, validated entities/tickers, source run and
evidence dates. A later turn uses only this metadata to broaden its authorized
hybrid retrieval; it never places an older report body into the model context
or treats that report as evidence for a new claim. The store applies a fixed
entity/ticker metadata filter, with a conservative textual fallback only when
the new question has no usable entity lead.

`memory_records` records `conversation_id` and `retention_policy`. Short-term
records must be private, belong to a user and a single conversation, and use
the `session` retention policy; queries without a conversation ID fail closed
for that layer. Long-term and research records may use `user_managed`,
`organization_default`, or `legal_hold` according to the applicable retention
policy. Migration `0004_memory_lifecycle.sql` adds these lifecycle controls.
Memory updates distinguish an omitted expiry from an explicit `expiresAt: null`,
so a caller can deliberately remove a TTL without changing other fields.

Confirmed user preferences are a closed, non-evidentiary contract available at
`GET/PUT /v1/memory/preferences`. They are private to the authenticated user,
never inferred from a research turn, and may only affect planning/display
defaults. Migration `0008_confirmed_preference_uniqueness.sql` preserves any
legacy duplicate preference record as inactive history and enforces one active
preference key per organization/user; PostgreSQL writes use an atomic upsert.

Coordinated deletion writes append-only `requested` and `completed` audit
events (or `failed` after a propagation error) without copying memory content.
The audit records the actor, tenant, memory scope and linked evidence IDs before
the workflow propagates deletion to the graph, index and object lake. Linked
`evidenceIds` are citations and remain immutable shared source evidence: deleting
a memory never removes them. Only explicitly owned
`memoryArtifactEvidenceIds` and `memoryArtifactEvidenceUris` may be physically
removed as memory-derived artifacts; unrecognized legacy metadata is retained
fail-closed. Migration `0005_memory_deletion_audit.sql` creates this immutable
audit ledger.

## Infrastructure

`infra/terraform` defines the Fargate Web, API, and Worker services, SQS + DLQ, a
dedicated metadata-only EventBridge domain-event bus, and EventBridge scheduled
Fargate tasks for `sec-ingestion-main` and memory retention. It intentionally
accepts existing VPC, ECS cluster, images, secret ARNs, and five dedicated IAM
task-role inputs rather than creating broad IAM permissions. API, Worker, SEC
ingestion, memory retention, and migration each receive a distinct role; Web
has no application task role. The scheduled SEC task receives
`SEC_INGEST_TENANT_ID` and `SEC_INGEST_TICKERS` through the worker secret map;
the SQS queue URL is supplied as a non-secret task environment variable.
The owning platform must provide existing `api_target_group_arn` and
`web_target_group_arn`; API and Web remain in private subnets and are attached
to the organization-managed load balancer through those target groups.

It also creates queue-depth, oldest-message, and DLQ-arrival CloudWatch alarms.
Pass an existing `alert_topic_arn` to route state changes to the organization’s
incident process; when omitted, alarms are still visible in CloudWatch but do
not create or own an SNS topic. Tune `queue_backlog_alarm_threshold` and
`queue_oldest_message_alarm_seconds` to the team’s agreed SLO before apply.
Set `worker_otlp_traces_endpoint` to the organization-managed OTLP collector;
the worker task receives it as non-secret runtime configuration.
Set `worker_sec_max_response_bytes` only within its validated 64 KiB–5 MiB
range; the same value is inherited by the scheduled SEC-ingestion task. Keep
`SEC_USER_AGENT` in the Worker secret map with the approved contact identity.
Run `pnpm check:infra` for static alert-contract verification, then run
`terraform -chdir=infra/terraform init -backend=false` and
`terraform -chdir=infra/terraform validate` in a Terraform-enabled environment.
Run `pnpm check:container` to ensure container builds use the committed lockfile,
retain the required public OIDC build arguments, and deploy only production
dependencies plus compiled API/Worker artifacts. The Web image uses Next.js
standalone output. CI builds each production image target; deployment still
must build and publish its approved immutable image digest.
The production release, queue/DLQ, EventBridge, restore, data-license, security
review and drill procedures are versioned in
[docs/operations/production-runbook.md](docs/operations/production-runbook.md).
The implementation evidence and external-release acceptance matrix is in
[docs/architecture/implementation-matrix.md](docs/architecture/implementation-matrix.md).
`pnpm check:operations` prevents those mandatory controls from being removed
from the release contract.
