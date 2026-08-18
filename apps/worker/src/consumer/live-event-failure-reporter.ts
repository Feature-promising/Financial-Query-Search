import type { RunEvent } from "@research/contracts";

export interface LiveEventFailureReporter {
  report(event: RunEvent, error: unknown): void;
}

/**
 * Redis fan-out is non-authoritative, but outages must still be visible without
 * turning every runtime event into an unbounded CloudWatch log burst.
 */
export class RateLimitedLiveEventFailureReporter implements LiveEventFailureReporter {
  private lastReportedAt = 0;
  private suppressed = 0;

  constructor(private readonly minimumIntervalMs = 60_000, private readonly write: (line: string) => void = (line) => process.stderr.write(line)) {}

  report(event: RunEvent, error: unknown): void {
    const now = Date.now();
    if (now - this.lastReportedAt < this.minimumIntervalMs) {
      this.suppressed += 1;
      return;
    }
    this.write(`${JSON.stringify({
      level: "warn",
      event: "live_event_publish_failed",
      runId: event.runId,
      eventType: event.type,
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
