import type { Queue, QueueConsumer } from "./types.js";

/** Processes one bounded batch; hosting code controls polling and shutdown. */
export async function consumeBatch<T>(queue: Queue<T>, consumer: QueueConsumer<T>, maxMessages = 1, signal?: AbortSignal): Promise<number> {
  const messages = await queue.receive(maxMessages, signal);
  for (const message of messages) {
    await consumer.handle(message.body, signal);
    await queue.acknowledge(message.receipt);
  }
  return messages.length;
}
