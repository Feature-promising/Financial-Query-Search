import { describe, expect, it } from "vitest";
import { OpenSearchVectorIndex, type OpenSearchTransport } from "../src/index.js";

describe("OpenSearchVectorIndex", () => {
  it("places tenant and entitlement filtering in every retrieval query", async () => {
    const transport = new FakeTransport();
    const index = new OpenSearchVectorIndex(transport, "evidence-v1", { embed: async () => [0.1, 0.2] });
    await index.search({ text: "NVDA revenue", tenantId: "org-1", allowedEntitlements: ["market-data"], limit: 10 });
    expect(JSON.stringify(transport.searchRequest)).toContain("tenantId");
    expect(JSON.stringify(transport.searchRequest)).toContain("org-1");
    expect(JSON.stringify(transport.searchRequest)).toContain("requiredEntitlements");
    expect(JSON.stringify(transport.searchRequest)).toContain("market-data");
  });

  it("rechecks tenant, licence and evidence eligibility on returned hits", async () => {
    const authorized = primaryEvidence();
    const otherTenant = { ...primaryEvidence(), id: "782c9073-c2a9-472c-a3da-2dd6d99429e0", tenantId: "org-2" };
    const unlicensed = { ...primaryEvidence(), id: "a996b0ad-44ed-4fdc-8af1-7219746f1bfb", authority: "licensed" as const, sourceType: "market_data" as const, requiredEntitlements: ["market-data"] };
    const researchMemory = { ...primaryEvidence(), id: "0ad0a2e1-a85a-4230-b828-7ac19c30dd3b", sourceType: "research_memory" as const };
    const transport = new FakeTransport({}, [authorized, otherTenant, unlicensed, researchMemory]);
    const index = new OpenSearchVectorIndex(transport, "evidence-v1", { embed: async () => [0.1, 0.2] });

    const results = await index.search({ text: "NVDA revenue", tenantId: "org-1", allowedEntitlements: [], limit: 10 });

    expect(results).toEqual([authorized]);
  });

  it("rejects licensed evidence without explicit access grants before indexing", async () => {
    const index = new OpenSearchVectorIndex(new FakeTransport(), "evidence-v1", { embed: async () => [0.1, 0.2] });
    await expect(index.upsert([{
      id: "8ce31e9d-b5be-49cd-bd2a-d145c1ffc375", tenantId: "org-1", sourceType: "market_data", authority: "licensed", title: "Legacy vendor record", content: "Close price: 100.", sourceUrl: null, locator: "row:1", entity: "EXM", publishedAt: null, asOfDate: "2026-08-13", retrievedAt: "2026-08-14T00:00:00.000Z", contentHash: "a".repeat(64), license: "Legacy vendor", metadata: {},
    }])).rejects.toThrow("must declare required entitlements");
  });

  it("fails closed when an OpenSearch bulk response contains item-level errors", async () => {
    const index = new OpenSearchVectorIndex(new FakeTransport({ errors: true, items: [{ index: { status: 429, error: { reason: "rejected" } } }] }), "evidence-v1", { embed: async () => [0.1, 0.2] });
    await expect(index.upsert([primaryEvidence()])).rejects.toThrow("bulk indexing reported");
  });

  it("requires a complete successful bulk acknowledgement for every evidence item", async () => {
    const missingAcknowledgement = new OpenSearchVectorIndex(new FakeTransport({ errors: false }), "evidence-v1", { embed: async () => [0.1, 0.2] });
    await expect(missingAcknowledgement.upsert([primaryEvidence()])).rejects.toThrow("bulk indexing reported");

    const confirmed = new OpenSearchVectorIndex(new FakeTransport({ errors: false, items: [{ index: { status: 201 } }] }), "evidence-v1", { embed: async () => [0.1, 0.2] });
    await expect(confirmed.upsert([primaryEvidence()])).resolves.toBeUndefined();
  });
});

class FakeTransport implements OpenSearchTransport {
  searchRequest: unknown;
  constructor(private readonly bulkResponse: { errors?: boolean; items?: Array<Record<string, { status?: number; error?: unknown }>> } = {}, private readonly searchHits: unknown[] = []) {}
  async bulk() { return this.bulkResponse; }
  async search(request: { index: string; body: Record<string, unknown> }) { this.searchRequest = request; return { hits: { hits: this.searchHits.map((_source) => ({ _source })) } }; }
  async deleteByQuery(): Promise<unknown> { return {}; }
}

function primaryEvidence() {
  return {
    id: "8ce31e9d-b5be-49cd-bd2a-d145c1ffc375", tenantId: "org-1", sourceType: "sec_filing" as const, authority: "primary" as const, title: "Filing", content: "Revenue disclosure.", sourceUrl: null, locator: "Item 7", entity: "EXM", publishedAt: null, asOfDate: "2026-08-13", retrievedAt: "2026-08-14T00:00:00.000Z", contentHash: "a".repeat(64), license: "SEC", metadata: {},
  };
}
