import { randomUUID } from "node:crypto";
import type { Queue, QueueMessage } from "./types.js";

export class InMemoryQueue<T> implements Queue<T> {
  private readonly messages: QueueMessage<T>[] = [];
  async enqueue(body: T): Promise<void> { this.messages.push({ id: randomUUID(), receipt: randomUUID(), body, attempts: 0 }); }
  async receive(maxMessages: number, _signal?: AbortSignal): Promise<QueueMessage<T>[]> {
    return this.messages.slice(0, maxMessages).map((message) => {
      message.attempts += 1;
      return { ...message };
    });
  }
  async acknowledge(receipt: string): Promise<void> {
    const index = this.messages.findIndex((message) => message.receipt === receipt);
    if (index >= 0) this.messages.splice(index, 1);
  }
}
