import type { ResearchPlan, ToolManifest } from "@research/contracts";

/**
 * Deterministic planner boundary: a model may sequence research tasks, but it
 * cannot expand the tools authorized when this run was submitted. Unsupported
 * tasks remain replayable as skipped instead of being silently reinterpreted.
 */
export function restrictPlanToAuthorizedTools(plan: ResearchPlan, manifests: ToolManifest[]): ResearchPlan {
  const authorized = new Set(
    manifests.filter((manifest) => manifest.enabled && manifest.visibility !== "internal").map((manifest) => manifest.id),
  );
  return {
    ...plan,
    tasks: plan.tasks.map((task) => {
      const allowedTools = task.allowedTools.filter((toolId) => authorized.has(toolId));
      return allowedTools.length > 0 ? { ...task, allowedTools } : { ...task, status: "skipped" as const };
    }),
  };
}
