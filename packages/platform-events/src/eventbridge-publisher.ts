import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { DomainEventSchema, type DomainEvent } from "@research/contracts";
import type { DomainEventPublisher } from "./types.js";

interface EventBridgeClientLike {
  send(command: PutEventsCommand): Promise<{ FailedEntryCount?: number; Entries?: Array<{ ErrorCode?: string; ErrorMessage?: string }> }>;
}

export interface AwsEventBridgePublisherOptions {
  region: string;
  eventBusName: string;
  source?: string;
  client?: EventBridgeClientLike;
}

/** AWS EventBridge implementation with strict partial-failure handling. */
export class AwsEventBridgePublisher implements DomainEventPublisher {
  private readonly client: EventBridgeClientLike;
  private readonly source: string;

  constructor(private readonly options: AwsEventBridgePublisherOptions) {
    this.client = options.client ?? new EventBridgeClient({ region: options.region });
    this.source = options.source ?? "interactive-research-agent";
  }

  async publish(events: DomainEvent[]): Promise<void> {
    for (const chunk of chunks(events.map((event) => DomainEventSchema.parse(event)), 10)) {
      const response = await this.client.send(new PutEventsCommand({
        Entries: chunk.map((event) => ({
          EventBusName: this.options.eventBusName,
          Source: this.source,
          DetailType: event.type,
          Time: new Date(event.occurredAt),
          Detail: JSON.stringify(event),
        })),
      }));
      const failure = response.Entries?.find((entry) => entry.ErrorCode || entry.ErrorMessage);
      if ((response.FailedEntryCount ?? 0) > 0 || failure) {
        throw new Error(`EventBridge rejected lifecycle event: ${failure?.ErrorCode ?? failure?.ErrorMessage ?? "unknown failure"}`);
      }
    }
  }
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}
