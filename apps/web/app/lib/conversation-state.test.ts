import { describe, expect, it } from "vitest";
import { isConversationArchived } from "./conversation-state";

describe("isConversationArchived", () => {
  it("treats only an archived timestamp as read-only", () => {
    expect(isConversationArchived()).toBe(false);
    expect(isConversationArchived({ conversation: { archivedAt: null } } as never)).toBe(false);
    expect(isConversationArchived({ conversation: { archivedAt: "2026-08-17T00:00:00.000Z" } } as never)).toBe(true);
  });
});
