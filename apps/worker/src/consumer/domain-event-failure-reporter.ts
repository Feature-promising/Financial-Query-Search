export interface DomainEventFailureReporter {
  report(error: unknown, eventName?: "domain_event_publish_failed" | "domain_event_outbox_health_failed"): void;
}

/**
 * EventBridge is non-authoritative because its source event is already durable
 * in PostgreSQL. Keep failures visible while allowing time-bounded research
 * work to continue and the outbox to retry on a later worker cycle.
 */
export class RateLimitedDomainEventFailureReporter implements DomainEventFailureReporter {
  private lastReportedAt = 0;
  private suppressed = 0;

  constructor(private readonly minimumIntervalMs = 60_000, private readonly write: (line: string) => void = (line) => process.stderr.write(line)) {}

  report(error: unknown, eventName: "domain_event_publish_failed" | "domain_event_outbox_health_failed" = "domain_event_publish_failed"): void {
    const now = Date.now();
    if (now - this.lastReportedAt < this.minimumIntervalMs) {
      this.suppressed += 1;
      return;
    }
    this.write(`${JSON.stringify({
      level: "warn",
      event: eventName,
      errorType: safeErrorType(error),
      suppressedSinceLastReport: this.suppressed,
    })}\n`);
    this.lastReportedAt = now;
    this.suppressed = 0;
  }
}

function safeErrorType(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  return /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(error.name) ? error.name : "error";
}
