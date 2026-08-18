import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PostgresMemoryDeletionAuditSink } from "../src/index.js";

describe("PostgresMemoryDeletionAuditSink", () => {
  it("persists an append-only, content-free deletion event", async () => {
    const calls: unknown[][] = [];
    const sink = new PostgresMemoryDeletionAuditSink({ query: async (_sql, values = []) => { calls.push(values); return { rows: [], rowCount: 1 }; } });
    const event = {
      id: randomUUID(), tenantId: "org-1", memoryId: randomUUID(), actorUserId: "user-1",
      memoryScope: "research" as const, sourceRunId: null, evidenceIds: [randomUUID()], eventType: "requested" as const,
      occurredAt: "2026-08-14T00:00:00.000Z",
    };

    await sink.append(event);

    expect(calls).toEqual([[event.id, "org-1", event.memoryId, "user-1", "research", null, event.evidenceIds, "requested", event.occurredAt]]);
  });
});
