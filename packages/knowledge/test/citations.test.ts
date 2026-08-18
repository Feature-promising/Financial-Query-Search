import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { verifyCitations } from "../src/index.js";

describe("verifyCitations", () => {
  it("rejects claims that refer to unavailable evidence", () => {
    const claimId = randomUUID();
    const result = verifyCitations([{ id: claimId, text: "Unsupported claim", evidenceIds: [randomUUID()], confidence: 0.8, qualification: null }], [], { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] });
    expect(result).toEqual([{ claimId, valid: false, reason: expect.stringContaining("missing") }]);
  });

  it("permits a secondary source when a primary citation also supports the claim", () => {
    const primary = evidence("primary");
    const secondary = evidence("secondary");
    const claimId = randomUUID();
    const result = verifyCitations([{ id: claimId, text: "Supported claim", evidenceIds: [primary.id, secondary.id], confidence: 0.8, qualification: null }], [primary, secondary], { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: ["secondary-research"] });
    expect(result).toEqual([{ claimId, valid: true }]);
  });

  it("rejects evidence outside an explicitly requested reporting year", () => {
    const primary = { ...evidence("primary"), asOfDate: "2024-12-31" };
    const claimId = randomUUID();
    const result = verifyCitations([{ id: claimId, text: "Supported claim", evidenceIds: [primary.id], confidence: 0.8, qualification: null }], [primary], { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] }, "2025");
    expect(result).toEqual([{ claimId, valid: false, reason: "evidence does not match requested period: 2025" }]);
  });

  it("accepts a source-dated financial record when its fiscal period matches the requested year", () => {
    const financial = { ...evidence("primary"), sourceType: "market_data" as const, authority: "licensed" as const, asOfDate: "2026-02-20", requiredEntitlements: ["market-data"], metadata: { fiscalPeriod: "FY2025", sourceAsOf: "2026-02-20" } };
    const claimId = randomUUID();
    const result = verifyCitations([{ id: claimId, text: "Supported claim", evidenceIds: [financial.id], confidence: 0.8, qualification: null }], [financial], { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: ["market-data"] }, "2025");
    expect(result).toEqual([{ claimId, valid: true }]);
  });

  it("rejects research-memory and graph leads as factual claim citations", () => {
    const researchMemory = { ...evidence("primary"), sourceType: "research_memory" as const };
    const graphLead = { ...evidence("primary"), sourceType: "graph" as const };
    const claimId = randomUUID();

    const result = verifyCitations([{ id: claimId, text: "Unsupported claim", evidenceIds: [researchMemory.id, graphLead.id], confidence: 0.8, qualification: null }], [researchMemory, graphLead], { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] });

    expect(result).toEqual([{ claimId, valid: false, reason: expect.stringContaining("missing or unauthorized") }]);
  });
});

function evidence(authority: "primary" | "secondary") {
  return {
    id: randomUUID(), sourceType: authority === "primary" ? "sec_filing" : "news", authority,
    title: "Evidence", content: "Evidence text", sourceUrl: null, locator: "page 1", entity: "NVDA",
    publishedAt: null, asOfDate: null, retrievedAt: "2026-08-14T08:00:00.000Z", contentHash: "a".repeat(64),
    license: "test", tenantId: "org-1", metadata: {},
  } as const;
}
