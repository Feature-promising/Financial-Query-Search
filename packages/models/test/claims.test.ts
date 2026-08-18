import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BedrockClaimComposer, type StructuredModel } from "../src/index.js";

const evidenceId = randomUUID();
const evidence = [{ id: evidenceId, sourceType: "sec_filing" as const, authority: "primary" as const, title: "Example 10-K", content: "Revenue increased.", sourceUrl: "https://www.sec.gov/example", locator: "Item 7", entity: "EXMP", publishedAt: null, asOfDate: "2025-12-31", retrievedAt: "2026-01-01T00:00:00.000Z", contentHash: "0123456789abcdef", license: "SEC EDGAR public filing", tenantId: "org-a", metadata: {} }];

describe("BedrockClaimComposer", () => {
  it("drops claims without permitted evidence", async () => {
    const fake: StructuredModel = { generate: async () => ({ claims: [{ text: "Supported", evidenceIds: [evidenceId], confidence: 0.8, qualification: null }, { text: "Unsupported", evidenceIds: [randomUUID()], confidence: 0.9, qualification: null }] }) };
    const claims = await new BedrockClaimComposer(fake).compose("Question", evidence);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.evidenceIds).toEqual([evidenceId]);
  });
});
