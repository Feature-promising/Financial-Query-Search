import { describe, expect, it } from "vitest";
import { RateLimitedDomainEventFailureReporter } from "../src/consumer/domain-event-failure-reporter.js";

describe("RateLimitedDomainEventFailureReporter", () => {
  it("distinguishes a monitoring-query fault from an EventBridge delivery fault", () => {
    const lines: string[] = [];
    const reporter = new RateLimitedDomainEventFailureReporter(60_000, (line) => lines.push(line));

    reporter.report(new Error("database password=secret"), "domain_event_outbox_health_failed");
    const record = JSON.parse(lines[0]!);
    expect(record).toMatchObject({
      event: "domain_event_outbox_health_failed",
      errorType: "Error",
    });
    expect(JSON.stringify(record)).not.toContain("password=secret");
  });
});
