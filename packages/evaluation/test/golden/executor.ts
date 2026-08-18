import { randomUUID } from "node:crypto";
import type { Claim, EvidenceItem, ResearchScope, ResearchTask } from "@research/contracts";
import { InMemoryRunEventSink, ResearchRuntime } from "../../../agent-runtime/src/index.js";
import { InMemoryStore } from "../../../memory/src/index.js";
import { InMemoryToolAuditSink, ReportTool, ToolRegistry, type Tool } from "../../../tools/src/index.js";
import { evaluateCase, type EvaluationResult } from "../../src/index.js";
import type { GoldenFixture } from "./fixtures.js";

const fixtureToolId = "fixture.evidence";
const incompleteTaskToolId = "fixture.required-source";

export async function executeGoldenFixture(fixture: GoldenFixture): Promise<EvaluationResult> {
  const registry = new ToolRegistry(new InMemoryToolAuditSink());
  registry.register(new ReportTool());
  registry.register(fixtureTool(fixture));
  if (fixture.outcome === "incomplete_plan") registry.register(incompleteTaskTool());
  const runtime = new ResearchRuntime({
    events: new InMemoryRunEventSink(),
    memories: new InMemoryStore(),
    tools: registry,
    planner: { plan: async () => ({ summary: fixture.evaluation.id, tasks: tasksFor(fixture) }) },
    claimComposer: { compose: async (evidence) => claimsFor(fixture, evidence) },
  });
  const result = await runtime.run({
    runId: randomUUID(),
    conversationId: randomUUID(),
    question: fixture.evaluation.question,
    scope: scopeFor(fixture),
    budget: { maxTasks: 12, maxToolCalls: 24, maxToolDurationMs: 20_000, maxRunDurationMs: 300_000, maxCriticRepairs: fixture.outcome === "incomplete_plan" ? 0 : 1, maxEstimatedCostUsd: 5 },
  });
  return evaluateCase(fixture.evaluation, result.status, result.state.claims, result.state.evidence);
}

function tasksFor(fixture: GoldenFixture): ResearchTask[] {
  const evidenceTask: ResearchTask = {
    id: fixture.evaluation.id,
    title: fixture.evaluation.category,
    objective: "Run a deterministic golden-evaluation source fixture.",
    dependsOn: [],
    allowedTools: [fixtureToolId],
    acceptanceCriteria: ["Return verified evidence or an explicit failure."],
    status: "pending",
  };
  if (fixture.outcome !== "incomplete_plan") return [evidenceTask];
  return [
    evidenceTask,
    {
      id: "required-source",
      title: "Required independent source",
      objective: "Complete the required research-plan coverage.",
      dependsOn: [],
      allowedTools: [incompleteTaskToolId],
      acceptanceCriteria: ["Return required evidence."],
      status: "pending",
    },
  ];
}

function fixtureTool(fixture: GoldenFixture): Tool<{ query: string }, { status: "ok" }> {
  return {
    manifest: { id: fixtureToolId, version: "golden-v1", capability: "golden_fixture", requiredEntitlements: fixture.outcome === "authorization_boundary" ? ["market-data"] : [], timeoutMs: 500, enabled: true },
    input: schema<{ query: string }>(),
    output: schema<{ status: "ok" }>(),
    async invoke() {
  if (fixture.outcome === "missing_evidence") return { ok: false, failure: { code: "UNAVAILABLE", message: "fixture source unavailable", retryable: false }, estimatedCostUsd: 0 };
      return { ok: true, value: { status: "ok" }, evidence: [fixture.evidence, ...(fixture.additionalEvidence ?? [])].filter((item): item is EvidenceItem => Boolean(item)), estimatedCostUsd: 0 };
    },
  };
}

function scopeFor(fixture: GoldenFixture): ResearchScope {
  return {
    organizationId: "golden-org",
    userId: "golden-user",
    roles: ["researcher"],
    entitlements: fixture.outcome === "financial_data_conflict" ? ["market-data"] : [],
  };
}

function claimsFor(fixture: GoldenFixture, evidence: EvidenceItem[]): Claim[] {
  if (fixture.outcome === "missing_evidence" || fixture.outcome === "authorization_boundary" || fixture.outcome === "prompt_injection" || !evidence[0]) return [];
  const text = fixture.outcome === "financial_data_conflict" ? "Revenue was 130" : "Revenue was $100 million.";
  return [{ id: randomUUID(), text, evidenceIds: [evidence[0].id], confidence: 0.9, qualification: null }];
}

function incompleteTaskTool(): Tool<{ query: string }, { status: "ok" }> {
  return {
    manifest: { id: incompleteTaskToolId, version: "golden-v1", capability: "golden_fixture", requiredEntitlements: [], timeoutMs: 500, enabled: true },
    input: schema<{ query: string }>(),
    output: schema<{ status: "ok" }>(),
    async invoke() { return { ok: false, failure: { code: "UNAVAILABLE", message: "required fixture source unavailable", retryable: false }, estimatedCostUsd: 0 }; },
  };
}

/** Minimal deterministic Zod-compatible schema used only by controlled test tools. */
function schema<T>(): Tool<T, T>["input"] {
  return { safeParse: (value: T) => ({ success: true as const, data: value }), parse: (value: T) => value } as Tool<T, T>["input"];
}
