import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/index.js";

describe("InMemoryStore", () => {
  it("never returns another tenant's private memory", async () => {
    const store = new InMemoryStore();
    await store.save({ scope: "long_term", tenantId: "org-a", userId: "user-a", visibility: "private", content: "Uses DCF", sourceRunId: null, expiresAt: null, metadata: {} });
    await store.save({ scope: "long_term", tenantId: "org-b", userId: "user-b", visibility: "organization", content: "Other tenant", sourceRunId: null, expiresAt: null, metadata: {} });
    const records = await store.retrieve({ tenantId: "org-a", userId: "user-a" });
    expect(records).toHaveLength(1);
    expect(records[0]?.content).toBe("Uses DCF");
  });

  it("finds research assets by controlled entity/ticker metadata rather than report prose", async () => {
    const store = new InMemoryStore();
    await store.save({ scope: "research", tenantId: "org-a", userId: null, visibility: "organization", content: "Historical report body", sourceRunId: null, expiresAt: null, metadata: { entities: ["NVIDIA"], tickers: ["NVDA"] } });
    await store.save({ scope: "research", tenantId: "org-a", userId: null, visibility: "organization", content: "Other report", sourceRunId: null, expiresAt: null, metadata: { entities: ["AMD"], tickers: ["AMD"] } });

    const records = await store.retrieve({ tenantId: "org-a", scopes: ["research"], researchTerms: ["NVIDIA", "NVDA"] });

    expect(records.map((record) => record.content)).toEqual(["Historical report body"]);
  });

  it("requires the tenant to delete a memory record", async () => {
    const store = new InMemoryStore();
    const id = randomUUID();
    await store.save({ id, scope: "research", tenantId: "org-a", userId: null, visibility: "organization", content: "Research artifact", sourceRunId: null, expiresAt: null, metadata: {} });
    await expect(store.delete(id, "org-b")).rejects.toThrow("not found");
    await store.delete(id, "org-a");
    expect(await store.retrieve({ tenantId: "org-a" })).toHaveLength(0);
  });

  it("limits short-term retrieval to the requested conversation", async () => {
    const store = new InMemoryStore();
    const firstConversation = randomUUID();
    await store.save({ scope: "short_term", tenantId: "org-a", userId: "user-a", conversationId: firstConversation, visibility: "private", content: "Current conversation", sourceRunId: null, expiresAt: null, retentionPolicy: "session", metadata: {} });
    await store.save({ scope: "short_term", tenantId: "org-a", userId: "user-a", conversationId: randomUUID(), visibility: "private", content: "Another conversation", sourceRunId: null, expiresAt: null, retentionPolicy: "session", metadata: {} });

    const records = await store.retrieve({ tenantId: "org-a", userId: "user-a", scopes: ["short_term"], conversationId: firstConversation });

    expect(records.map((record) => record.content)).toEqual(["Current conversation"]);
    expect(await store.retrieve({ tenantId: "org-a", userId: "user-a", scopes: ["short_term"] })).toEqual([]);
  });

  it("rejects a short-term record without its session lifecycle safeguards", async () => {
    const store = new InMemoryStore();
    await expect(store.save({ scope: "short_term", tenantId: "org-a", userId: "user-a", visibility: "private", content: "Missing session", sourceRunId: null, expiresAt: null, metadata: {} })).rejects.toThrow("conversation id");
  });
});
