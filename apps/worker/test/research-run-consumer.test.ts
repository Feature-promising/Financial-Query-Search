import { describe, expect, it } from "vitest";
import { InMemoryQueue } from "@research/queue";
import { InMemoryConversationStore } from "@research/conversation";
import { DefaultPlanner, ResearchRuntime } from "@research/agent-runtime";
import type { RunBudget, RunCostLedger } from "@research/contracts";
import { InMemoryStore } from "@research/memory";
import { InMemoryRunStore } from "@research/runs";
import { createDefaultToolRegistry } from "@research/tools";
import { DurableResearchRunHandler, PollingResearchWorker, ResearchRunConsumer, type ResearchRunCommand } from "../src/index.js";

class EventPersistenceFailureRunStore extends InMemoryRunStore {
  override async appendEvent(..._args: Parameters<InMemoryRunStore["appendEvent"]>): Promise<void> {
    throw new Error("run event store unavailable");
  }
}

const command: ResearchRunCommand = {
  runId: "0575f74e-fd3d-4b5c-94f7-8b59e680d10d",
  conversationId: "a5b46706-5772-4b52-b3eb-07f59131656a",
  version: "v2",
  scope: { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] },
  question: "Analyze NVDA's latest filing",
  toolManifestSnapshot: [
    { id: "filing.search", version: "1", capability: "sec_filing_retrieval", requiredEntitlements: [], timeoutMs: 20_000, enabled: true },
    { id: "financial.get", version: "1", capability: "licensed_financial_data", requiredEntitlements: [], timeoutMs: 20_000, enabled: true },
    { id: "retrieval.search", version: "1", capability: "hybrid_retrieval", requiredEntitlements: [], timeoutMs: 20_000, enabled: true },
    { id: "analysis.dcf", version: "dcf-v1", capability: "deterministic_valuation", requiredEntitlements: [], timeoutMs: 5_000, enabled: true },
  ],
  requestedAt: "2026-08-14T08:00:00.000Z",
};

