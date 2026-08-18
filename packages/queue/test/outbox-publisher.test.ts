import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryQueue, ResearchRunOutboxPublisher, type PublishableOutbox } from "../src/index.js";
import type { OutboxEvent, ResearchRunCommand } from "@research/contracts";

const command: ResearchRunCommand = {
  version: "v2", runId: "23602739-5277-48ac-a92a-9e9f71bb0132", conversationId: "b71f095f-9bd4-4c3c-bc84-7b4b3d45291e",
  scope: { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] }, question: "Analyze NVDA",
  toolManifestSnapshot: [{ id: "filing.search", version: "1", capability: "sec_filing_retrieval", requiredEntitlements: [], timeoutMs: 20_000, enabled: true }], requestedAt: "2026-08-14T08:00:00.000Z",
};

describe("ResearchRunOutboxPublisher", () => {
  it("publishes a claimed command then marks it as published", async () => {
    const outbox = new StubOutbox([event(command)]);
    const queue = new InMemoryQueue<ResearchRunCommand>();
    expect(await new ResearchRunOutboxPublisher(outbox, queue).publishBatch()).toBe(1);
    expect(outbox.published).toHaveLength(1);
    expect((await queue.receive(1))[0]?.body).toEqual(command);
  });
});

class StubOutbox implements PublishableOutbox {
  readonly published: string[] = [];
  constructor(private readonly events: OutboxEvent[]) {}
  async claimBatch(): Promise<OutboxEvent[]> { return this.events; }
  async markPublished(id: string): Promise<void> { this.published.push(id); }
  async release(): Promise<void> { throw new Error("unexpected release"); }
}

function event(payload: ResearchRunCommand): OutboxEvent {
  return { id: randomUUID(), type: "research_run_requested", payload, occurredAt: "2026-08-14T08:00:00.000Z", attempts: 1 };
}
