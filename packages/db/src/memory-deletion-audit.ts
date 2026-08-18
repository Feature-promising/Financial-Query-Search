import type { MemoryDeletionAudit } from "@research/contracts";

interface SqlClient {
  query<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

/** Writes content-free, append-only records for coordinated memory deletion. */
export class PostgresMemoryDeletionAuditSink {
  constructor(private readonly client: SqlClient) {}

  async append(event: MemoryDeletionAudit): Promise<void> {
    await this.client.query(
      `INSERT INTO memory_deletion_audit_events
       (id, organization_id, memory_id, actor_user_id, memory_scope, source_run_id, evidence_ids, event_type, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [event.id, event.tenantId, event.memoryId, event.actorUserId, event.memoryScope, event.sourceRunId, event.evidenceIds, event.eventType, event.occurredAt],
    );
  }
}
