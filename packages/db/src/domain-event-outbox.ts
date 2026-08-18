import { DomainEventSchema, type DomainEvent } from "@research/contracts";
import type { OutboxSqlClient } from "./outbox.js";

export interface DomainEventOutboxStore {
  enqueue(event: DomainEvent): Promise<void>;
  claimBatch(limit: number, lockSeconds?: number): Promise<DomainEvent[]>;
  markPublished(id: string): Promise<void>;
  release(id: string): Promise<void>;
}

/** Content-free operational snapshot for monitoring EventBridge delivery lag. */
export interface DomainEventOutboxHealth {
  pending: number;
  oldestPendingAgeSeconds: number;
  maxAttempts: number;
}

/** PostgreSQL transactional outbox for metadata-only EventBridge notifications. */
export class PostgresDomainEventOutboxStore implements DomainEventOutboxStore {
  constructor(private readonly client: OutboxSqlClient) {}

  async enqueue(event: DomainEvent): Promise<void> {
    const parsed = DomainEventSchema.parse(event);
    await this.client.query(
      "INSERT INTO domain_event_outbox (id, event_type, aggregate_id, organization_id, payload, occurred_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING",
      [parsed.id, parsed.type, parsed.aggregateId, parsed.tenantId, parsed, parsed.occurredAt],
    );
  }

  async claimBatch(limit: number, lockSeconds = 60): Promise<DomainEvent[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const boundedLockSeconds = Math.max(5, Math.min(lockSeconds, 900));
    const result = await this.client.query<{ payload: unknown }>(
      `WITH candidates AS (
         SELECT id FROM domain_event_outbox
         WHERE published_at IS NULL AND (locked_until IS NULL OR locked_until < now())
         ORDER BY occurred_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE domain_event_outbox AS event
       SET attempts = event.attempts + 1, locked_until = now() + ($2::text || ' seconds')::interval
       FROM candidates
       WHERE event.id = candidates.id
       RETURNING event.payload`,
      [boundedLimit, boundedLockSeconds],
    );
    return result.rows.map((row) => DomainEventSchema.parse(row.payload));
  }

  async markPublished(id: string): Promise<void> {
    await this.client.query("UPDATE domain_event_outbox SET published_at = now(), locked_until = NULL WHERE id = $1", [id]);
  }

  async release(id: string): Promise<void> {
    await this.client.query("UPDATE domain_event_outbox SET locked_until = NULL WHERE id = $1 AND published_at IS NULL", [id]);
  }

  /**
   * Never returns event payloads: monitoring must not turn the outbox into an
   * alternate path for questions, prompts, claims, or licensed evidence.
   */
  async getHealth(): Promise<DomainEventOutboxHealth> {
    const result = await this.client.query<{ pending: string | number; oldest_pending_age_seconds: string | number; max_attempts: string | number }>(
      `SELECT
         count(*) AS pending,
         coalesce(extract(epoch FROM now() - min(occurred_at)), 0) AS oldest_pending_age_seconds,
         coalesce(max(attempts), 0) AS max_attempts
       FROM domain_event_outbox
       WHERE published_at IS NULL`,
    );
    const row = result.rows[0] ?? { pending: 0, oldest_pending_age_seconds: 0, max_attempts: 0 };
    return {
      pending: Number(row.pending),
      oldestPendingAgeSeconds: Math.max(0, Math.floor(Number(row.oldest_pending_age_seconds))),
      maxAttempts: Number(row.max_attempts),
    };
  }
}
