import { randomUUID } from "node:crypto";
import { DomainEventSchema } from "@research/contracts";
import type { ToolInvocationAudit, ToolAuditSink } from "./types.js";

export interface SqlClient {
  query<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

/** Durable tool audit sink. Input/output values remain hashed; raw research content is not logged here. */
export class PostgresToolAuditSink implements ToolAuditSink {
  constructor(private readonly client: SqlClient) {}

  async write(event: ToolInvocationAudit): Promise<void> {
    const domainEvent = DomainEventSchema.parse({
      id: randomUUID(), type: "audit.tool_invocation.recorded", tenantId: event.organizationId, aggregateId: event.runId, occurredAt: event.at,
      data: { runId: event.runId, toolId: event.toolId, idempotencyKey: event.idempotencyKey, ok: event.ok, failureCode: event.failureCode ?? null, estimatedCostUsd: event.estimatedCostUsd, durationMs: event.durationMs },
    });
    await this.client.query(
      `WITH audit AS (
         INSERT INTO tool_invocations (run_id, organization_id, tool_id, idempotency_key, invoked_at, ok, input_hash, output_hash, evidence_ids, estimated_cost_usd, duration_ms, failure_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING run_id
       )
       INSERT INTO domain_event_outbox (id, event_type, aggregate_id, organization_id, payload, occurred_at)
       SELECT $13,$14,$1,$2,$15,$16 FROM audit`,
      [event.runId, event.organizationId, event.toolId, event.idempotencyKey, event.at, event.ok, event.inputHash, event.outputHash ?? null, event.evidenceIds, event.estimatedCostUsd, event.durationMs, event.failureCode ?? null, domainEvent.id, domainEvent.type, domainEvent, domainEvent.occurredAt],
    );
  }
}
