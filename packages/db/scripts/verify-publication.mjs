import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresResearchRunPublicationFinalizer } from "../dist/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for PostgreSQL publication verification");

const pool = new Pool({ connectionString: databaseUrl });
try {
  const scope = await createScope(pool);
  const firstRunId = await createRun(pool, scope);
  await assertCrossTenantArtifactsAreRejected(pool, scope, firstRunId);
  const terminalEventId = randomUUID();
  const finalizer = new PostgresResearchRunPublicationFinalizer(pool);

  await finalizer.finalize(scope, {
    runId: firstRunId,
    ownerUserId: scope.userId,
    status: "abstained",
    answer: "No verified evidence is available.",
    terminalEvent: terminalEvent(firstRunId, terminalEventId, "abstained", "No verified evidence is available."),
  });
  await assertCommittedPublication(pool, scope, firstRunId, terminalEventId);

  const completedRunId = await createRun(pool, scope);
  const completedEventId = randomUUID();
  await finalizer.finalize(scope, {
    runId: completedRunId,
    ownerUserId: scope.userId,
    status: "completed",
    answer: "# Completed research",
    report: { markdown: "# Completed research", citations: [] },
    researchMemory: researchMemory(scope.organizationId, completedRunId, "# Completed research"),
    terminalEvent: terminalEvent(completedRunId, completedEventId, "completed", "# Completed research"),
  });
  await assertCompletedPublication(pool, scope, completedRunId, completedEventId);

  const rollbackRunId = await createRun(pool, scope);
  await expectRollback(pool, finalizer, scope, rollbackRunId, completedEventId);
  process.stdout.write("PostgreSQL migration and atomic publication verification passed\n");
} finally {
  await pool.end();
}

async function createScope(pool) {
  const organization = await pool.query("INSERT INTO organizations (name) VALUES ($1) RETURNING id", ["integration-test-org"]);
  const organizationId = organization.rows[0].id;
  const user = await pool.query("INSERT INTO users (organization_id, oidc_subject, email) VALUES ($1,$2,$3) RETURNING id", [organizationId, `integration|${randomUUID()}`, `integration-${randomUUID()}@example.test`]);
  return { organizationId, userId: user.rows[0].id, roles: ["researcher"], entitlements: [] };
}

async function createRun(pool, scope) {
  const conversation = await pool.query("INSERT INTO conversations (organization_id, created_by, title) VALUES ($1,$2,$3) RETURNING id", [scope.organizationId, scope.userId, "Integration test"]);
  const runId = randomUUID();
  await pool.query(
    "INSERT INTO research_runs (id, conversation_id, organization_id, status, question, budget, state) VALUES ($1,$2,$3,'running',$4,$5,$6)",
    [runId, conversation.rows[0].id, scope.organizationId, "Verify publication", { maxTasks: 1 }, {}],
  );
  return runId;
}

function terminalEvent(runId, id, type, answer) {
  return {
    id,
    runId,
    sequence: 1,
    type,
    at: new Date().toISOString(),
    payload: { answer, evidenceCount: 0 },
  };
}

async function assertCommittedPublication(pool, scope, runId, terminalEventId) {
  const [run, messages, events, reports, memories, lifecycle] = await Promise.all([
    pool.query("SELECT status, state->>'answer' AS answer FROM research_runs WHERE id=$1", [runId]),
    pool.query("SELECT count(*)::int AS count, min(organization_id)::text AS organization_id FROM messages WHERE run_id=$1", [runId]),
    pool.query("SELECT id, type, organization_id FROM run_events WHERE run_id=$1", [runId]),
    pool.query("SELECT count(*)::int AS count FROM research_reports WHERE run_id=$1", [runId]),
    pool.query("SELECT count(*)::int AS count FROM memory_records WHERE source_run_id=$1", [runId]),
    pool.query("SELECT count(*)::int AS count FROM domain_event_outbox WHERE aggregate_id=$1", [runId]),
  ]);
  if (run.rows[0]?.status !== "abstained" || run.rows[0]?.answer !== "No verified evidence is available.") throw new Error("terminal run state was not committed");
  if (messages.rows[0]?.count !== 1 || messages.rows[0]?.organization_id !== scope.organizationId || events.rows[0]?.id !== terminalEventId || events.rows[0]?.type !== "abstained" || events.rows[0]?.organization_id !== scope.organizationId) throw new Error("assistant message or terminal run event was not committed with its tenant key");
  if (reports.rows[0]?.count !== 0 || memories.rows[0]?.count !== 0 || lifecycle.rows[0]?.count !== 1) throw new Error("abstained publication emitted an unexpected report, memory, or lifecycle event count");
}

