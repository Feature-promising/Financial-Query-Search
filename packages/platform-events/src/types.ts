import type { DomainEvent } from "@research/contracts";

/** External bus adapter. Consumers must use the event ID for idempotency. */
export interface DomainEventPublisher {
  publish(events: DomainEvent[]): Promise<void>;
}

/** Durable source of events that have committed but are not yet delivered. */
export interface PublishableDomainEventOutbox {
  claimBatch(limit: number, lockSeconds?: number): Promise<DomainEvent[]>;
  markPublished(id: string): Promise<void>;
  release(id: string): Promise<void>;
}
