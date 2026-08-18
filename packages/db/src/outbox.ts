import { randomUUID } from "node:crypto";
import { OutboxEventSchema, type OutboxEvent, type ResearchRunCommand } from "@research/contracts";

export interface OutboxSqlClient {
  query<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

export interface OutboxStore {
  enqueueResearchRun(command: ResearchRunCommand): Promise<void>;
  claimBatch(limit: number, lockSeconds?: number): Promise<OutboxEvent[]>;
  markPublished(id: string): Promise<void>;
  release(id: string): Promise<void>;
}

/** PostgreSQL transactional-outbox repository. Claiming uses SKIP LOCKED to support multiple publishers. */
export class PostgresOutboxStore implements OutboxStore {
  constructor(private readonly client: OutboxSqlClient) {}

  async enqueueResearchRun(command: ResearchRunCommand): Promise<void> {
    const event = OutboxEventSchema.parse({ id: randomUUID(), type: "research_run_requested", payload: command, occurredAt: new Date().toISOString(), attempts: 0 });
    await this.client.query(
      "INSERT INTO outbox_events (id, event_type, aggregate_id, organization_id, payload) VALUES ($1,$2,$3,$4,$5)",
      [event.id, event.type, command.runId, command.scope.organizationId, event.payload],
    );
  }

  async claimBatch(limit: number, lockSeconds = 60): Promise<OutboxEvent[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const boundedLockSeconds = Math.max(5, Math.min(lockSeconds, 900));
    const result = await this.client.query<Record<string, unknown>>(
      `WITH candidates AS (
         SELECT id FROM outbox_events
         WHERE published_at IS NULL AND (locked_until IS NULL OR locked_until < now())
         ORDER BY occurred_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE outbox_events AS event
       SET attempts = event.attempts + 1, locked_until = now() + ($2::text || ' seconds')::interval
       FROM candidates
       WHERE event.id = candidates.id
       RETURNING event.*`,
      [boundedLimit, boundedLockSeconds],
    );
    return result.rows.map(toOutboxEvent);
  }

  async markPublished(id: string): Promise<void> {
    await this.client.query("UPDATE outbox_events SET published_at = now(), locked_until = NULL WHERE id = $1", [id]);
  }

  async release(id: string): Promise<void> {
    await this.client.query("UPDATE outbox_events SET locked_until = NULL WHERE id = $1 AND published_at IS NULL", [id]);
  }
}

export class InMemoryOutboxStore implements OutboxStore {
  private readonly pending = new Map<string, OutboxEvent>();

  async enqueueResearchRun(command: ResearchRunCommand): Promise<void> {
    const event = OutboxEventSchema.parse({ id: randomUUID(), type: "research_run_requested", payload: command, occurredAt: new Date().toISOString(), attempts: 0 });
    this.pending.set(event.id, event);
  }

  async claimBatch(limit: number): Promise<OutboxEvent[]> {
    const events = [...this.pending.values()].slice(0, Math.max(1, Math.min(limit, 100)));
    for (const event of events) this.pending.set(event.id, { ...event, attempts: event.attempts + 1 });
    return events.map((event) => ({ ...event, attempts: event.attempts + 1 }));
  }

  async markPublished(id: string): Promise<void> { this.pending.delete(id); }
  async release(_id: string): Promise<void> { /* Entries remain available for the next claim. */ }
}

function toOutboxEvent(row: Record<string, unknown>): OutboxEvent {
  return OutboxEventSchema.parse({
    id: row.id, type: row.event_type, payload: row.payload,
    occurredAt: new Date(String(row.occurred_at)).toISOString(), attempts: Number(row.attempts),
  });
}
