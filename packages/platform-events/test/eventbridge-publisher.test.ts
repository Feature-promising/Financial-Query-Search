import { describe, expect, it } from "vitest";
import { AwsEventBridgePublisher } from "../src/index.js";
import type { DomainEvent } from "@research/contracts";

const event: DomainEvent = {
  id: "fa6229ec-b234-4e2f-b06e-4123da270359",
  type: "research.run.lifecycle",
  tenantId: "tenant-1",
  aggregateId: "cca954c0-1b2f-4b34-9906-b6ea9aa98071",
  occurredAt: "2026-08-14T08:00:00.000Z",
  data: { runId: "cca954c0-1b2f-4b34-9906-b6ea9aa98071", sequence: 2, eventType: "plan_ready" },
};

describe("AwsEventBridgePublisher", () => {
  it("publishes metadata-only lifecycle records to the configured bus", async () => {
    let input: unknown;
    const publisher = new AwsEventBridgePublisher({
      region: "us-east-1",
      eventBusName: "research-domain-events",
      client: { send: async (command) => { input = command.input; return { FailedEntryCount: 0, Entries: [{}] }; } },
    });

    await publisher.publish([event]);
    expect(input).toMatchObject({ Entries: [{ EventBusName: "research-domain-events", Source: "interactive-research-agent", DetailType: "research.run.lifecycle" }] });
    expect(JSON.parse((input as { Entries: Array<{ Detail: string }> }).Entries[0]!.Detail)).toEqual(event);
  });

  it("fails closed on a partial provider rejection", async () => {
    const publisher = new AwsEventBridgePublisher({
      region: "us-east-1",
      eventBusName: "research-domain-events",
      client: { send: async () => ({ FailedEntryCount: 1, Entries: [{ ErrorCode: "AccessDeniedException" }] }) },
    });

    await expect(publisher.publish([event])).rejects.toThrow("AccessDeniedException");
  });
});
