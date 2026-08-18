import { describe, expect, it } from "vitest";
import { PostgresRunCheckpointSink } from "../src/index.js";

describe("PostgresRunCheckpointSink", () => {
  it("appends phase snapshots with run and tenant scope", async () => {
    const calls: unknown[][] = [];
    const sink = new PostgresRunCheckpointSink({ query: async (_sql, values = []) => { calls.push(values); return { rows: [], rowCount: 1 }; } });
    await sink.save({ runId: "run-1", organizationId: "org-1", phase: "planned", snapshot: { tasks: [] }, createdAt: "2026-08-14T00:00:00.000Z" });
    expect(calls).toEqual([["run-1", "org-1", "planned", { tasks: [] }, "2026-08-14T00:00:00.000Z"]]);
  });
});