async function assertCompletedPublication(pool, scope, runId, terminalEventId) {
  const [run, messages, events, reports, memories, lifecycle] = await Promise.all([
    pool.query("SELECT status, state->>'answer' AS answer FROM research_runs WHERE id=$1", [runId]),
    pool.query("SELECT count(*)::int AS count, min(organization_id)::text AS organization_id FROM messages WHERE run_id=$1", [runId]),
    pool.query("SELECT id, type, organization_id FROM run_events WHERE run_id=$1", [runId]),
    pool.query("SELECT count(*)::int AS count FROM research_reports WHERE run_id=$1", [runId]),
    pool.query("SELECT content, source_run_id, scope, visibility FROM memory_records WHERE source_run_id=$1", [runId]),
    pool.query("SELECT count(*)::int AS count FROM domain_event_outbox WHERE aggregate_id=$1", [runId]),
  ]);
  if (run.rows[0]?.status !== "completed" || run.rows[0]?.answer !== "# Completed research") throw new Error("completed terminal run state was not committed");
  if (messages.rows[0]?.count !== 1 || messages.rows[0]?.organization_id !== scope.organizationId || events.rows[0]?.id !== terminalEventId || events.rows[0]?.type !== "completed" || events.rows[0]?.organization_id !== scope.organizationId) throw new Error("completed assistant message or terminal run event was not committed with its tenant key");
  if (reports.rows[0]?.count !== 1 || memories.rows[0]?.content !== "# Completed research" || memories.rows[0]?.source_run_id !== runId || memories.rows[0]?.scope !== "research" || memories.rows[0]?.visibility !== "organization" || lifecycle.rows[0]?.count !== 1) {
    throw new Error("completed publication did not atomically persist report, research memory, and lifecycle event");
  }
}

/** Exercises the composite foreign keys added by tenant-integrity migration. */
async function assertCrossTenantArtifactsAreRejected(pool, scope, runId) {
  const otherScope = await createScope(pool);
  const otherRunId = await createRun(pool, otherScope);
  await expectForeignKeyViolation(
    () => pool.query(
      "INSERT INTO research_reports (id, run_id, organization_id, version, markdown, citations) VALUES ($1,$2,$3,1,$4,$5)",
      [randomUUID(), runId, otherScope.organizationId, "cross-tenant report", []],
    ),
    "cross-tenant report",
  );

  const evidenceId = randomUUID();
  await pool.query(
    "INSERT INTO evidence_items (id, run_id, organization_id, source_type, authority, source_url, locator, content_hash, content, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    [evidenceId, runId, scope.organizationId, "sec_filing", "primary", null, "test", randomUUID().replaceAll("-", ""), "test evidence", {}],
  );
  await expectForeignKeyViolation(
    () => pool.query(
      "INSERT INTO research_run_evidence (run_id, evidence_id, organization_id) VALUES ($1,$2,$3)",
      [otherRunId, evidenceId, otherScope.organizationId],
    ),
    "cross-tenant evidence reuse",
  );
}

async function expectRollback(pool, finalizer, scope, runId, duplicateTerminalEventId) {
  await finalizer.finalize(scope, {
    runId,
    ownerUserId: scope.userId,
    status: "completed",
    answer: "# Must roll back",
    report: { markdown: "# Must roll back", citations: [] },
    researchMemory: researchMemory(scope.organizationId, runId, "# Must roll back"),
    terminalEvent: terminalEvent(runId, duplicateTerminalEventId, "completed", "# Must roll back"),
  }).then(
    () => { throw new Error("duplicate terminal event unexpectedly committed"); },
    () => undefined,
  );
  const [run, messages, reports, memories] = await Promise.all([
    pool.query("SELECT status FROM research_runs WHERE id=$1", [runId]),
    pool.query("SELECT count(*)::int AS count FROM messages WHERE run_id=$1", [runId]),
    pool.query("SELECT count(*)::int AS count FROM research_reports WHERE run_id=$1", [runId]),
    pool.query("SELECT count(*)::int AS count FROM memory_records WHERE source_run_id=$1", [runId]),
  ]);
  if (run.rows[0]?.status !== "running" || messages.rows[0]?.count !== 0 || reports.rows[0]?.count !== 0 || memories.rows[0]?.count !== 0) throw new Error("failed publication was not rolled back atomically");
}

function researchMemory(tenantId, runId, content) {
  return {
    scope: "research", tenantId, userId: null, conversationId: null, visibility: "organization",
    content, sourceRunId: runId, expiresAt: null, retentionPolicy: "organization_default",
    metadata: { researchMemoryVersion: 1, question: "Verify publication", entities: [], tickers: [], asOfDates: [], evidenceIds: [], claimCount: 0, publishedAt: new Date().toISOString() },
  };
}

async function expectForeignKeyViolation(operation, label) {
  try {
    await operation();
  } catch (error) {
    if (error && typeof error === "object" && error.code === "23503") return;
    throw error;
  }
  throw new Error(`${label} unexpectedly bypassed tenant foreign-key protection`);
}
