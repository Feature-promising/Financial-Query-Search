import { randomUUID } from "node:crypto";
import { MemoryRecordSchema, type MemoryRecord } from "@research/contracts";
import type { ConfirmedPreferenceStore, ExpiredMemoryReader, MemoryQuery, MemoryStore, NewMemoryRecord } from "./types.js";

export class InMemoryStore implements MemoryStore, ExpiredMemoryReader, ConfirmedPreferenceStore {
  private readonly records = new Map<string, MemoryRecord>();
  async save(record: NewMemoryRecord): Promise<MemoryRecord> {
    const item = MemoryRecordSchema.parse({ ...record, id: record.id ?? randomUUID() });
    this.records.set(item.id, item); return item;
  }
  async upsertConfirmedPreference(record: NewMemoryRecord): Promise<MemoryRecord> {
    const item = MemoryRecordSchema.parse({ ...record, id: record.id ?? randomUUID() });
    const key = activePreferenceKey(item);
    if (!key) throw new Error("confirmed preference requires a stable preference key");
    const existing = [...this.records.values()].find((candidate) => candidate.tenantId === item.tenantId && candidate.userId === item.userId && activePreferenceKey(candidate) === key);
    const saved = existing ? MemoryRecordSchema.parse({ ...item, id: existing.id }) : item;
    this.records.set(saved.id, saved);
    return saved;
  }
  async get(id: string, tenantId: string): Promise<MemoryRecord | undefined> {
    const item = this.records.get(id);
    return item?.tenantId === tenantId ? item : undefined;
  }
  async retrieve(query: MemoryQuery): Promise<MemoryRecord[]> {
    const now = new Date().toISOString(); const needle = query.text?.toLocaleLowerCase();
    return [...this.records.values()]
      .filter((item) => item.tenantId === query.tenantId)
      .filter((item) => !query.userId || item.userId === query.userId || item.visibility === "organization")
      .filter((item) => !query.scopes || query.scopes.includes(item.scope))
      .filter((item) => query.conversationId || item.scope !== "short_term")
      .filter((item) => !query.conversationId || item.conversationId === query.conversationId)
      .filter((item) => !item.expiresAt || item.expiresAt > now)
      .filter((item) => !needle || item.content.toLocaleLowerCase().includes(needle))
      .filter((item) => !query.researchTerms?.length || item.scope !== "research" || researchMetadataMatches(item.metadata, query.researchTerms))
      .slice(0, query.limit ?? 20);
  }
  async update(id: string, tenantId: string, patch: Partial<Pick<MemoryRecord, "content" | "metadata" | "expiresAt">>): Promise<MemoryRecord> {
    const current = this.records.get(id);
    if (!current || current.tenantId !== tenantId) throw new Error("memory record not found");
    const item = MemoryRecordSchema.parse({ ...current, ...patch }); this.records.set(id, item); return item;
  }
  async delete(id: string, tenantId: string, _actorUserId?: string): Promise<void> {
    const current = this.records.get(id);
    if (!current || current.tenantId !== tenantId) throw new Error("memory record not found");
    this.records.delete(id);
  }
  async listExpired(limit: number, now = new Date()): Promise<MemoryRecord[]> {
    const threshold = now.getTime();
    return [...this.records.values()]
      .filter((item) => item.retentionPolicy !== "legal_hold" && item.expiresAt !== null && new Date(item.expiresAt).getTime() <= threshold)
      .sort((left, right) => left.expiresAt!.localeCompare(right.expiresAt!))
      .slice(0, Math.max(1, Math.min(limit, 1_000)));
  }
}

function activePreferenceKey(record: MemoryRecord): string | undefined {
  return record.scope === "long_term" && record.visibility === "private" && record.retentionPolicy === "user_managed" && record.metadata.userConfirmed === true && typeof record.metadata.preferenceKey === "string"
    ? record.metadata.preferenceKey
    : undefined;
}

function researchMetadataMatches(metadata: Record<string, unknown>, terms: string[]): boolean {
  const values = [metadata.entities, metadata.tickers]
    .flatMap((value) => Array.isArray(value) ? value : [])
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLocaleLowerCase());
  return terms.some((term) => values.includes(term.toLocaleLowerCase()));
}
