import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BedrockCitationEntailmentVerifier, type StructuredModel } from "../src/index.js";

describe("BedrockCitationEntailmentVerifier", () => {
  it("fails closed when the structured verifier omits a claim verdict", async () => {
    const first = claim();
    const second = claim();
    const source = evidence();
    const model: StructuredModel = { generate: async () => ({ verdicts: [{ claimId: first.id, supported: true, reason: "Explicitly stated." }] }) };

    const verdicts = await new BedrockCitationEntailmentVerifier(model).verify([first, second], [source], { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] });

    expect(verdicts).toEqual([
      { claimId: first.id, supported: true, reason: "Explicitly stated." },
      { claimId: second.id, supported: false, reason: "citation verifier omitted a verdict" },
    ]);
  });
});

function claim() { return { id: randomUUID(), text: "Revenue increased.", evidenceIds: [evidenceId], confidence: 0.8, qualification: null }; }
const evidenceId = randomUUID();
function evidence() {
  return {
    id: evidenceId, sourceType: "sec_filing" as const, authority: "primary" as const,
    title: "Example filing", content: "Revenue increased.", sourceUrl: null, locator: "page 1",
    entity: "EXMP", publishedAt: null, asOfDate: "2025-12-31", retrievedAt: "2026-01-01T00:00:00.000Z",
    contentHash: "0123456789abcdef", license: "SEC EDGAR public filing", tenantId: "org-1", metadata: {},
  };
}
