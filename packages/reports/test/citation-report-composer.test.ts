import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CitationReportComposer } from "../src/index.js";

describe("CitationReportComposer", () => {
  it("renders only evidence-bound claims with exact source locators", () => {
    const evidenceId = randomUUID();
    const report = new CitationReportComposer().compose({
      question: "NVDA", scope: { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] },
      claims: [{ id: randomUUID(), text: "Revenue increased.", evidenceIds: [evidenceId], confidence: 0.9, qualification: null }],
      evidence: [{ id: evidenceId, sourceType: "sec_filing", authority: "primary", title: "10-K", content: "Revenue increased.", sourceUrl: "https://www.sec.gov/example", locator: "p. 42", entity: "NVDA", publishedAt: null, asOfDate: "2026-01-31", retrievedAt: "2026-08-14T08:00:00.000Z", contentHash: "a".repeat(64), license: "SEC EDGAR", tenantId: "org-1", metadata: {} }],
    });
    expect(report.markdown).toContain("[1]");
    expect(report.markdown).toContain("p. 42");
  });
});
