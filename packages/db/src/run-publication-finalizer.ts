import { randomUUID } from "node:crypto";
import { DomainEventSchema, ResearchMemoryPublicationSchema, RunEventSchema, type ResearchMemoryPublication, type ResearchReport, type ResearchScope, type RunEvent } from "@research/contracts";

export interface ResearchRunPublication {
  runId: string;
  ownerUserId: string;
  status: "completed" | "abstained";
  answer: string;
  report?: Pick<ResearchReport, "markdown" | "citations">;
  researchMemory?: ResearchMemoryPublication;
  /** Persisted in the same commit as the report/message/run transition. */
  terminalEvent: Extract<RunEvent, { type: "completed" | "abstained" }>;
}

export interface ResearchRunPublicationFinalizer {
  finalize(scope: ResearchScope, publication: ResearchRunPublication): Promise<void>;
}

interface SqlClient {
  query<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

/**
 * Atomically creates the public report (when approved), appends the assistant
 * message, research memory, and transitions the parent run. Evidence has already been stored
 * as an auditable input; this boundary prevents a visible conclusion from
 * being separated from its report or terminal run state.
 */
export class PostgresResearchRunPublicationFinalizer implements ResearchRunPublicationFinalizer {
  constructor(private readonly client: SqlClient) {}

  async finalize(scope: ResearchScope, publication: ResearchRunPublication): Promise<void> {
    if (publication.status === "completed" && !publication.report) throw new Error("completed research run has no controlled report");
    if (publication.status === "completed" && !publication.researchMemory) throw new Error("completed research run has no publication-bound research memory");
    const researchMemory = publication.researchMemory ? ResearchMemoryPublicationSchema.parse(publication.researchMemory) : undefined;
    if (researchMemory && (researchMemory.tenantId !== scope.organizationId || researchMemory.sourceRunId !== publication.runId || researchMemory.content !== publication.answer)) {
      throw new Error("research memory candidate is not bound to this publication");
    }
    const terminalEvent = RunEventSchema.parse(publication.terminalEvent);
    if (terminalEvent.runId !== publication.runId || terminalEvent.type !== publication.status) throw new Error("terminal event does not match publication");
    const lifecycleEvent = DomainEventSchema.parse({
      id: randomUUID(), type: "research.run.lifecycle", tenantId: scope.organizationId, aggregateId: publication.runId, occurredAt: terminalEvent.at,
      data: { runId: publication.runId, sequence: terminalEvent.sequence, eventType: terminalEvent.type },
    });
    const result = await this.client.query<{ finalized: boolean }>(
      `WITH authorized_run AS (
         SELECT r.id, c.id AS conversation_id
         FROM research_runs r JOIN conversations c ON c.id = r.conversation_id
         WHERE r.id=$1 AND r.organization_id=$2 AND (c.created_by=$3 OR $4::boolean)
           AND c.created_by=$5 AND r.status='running'
       ), created_report AS (
         INSERT INTO research_reports (id, run_id, organization_id, version, markdown, citations)
         SELECT $8, ar.id, $2,
           COALESCE((SELECT max(version) FROM research_reports WHERE run_id=ar.id AND organization_id=$2), 0) + 1,
           $9, $10
         FROM authorized_run ar WHERE $6='completed'
         RETURNING run_id
       ), created_research_memory AS (
         INSERT INTO memory_records (id, organization_id, user_id, conversation_id, scope, visibility, content, source_run_id, expires_at, retention_policy, metadata)
         SELECT $19, $2, NULL, NULL, 'research', 'organization', $20, $1, NULL, 'organization_default', $21::jsonb
         FROM created_report WHERE $6='completed'
         RETURNING id
       ), finished_run AS (
         UPDATE research_runs r
         SET status=$6, state=jsonb_set(r.state, '{answer}', to_jsonb($7::text), true), finished_at=now()
         FROM authorized_run ar
         WHERE r.id=ar.id AND ($6 <> 'completed' OR (EXISTS (SELECT 1 FROM created_report) AND EXISTS (SELECT 1 FROM created_research_memory)))
         RETURNING r.id, ar.conversation_id
       ), updated_conversation AS (
         UPDATE conversations c SET updated_at=now()
         FROM finished_run fr WHERE c.id=fr.conversation_id
         RETURNING c.id
       ), created_message AS (
         INSERT INTO messages (conversation_id, organization_id, role, content, run_id)
         SELECT conversation_id, $2, 'assistant', $7, id FROM finished_run
         WHERE EXISTS (SELECT 1 FROM updated_conversation)
         RETURNING id
       ), terminal_run_event AS (
         INSERT INTO run_events (id, run_id, organization_id, sequence, type, payload)
         SELECT $11, $1, $2, $12, $13, $14 FROM finished_run
         RETURNING run_id
       ), terminal_lifecycle_event AS (
         INSERT INTO domain_event_outbox (id, event_type, aggregate_id, organization_id, payload, occurred_at)
         SELECT $15, $16, $1, $2, $17, $18 FROM terminal_run_event
         RETURNING id
       )
       SELECT EXISTS(SELECT 1 FROM created_message) AND EXISTS(SELECT 1 FROM terminal_lifecycle_event) AS finalized`,
      [
        publication.runId, scope.organizationId, scope.userId, scope.roles.includes("admin"), publication.ownerUserId,
        publication.status, publication.answer, randomUUID(), publication.report?.markdown ?? null, publication.report?.citations ?? [],
        terminalEvent.id, terminalEvent.sequence, terminalEvent.type, terminalEvent.payload,
        lifecycleEvent.id, lifecycleEvent.type, lifecycleEvent, lifecycleEvent.occurredAt,
        researchMemory ? randomUUID() : null, researchMemory?.content ?? null, researchMemory?.metadata ?? {},
      ],
    );
    if (result.rows[0]?.finalized !== true) throw new Error("research run is no longer active or authorized for publication");
  }
}
