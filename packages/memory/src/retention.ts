import type { MemoryRecord } from "@research/contracts";
import type { ExpiredMemoryReader, MemoryStore } from "./types.js";

export interface MemoryRetentionResult {
  scanned: number;
  deleted: number;
  failed: number;
}

/**
 * Deletes expired, non-held memory in small batches through the normal store,
 * preserving audit events and cross-store evidence propagation.
 */
export class MemoryRetentionService {
  constructor(private readonly reader: ExpiredMemoryReader, private readonly store: Pick<MemoryStore, "delete">, private readonly now: () => Date = () => new Date()) {}

  async purgeExpired(limit = 100): Promise<MemoryRetentionResult> {
    const boundedLimit = Math.max(1, Math.min(limit, 1_000));
    const candidates = await this.reader.listExpired(boundedLimit, this.now());
    let deleted = 0;
    let failed = 0;
    for (const record of candidates) {
      if (!isEligibleForRetentionDeletion(record, this.now())) continue;
      try {
        // No human actor is attributed to a scheduled retention policy.
        await this.store.delete(record.id, record.tenantId);
        deleted += 1;
      } catch {
        // Continue the bounded batch. The next scheduled attempt is idempotent
        // for successful deletes and retries only the unresolved records.
        failed += 1;
      }
    }
    return { scanned: candidates.length, deleted, failed };
  }
}

export function isEligibleForRetentionDeletion(record: MemoryRecord, now: Date): boolean {
  return record.retentionPolicy !== "legal_hold" && record.expiresAt !== null && new Date(record.expiresAt).getTime() <= now.getTime();
}
