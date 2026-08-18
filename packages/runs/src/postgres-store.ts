import { randomUUID } from "node:crypto";
import { DomainEventSchema, RunEventSchema, StoredRunSchema } from "@research/contracts";
import type { ResearchScope, RunEvent } from "@research/contracts";
import type { RunControlResult, RunStore, SqlClient, StoredRun } from "./types.js";

export class PostgresRunStore implements RunStore {
  constructor(private readonly client: SqlClient) {}
  async create(run: Omit<StoredRun, "events" | "status" | "answer">): Promise<void> {
    const validated = StoredRunSchema.parse({ ...run, status: "queued", events: [] });
    const result = await this.client.query(
      `INSERT INTO research_runs (id, conversation_id, organization_id, status, question, budget, state)
       SELECT $1, c.id, $3, 'queued', $4, $5, $6 FROM conversations c
       WHERE c.id = $2 AND c.organization_id = $3 AND c.created_by = $7`,
      [validated.id, validated.conversationId, validated.organizationId, validated.question, validated.budget, {}, validated.createdBy],
    );
    if (result.rowCount !== 1) throw new Error("conversation not found");
  }
  async claim(scope: ResearchScope, runId: string): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE research_runs
       SET status='running', state=jsonb_set(state, '{leaseExpiresAt}', to_jsonb((now() + interval '6 minutes')::text), true)
       FROM conversations c WHERE research_runs.id=$1 AND research_runs.organization_id=$2 AND research_runs.conversation_id=c.id
         AND (c.created_by=$3 OR $4::boolean) AND research_runs.status='queued'`,
      [runId, scope.organizationId, scope.userId, scope.roles.includes("admin")],
    );
    return result.rowCount === 1;
  }
  async requeueForRecovery(scope: ResearchScope, runId: string): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE research_runs SET status='queued', state=jsonb_set(state, '{recoveryAttempts}', '1'::jsonb, true), finished_at=NULL
       FROM conversations c WHERE research_runs.id=$1 AND research_runs.organization_id=$2 AND research_runs.conversation_id=c.id
         AND (c.created_by=$3 OR $4::boolean) AND research_runs.status='failed' AND COALESCE((research_runs.state->>'recoveryAttempts')::int, 0) < 1`,
      [runId, scope.organizationId, scope.userId, scope.roles.includes("admin")],
    );
    return result.rowCount === 1;
  }
  async expireStaleLease(scope: ResearchScope, runId: string): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE research_runs
       SET status='failed', state=jsonb_set(state, '{leaseExpiredAt}', to_jsonb(now()::text), true), finished_at=now()
       FROM conversations c WHERE research_runs.id=$1 AND research_runs.organization_id=$2 AND research_runs.conversation_id=c.id
         AND (c.created_by=$3 OR $4::boolean) AND research_runs.status='running'
         AND COALESCE(NULLIF(research_runs.state->>'leaseExpiresAt', '')::timestamptz, research_runs.created_at + interval '6 minutes') <= now()`,
      [runId, scope.organizationId, scope.userId, scope.roles.includes("admin")],
    );
    return result.rowCount === 1;
  }
  async pause(scope: ResearchScope, runId: string, event: Extract<RunEvent, { type: "run_paused" }>): Promise<RunControlResult> {
    const validatedEvent = RunEventSchema.parse(event);
    if (validatedEvent.runId !== runId) throw new Error("pause event run ID does not match target run");
    const lifecycleEvent = lifecycleEventFor(scope, validatedEvent);
    const result = await this.client.query<{ outcome: RunControlResult }>(
      `WITH authorized_run AS (
         SELECT r.id, r.organization_id FROM research_runs r JOIN conversations c ON c.id = r.conversation_id
         WHERE r.id=$1 AND r.organization_id=$2 AND (c.created_by=$3 OR $4::boolean)
       ), transitioned AS (
         UPDATE research_runs r SET status='paused', state=r.state - 'leaseExpiresAt'
         FROM authorized_run a WHERE r.id=a.id AND r.organization_id=a.organization_id AND r.status='queued'
           AND $6 = COALESCE((SELECT max(sequence) + 1 FROM run_events WHERE run_id=r.id AND organization_id=r.organization_id), 1)
         RETURNING r.id, r.organization_id
       ), written_event AS (
         INSERT INTO run_events (id, run_id, organization_id, sequence, type, payload)
         SELECT $5, t.id, t.organization_id, $6, $7, $8 FROM transitioned t
         RETURNING run_id, organization_id
       ), written_lifecycle AS (
         INSERT INTO domain_event_outbox (id, event_type, aggregate_id, organization_id, payload, occurred_at)
         SELECT $9, $10, e.run_id, e.organization_id, $11, $12 FROM written_event e
         RETURNING id
       )
       SELECT CASE
         WHEN EXISTS(SELECT 1 FROM written_lifecycle) THEN 'paused'
         WHEN EXISTS(SELECT 1 FROM authorized_run) THEN 'not_allowed'
         ELSE 'not_found'
       END AS outcome`,
      [runId, scope.organizationId, scope.userId, scope.roles.includes("admin"), validatedEvent.id, validatedEvent.sequence, validatedEvent.type, validatedEvent.payload, lifecycleEvent.id, lifecycleEvent.type, lifecycleEvent, lifecycleEvent.occurredAt],
    );
    return result.rows[0]?.outcome ?? "not_found";
  }
  async resume(scope: ResearchScope, runId: string, event: Extract<RunEvent, { type: "run_resumed" }>): Promise<RunControlResult> {
    const validatedEvent = RunEventSchema.parse(event);
    if (validatedEvent.runId !== runId) throw new Error("resume event run ID does not match target run");
    const lifecycleEvent = lifecycleEventFor(scope, validatedEvent);
    const result = await this.client.query<{ outcome: RunControlResult }>(
      `WITH authorized_run AS (
         SELECT r.id, r.organization_id, r.status, r.state FROM research_runs r JOIN conversations c ON c.id = r.conversation_id
         WHERE r.id=$1 AND r.organization_id=$2 AND (c.created_by=$3 OR $4::boolean)
       ), transitioned AS (
         UPDATE research_runs r SET status='queued', finished_at=NULL
         FROM authorized_run a WHERE r.id=a.id AND r.organization_id=a.organization_id
           AND r.status='paused' AND r.state ? 'command'
           AND $6 = COALESCE((SELECT max(sequence) + 1 FROM run_events WHERE run_id=r.id AND organization_id=r.organization_id), 1)
         RETURNING r.id, r.organization_id, r.state->'command' AS command
       ), written_event AS (
         INSERT INTO run_events (id, run_id, organization_id, sequence, type, payload)
         SELECT $5, t.id, t.organization_id, $6, $7, $8 FROM transitioned t
         RETURNING run_id, organization_id
       ), written_lifecycle AS (
         INSERT INTO domain_event_outbox (id, event_type, aggregate_id, organization_id, payload, occurred_at)
         SELECT $9, $10, e.run_id, e.organization_id, $11, $12 FROM written_event e
         RETURNING id
       ), written_outbox AS (
         INSERT INTO outbox_events (id, event_type, aggregate_id, organization_id, payload)
         SELECT $13, 'research_run_requested', t.id, t.organization_id, t.command FROM transitioned t
         WHERE EXISTS(SELECT 1 FROM written_lifecycle)
         RETURNING id
       )
       SELECT CASE
         WHEN EXISTS(SELECT 1 FROM written_outbox) THEN 'resumed'
         WHEN EXISTS(SELECT 1 FROM authorized_run WHERE status='paused' AND NOT (state ? 'command')) THEN 'command_missing'
         WHEN EXISTS(SELECT 1 FROM authorized_run) THEN 'not_allowed'
         ELSE 'not_found'
       END AS outcome`,
      [runId, scope.organizationId, scope.userId, scope.roles.includes("admin"), validatedEvent.id, validatedEvent.sequence, validatedEvent.type, validatedEvent.payload, lifecycleEvent.id, lifecycleEvent.type, lifecycleEvent, lifecycleEvent.occurredAt, randomUUID()],
    );
    return result.rows[0]?.outcome ?? "not_found";
  }
  async appendEvent(scope: ResearchScope, event: RunEvent): Promise<void> {
    const validatedEvent = RunEventSchema.parse(event);
    const lifecycleEvent = DomainEventSchema.parse({
      id: randomUUID(),
      type: "research.run.lifecycle",
      tenantId: scope.organizationId,
      aggregateId: validatedEvent.runId,
      occurredAt: validatedEvent.at,
      data: { runId: validatedEvent.runId, sequence: validatedEvent.sequence, eventType: validatedEvent.type },
    });
    const result = await this.client.query<{ appended: boolean }>(`WITH appended_run_event AS (
        INSERT INTO run_events (id, run_id, organization_id, sequence, type, payload)
        SELECT $1,$2,$6,$3,$4,$5 WHERE EXISTS (
          SELECT 1 FROM research_runs r JOIN conversations c ON c.id=r.conversation_id
          WHERE r.id=$2 AND r.organization_id=$6 AND (c.created_by=$7 OR $8::boolean)
        )
        RETURNING run_id
      ), appended_lifecycle_event AS (
        INSERT INTO domain_event_outbox (id, event_type, aggregate_id, organization_id, payload, occurred_at)
        SELECT $9,$10,$2,$6,$11,$12 FROM appended_run_event
        RETURNING id
      )
      SELECT EXISTS(SELECT 1 FROM appended_lifecycle_event) AS appended`, [
      validatedEvent.id, validatedEvent.runId, validatedEvent.sequence, validatedEvent.type, validatedEvent.payload,
      scope.organizationId, scope.userId, scope.roles.includes("admin"),
      lifecycleEvent.id, lifecycleEvent.type, lifecycleEvent, lifecycleEvent.occurredAt,
    ]);
    if (result.rows[0]?.appended !== true) throw new Error("run not found");
  }
  async finish(scope: ResearchScope, runId: string, status: StoredRun["status"], answer?: string): Promise<void> {
    const result = await this.client.query(`UPDATE research_runs SET status=$3, state=jsonb_set(state, '{answer}', to_jsonb($4::text), true), finished_at=now()
      FROM conversations c WHERE research_runs.id=$1 AND research_runs.organization_id=$2 AND research_runs.conversation_id=c.id
      AND (c.created_by=$5 OR $6::boolean) AND research_runs.status='running'`, [runId, scope.organizationId, status, answer ?? null, scope.userId, scope.roles.includes("admin")]);
    if (result.rowCount !== 1) throw new Error("run is no longer active");
  }
  async get(scope: ResearchScope, id: string): Promise<StoredRun | undefined> {
    const result = await this.client.query<Record<string, unknown>>(`SELECT r.*, c.created_by FROM research_runs r JOIN conversations c ON c.id=r.conversation_id
      WHERE r.id=$1 AND r.organization_id=$2 AND (c.created_by=$3 OR $4::boolean)`, [id, scope.organizationId, scope.userId, scope.roles.includes("admin")]);
    const row = result.rows[0]; if (!row) return undefined;
    const events = await this.client.query<Record<string, unknown>>(`SELECT * FROM run_events WHERE run_id=$1 AND organization_id=$2 ORDER BY sequence`, [id, scope.organizationId]);
    const answer = storedAnswer(row.state);
    return StoredRunSchema.parse({
      id: row.id,
      organizationId: row.organization_id,
      conversationId: row.conversation_id,
      createdBy: row.created_by,
      question: row.question,
      budget: row.budget,
      status: row.status,
      ...(answer === undefined ? {} : { answer }),
      events: events.rows.map(toEvent),
    });
  }
}
function toEvent(row: Record<string, unknown>): RunEvent {
  return RunEventSchema.parse({ id: String(row.id), runId: String(row.run_id), sequence: Number(row.sequence), type: row.type, at: new Date(String(row.created_at)).toISOString(), payload: row.payload });
}

function storedAnswer(state: unknown): string | undefined {
  if (!state || typeof state !== "object" || Array.isArray(state)) return undefined;
  const answer = (state as Record<string, unknown>).answer;
  return typeof answer === "string" ? answer : undefined;
}

/** Keeps run-control events in the same metadata-only lifecycle stream as runtime events. */
function lifecycleEventFor(scope: ResearchScope, event: RunEvent) {
  return DomainEventSchema.parse({
    id: randomUUID(),
    type: "research.run.lifecycle",
    tenantId: scope.organizationId,
    aggregateId: event.runId,
    occurredAt: event.at,
    data: { runId: event.runId, sequence: event.sequence, eventType: event.type },
  });
}
