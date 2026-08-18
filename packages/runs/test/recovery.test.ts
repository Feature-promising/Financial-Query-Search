import { describe, expect, it } from "vitest";
import { InMemoryRunStore, markRunFailedIfActive } from "../src/index.js";
import { randomUUID } from "node:crypto";

describe("run recovery", () => {
  it("permits exactly one failed-to-queued recovery", async () => {
    const store = new InMemoryRunStore();
    const scope = { organizationId: "org", userId: "user", roles: ["researcher"] as const, entitlements: [] };
    const runId = "0a5431bf-c709-4a7c-bcef-5f3f7e1a8b17";
    await store.create(run(runId, scope.userId));
    await store.claim(scope, runId); await store.finish(scope, runId, "failed");
    expect(await store.requeueForRecovery(scope, runId)).toBe(true);
    await store.claim(scope, runId); await store.finish(scope, runId, "failed");
    expect(await store.requeueForRecovery(scope, runId)).toBe(false);
  });

  it("marks an elapsed running lease as failed without executing a second claim", async () => {
    let now = 0;
    const store = new InMemoryRunStore({ leaseDurationMs: 100, now: () => now });
    const scope = { organizationId: "org", userId: "user", roles: ["researcher"] as const, entitlements: [] };
    const runId = "50a4b00e-d29e-4a72-823b-5d6aaac2a5c8";
    await store.create(run(runId, scope.userId));
    await store.claim(scope, runId);
    now = 100;

    expect(await store.expireStaleLease(scope, runId)).toBe(true);
    expect((await store.get(scope, runId))?.status).toBe("failed");
    expect(await store.claim(scope, runId)).toBe(false);
    await expect(store.finish(scope, runId, "completed")).rejects.toThrow("no longer active");
  });

  it("marks only an active run as failed during best-effort error finalization", async () => {
    const store = new InMemoryRunStore();
    const scope = { organizationId: "org", userId: "user", roles: ["researcher"] as const, entitlements: [] };
    const runId = "3a3a9832-40f9-4954-8f84-2b56d0b386e2";
    await store.create(run(runId, scope.userId));
    await store.claim(scope, runId);

    expect(await markRunFailedIfActive(store, scope, runId)).toBe(true);
    expect((await store.get(scope, runId))?.status).toBe("failed");
    expect(await markRunFailedIfActive(store, scope, runId)).toBe(false);
  });

  it("pauses only a queued run and restores it with an ordered audit trail", async () => {
    const store = new InMemoryRunStore();
    const scope = { organizationId: "org", userId: "user", roles: ["researcher"] as const, entitlements: [] };
    const runId = "b74c0649-2e87-46dd-93e7-6ebd3105f225";
    await store.create(run(runId, scope.userId));

    expect(await store.pause(scope, runId, controlEvent(runId, 1, "run_paused"))).toBe("paused");
    expect((await store.get(scope, runId))?.status).toBe("paused");
    expect(await store.claim(scope, runId)).toBe(false);
    expect(await store.resume(scope, runId, controlEvent(runId, 2, "run_resumed"))).toBe("resumed");
    expect((await store.get(scope, runId))?.events.map((event) => event.type)).toEqual(["run_paused", "run_resumed"]);
    expect(await store.claim(scope, runId)).toBe(true);
    expect(await store.pause(scope, runId, controlEvent(runId, 3, "run_paused"))).toBe("not_allowed");
  });
});

function controlEvent(runId: string, sequence: number, type: "run_paused" | "run_resumed") {
  return { id: randomUUID(), runId, sequence, type, at: "2026-08-16T00:00:00.000Z", payload: { reason: "user_requested" as const, safeBoundary: "queued" as const } };
}

function run(id: string, createdBy: string) {
  return {
    id,
    organizationId: "org",
    conversationId: "a11a3b4f-8797-4dfe-bfe3-293beff10f78",
    createdBy,
    question: "q",
    budget: { maxTasks: 1, maxToolCalls: 1, maxToolDurationMs: 1, maxRunDurationMs: 1, maxCriticRepairs: 0, maxEstimatedCostUsd: 1 },
  };
}
