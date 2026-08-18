import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HybridRetrievalPipeline, type VectorIndex } from "@research/knowledge";
import { HybridRetrievalTool } from "../src/index.js";

describe("HybridRetrievalTool", () => {
  it("returns only tenant-scoped evidence", async () => {
    const tool = new HybridRetrievalTool(new HybridRetrievalPipeline(new Index()));
    const result = await tool.invoke({ query: "NVDA revenue" }, { runId: "run-1", scope: { organizationId: "org-1", userId: "u-1", roles: ["researcher"], entitlements: [] }, remainingToolCalls: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.evidence.every((item) => item.tenantId === "org-1")).toBe(true);
  });
});

class Index implements VectorIndex {
  async upsert(): Promise<void> {}
  async deleteByEvidenceIds(): Promise<void> {}
  async search(query: { tenantId: string }) { return [evidence(query.tenantId)]; }
}

function evidence(tenantId: string) {
  return { id: randomUUID(), sourceType: "sec_filing" as const, authority: "primary" as const, title: "Filing", content: "NVDA revenue", sourceUrl: null, locator: "p.1", entity: "NVDA", publishedAt: null, asOfDate: null, retrievedAt: "2026-08-14T08:00:00.000Z", contentHash: randomUUID().replaceAll("-", "").repeat(2), license: "SEC", tenantId, metadata: {} };
}
