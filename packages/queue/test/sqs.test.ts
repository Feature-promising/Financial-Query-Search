import { ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { describe, expect, it } from "vitest";
import { SqsQueue } from "../src/index.js";

describe("SqsQueue", () => {
  it("passes the configured visibility timeout on every research-message receive", async () => {
    const client = new FakeSqsClient();
    const queue = new SqsQueue<{ runId: string }>({ queueUrl: "https://sqs.us-east-1.amazonaws.com/123/research", region: "us-east-1", visibilityTimeoutSeconds: 360, client: client as never });

    await queue.receive(1);

    expect(client.receive?.input.VisibilityTimeout).toBe(360);
  });

  it("uses a cancellable 20-second long poll by default", async () => {
    const client = new FakeSqsClient();
    const queue = new SqsQueue<{ runId: string }>({ queueUrl: "https://sqs.us-east-1.amazonaws.com/123/research", region: "us-east-1", client: client as never });
    const controller = new AbortController();

    await queue.receive(1, controller.signal);

    expect(client.receive?.input.WaitTimeSeconds).toBe(20);
    expect(client.abortSignal).toBe(controller.signal);
  });
});

class FakeSqsClient {
  receive?: ReceiveMessageCommand;
  abortSignal?: AbortSignal;

  async send(command: ReceiveMessageCommand, options?: { abortSignal?: AbortSignal }): Promise<Record<string, unknown>> {
    this.receive = command;
    this.abortSignal = options?.abortSignal;
    return { Messages: [] };
  }
}
