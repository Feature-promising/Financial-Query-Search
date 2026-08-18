import { describe, expect, it } from "vitest";
import { InMemoryStore, UserPreferenceMemoryService } from "../src/index.js";

describe("UserPreferenceMemoryService", () => {
  it("persists only explicit, private user-managed preferences and updates by key", async () => {
    const store = new InMemoryStore();
    const preferences = new UserPreferenceMemoryService(store);
    const scope = { tenantId: "org-1", userId: "user-1" };

    await preferences.save(scope, { key: "valuation_method", value: "DCF" });
    await preferences.save(scope, { key: "valuation_method", value: "blended" });

    expect(await preferences.list(scope)).toEqual([{ key: "valuation_method", value: "blended" }]);
    const records = await store.retrieve({ tenantId: "org-1", userId: "user-1", scopes: ["long_term"] });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ scope: "long_term", userId: "user-1", visibility: "private", retentionPolicy: "user_managed", sourceRunId: null, metadata: { userConfirmed: true, preferenceKey: "valuation_method", preferenceValue: "blended" } });
  });

  it("does not promote arbitrary long-term memory or another user’s record into a preference", async () => {
    const store = new InMemoryStore();
    await store.save({ scope: "long_term", tenantId: "org-1", userId: "user-1", visibility: "private", content: "Infer this investor profile", sourceRunId: null, expiresAt: null, metadata: { preferenceKey: "valuation_method", preferenceValue: "DCF" } });
    await new UserPreferenceMemoryService(store).save({ tenantId: "org-1", userId: "user-2" }, { key: "display_unit", value: "USD millions" });

    expect(await new UserPreferenceMemoryService(store).list({ tenantId: "org-1", userId: "user-1" })).toEqual([]);
  });
});
