import { trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { TraceEvent, TraceSink } from "./index.js";

export interface OpenTelemetrySdk {
  start(): void;
  shutdown(): Promise<void>;
}

export interface OpenTelemetryLifecycle {
  enabled: boolean;
  shutdown(): Promise<void>;
}

/**
 * Registers the Node SDK before any research span is created. An absent
 * endpoint is an intentional local-development no-op, never an implicit
 * localhost export target.
 */
export function startOpenTelemetry(options: {
  serviceName: string;
  tracesEndpoint?: string;
  sdk?: OpenTelemetrySdk;
}): OpenTelemetryLifecycle {
  if (!options.tracesEndpoint) return { enabled: false, shutdown: async () => undefined };
  const sdk = options.sdk ?? new NodeSDK({
    serviceName: options.serviceName,
    traceExporter: new OTLPTraceExporter({ url: options.tracesEndpoint }),
  });
  sdk.start();
  return { enabled: true, shutdown: () => sdk.shutdown() };
}

/** Bridges the package's content-safe trace event contract to OpenTelemetry. */
export class OpenTelemetryTraceSink implements TraceSink {
  constructor(private readonly tracerName = "interactive-research-agent") {}

  async emit(event: TraceEvent): Promise<void> {
    const span = trace.getTracer(this.tracerName).startSpan(event.name, { startTime: new Date(event.startedAt) });
    span.setAttributes({ "research.trace_id": event.traceId, "research.span_id": event.spanId, ...event.attributes });
    span.end(event.durationMs ? new Date(new Date(event.startedAt).getTime() + event.durationMs) : undefined);
  }
}
