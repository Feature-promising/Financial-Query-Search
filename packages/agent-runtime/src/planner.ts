import { ResearchPlanSchema, type Intent, type ResearchPlan, type ResearchTask, type RunBudget } from "@research/contracts";
import type { Planner, ResearchPlanningContext } from "./types.js";

export class DefaultPlanner implements Planner {
  async plan(intent: Intent, question: string, budget: RunBudget, _signal?: AbortSignal, context?: ResearchPlanningContext): Promise<ResearchPlan> {
    const available = new Set(context?.availableToolIds ?? ["filing.search", "financial.get", "retrieval.search", "analysis.dcf"]);
    const tasks: ResearchTask[] = [];
    if (available.has("filing.search")) {
      tasks.push({ id: "filings", title: "Obtain primary disclosures", objective: "Retrieve relevant SEC or company-IR filings.", dependsOn: [], allowedTools: ["filing.search"], acceptanceCriteria: ["Primary-source passages include source locator and reporting period."], status: "pending" });
    }
    if (available.has("financial.get")) {
      tasks.push({ id: "financials", title: "Obtain standardized financial data", objective: "Retrieve licensed financial fields using explicit as-of dates.", dependsOn: [], allowedTools: ["financial.get"], acceptanceCriteria: ["Every value includes period, unit, currency, and source."], status: "pending" });
    }
    if (available.has("retrieval.search")) {
      tasks.push({ id: "context", title: "Retrieve supporting context", objective: "Find licensed or primary supporting research context.", dependsOn: available.has("filing.search") ? ["filings"] : [], allowedTools: ["retrieval.search"], acceptanceCriteria: ["All passages are permission-filtered and individually locatable."], status: "pending" });
    }
    if (intent.category === "valuation" && available.has("analysis.dcf") && available.has("financial.get")) {
      tasks.push({ id: "valuation", title: "Run valuation analysis", objective: "Run deterministic valuation once verified model inputs are available.", dependsOn: ["financials"], allowedTools: ["analysis.dcf"], acceptanceCriteria: ["Formula version and every input are preserved."], status: "pending" });
    }
    // ResearchPlan is intentionally non-empty. This placeholder is then
    // deterministically skipped by the Runtime if no eligible tool exists.
    if (tasks.length === 0) tasks.push({ id: "unavailable", title: "No authorized research tools", objective: "Record that no approved research capability is available.", dependsOn: [], allowedTools: ["filing.search"], acceptanceCriteria: ["A controlled abstention is produced."], status: "pending" });
    return ResearchPlanSchema.parse({ summary: `Evidence-first plan for: ${question}`, tasks: tasks.slice(0, budget.maxTasks) });
  }
}
