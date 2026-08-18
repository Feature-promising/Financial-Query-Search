import { describe, expect, it } from "vitest";
import { InMemoryConversationStore } from "../src/index.js";

const scope = { organizationId: "org-1", userId: "user-1", roles: ["researcher"] as const, entitlements: [] };

describe("conversation lifecycle", () => {
  it("keeps archive reversible and makes deletion invisible without mutating unrelated sessions", async () => {
    const store = new InMemoryConversationStore();
    const first = await store.create(scope, "First");
    const second = await store.create(scope, "Second");

    await store.rename(scope, first.id, "Renamed");
    const archived = await store.setArchived(scope, first.id, true);
    expect(archived).toMatchObject({ title: "Renamed", archivedAt: expect.any(String) });
    expect((await store.list(scope)).map((conversation) => conversation.id)).toEqual([second.id]);
    expect((await store.list(scope, true)).map((conversation) => conversation.id)).toEqual([first.id]);

    expect(await store.delete(scope, first.id)).toBe(true);
    expect(await store.get(scope, first.id)).toBeUndefined();
    expect((await store.list(scope)).map((conversation) => conversation.id)).toEqual([second.id]);
  });

  it("makes archived conversations read-only until they are restored", async () => {
    const store = new InMemoryConversationStore();
    const conversation = await store.create(scope, "Read-only archive");
    await store.setArchived(scope, conversation.id, true);

    await expect(store.appendMessage(scope, { conversationId: conversation.id, role: "user", content: "Do not add a turn" }))
      .rejects.toMatchObject({ name: "ConversationArchivedError" });
    expect((await store.listMessages(scope, conversation.id)).length).toBe(0);

    await store.setArchived(scope, conversation.id, false);
    await expect(store.appendMessage(scope, { conversationId: conversation.id, role: "user", content: "Continue research" }))
      .resolves.toMatchObject({ content: "Continue research" });
  });

  it("preserves the audit trail for a run that finishes after its conversation is archived", async () => {
    const store = new InMemoryConversationStore();
    const conversation = await store.create(scope, "In-flight research");
    await store.appendMessage(scope, { conversationId: conversation.id, role: "user", content: "Analyze NVDA" });
    await store.setArchived(scope, conversation.id, true);

    await expect(store.appendMessage(scope, { conversationId: conversation.id, role: "user", content: "A new question" }))
      .rejects.toMatchObject({ name: "ConversationArchivedError" });
    await expect(store.appendPublishedAssistantMessage(scope, { conversationId: conversation.id, content: "Completed cited result", runId: "run-1" }))
      .resolves.toMatchObject({ role: "assistant", content: "Completed cited result" });
    expect((await store.listMessages(scope, conversation.id)).map((message) => message.content)).toEqual(["Analyze NVDA", "Completed cited result"]);
  });

  it("uses a stable keyset cursor rather than truncating a long session directory", async () => {
    const store = new InMemoryConversationStore();
    const original = await Promise.all(["One", "Two", "Three"].map((title) => store.create(scope, title)));

    const first = await store.listPage(scope, { limit: 1 });
    await store.create(scope, "Created after the snapshot");
    const second = await store.listPage(scope, { limit: 1, cursor: first.nextCursor });
    const third = await store.listPage(scope, { limit: 1, cursor: second.nextCursor });

    expect(first.conversations).toHaveLength(1);
    expect(second.conversations).toHaveLength(1);
    expect(third.conversations).toHaveLength(1);
    expect(new Set([...first.conversations, ...second.conversations, ...third.conversations].map((conversation) => conversation.id))).toEqual(new Set(original.map((conversation) => conversation.id)));
    expect(third.nextCursor).toBeUndefined();
  });
});
