import { describe, expect, it } from "vitest";
import { DomainEventOutboxPublisher } from "../src/index.js";
import type { DomainEvent } from "@research/contracts";

const event: DomainEvent = {
  id: "1e198dbd-bf30-4d62-887c-4c8586fe0778",
  type: "research.run.lifecycle",
  tenantId: "tenant-1",
  aggregateId: "e22c851a-a6c1-49f0-9996-2bd14db3870d",
  occurredAt: "2026-08-14T08:00:00.000Z",
  data: { runId: "e22c851a-a6c1-49f0-9996-2bd14db3870d", sequence: 1, eventType: "run_started" },
};

describe("DomainEventOutboxPublisher", () => {
  it("marks committed events as published only after EventBridge accepts the batch", async () => {
    const published: DomainEvent[][] = [];
    const marked: string[] = [];
    const dispatcher = new DomainEventOutboxPublisher(
      { claimBatch: async () => [event], markPublished: async (id) => { marked.push(id); }, release: async () => undefined },
      { publish: async (events) => { published.push(events); } },
    );

    await expect(dispatcher.publishBatch()).resolves.toBe(1);
    expect(published).toEqual([[event]]);
    expect(marked).toEqual([event.id]);
  });

  it("releases the full batch for at-least-once retry if publication fails", async () => {
    const released: string[] = [];
    const dispatcher = new DomainEventOutboxPublisher(
      { claimBatch: async () => [event], markPublished: async () => undefined, release: async (id) => { released.push(id); } },
      { publish: async () => { throw new Error("eventbridge unavailable"); } },
    );

    await expect(dispatcher.publishBatch()).rejects.toThrow("eventbridge unavailable");
    expect(released).toEqual([event.id]);
  });
});
