import type { MemoryDeletionAudit, MemoryRecord } from "@research/contracts";

export type NewMemoryRecord = Omit<MemoryRecord, "id" | "conversationId" | "retentionPolicy"> & {
  id?: string;
  conversationId?: string | null;
  retentionPolicy?: MemoryRecord["retentionPolicy"];
};

export interface MemoryQuery {
  tenantId: string;
  userId?: string;
  scopes?: MemoryRecord["scope"][];
  /** Required whenever reading short-term memory, preventing cross-session context leakage. */
  conversationId?: string;
  text?: string;
  /** Exact entity/ticker leads for research assets; never an arbitrary metadata query. */
  researchTerms?: string[];
  limit?: number;
}

export interface MemoryStore {
  save(record: NewMemoryRecord): Promise<MemoryRecord>;
  get(id: string, tenantId: string): Promise<MemoryRecord | undefined>;
  retrieve(query: MemoryQuery): Promise<MemoryRecord[]>;
  update(id: string, tenantId: string, patch: Partial<Pick<MemoryRecord, "content" | "metadata" | "expiresAt">>): Promise<MemoryRecord>;
  delete(id: string, tenantId: string, actorUserId?: string): Promise<void>;
}

/** Stronger write contract for explicitly confirmed user preferences. */
export interface ConfirmedPreferenceStore {
  upsertConfirmedPreference(record: NewMemoryRecord): Promise<MemoryRecord>;
}

export function isConfirmedPreferenceStore(store: MemoryStore): store is MemoryStore & ConfirmedPreferenceStore {
  return "upsertConfirmedPreference" in store && typeof (store as Partial<ConfirmedPreferenceStore>).upsertConfirmedPreference === "function";
}

/** Bounded maintenance query; legal-hold records are never eligible. */
export interface ExpiredMemoryReader {
  listExpired(limit: number, now?: Date): Promise<MemoryRecord[]>;
}

/** Audit storage is intentionally append-only and contains no memory content. */
export interface MemoryDeletionAuditSink {
  append(event: MemoryDeletionAudit): Promise<void>;
}

export interface SqlClient {
  query<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}
