import { describe, expect, it } from "vitest";
import { InMemoryOutboxStore } from "../src/outbox.js";
import type { ResearchRunCommand } from "@research/contracts";

const command: ResearchRunCommand = {
  version: "v2", runId: "ba1658b8-f6f3-46ce-80e6-8caa7eb0be17", conversationId: "6f89ef3c-04cb-49df-9f6d-b5b5bbfb8ab9",
  scope: { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] }, question: "Analyze NVDA",
  toolManifestSnapshot: [{ id: "filing.search", version: "1", capability: "sec_filing_retrieval", requiredEntitlements: [], timeoutMs: 20_000, enabled: true }], requestedAt: "2026-08-14T08:00:00.000Z",
};

describe("InMemoryOutboxStore", () => {
  it("retains failed publication work and removes published work", async () => {
    const store = new InMemoryOutboxStore();
    await store.enqueueResearchRun(command);
    const first = await store.claimBatch(10);
    expect(first[0]?.attempts).toBe(1);
    await store.release(first[0]!.id);
    const retry = await store.claimBatch(10);
    expect(retry[0]?.attempts).toBe(2);
    await store.markPublished(retry[0]!.id);
    expect(await store.claimBatch(10)).toEqual([]);
  });
});
