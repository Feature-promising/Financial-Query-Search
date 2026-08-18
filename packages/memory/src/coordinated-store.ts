import { randomUUID } from "node:crypto";
import type { EvidenceDeletionCoordinator } from "@research/knowledge";
import { MemoryDeletionAuditSchema, type MemoryRecord } from "@research/contracts";
import { MemoryDeletionWorkflowError } from "./deletion-errors.js";
import { isConfirmedPreferenceStore, type ConfirmedPreferenceStore, type ExpiredMemoryReader, type MemoryDeletionAuditSink, type MemoryQuery, type MemoryStore, type NewMemoryRecord } from "./types.js";

/** Adds cross-store evidence cleanup to any MemoryStore without coupling storage implementations. */
export class CoordinatedMemoryStore implements MemoryStore, ExpiredMemoryReader, ConfirmedPreferenceStore {
  constructor(private readonly delegate: MemoryStore, private readonly deletion: EvidenceDeletionCoordinator, private readonly audit?: MemoryDeletionAuditSink) {}

  async save(record: NewMemoryRecord): Promise<MemoryRecord> { return this.delegate.save(record); }
  async upsertConfirmedPreference(record: NewMemoryRecord): Promise<MemoryRecord> {
    return isConfirmedPreferenceStore(this.delegate) ? this.delegate.upsertConfirmedPreference(record) : this.delegate.save(record);
  }
  async get(id: string, tenantId: string): Promise<MemoryRecord | undefined> { return this.delegate.get(id, tenantId); }
  async retrieve(query: MemoryQuery): Promise<MemoryRecord[]> { return this.delegate.retrieve(query); }
  async update(id: string, tenantId: string, patch: Parameters<MemoryStore["update"]>[2]): Promise<MemoryRecord> { return this.delegate.update(id, tenantId, patch); }
  async listExpired(limit: number, now?: Date): Promise<MemoryRecord[]> {
    return isExpiredMemoryReader(this.delegate) ? this.delegate.listExpired(limit, now) : [];
  }

  async delete(id: string, tenantId: string, actorUserId?: string): Promise<void> {
    const record = await this.delegate.get(id, tenantId);
    if (!record) throw new Error("memory record not found");
    const references = memoryReferences(record);
    const event = (eventType: "requested" | "completed" | "failed") => MemoryDeletionAuditSchema.parse({
      id: randomUUID(), tenantId, memoryId: record.id, actorUserId: actorUserId ?? null,
      memoryScope: record.scope, sourceRunId: record.sourceRunId, evidenceIds: references.citationEvidenceIds, eventType,
      occurredAt: new Date().toISOString(),
    });
    try {
      await this.audit?.append(event("requested"));
    } catch (error) {
      // Do not begin irreversible external cleanup without its requested audit
      // record. The caller can retry safely once PostgreSQL is healthy.
      throw new MemoryDeletionWorkflowError("requested_audit", {
        memoryRecordDeleted: false,
        artifactCleanupMayBePartial: false,
        auditEventMayBeMissing: true,
      }, error);
    }
    try {
      await this.deletion.delete({
        tenantId,
        evidenceIds: references.ownedArtifactEvidenceIds,
        evidenceUris: references.ownedArtifactEvidenceUris,
      });
    } catch (error) {
      throw await this.failure("artifact_cleanup", event("failed"), error);
    }
    try {
      await this.delegate.delete(id, tenantId, actorUserId);
    } catch (error) {
      // A database/network error can be ambiguous to the caller. Do not claim
      // the row was retained merely because the delete promise rejected.
      throw await this.failure("record_delete", event("failed"), error, true);
    }
    try {
      await this.audit?.append(event("completed"));
    } catch (error) {
      // The row and owned artifacts are gone, but the durable completion proof
      // is missing. Surface this separately so API/operations never turn it
      // into a misleading successful deletion response.
      throw new MemoryDeletionWorkflowError("completed_audit", {
        memoryRecordDeleted: true,
        artifactCleanupMayBePartial: false,
        auditEventMayBeMissing: true,
      }, error);
    }
  }

  private async failure(
    phase: "artifact_cleanup" | "record_delete",
    failedEvent: ReturnType<typeof MemoryDeletionAuditSchema.parse>,
    cause: unknown,
    memoryRecordDeleted = false,
  ): Promise<MemoryDeletionWorkflowError> {
    try {
      await this.audit?.append(failedEvent);
      return new MemoryDeletionWorkflowError(phase, {
        memoryRecordDeleted,
        artifactCleanupMayBePartial: phase === "artifact_cleanup",
        auditEventMayBeMissing: false,
      }, cause);
    } catch (auditError) {
      // Preserve the original cleanup/delete failure. A failed audit append is
      // additional diagnostic state, never a replacement for the root cause.
      return new MemoryDeletionWorkflowError(phase, {
        memoryRecordDeleted,
        artifactCleanupMayBePartial: phase === "artifact_cleanup",
        auditEventMayBeMissing: true,
        failedAuditWrite: auditError,
      }, cause);
    }
  }
}

function isExpiredMemoryReader(store: MemoryStore): store is MemoryStore & ExpiredMemoryReader {
  return "listExpired" in store && typeof (store as Partial<ExpiredMemoryReader>).listExpired === "function";
}

/**
 * Citations point to immutable, potentially shared source evidence; deleting
 * a memory must never delete them. Physical cleanup is reserved for explicit
 * per-memory derived artifacts (such as a future memory-only index chunk).
 * Unknown legacy metadata fails closed to retention rather than data loss.
 */
function memoryReferences(record: MemoryRecord): {
  citationEvidenceIds: string[];
  ownedArtifactEvidenceIds: string[];
  ownedArtifactEvidenceUris: string[];
} {
  const metadata = record.metadata;
  return {
    citationEvidenceIds: stringValues(metadata.evidenceIds),
    ownedArtifactEvidenceIds: stringValues(metadata.memoryArtifactEvidenceIds),
    ownedArtifactEvidenceUris: stringValues(metadata.memoryArtifactEvidenceUris),
  };
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 1_000) : [];
}
