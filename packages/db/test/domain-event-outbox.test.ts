import { describe, expect, it } from "vitest";
import { PostgresDomainEventOutboxStore } from "../src/domain-event-outbox.js";

describe("PostgresDomainEventOutboxStore", () => {
  it("reads an aggregate-only backlog snapshot", async () => {
    const queries: string[] = [];
    const store = new PostgresDomainEventOutboxStore({
      query: async (sql) => {
        queries.push(sql);
        return { rows: [{ pending: "4", oldest_pending_age_seconds: "65.9", max_attempts: "2" }], rowCount: 1 };
      },
    });

    await expect(store.getHealth()).resolves.toEqual({ pending: 4, oldestPendingAgeSeconds: 65, maxAttempts: 2 });
    expect(queries[0]).toContain("WHERE published_at IS NULL");
    expect(queries[0]).not.toContain("payload");
  });
});
