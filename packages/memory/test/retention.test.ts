import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryStore, MemoryRetentionService } from "../src/index.js";

describe("MemoryRetentionService", () => {
  it("deletes expired records in bounded batches while retaining legal-hold memory", async () => {
    const store = new InMemoryStore();
    const expired = await store.save(memory({ expiresAt: "2026-08-14T00:00:00.000Z" }));
    const held = await store.save(memory({ expiresAt: "2026-08-14T00:00:00.000Z", retentionPolicy: "legal_hold" }));
    const active = await store.save(memory({ expiresAt: "2026-08-16T00:00:00.000Z" }));
    const service = new MemoryRetentionService(store, store, () => new Date("2026-08-15T00:00:00.000Z"));

    expect(await service.purgeExpired(1)).toEqual({ scanned: 1, deleted: 1, failed: 0 });
    expect(await store.get(expired.id, "org-1")).toBeUndefined();
    expect(await store.get(held.id, "org-1")).toBeDefined();
    expect(await store.get(active.id, "org-1")).toBeDefined();
  });

  it("continues a batch when one coordinated deletion fails", async () => {
    const store = new InMemoryStore();
    const first = await store.save(memory({ expiresAt: "2026-08-14T00:00:00.000Z" }));
    const second = await store.save(memory({ expiresAt: "2026-08-14T01:00:00.000Z" }));
    const service = new MemoryRetentionService(store, {
      delete: async (id, tenantId) => {
        if (id === first.id) throw new Error("transient cleanup failure");
        await store.delete(id, tenantId);
      },
    }, () => new Date("2026-08-15T00:00:00.000Z"));

    expect(await service.purgeExpired()).toEqual({ scanned: 2, deleted: 1, failed: 1 });
    expect(await store.get(first.id, "org-1")).toBeDefined();
    expect(await store.get(second.id, "org-1")).toBeUndefined();
  });
});

function memory(overrides: Record<string, unknown>) {
  return {
    id: randomUUID(), scope: "long_term" as const, tenantId: "org-1", userId: "user-1", visibility: "private" as const,
    content: "Research preference", sourceRunId: null, expiresAt: null, retentionPolicy: "user_managed" as const, metadata: {}, ...overrides,
  };
}
