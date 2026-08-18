import { describe, expect, it } from "vitest";
import { buildContext } from "../src/index.js";

describe("evidence entitlement compatibility", () => {
  it("fails closed for legacy licensed evidence missing explicit access grants", () => {
    const context = buildContext(
      { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: ["market-data"] },
      [{
        id: "f5d890db-010e-4ac1-b086-805a3fe01ec4", tenantId: "org-1", sourceType: "market_data", authority: "licensed", title: "Legacy vendor record", content: "Close price: 100.", sourceUrl: null, locator: "row:1", entity: "EXM", publishedAt: null, asOfDate: "2026-08-13", retrievedAt: "2026-08-14T00:00:00.000Z", contentHash: "a".repeat(64), license: "Legacy vendor", metadata: {},
      }],
    );

    expect(context).toEqual([]);
  });
});
