import { describe, expect, it } from "vitest";
import { decideRecovery } from "../src/index.js";

describe("recovery policy", () => {
  it("only permits automatic retry before task execution", () => {
    const base = { runId: "run", organizationId: "org", snapshot: { tasks: [], evidenceIds: [], claims: [] }, createdAt: "2026-08-14T00:00:00.000Z" };
    expect(decideRecovery({ ...base, phase: "planned" }).automatic).toBe(true);
    expect(decideRecovery({ ...base, phase: "tasks_executed" }).automatic).toBe(false);
    expect(decideRecovery(undefined).automatic).toBe(false);
  });
});
