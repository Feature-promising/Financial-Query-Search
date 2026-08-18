import { describe, expect, it } from "vitest";
import { PostgresConversationStore } from "../src/index.js";

const scope = { organizationId: "org-1", userId: "user-1", roles: ["researcher"] as const, entitlements: [] };

describe("PostgresConversationStore", () => {
  it("writes and filters messages by their direct organization key", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const store = new PostgresConversationStore({
      query: async (sql, values = []) => {
        calls.push({ sql, values });
        if (sql.includes("INSERT INTO messages")) {
          return { rows: [{ id: "message-1", conversation_id: "conversation-1", role: "user", content: "Analyze NVDA", run_id: null, created_at: "2026-08-16T00:00:00.000Z" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
    });

    await store.appendMessage(scope, { conversationId: "conversation-1", role: "user", content: "Analyze NVDA" });
    await store.listMessages(scope, "conversation-1");

    expect(calls[0]?.sql).toContain("INSERT INTO messages (conversation_id, organization_id, role, content, run_id)");
    expect(calls[0]?.sql).toContain("SELECT id, $2, $5, $6, $7 FROM conversations");
    expect(calls[0]?.sql).toContain("deleted_at IS NULL AND archived_at IS NULL");
    expect(calls[0]?.values).toContain("org-1");
    expect(calls[2]?.sql).toContain("m.organization_id = $2");
  });

  it("uses a dedicated trusted publication path for an in-flight run after archive", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const store = new PostgresConversationStore({
      query: async (sql, values = []) => {
        calls.push({ sql, values });
        if (sql.includes("INSERT INTO messages")) {
          return { rows: [{ id: "message-1", conversation_id: "conversation-1", role: "assistant", content: "Published", run_id: "run-1", created_at: "2026-08-16T00:00:00.000Z" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
    });

    await store.appendPublishedAssistantMessage(scope, { conversationId: "conversation-1", content: "Published", runId: "run-1" });

    expect(calls[0]?.sql).toContain("SELECT id, $2, 'assistant', $5, $6 FROM conversations");
    expect(calls[0]?.sql).not.toContain("archived_at IS NULL");
    expect(calls[0]?.sql).not.toContain("deleted_at IS NULL");
  });

  it("uses tenant-filtered keyset pagination with a deterministic secondary ordering key", async () => {
    const store = new PostgresConversationStore({ query: async () => ({ rows: [], rowCount: 0 }) });
    const cursor = "2026-08-17T00:00:00.000Z|2026-08-16T00:00:00.000Z|144d8a8a-cd10-49a9-ab1f-7a0bff2aa8b8";
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const inspected = new PostgresConversationStore({
      query: async (sql, values = []) => { calls.push({ sql, values }); return { rows: [], rowCount: 0 }; },
    });

    await inspected.listPage(scope, { cursor, limit: 20 });

    expect(calls[0]?.sql).toContain("updated_at <= $4::timestamptz");
    expect(calls[0]?.sql).toContain("(updated_at, id) < ($5::timestamptz, $6::uuid)");
    expect(calls[0]?.sql).toContain("ORDER BY updated_at DESC, id DESC LIMIT $7");
    expect(calls[0]?.values).toEqual(expect.arrayContaining(["org-1", "2026-08-17T00:00:00.000Z", "2026-08-16T00:00:00.000Z", "144d8a8a-cd10-49a9-ab1f-7a0bff2aa8b8", 21]));
    await expect(store.listPage(scope, { cursor: "not-a-cursor" })).rejects.toThrow("invalid conversation page cursor");
  });
});
