import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { RunCostBudgetExceeded } from "@research/contracts";
import { ResearchRuntime } from "./runtime.js";
import type { ResearchRunInput, ResearchRunResult, ResearchRuntimeSession } from "./types.js";

const GraphAnnotation = Annotation.Root({
  input: Annotation<ResearchRunInput>(),
  session: Annotation<ResearchRuntimeSession>(),
  costBudgetExceeded: Annotation<boolean>(),
  runDeadlineExceeded: Annotation<boolean>(),
  workerShutdown: Annotation<boolean>(),
  result: Annotation<ResearchRunResult>(),
});

/** These named nodes are the auditable production state machine, not a chat loop. */
export const researchGraphNodeNames = [
  "start_run",
  "load_context",
  "analyze_intent",
  "plan_research",
  "execute_tasks",
  "build_evidence",
  "compose_claims",
  "critic",
  "publish_report",
  "cost_budget_exhausted",
  "run_deadline_exceeded",
  "worker_shutdown",
] as const;

/**
 * The graph owns phase ordering and the terminal budget-refusal branch.
 * PostgreSQL domain checkpoints remain the recovery authority because they
 * understand the non-replayable boundary after billable tool invocation.
 */
export function createResearchGraph(runtime: ResearchRuntime) {
  const phase = (operation: (session: ResearchRuntimeSession) => Promise<void>) => async (state: typeof GraphAnnotation.State) => {
    try {
      await operation(state.session);
      return { costBudgetExceeded: false, runDeadlineExceeded: false, workerShutdown: false };
    } catch (error) {
      if (error instanceof RunCostBudgetExceeded) return { costBudgetExceeded: true };
      if (runtime.isRunShutdownRequested(state.session, error)) return { workerShutdown: true };
      if (runtime.isRunDeadlineExceeded(state.session, error)) return { runDeadlineExceeded: true };
      throw error;
    }
  };
  const next = (target: string) => (state: typeof GraphAnnotation.State) => {
    if (state.workerShutdown) return "worker_shutdown";
    if (state.runDeadlineExceeded) return "run_deadline_exceeded";
    return state.costBudgetExceeded ? "cost_budget_exhausted" : target;
  };

  return new StateGraph(GraphAnnotation)
    .addNode("start_run", async (state) => {
      const session = runtime.createSession(state.input);
      try {
        await runtime.start(session);
        return { session, costBudgetExceeded: false, runDeadlineExceeded: false, workerShutdown: false };
      } catch (error) {
        if (runtime.isRunShutdownRequested(session, error)) return { session, workerShutdown: true };
        if (runtime.isRunDeadlineExceeded(session, error)) return { session, runDeadlineExceeded: true };
        throw error;
      }
    })
    .addNode("load_context", phase((session) => runtime.loadContextPhase(session)))
    .addNode("analyze_intent", phase((session) => runtime.analyzeIntentPhase(session)))
    .addNode("plan_research", phase((session) => runtime.planResearchPhase(session)))
    .addNode("execute_tasks", phase((session) => runtime.executeTasksPhase(session)))
    .addNode("build_evidence", phase((session) => runtime.buildEvidencePhase(session)))
    .addNode("compose_claims", phase((session) => runtime.composeClaimsPhase(session)))
    .addNode("critic", phase((session) => runtime.criticPhase(session)))
    .addNode("publish_report", async (state) => ({ result: await runtime.publishPhase(state.session) }))
    .addNode("cost_budget_exhausted", async (state) => ({ result: await runtime.costBudgetExceededPhase(state.session) }))
    .addNode("run_deadline_exceeded", async (state) => ({ result: await runtime.deadlineExceededPhase(state.session) }))
    .addNode("worker_shutdown", async (state) => ({ result: await runtime.shutdownPhase(state.session) }))
    .addEdge(START, "start_run")
    .addConditionalEdges("start_run", next("load_context"))
    .addConditionalEdges("load_context", next("analyze_intent"))
    .addConditionalEdges("analyze_intent", next("plan_research"))
    .addConditionalEdges("plan_research", next("execute_tasks"))
    .addConditionalEdges("execute_tasks", next("build_evidence"))
    .addConditionalEdges("build_evidence", next("compose_claims"))
    .addConditionalEdges("compose_claims", next("critic"))
    .addConditionalEdges("critic", next("publish_report"))
    .addEdge("publish_report", END)
    .addEdge("cost_budget_exhausted", END)
    .compile();
}

/** Executes one bounded research turn through explicit, replay-safe graph phases. */
export async function runResearchGraph(runtime: ResearchRuntime, input: ResearchRunInput): Promise<ResearchRunResult> {
  return runtime.withRunTrace(input, async () => {
    try {
      const state = await createResearchGraph(runtime).invoke({ input });
      if (!state.result) throw new Error("research graph completed without a result");
      return state.result;
    } finally {
      runtime.closeRunSession(input.runId);
    }
  });
}
