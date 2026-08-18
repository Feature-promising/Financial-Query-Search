import type { ResearchTask } from "@research/contracts";
import type { CriticResult, ResearchState } from "./types.js";

export interface CriticRepairProposal {
  task: ResearchTask;
  reason: string;
}

/**
 * Critic repair is intentionally a retry of one already-authorized failed
 * task. It cannot add tools, change the user's question, or manufacture facts.
 */
export function proposeCriticRepair(state: ResearchState, result: CriticResult): CriticRepairProposal | undefined {
  if (result.publishable || state.criticRepairs >= state.budget.maxCriticRepairs) return undefined;
  if (state.tasks.length >= state.budget.maxTasks) return undefined;
  const failed = state.tasks.find((task) => task.status === "failed");
  if (!failed) return undefined;
  const attempt = state.criticRepairs + 1;
  return {
    reason: `Critic requested bounded supplementary evidence after: ${result.reason}`,
    task: {
      id: `critic-repair-${attempt}-${failed.id}`,
      title: `Supplementary evidence: ${failed.title}`,
      objective: failed.objective,
      dependsOn: [],
      allowedTools: [...failed.allowedTools],
      acceptanceCriteria: [...failed.acceptanceCriteria, "Return only permissioned evidence with a stable source locator."],
      status: "pending",
    },
  };
}
