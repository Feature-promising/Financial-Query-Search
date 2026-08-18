import type { OutboxEvent, ResearchRunCommand } from "@research/contracts";
import type { Queue } from "./types.js";

export interface PublishableOutbox {
  claimBatch(limit: number, lockSeconds?: number): Promise<OutboxEvent[]>;
  markPublished(id: string): Promise<void>;
  release(id: string): Promise<void>;
}

/**
 * Copies durable outbox commands into the transport. SQS's at-least-once
 * semantics are paired with the worker-side atomic run claim.
 */
export class ResearchRunOutboxPublisher {
  constructor(private readonly outbox: PublishableOutbox, private readonly queue: Queue<ResearchRunCommand>) {}

  async publishBatch(limit = 10): Promise<number> {
    const events = await this.outbox.claimBatch(limit);
    for (const event of events) {
      try {
        await this.queue.enqueue(event.payload);
        await this.outbox.markPublished(event.id);
      } catch (error) {
        await this.outbox.release(event.id);
        throw error;
      }
    }
    return events.length;
  }
}
