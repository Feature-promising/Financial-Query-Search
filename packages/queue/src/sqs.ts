import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { Queue, QueueMessage } from "./types.js";

export class SqsQueue<T> implements Queue<T> {
  private readonly client: SQSClient;
  constructor(private readonly options: { queueUrl: string; region: string; waitTimeSeconds?: number; visibilityTimeoutSeconds?: number; client?: SQSClient }) {
    this.client = options.client ?? new SQSClient({ region: options.region });
  }
  async enqueue(message: T): Promise<void> {
    await this.client.send(new SendMessageCommand({ QueueUrl: this.options.queueUrl, MessageBody: JSON.stringify(message) }));
  }
  async receive(maxMessages: number, signal?: AbortSignal): Promise<QueueMessage<T>[]> {
    const result = await this.client.send(
      new ReceiveMessageCommand({ QueueUrl: this.options.queueUrl, MaxNumberOfMessages: Math.min(maxMessages, 10), WaitTimeSeconds: this.options.waitTimeSeconds ?? 20, VisibilityTimeout: this.options.visibilityTimeoutSeconds ?? 60, MessageSystemAttributeNames: ["ApproximateReceiveCount"] }),
      { abortSignal: signal },
    );
    return (result.Messages ?? []).flatMap((message) => {
      if (!message.MessageId || !message.ReceiptHandle || !message.Body) return [];
      try { return [{ id: message.MessageId, receipt: message.ReceiptHandle, body: JSON.parse(message.Body) as T, attempts: Number(message.Attributes?.ApproximateReceiveCount ?? 1) }]; }
      catch { throw new Error(`SQS message ${message.MessageId} contains invalid JSON`); }
    });
  }
  async acknowledge(receipt: string): Promise<void> { await this.client.send(new DeleteMessageCommand({ QueueUrl: this.options.queueUrl, ReceiptHandle: receipt })); }
}
