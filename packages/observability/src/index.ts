export interface TraceEvent {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startedAt: string;
  durationMs?: number;
  attributes: Record<string, string | number | boolean>;
}

export interface TraceSink { emit(event: TraceEvent): Promise<void>; }

/** Adapter boundary for OpenTelemetry. No research content is logged by default. */
export class RunTracer {
  constructor(private readonly sink: TraceSink, readonly traceId: string) {}
  async span<T>(name: string, attributes: TraceEvent["attributes"], operation: () => Promise<T>): Promise<T> {
    const started = Date.now();
    const spanId = randomUUID();
    try {
      const result = await operation();
      await this.sink.emit({ traceId: this.traceId, spanId, name, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, attributes: { ...attributes, outcome: "success" } });
      return result;
    } catch (error) {
      await this.sink.emit({ traceId: this.traceId, spanId, name, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, attributes: { ...attributes, outcome: "failure" } });
      throw error;
    }
  }
}
import { randomUUID } from "node:crypto";

export * from "./opentelemetry.js";
export * from "./domain-event-outbox.js";
