import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EvidenceDeletionCoordinator } from "@research/knowledge";
import { CoordinatedMemoryStore, InMemoryMemoryDeletionAuditSink, InMemoryStore, MemoryDeletionWorkflowError } from "../src/index.js";

describe("CoordinatedMemoryStore", () => {
  it("removes only memory-owned derived artifacts before deleting a memory record", async () => {
    const actions: string[] = [];
    const store = new CoordinatedMemoryStore(new InMemoryStore(), new EvidenceDeletionCoordinator({
      index: { upsert: async () => undefined, search: async () => [], deleteByEvidenceIds: async () => { actions.push("index"); } },
      graph: { expand: async () => [], deleteEvidenceReferences: async () => { actions.push("graph"); } },
      lake: { put: async () => ({ uri: "", versionId: "" }), get: async () => new Uint8Array(), delete: async () => { actions.push("lake"); } },
    }));
    const record = await store.save({ scope: "research", tenantId: "org-1", userId: null, visibility: "organization", content: "report", sourceRunId: null, expiresAt: null, metadata: { evidenceIds: [randomUUID()], memoryArtifactEvidenceIds: [randomUUID()], memoryArtifactEvidenceUris: ["s3://bucket/memory-artifact"] } });
    await store.delete(record.id, "org-1");
    expect(actions).toEqual(["index", "graph", "lake"]);
  });

  it("retains shared cited evidence when a report memory is deleted", async () => {
    const actions: string[] = [];
    const store = new CoordinatedMemoryStore(new InMemoryStore(), new EvidenceDeletionCoordinator({
      index: { upsert: async () => undefined, search: async () => [], deleteByEvidenceIds: async () => { actions.push("index"); } },
      graph: { expand: async () => [], deleteEvidenceReferences: async () => { actions.push("graph"); } },
      lake: { put: async () => ({ uri: "", versionId: "" }), get: async () => new Uint8Array(), delete: async () => { actions.push("lake"); } },
    }));
    const record = await store.save({ scope: "research", tenantId: "org-1", userId: null, visibility: "organization", content: "report", sourceRunId: null, expiresAt: null, metadata: { evidenceIds: [randomUUID()], evidenceUris: ["s3://bucket/source-evidence"] } });

    await store.delete(record.id, "org-1");

    expect(actions).toEqual([]);
  });

  it("appends content-free requested and completed audit events with the deleting actor", async () => {
    const audit = new InMemoryMemoryDeletionAuditSink();
    const store = new CoordinatedMemoryStore(new InMemoryStore(), new EvidenceDeletionCoordinator({
      index: { upsert: async () => undefined, search: async () => [], deleteByEvidenceIds: async () => undefined },
      graph: { expand: async () => [], deleteEvidenceReferences: async () => undefined },
      lake: { put: async () => ({ uri: "", versionId: "" }), get: async () => new Uint8Array(), delete: async () => undefined },
    }), audit);
    const evidenceId = randomUUID();
    const record = await store.save({ scope: "research", tenantId: "org-1", userId: null, visibility: "organization", content: "private report content", sourceRunId: null, expiresAt: null, metadata: { evidenceIds: [evidenceId] } });

    await store.delete(record.id, "org-1", "analyst-1");

    expect(audit.events.map((event) => event.eventType)).toEqual(["requested", "completed"]);
    expect(audit.events[0]).toMatchObject({ tenantId: "org-1", memoryId: record.id, actorUserId: "analyst-1", evidenceIds: [evidenceId] });
    expect(JSON.stringify(audit.events)).not.toContain("private report content");
  });

  it("fails closed before cleanup when the requested audit cannot be persisted", async () => {
    const base = new InMemoryStore();
    const store = new CoordinatedMemoryStore(base, deletionCoordinator(), { append: async () => { throw new Error("audit unavailable"); } });
    const record = await base.save(memoryRecord());

    let error: unknown;
    try { await store.delete(record.id, "org-1"); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(MemoryDeletionWorkflowError);
    expect(await base.get(record.id, "org-1")).toBeDefined();
    expect((error as MemoryDeletionWorkflowError).phase).toBe("requested_audit");
  });

  it("retains the cleanup error when the failed audit append also fails", async () => {
    const base = new InMemoryStore();
    const cleanupError = new Error("index delete unavailable");
    const store = new CoordinatedMemoryStore(base, new EvidenceDeletionCoordinator({
      index: { upsert: async () => undefined, search: async () => [], deleteByEvidenceIds: async () => { throw cleanupError; } },
      graph: { expand: async () => [], deleteEvidenceReferences: async () => undefined },
      lake: { put: async () => ({ uri: "", versionId: "" }), get: async () => new Uint8Array(), delete: async () => undefined },
    }), { append: async (event) => { if (event.eventType === "requested") return; throw new Error("audit write unavailable"); } });
    const record = await base.save(memoryRecord({ memoryArtifactEvidenceIds: [randomUUID()] }));

    try {
      await store.delete(record.id, "org-1");
      throw new Error("expected deletion to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryDeletionWorkflowError);
      const failure = error as MemoryDeletionWorkflowError;
      expect(failure.phase).toBe("artifact_cleanup");
      expect(failure.cause).toBeInstanceOf(AggregateError);
      expect((failure.cause as AggregateError).errors).toContain(cleanupError);
      expect(failure.details.auditEventMayBeMissing).toBe(true);
      expect(failure.details.failedAuditWrite).toBeInstanceOf(Error);
    }
    expect(await base.get(record.id, "org-1")).toBeDefined();
  });

  it("surfaces a missing completion audit after the memory record has been removed", async () => {
    const base = new InMemoryStore();
    const store = new CoordinatedMemoryStore(base, deletionCoordinator(), { append: async (event) => { if (event.eventType === "completed") throw new Error("audit unavailable"); } });
    const record = await base.save(memoryRecord());

    try {
      await store.delete(record.id, "org-1");
      throw new Error("expected deletion to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryDeletionWorkflowError);
      const failure = error as MemoryDeletionWorkflowError;
      expect(failure.phase).toBe("completed_audit");
      expect(failure.details.memoryRecordDeleted).toBe(true);
      expect(failure.details.auditEventMayBeMissing).toBe(true);
    }
    expect(await base.get(record.id, "org-1")).toBeUndefined();
  });
});

function deletionCoordinator(): EvidenceDeletionCoordinator {
  return new EvidenceDeletionCoordinator({
    index: { upsert: async () => undefined, search: async () => [], deleteByEvidenceIds: async () => undefined },
    graph: { expand: async () => [], deleteEvidenceReferences: async () => undefined },
    lake: { put: async () => ({ uri: "", versionId: "" }), get: async () => new Uint8Array(), delete: async () => undefined },
  });
}

function memoryRecord(metadata: Record<string, unknown> = {}) {
  return { scope: "research" as const, tenantId: "org-1", userId: null, visibility: "organization" as const, content: "report", sourceRunId: null, expiresAt: null, metadata };
}
