import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RateLimitedLiveEventFailureReporter } from "../src/index.js";

describe("RateLimitedLiveEventFailureReporter", () => {
  it("retains an outage signal without logging every failed fan-out", () => {
    const lines: string[] = [];
    const reporter = new RateLimitedLiveEventFailureReporter(60_000, (line) => lines.push(line));
    const event = { id: randomUUID(), runId: randomUUID(), sequence: 1, type: "run_started" as const, at: "2026-08-14T00:00:00.000Z", payload: { question: "Analyze NVDA" } };

    reporter.report(event, new Error("redis password=secret"));
    reporter.report({ ...event, sequence: 2 }, new Error("redis password=secret"));
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);
    expect(record).toMatchObject({ event: "live_event_publish_failed", errorType: "Error", suppressedSinceLastReport: 0 });
    expect(JSON.stringify(record)).not.toContain("password=secret");
  });
});
