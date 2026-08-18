import { randomUUID } from "node:crypto";
import { DomainEventSchema } from "@research/contracts";
interface SqlClient {
  query<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

export interface ModelInvocationAudit {
  runId: string;
  organizationId: string;
  modelId: string;
  operation: string;
  invokedAt: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
}

export interface ModelAuditSink { write(event: ModelInvocationAudit): Promise<void>; }

/** Durable, content-free accounting ledger for Bedrock generation calls. */
export class PostgresModelAuditSink implements ModelAuditSink {
  constructor(private readonly client: SqlClient) {}

  async write(event: ModelInvocationAudit): Promise<void> {
    const domainEvent = DomainEventSchema.parse({
      id: randomUUID(), type: "audit.model_invocation.recorded", tenantId: event.organizationId, aggregateId: event.runId, occurredAt: event.invokedAt,
      data: { runId: event.runId, modelId: event.modelId, operation: event.operation, inputTokens: event.inputTokens, outputTokens: event.outputTokens, totalTokens: event.totalTokens, estimatedCostUsd: event.estimatedCostUsd },
    });
    await this.client.query(
      `WITH audit AS (
         INSERT INTO model_invocations (run_id, organization_id, model_id, operation, invoked_at, input_tokens, output_tokens, total_tokens, estimated_cost_usd)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING run_id
       )
       INSERT INTO domain_event_outbox (id, event_type, aggregate_id, organization_id, payload, occurred_at)
       SELECT $10,$11,$1,$2,$12,$13 FROM audit`,
      [event.runId, event.organizationId, event.modelId, event.operation, event.invokedAt, event.inputTokens, event.outputTokens, event.totalTokens, event.estimatedCostUsd, domainEvent.id, domainEvent.type, domainEvent, domainEvent.occurredAt],
    );
  }
}
