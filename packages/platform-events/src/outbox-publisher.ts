import type { DomainEventPublisher, PublishableDomainEventOutbox } from "./types.js";

/**
 * Delivers a claimed batch atomically from the consumer perspective: on any
 * provider failure the whole batch remains available for at-least-once retry.
 */
export class DomainEventOutboxPublisher {
  constructor(private readonly outbox: PublishableDomainEventOutbox, private readonly publisher: DomainEventPublisher) {}

  async publishBatch(limit = 10): Promise<number> {
    const events = await this.outbox.claimBatch(limit);
    if (events.length === 0) return 0;
    try {
      await this.publisher.publish(events);
      for (const event of events) await this.outbox.markPublished(event.id);
      return events.length;
    } catch (error) {
      await Promise.all(events.map(async (event) => this.outbox.release(event.id)));
      throw error;
    }
  }
}
