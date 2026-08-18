import { randomUUID } from "node:crypto";
import { MemoryRecordSchema, type MemoryRecord } from "@research/contracts";
import type { ConfirmedPreferenceStore, ExpiredMemoryReader, MemoryQuery, MemoryStore, NewMemoryRecord, SqlClient } from "./types.js";

type MemoryRow = Record<string, unknown>;

export class PostgresMemoryStore implements MemoryStore, ExpiredMemoryReader, ConfirmedPreferenceStore {
  constructor(private readonly client: SqlClient) {}

  async save(record: NewMemoryRecord): Promise<MemoryRecord> {
    const item = MemoryRecordSchema.parse({ ...record, id: record.id ?? randomUUID() });
    const result = await this.client.query<MemoryRow>(
      `INSERT INTO memory_records (id, organization_id, user_id, conversation_id, scope, visibility, content, source_run_id, expires_at, retention_policy, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [item.id, item.tenantId, item.userId, item.conversationId, item.scope, item.visibility, item.content, item.sourceRunId, item.expiresAt, item.retentionPolicy, item.metadata],
    );
    return toMemory(result.rows[0]);
  }

  /** Atomic per-user preference replacement backed by migration 0008. */
  async upsertConfirmedPreference(record: NewMemoryRecord): Promise<MemoryRecord> {
    const item = MemoryRecordSchema.parse({ ...record, id: record.id ?? randomUUID() });
    const preferenceKey = activePreferenceKey(item);
    if (!preferenceKey) throw new Error("confirmed preference requires a stable preference key");
    const result = await this.client.query<MemoryRow>(
      `INSERT INTO memory_records (id, organization_id, user_id, conversation_id, scope, visibility, content, source_run_id, expires_at, retention_policy, metadata, preference_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (organization_id, user_id, preference_key) WHERE preference_key IS NOT NULL
       DO UPDATE SET content = EXCLUDED.content, source_run_id = EXCLUDED.source_run_id, expires_at = EXCLUDED.expires_at, retention_policy = EXCLUDED.retention_policy, metadata = EXCLUDED.metadata
       RETURNING *`,
      [item.id, item.tenantId, item.userId, item.conversationId, item.scope, item.visibility, item.content, item.sourceRunId, item.expiresAt, item.retentionPolicy, item.metadata, preferenceKey],
    );
    return toMemory(result.rows[0]);
  }

  async get(id: string, tenantId: string): Promise<MemoryRecord | undefined> {
    const result = await this.client.query<MemoryRow>("SELECT * FROM memory_records WHERE id = $1 AND organization_id = $2", [id, tenantId]);
    return result.rows[0] ? toMemory(result.rows[0]) : undefined;
  }

  async retrieve(query: MemoryQuery): Promise<MemoryRecord[]> {
    const values: unknown[] = [query.tenantId];
    const clauses = ["organization_id = $1", "(expires_at IS NULL OR expires_at > now())"];
    if (query.userId) { values.push(query.userId); clauses.push(`(user_id = $${values.length} OR visibility = 'organization')`); }
    else clauses.push("visibility = 'organization'");
    if (query.scopes?.length) { values.push(query.scopes); clauses.push(`scope = ANY($${values.length}::text[])`); }
    if (!query.conversationId) clauses.push("scope <> 'short_term'");
    if (query.conversationId) { values.push(query.conversationId); clauses.push(`conversation_id = $${values.length}`); }
    if (query.text) { values.push(`%${query.text}%`); clauses.push(`content ILIKE $${values.length}`); }
    if (query.researchTerms?.length) {
      values.push(query.researchTerms.slice(0, 10));
      clauses.push(`(COALESCE(metadata -> 'entities', '[]'::jsonb) ?| $${values.length}::text[] OR COALESCE(metadata -> 'tickers', '[]'::jsonb) ?| $${values.length}::text[])`);
    }
    values.push(Math.min(query.limit ?? 20, 100));
    const result = await this.client.query<MemoryRow>(`SELECT * FROM memory_records WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT $${values.length}`, values);
    return result.rows.map(toMemory);
  }

  async update(id: string, tenantId: string, patch: Partial<Pick<MemoryRecord, "content" | "metadata" | "expiresAt">>): Promise<MemoryRecord> {
    const assignments: string[] = [];
    const values: unknown[] = [id, tenantId];
    if (Object.hasOwn(patch, "content")) { values.push(patch.content); assignments.push(`content = $${values.length}`); }
    if (Object.hasOwn(patch, "metadata")) { values.push(patch.metadata); assignments.push(`metadata = $${values.length}`); }
    if (Object.hasOwn(patch, "expiresAt")) { values.push(patch.expiresAt); assignments.push(`expires_at = $${values.length}`); }
    if (assignments.length === 0) return this.requireMemory(id, tenantId);
    const result = await this.client.query<MemoryRow>(
      `UPDATE memory_records SET ${assignments.join(", ")}
       WHERE id = $1 AND organization_id = $2 RETURNING *`,
      values,
    );
    if (!result.rows[0]) throw new Error("memory record not found");
    return toMemory(result.rows[0]);
  }

  private async requireMemory(id: string, tenantId: string): Promise<MemoryRecord> {
    const item = await this.get(id, tenantId);
    if (!item) throw new Error("memory record not found");
    return item;
  }

  async delete(id: string, tenantId: string, _actorUserId?: string): Promise<void> {
    const result = await this.client.query("DELETE FROM memory_records WHERE id = $1 AND organization_id = $2", [id, tenantId]);
    if (result.rowCount !== 1) throw new Error("memory record not found");
  }

  async listExpired(limit: number, now = new Date()): Promise<MemoryRecord[]> {
    const result = await this.client.query<MemoryRow>(
      `SELECT * FROM memory_records
       WHERE expires_at IS NOT NULL AND expires_at <= $1 AND retention_policy <> 'legal_hold'
       ORDER BY expires_at ASC LIMIT $2`,
      [now.toISOString(), Math.max(1, Math.min(limit, 1_000))],
    );
    return result.rows.map(toMemory);
  }
}

function toMemory(row: MemoryRow): MemoryRecord {
  return MemoryRecordSchema.parse({
    id: row.id, tenantId: row.organization_id, userId: row.user_id, conversationId: row.conversation_id, scope: row.scope, visibility: row.visibility,
    content: row.content, sourceRunId: row.source_run_id, expiresAt: asIso(row.expires_at), retentionPolicy: row.retention_policy, metadata: row.metadata ?? {},
  });
}

function asIso(value: unknown): string | null {
  return value == null ? null : new Date(String(value)).toISOString();
}

function activePreferenceKey(record: MemoryRecord): string | undefined {
  return record.scope === "long_term" && record.visibility === "private" && record.userId !== null && record.retentionPolicy === "user_managed" && record.metadata.userConfirmed === true && typeof record.metadata.preferenceKey === "string"
    ? record.metadata.preferenceKey
    : undefined;
}
