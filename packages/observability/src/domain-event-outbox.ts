/**
 * Minimal contract intentionally decoupled from the database adapter. It keeps
 * operational monitoring content-free and lets alternate stores expose the
 * same health signal without coupling to PostgreSQL.
 */
export interface DomainEventOutboxHealthSource {
  getHealth(): Promise<DomainEventOutboxHealthSnapshot>;
}

export interface DomainEventOutboxHealthSnapshot {
  pending: number;
  oldestPendingAgeSeconds: number;
  maxAttempts: number;
}

export interface DomainEventOutboxHealthReporter {
  reportIfDue(): Promise<boolean>;
}

/**
 * Emits CloudWatch Logs JSON metric values at a bounded cadence. The record
 * contains aggregate counters only and is safe for the worker log stream.
 */
export class RateLimitedDomainEventOutboxHealthReporter implements DomainEventOutboxHealthReporter {
  private lastReportedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly source: DomainEventOutboxHealthSource,
    private readonly minimumIntervalMs = 60_000,
    private readonly now: () => number = () => Date.now(),
    private readonly write: (line: string) => void = (line) => process.stdout.write(line),
  ) {}

  async reportIfDue(): Promise<boolean> {
    const current = this.now();
    if (current - this.lastReportedAt < this.minimumIntervalMs) return false;
    const health = await this.source.getHealth();
    this.lastReportedAt = current;
    this.write(`${JSON.stringify({
      level: "info",
      event: "domain_event_outbox_health",
      domain_event_outbox_pending: finiteNonNegative(health.pending),
      domain_event_outbox_oldest_age_seconds: finiteNonNegative(health.oldestPendingAgeSeconds),
      domain_event_outbox_max_attempts: finiteNonNegative(health.maxAttempts),
    })}\n`);
    return true;
  }
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
