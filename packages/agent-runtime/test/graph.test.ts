import { describe, expect, it } from "vitest";
import { InMemoryRunEventSink, ResearchRuntime, researchGraphNodeNames, runResearchGraph } from "../src/index.js";
import { InMemoryStore } from "@research/memory";
import { createDefaultToolRegistry } from "@research/tools";
import { RunCostBudgetExceeded } from "@research/contracts";
import { RunTracer, type TraceEvent } from "@research/observability";

describe("runResearchGraph", () => {
  it("runs one bounded turn through the LangGraph boundary", async () => {
    const runtime = new ResearchRuntime({
      events: new InMemoryRunEventSink(), memories: new InMemoryStore(), tools: createDefaultToolRegistry(),
    });

    const result = await runResearchGraph(runtime, {
      runId: "a8afe4f1-267b-40da-8f9d-c25137156924", conversationId: "0bbd061d-3c55-4c33-a6fe-3764d4c7390d",
      question: "Analyze NVDA", scope: { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] },
      budget: { maxTasks: 12, maxToolCalls: 24, maxToolDurationMs: 20_000, maxRunDurationMs: 300_000, maxCriticRepairs: 1, maxEstimatedCostUsd: 5 },
    });

    expect(result.status).toBe("abstained");
    expect(result.state.run.id).toBe("a8afe4f1-267b-40da-8f9d-c25137156924");
  });

  it("declares explicit bounded research phases rather than a single chat node", () => {
    expect(researchGraphNodeNames).toEqual([
      "start_run", "load_context", "analyze_intent", "plan_research",
      "execute_tasks", "build_evidence", "compose_claims", "critic", "publish_report", "cost_budget_exhausted", "run_deadline_exceeded", "worker_shutdown",
    ]);
  });

  it("takes the graph's terminal refusal path when a model phase exhausts the cost budget", async () => {
    const events = new InMemoryRunEventSink();
    const runtime = new ResearchRuntime({
      events, memories: new InMemoryStore(), tools: createDefaultToolRegistry(),
      intentAnalyzer: { analyze: async () => { throw new RunCostBudgetExceeded(); } },
    });

    const result = await runResearchGraph(runtime, {
      runId: "aed1c85c-9a02-42c1-95ca-cf8232e87016", conversationId: "025ac08a-4eb5-4c2a-9c95-1d30d9a99d13",
      question: "Analyze NVDA", scope: { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] },
      budget: { maxTasks: 12, maxToolCalls: 24, maxToolDurationMs: 20_000, maxRunDurationMs: 300_000, maxCriticRepairs: 1, maxEstimatedCostUsd: 5 },
    });

    expect(result.status).toBe("abstained");
    expect(events.events.map((event) => event.type)).toEqual(["run_started", "critic_result", "abstained"]);
  });

  it("preserves the top-level run trace when the graph owns phase sequencing", async () => {
    const traces: TraceEvent[] = [];
    const runtime = new ResearchRuntime({
      events: new InMemoryRunEventSink(), memories: new InMemoryStore(), tools: createDefaultToolRegistry(),
      tracer: new RunTracer({ emit: async (event) => { traces.push(event); } }, "trace-run"),
    });

    await runResearchGraph(runtime, {
      runId: "e41392b5-f772-45f2-b5ea-2cd5ef67d534", conversationId: "fc7d0b1f-aac1-4330-b104-73bf6d45d004",
      question: "Analyze NVDA", scope: { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] },
      budget: { maxTasks: 12, maxToolCalls: 24, maxToolDurationMs: 20_000, maxRunDurationMs: 300_000, maxCriticRepairs: 1, maxEstimatedCostUsd: 5 },
    });

    expect(traces.some((event) => event.name === "research.run" && event.attributes.outcome === "success")).toBe(true);
  });

  it("takes the graph's terminal refusal path when a model phase exceeds the run deadline", async () => {
    const runtime = new ResearchRuntime({
      events: new InMemoryRunEventSink(), memories: new InMemoryStore(), tools: createDefaultToolRegistry(),
      intentAnalyzer: {
        analyze: async (_question, signal) => {
          await new Promise<never>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
          throw new Error("unreachable");
        },
      },
    });

    const result = await runResearchGraph(runtime, {
      runId: "de9f04b7-0234-4a10-818c-7f7a49cee22f", conversationId: "9e68b7ef-bc48-4678-a39d-7327f4d63f11",
      question: "Analyze NVDA", scope: { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] },
      budget: { maxTasks: 12, maxToolCalls: 24, maxToolDurationMs: 20_000, maxRunDurationMs: 20, maxCriticRepairs: 1, maxEstimatedCostUsd: 5 },
    });

    expect(result.status).toBe("abstained");
    expect(result.answer).toContain("time budget");
  });

  it("records an abstention when the worker drain signal interrupts a model phase", async () => {
    const controller = new AbortController();
    const events = new InMemoryRunEventSink();
    const runtime = new ResearchRuntime({
      events, memories: new InMemoryStore(), tools: createDefaultToolRegistry(),
      intentAnalyzer: {
        analyze: async (_question, signal) => {
          setTimeout(() => controller.abort(), 5);
          await new Promise<never>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
          throw new Error("unreachable");
        },
      },
    });

    const result = await runResearchGraph(runtime, {
      runId: "b2b2c3c6-bf3d-4334-a069-8ee73b63d2fc", conversationId: "c46e5e8c-79f0-4bc3-b4fb-2ec583083ee7",
      question: "Analyze NVDA", scope: { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] },
      budget: { maxTasks: 12, maxToolCalls: 24, maxToolDurationMs: 20_000, maxRunDurationMs: 300_000, maxCriticRepairs: 1, maxEstimatedCostUsd: 5 },
      shutdownSignal: controller.signal,
    });

    expect(result.status).toBe("abstained");
    expect(result.answer).toContain("Worker shutdown");
    expect(events.events.find((event) => event.type === "critic_result")?.payload).toMatchObject({ phase: "worker_shutdown" });
  });
});
