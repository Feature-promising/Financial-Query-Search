import { describe, expect, it } from "vitest";
import { RateLimitedDomainEventOutboxHealthReporter } from "../src/index.js";

describe("RateLimitedDomainEventOutboxHealthReporter", () => {
  it("emits aggregate-only outbox health at a bounded cadence", async () => {
    const lines: string[] = [];
    let time = 1_000;
    const reporter = new RateLimitedDomainEventOutboxHealthReporter(
      { getHealth: async () => ({ pending: 7, oldestPendingAgeSeconds: 91.9, maxAttempts: 3 }) },
      60_000,
      () => time,
      (line) => lines.push(line),
    );

    await expect(reporter.reportIfDue()).resolves.toBe(true);
    await expect(reporter.reportIfDue()).resolves.toBe(false);
    time += 60_000;
    await expect(reporter.reportIfDue()).resolves.toBe(true);

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({
      level: "info",
      event: "domain_event_outbox_health",
      domain_event_outbox_pending: 7,
      domain_event_outbox_oldest_age_seconds: 91.9,
      domain_event_outbox_max_attempts: 3,
    });
  });

  it("sanitizes a broken metrics source instead of emitting invalid values", async () => {
    const lines: string[] = [];
    const reporter = new RateLimitedDomainEventOutboxHealthReporter(
      { getHealth: async () => ({ pending: Number.NaN, oldestPendingAgeSeconds: -4, maxAttempts: Number.POSITIVE_INFINITY }) },
      60_000,
      () => 1_000,
      (line) => lines.push(line),
    );

    await reporter.reportIfDue();
    expect(JSON.parse(lines[0]!)).toMatchObject({
      domain_event_outbox_pending: 0,
      domain_event_outbox_oldest_age_seconds: 0,
      domain_event_outbox_max_attempts: 0,
    });
  });
});
