import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadPrioritizedMemoryContext, InMemoryStore } from "../src/index.js";

describe("loadPrioritizedMemoryContext", () => {
  it("keeps the current session, research assets, and preferences in their explicit priority layers", async () => {
    const store = new InMemoryStore();
    const tenantId = "org-a";
    const userId = "user-a";
    const conversationId = randomUUID();
    await store.save({ scope: "short_term", tenantId, userId, conversationId, visibility: "private", content: "Current session asks for downside risks", sourceRunId: null, expiresAt: null, retentionPolicy: "session", metadata: {} });
    await store.save({ scope: "short_term", tenantId, userId, conversationId: randomUUID(), visibility: "private", content: "Different conversation", sourceRunId: null, expiresAt: null, retentionPolicy: "session", metadata: {} });
    await store.save({ scope: "research", tenantId, userId: null, visibility: "organization", content: "NVIDIA research: revenue growth", sourceRunId: null, expiresAt: null, metadata: { entities: ["NVIDIA"], tickers: ["NVDA"] } });
    await store.save({ scope: "long_term", tenantId, userId, visibility: "private", content: "Confirmed valuation method: DCF", sourceRunId: null, expiresAt: null, retentionPolicy: "user_managed", metadata: { userConfirmed: true, preferenceKey: "valuation_method", preferenceValue: "DCF" } });
    await store.save({ scope: "long_term", tenantId, userId, visibility: "private", content: "Unconfirmed free-form profile", sourceRunId: null, expiresAt: null, retentionPolicy: "user_managed", metadata: {} });

    const context = await loadPrioritizedMemoryContext(store, { tenantId, userId, conversationId, question: "NVIDIA" });

    expect(context.sessionFacts.map((item) => item.content)).toEqual(["Current session asks for downside risks"]);
    expect(context.researchAssets.map((item) => item.content)).toEqual(["NVIDIA research: revenue growth"]);
    expect(context.userPreferences.map((item) => item.content)).toEqual(["Confirmed valuation method: DCF"]);
  });
});
