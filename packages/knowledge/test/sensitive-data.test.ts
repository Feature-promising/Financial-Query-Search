import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildContext, redactSensitiveText } from "../src/index.js";

describe("sensitive-data model-context gate", () => {
  it("redacts credentials and personal identifiers while retaining a citation-safe evidence identity", () => {
    const item = {
      id: randomUUID(), tenantId: "org-1", sourceType: "sec_filing" as const, authority: "primary" as const,
      title: "Disclosure for analyst@example.com", content: "Contact analyst@example.com. API_KEY=super-secret-token. SSN 123-45-6789. Card 4111 1111 1111 1111.",
      sourceUrl: "https://www.sec.gov/Archives/example", locator: "Phone: 415-555-2671", entity: "EXM", publishedAt: null, asOfDate: "2025-12-31",
      retrievedAt: "2026-08-14T00:00:00.000Z", contentHash: "a".repeat(64), license: "SEC public filing", metadata: {},
    };
    const context = buildContext({ organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] }, [item]);

    expect(context).toHaveLength(1);
    expect(context[0]?.id).toBe(item.id);
    expect(context[0]?.content).not.toContain("analyst@example.com");
    expect(context[0]?.content).not.toContain("super-secret-token");
    expect(context[0]?.content).not.toContain("123-45-6789");
    expect(context[0]?.content).not.toContain("4111 1111 1111 1111");
    expect(context[0]?.title).not.toContain("analyst@example.com");
    expect(context[0]?.locator).not.toContain("415-555-2671");
    expect(context[0]?.metadata.sensitiveDataRedaction).toMatchObject({ detected: true, types: expect.arrayContaining(["api_key", "credit_card", "email", "phone", "ssn"]) });
  });

  it("does not redact ordinary financial identifiers that are not sensitive data", () => {
    const result = redactSensitiveText("NVDA CIK 0001045810 reported $100 million in revenue.");
    expect(result.text).toContain("0001045810");
    expect(result.assessment).toMatchObject({ detected: false, count: 0 });
  });
});
