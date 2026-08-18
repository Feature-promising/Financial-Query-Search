import { describe, expect, it } from "vitest";
import { HybridRetrievalPipeline, type KnowledgeGraph, type RetrievalQuery, type VectorIndex } from "../src/index.js";

describe("HybridRetrievalPipeline", () => {
  it("enforces tenant and data-entitlement scope before producing model context", async () => {
    const pipeline = new HybridRetrievalPipeline(new StubIndex());
    const result = await pipeline.retrieve({ organizationId: "org-1", userId: "u-1", roles: ["researcher"], entitlements: [] }, { text: "NVDA revenue", entities: ["NVDA"], limit: 10 });
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.tenantId).toBe("org-1");
    expect(result.evidence[0]?.requiredEntitlements).toBeUndefined();
    expect(result.expandedQueries.length).toBeGreaterThan(1);
  });

  it("does not traverse graph relationship leads without the graph-read entitlement", async () => {
    const graph = new RecordingGraph();
    const pipeline = new HybridRetrievalPipeline(new StubIndex(), graph);
    const denied = await pipeline.retrieve({ organizationId: "org-1", userId: "u-1", roles: ["researcher"], entitlements: [] }, { text: "NVDA competitors", entities: ["NVDA"], limit: 10 });
    expect(denied.graphRelations).toEqual([]);
    expect(graph.calls).toBe(0);

    const allowed = await pipeline.retrieve({ organizationId: "org-1", userId: "u-1", roles: ["researcher"], entitlements: ["graph-read"] }, { text: "NVDA competitors", entities: ["NVDA"], limit: 10 });
    expect(allowed.graphRelations).toHaveLength(1);
    expect(graph.calls).toBe(1);
    expect(graph.allowedEntitlements).toEqual(["graph-read"]);

    await pipeline.retrieve({ organizationId: "org-1", userId: "u-1", roles: ["researcher"], entitlements: ["graph-read", "market-data"] }, { text: "NVDA competitors", entities: ["NVDA"], limit: 10 });
    expect(graph.allowedEntitlements).toEqual(["graph-read", "market-data"]);
  });

  it("forwards the run cancellation signal into every vector retrieval", async () => {
    const index = new SignalRecordingIndex();
    const pipeline = new HybridRetrievalPipeline(index);
    const controller = new AbortController();

    await pipeline.retrieve({ organizationId: "org-1", userId: "u-1", roles: ["researcher"], entitlements: [] }, { text: "NVDA revenue", entities: ["NVDA"], limit: 10 }, 8_000, { signal: controller.signal });
    expect(index.signals.length).toBeGreaterThan(0);
    expect(index.signals.every((signal) => signal === controller.signal)).toBe(true);
  });

  it("uses validated prior-research questions only as additional retrieval leads", async () => {
    const index = new QueryRecordingIndex();
    const pipeline = new HybridRetrievalPipeline(index);

    await pipeline.retrieve({ organizationId: "org-1", userId: "u-1", roles: ["researcher"], entitlements: [] }, {
      text: "Analyze NVIDIA margins",
      entities: ["NVIDIA"],
      researchMemorySeeds: [{ sourceRunId: "0f01ec7c-1c35-4d58-aa66-99d27c40b53a", question: "Analyze NVDA FY2025 revenue", entities: ["NVIDIA"], tickers: ["NVDA"], asOfDates: ["2025-12-31"] }],
      limit: 10,
    });

    expect(index.queries).toContain("Analyze NVDA FY2025 revenue");
  });
});

class RecordingGraph implements KnowledgeGraph {
  calls = 0;
  allowedEntitlements: string[] = [];
  async expand(_tenantId: string, _entity: string, allowedEntitlements: string[], _limit: number) {
    this.calls += 1;
    this.allowedEntitlements = allowedEntitlements;
    return [{ subject: "NVDA", predicate: "COMPETES_WITH", object: "AMD", evidenceIds: ["evidence-1"] }];
  }
  async deleteEvidenceReferences(): Promise<void> {}
}

class StubIndex implements VectorIndex {
  async upsert(): Promise<void> {}
  async deleteByEvidenceIds(): Promise<void> {}
  async search(query: RetrievalQuery) {
    return [evidence(query.tenantId), licensedEvidence(query.tenantId), evidence("other-tenant")];
  }
}

class SignalRecordingIndex extends StubIndex {
  readonly signals: Array<AbortSignal | undefined> = [];
  override async search(query: RetrievalQuery, options?: { signal?: AbortSignal }) {
    this.signals.push(options?.signal);
    return super.search(query, options);
  }
}

class QueryRecordingIndex extends StubIndex {
  readonly queries: string[] = [];
  override async search(query: RetrievalQuery, options?: { signal?: AbortSignal }) {
    this.queries.push(query.text);
    return super.search(query, options);
  }
}

function licensedEvidence(tenantId: string) {
  return { ...evidence(tenantId), id: "76a8340f-3d69-4f26-a1de-05d0cb33bbb5", sourceType: "market_data" as const, authority: "licensed" as const, requiredEntitlements: ["market-data"] };
}

function evidence(tenantId: string) {
  return {
    id: tenantId === "org-1" ? "81937e62-6f6a-4c91-aefa-370a7d8c3987" : "2ca713b3-4650-4443-8387-d3f0287c8b4b", sourceType: "sec_filing" as const, authority: "primary" as const, title: "Filing", content: "NVDA revenue increased.", sourceUrl: null, locator: "page 1", entity: "NVDA", publishedAt: null, asOfDate: null,
    retrievedAt: "2026-08-14T08:00:00.000Z", contentHash: "a".repeat(64), license: "SEC", tenantId, metadata: {},
  };
}
