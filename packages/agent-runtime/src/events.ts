import { randomUUID } from "node:crypto";
import { RunEventSchema, type NewRunEvent, type RunEvent } from "@research/contracts";
import type { RunEventSink } from "./types.js";

/** Development adapter; production uses the PostgreSQL outbox-backed event sink. */
export class InMemoryRunEventSink implements RunEventSink {
  readonly events: RunEvent[] = [];
  private pending = Promise.resolve();

  async append(event: NewRunEvent): Promise<RunEvent> {
    const operation = this.pending.then(() => {
      const stored = RunEventSchema.parse({ ...event, id: randomUUID(), sequence: this.events.length + 1 });
      this.events.push(stored);
      return stored;
    });
    this.pending = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