describe("ResearchRunConsumer", () => {
  it("validates then dispatches a bounded queue batch", async () => {
    const queue = new InMemoryQueue<ResearchRunCommand>();
    await queue.enqueue(command);
    const received: ResearchRunCommand[] = [];
    const consumer = new ResearchRunConsumer({ handle: async (message) => { received.push(message); } });

    expect(await new PollingResearchWorker(queue, consumer).processOnce()).toBe(1);
    expect(received).toEqual([command]);
    expect(await queue.receive(1)).toEqual([]);
  });

  it("forwards a worker drain signal to the durable run handler", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const consumer = new ResearchRunConsumer({ handle: async (_message, signal) => { receivedSignal = signal; } });

    await consumer.handle(command, controller.signal);
    expect(receivedSignal).toBe(controller.signal);
  });

  it("claims only one long-running research run per worker poll by default", async () => {
    const queue = new InMemoryQueue<ResearchRunCommand>();
    await queue.enqueue(command);
    await queue.enqueue({ ...command, runId: "ce1a2817-1768-49ff-b701-40525336e08b" });
    const received: string[] = [];
    const consumer = new ResearchRunConsumer({ handle: async (message) => { received.push(message.runId); } });

    expect(await new PollingResearchWorker(queue, consumer).processOnce()).toBe(1);
    expect(received).toEqual([command.runId]);
    expect(await queue.receive(2)).toHaveLength(1);
  });

  it("claims a queued run and persists its auditable events", async () => {
    const conversations = new InMemoryConversationStore();
    const conversation = await conversations.create(command.scope, "Test");
    const runs = new InMemoryRunStore();
    await runs.create({ id: command.runId, organizationId: command.scope.organizationId, conversationId: conversation.id, createdBy: command.scope.userId, question: command.question, budget: { maxTasks: 12, maxToolCalls: 24, maxToolDurationMs: 20_000, maxRunDurationMs: 300_000, maxCriticRepairs: 1, maxEstimatedCostUsd: 5 } });
    const handler = new DurableResearchRunHandler({
      conversations, runs,
      runtime: { create: (events) => new ResearchRuntime({ events, memories: new InMemoryStore(), tools: createDefaultToolRegistry() }) },
    });

    await handler.handle({ ...command, conversationId: conversation.id });
    const run = await runs.get(command.scope, command.runId);
    expect(run?.status).toBe("abstained");
    expect(run?.events.map((event) => event.type)).toContain("abstained");
    expect((await conversations.listMessages(command.scope, conversation.id)).at(-1)?.role).toBe("assistant");
  });

  it("delegates final report/message/run persistence to an injected atomic finalizer", async () => {
    const conversations = new InMemoryConversationStore();
    const conversation = await conversations.create(command.scope, "Atomic finalization");
    const runs = new InMemoryRunStore();
    await runs.create({ id: command.runId, organizationId: command.scope.organizationId, conversationId: conversation.id, createdBy: command.scope.userId, question: command.question, budget: { maxTasks: 12, maxToolCalls: 24, maxToolDurationMs: 20_000, maxRunDurationMs: 300_000, maxCriticRepairs: 1, maxEstimatedCostUsd: 5 } });
    let finalized: { status: string; answer: string } | undefined;
    const handler = new DurableResearchRunHandler({
      conversations, runs,
      finalizer: { finalize: async (scope, publication) => {
        finalized = publication;
        await conversations.appendMessage(scope, { conversationId: conversation.id, role: "assistant", content: publication.answer, runId: publication.runId });
        await runs.finish(scope, publication.runId, publication.status, publication.answer);
      } },
      runtime: { create: (events) => new ResearchRuntime({ events, memories: new InMemoryStore(), tools: createDefaultToolRegistry() }) },
    });

    await handler.handle({ ...command, conversationId: conversation.id });
    expect(finalized).toMatchObject({ status: "abstained" });
    expect((await runs.get(command.scope, command.runId))?.status).toBe("abstained");
  });

  it("does not persist a successful terminal event when atomic publication fails", async () => {
    const conversations = new InMemoryConversationStore();
    const conversation = await conversations.create(command.scope, "Failed atomic finalization");
    const runs = new InMemoryRunStore();
    await runs.create({ id: command.runId, organizationId: command.scope.organizationId, conversationId: conversation.id, createdBy: command.scope.userId, question: command.question, budget: { maxTasks: 12, maxToolCalls: 24, maxToolDurationMs: 20_000, maxRunDurationMs: 300_000, maxCriticRepairs: 1, maxEstimatedCostUsd: 5 } });
    const handler = new DurableResearchRunHandler({
      conversations, runs,
      finalizer: { finalize: async () => { throw new Error("database publication failed"); } },
      runtime: { create: (events) => new ResearchRuntime({ events, memories: new InMemoryStore(), tools: createDefaultToolRegistry() }) },
    });

    await expect(handler.handle({ ...command, conversationId: conversation.id })).rejects.toThrow("database publication failed");
    const run = await runs.get(command.scope, command.runId);
    expect(run?.status).toBe("failed");
    expect(run?.events.some((event) => event.type === "abstained" || event.type === "completed")).toBe(false);
    expect(run?.events.at(-1)?.type).toBe("failed");
  });

  it("executes and accounts against the durable run budget rather than worker defaults", async () => {
    const conversations = new InMemoryConversationStore();
    const conversation = await conversations.create(command.scope, "Immutable budget");
    const runs = new InMemoryRunStore();
    const budget: RunBudget = { maxTasks: 3, maxToolCalls: 3, maxToolDurationMs: 1_000, maxRunDurationMs: 1_000, maxCriticRepairs: 0, maxEstimatedCostUsd: 0.5 };
    await runs.create({ id: command.runId, organizationId: command.scope.organizationId, conversationId: conversation.id, createdBy: command.scope.userId, question: command.question, budget });
    let plannerBudget: RunBudget | undefined;
    let ledger: RunCostLedger | undefined;
    const handler = new DurableResearchRunHandler({
      conversations,
      runs,
      runtime: { create: (events, _command, costLedger) => {
        ledger = costLedger;
        return new ResearchRuntime({
          events,
          memories: new InMemoryStore(),
          tools: createDefaultToolRegistry(),
          planner: { plan: async (intent, question, receivedBudget) => {
            plannerBudget = receivedBudget;
            return new DefaultPlanner().plan(intent, question, receivedBudget);
          } },
          costLedger,
        });
      } },
    });

    await handler.handle({ ...command, conversationId: conversation.id });

    expect(plannerBudget).toEqual(budget);
    expect(ledger?.limitUsd).toBe(budget.maxEstimatedCostUsd);
  });

  it("persists a content-free terminal failure when a runtime dependency exposes a secret", async () => {
    const conversations = new InMemoryConversationStore();
    const conversation = await conversations.create(command.scope, "Safe worker failure");
    const runs = new InMemoryRunStore();
    await runs.create({ id: command.runId, organizationId: command.scope.organizationId, conversationId: conversation.id, createdBy: command.scope.userId, question: command.question, budget: { maxTasks: 12, maxToolCalls: 24, maxToolDurationMs: 20_000, maxRunDurationMs: 300_000, maxCriticRepairs: 1, maxEstimatedCostUsd: 5 } });
    const handler = new DurableResearchRunHandler({
      conversations, runs,
      runtime: { create: (events) => new ResearchRuntime({ events, memories: new InMemoryStore(), tools: createDefaultToolRegistry(), intentAnalyzer: { analyze: async () => { throw new Error("upstream password=super-secret"); } } }) },
    });

    await expect(handler.handle({ ...command, conversationId: conversation.id })).rejects.toThrow("password=super-secret");

    const failure = (await runs.get(command.scope, command.runId))?.events.find((event) => event.type === "failed");
    expect(failure?.payload).toMatchObject({ code: "RUN_FAILED" });
    expect(JSON.stringify(failure)).not.toContain("password=super-secret");
  });

  it("uses the durable command rather than a queue delivery's altered permissions", async () => {
    const conversations = new InMemoryConversationStore();
    const conversation = await conversations.create(command.scope, "Durable authorization");
    const canonical = { ...command, conversationId: conversation.id };
    const runs = new InMemoryRunStore();
    await runs.create({ id: command.runId, organizationId: command.scope.organizationId, conversationId: conversation.id, createdBy: command.scope.userId, question: command.question, budget: { maxTasks: 12, maxToolCalls: 24, maxToolDurationMs: 20_000, maxRunDurationMs: 300_000, maxCriticRepairs: 1, maxEstimatedCostUsd: 5 } });
    let runtimeCommand: ResearchRunCommand | undefined;
    const handler = new DurableResearchRunHandler({
      conversations,
      runs,
      commandResolver: { resolve: async (runId) => runId === canonical.runId ? canonical : undefined },
      runtime: { create: (events, receivedCommand) => {
        runtimeCommand = receivedCommand;
        return new ResearchRuntime({ events, memories: new InMemoryStore(), tools: createDefaultToolRegistry() });
      } },
    });

    await handler.handle({ ...canonical, scope: { ...canonical.scope, roles: ["admin"], entitlements: ["market-data", "graph-read"] } });

    expect(runtimeCommand).toEqual(canonical);
    expect((await runs.get(command.scope, command.runId))?.status).toBe("abstained");
  });

  it("rejects a queue delivery that has no API-committed command", async () => {
    const handler = new DurableResearchRunHandler({
      conversations: new InMemoryConversationStore(),
      runs: new InMemoryRunStore(),
      commandResolver: { resolve: async () => undefined },
      runtime: { create: () => { throw new Error("must not create runtime"); } },
    });

    await expect(handler.handle(command)).rejects.toThrow("no durable command");
  });

  it("safely recovers a planned failed run exactly once and records the recovery", async () => {
    const { conversations, conversationId, runs } = await createFailedRun(command.runId);
    let executions = 0;
    const handler = new DurableResearchRunHandler({
      conversations,
      runs,
      checkpoints: { latest: async () => ({ phase: "planned" }) },
      runtime: { create: (events) => {
        executions += 1;
        return new ResearchRuntime({ events, memories: new InMemoryStore(), tools: createDefaultToolRegistry() });
      } },
    });

    await handler.handle({ ...command, conversationId });
    const recovered = await runs.get(command.scope, command.runId);
    expect(executions).toBe(1);
    expect(recovered?.events.find((event) => event.type === "run_recovered")?.payload).toMatchObject({ checkpointPhase: "planned", reason: "no task execution checkpoint exists" });
    expect(recovered?.status).toBe("abstained");

    await handler.handle({ ...command, conversationId });
    expect(executions).toBe(1);
  });

  it("expires a stale running lease before allowing only a safe checkpoint recovery", async () => {
    const conversations = new InMemoryConversationStore();
    const conversation = await conversations.create(command.scope, "Stale lease recovery");
    const runs = new InMemoryRunStore({ leaseDurationMs: 0 });
    await runs.create({ id: command.runId, organizationId: command.scope.organizationId, conversationId: conversation.id, createdBy: command.scope.userId, question: command.question, budget: { maxTasks: 12, maxToolCalls: 24, maxToolDurationMs: 20_000, maxCriticRepairs: 1, maxEstimatedCostUsd: 5 } });
    await runs.claim(command.scope, command.runId);
    const handler = new DurableResearchRunHandler({
      conversations,
      runs,
      checkpoints: { latest: async () => ({ phase: "planned" }) },
      runtime: { create: (events) => new ResearchRuntime({ events, memories: new InMemoryStore(), tools: createDefaultToolRegistry() }) },
    });

    await handler.handle({ ...command, conversationId: conversation.id });

    const run = await runs.get(command.scope, command.runId);
    expect(run?.status).toBe("abstained");
    expect(run?.events.some((event) => event.type === "failed" && String(event.payload.message).includes("lease expired"))).toBe(true);
    expect(run?.events.some((event) => event.type === "run_recovered")).toBe(true);
  });

  it("does not replay a run whose latest checkpoint may have called a tool", async () => {
    const runId = "3438432a-0595-4409-ba84-3fa48908277b";
    const { conversations, conversationId, runs } = await createFailedRun(runId);
    let executions = 0;
    const handler = new DurableResearchRunHandler({
      conversations,
      runs,
      checkpoints: { latest: async () => ({ phase: "tasks_executed" }) },
      runtime: { create: (events) => {
        executions += 1;
        return new ResearchRuntime({ events, memories: new InMemoryStore(), tools: createDefaultToolRegistry() });
      } },
    });

    await handler.handle({ ...command, runId, conversationId });
    expect(executions).toBe(0);
    expect((await runs.get(command.scope, runId))?.status).toBe("failed");
  });

  it("denies a second automatic recovery after the recovered attempt fails", async () => {
    const runId = "8e0e37b9-6a0e-4dd8-8717-d53f7d664b3f";
    const { conversations, conversationId, runs } = await createFailedRun(runId);
    let executions = 0;
    const handler = new DurableResearchRunHandler({
      conversations,
      runs,
      checkpoints: { latest: async () => ({ phase: "planned" }) },
      runtime: { create: () => {
        executions += 1;
        throw new Error("unexpected runtime factory failure");
      } },
    });

    await expect(handler.handle({ ...command, runId, conversationId })).rejects.toThrow("unexpected runtime factory failure");
    await handler.handle({ ...command, runId, conversationId });
    expect(executions).toBe(1);
    expect((await runs.get(command.scope, runId))?.events.filter((event) => event.type === "run_recovered")).toHaveLength(1);
  });

  it("keeps the durable run authoritative if live event publication fails", async () => {
    const conversations = new InMemoryConversationStore();
    const conversation = await conversations.create(command.scope, "Live event failure");
    const runs = new InMemoryRunStore();
    await runs.create({ id: command.runId, organizationId: command.scope.organizationId, conversationId: conversation.id, createdBy: command.scope.userId, question: command.question, budget: { maxTasks: 12, maxToolCalls: 24, maxToolDurationMs: 20_000, maxRunDurationMs: 300_000, maxCriticRepairs: 1, maxEstimatedCostUsd: 5 } });
    const handler = new DurableResearchRunHandler({
      conversations,
      runs,
      liveEvents: { publish: async () => { throw new Error("redis unavailable"); }, close: async () => undefined },
      liveEventFailureReporter: { report: () => undefined },
      runtime: { create: (events) => new ResearchRuntime({ events, memories: new InMemoryStore(), tools: createDefaultToolRegistry() }) },
    });

    await handler.handle({ ...command, conversationId: conversation.id });
    expect((await runs.get(command.scope, command.runId))?.status).toBe("abstained");
  });

  it("fails the active run even when failure-event persistence is unavailable", async () => {
    const conversations = new InMemoryConversationStore();
    const conversation = await conversations.create(command.scope, "Failure finalization");
    const runs = new EventPersistenceFailureRunStore();
    await runs.create({ id: command.runId, organizationId: command.scope.organizationId, conversationId: conversation.id, createdBy: command.scope.userId, question: command.question, budget: { maxTasks: 12, maxToolCalls: 24, maxToolDurationMs: 20_000, maxRunDurationMs: 300_000, maxCriticRepairs: 1, maxEstimatedCostUsd: 5 } });
    const handler = new DurableResearchRunHandler({
      conversations,
      runs,
      runtime: { create: (events) => new ResearchRuntime({ events, memories: new InMemoryStore(), tools: createDefaultToolRegistry() }) },
    });

    await expect(handler.handle({ ...command, conversationId: conversation.id })).rejects.toThrow("run event store unavailable");
    expect((await runs.get(command.scope, command.runId))?.status).toBe("failed");
  });

  it("fails a claimed run when a queue command is not bound to its persisted conversation", async () => {
    const conversations = new InMemoryConversationStore();
    const firstConversation = await conversations.create(command.scope, "Authoritative run");
    const otherConversation = await conversations.create(command.scope, "Unexpected destination");
    const runs = new InMemoryRunStore();
    await runs.create({ id: command.runId, organizationId: command.scope.organizationId, conversationId: firstConversation.id, createdBy: command.scope.userId, question: command.question, budget: { maxTasks: 12, maxToolCalls: 24, maxToolDurationMs: 20_000, maxRunDurationMs: 300_000, maxCriticRepairs: 1, maxEstimatedCostUsd: 5 } });
    let executions = 0;
    const handler = new DurableResearchRunHandler({
      conversations,
      runs,
      runtime: { create: () => { executions += 1; return new ResearchRuntime({ events: { append: async () => { throw new Error("must not execute"); } }, memories: new InMemoryStore(), tools: createDefaultToolRegistry() }); } },
    });

    await expect(handler.handle({ ...command, conversationId: otherConversation.id })).rejects.toThrow("does not match its persisted research run");
    expect(executions).toBe(0);
    expect((await runs.get(command.scope, command.runId))?.status).toBe("failed");
  });
});

async function createFailedRun(runId: string): Promise<{ conversations: InMemoryConversationStore; conversationId: string; runs: InMemoryRunStore }> {
  const conversations = new InMemoryConversationStore();
  const conversation = await conversations.create(command.scope, "Recovery test");
  const runs = new InMemoryRunStore();
  await runs.create({
    id: runId,
    organizationId: command.scope.organizationId,
    conversationId: conversation.id,
    createdBy: command.scope.userId,
    question: command.question,
    budget: { maxTasks: 12, maxToolCalls: 24, maxToolDurationMs: 20_000, maxRunDurationMs: 300_000, maxCriticRepairs: 1, maxEstimatedCostUsd: 5 },
  });
  await runs.claim(command.scope, runId);
  await runs.finish(command.scope, runId, "failed");
  return { conversations, conversationId: conversation.id, runs };
}
