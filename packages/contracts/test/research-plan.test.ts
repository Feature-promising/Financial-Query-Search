import { describe, expect, it } from "vitest";
import { ResearchPlanSchema } from "../src/index.js";

describe("ResearchPlanSchema", () => {
  it("rejects duplicate task IDs and ambiguous multi-tool tasks", () => {
    const task = { id: "source", title: "Source", objective: "Retrieve a source", dependsOn: [], allowedTools: ["filing.search"], acceptanceCriteria: ["locatable evidence"], status: "pending" };
    expect(ResearchPlanSchema.safeParse({ summary: "valid", tasks: [task] }).success).toBe(true);
    expect(ResearchPlanSchema.safeParse({ summary: "duplicate", tasks: [task, { ...task, title: "Repeated task" }] }).success).toBe(false);
    expect(ResearchPlanSchema.safeParse({ summary: "ambiguous", tasks: [{ ...task, allowedTools: ["filing.search", "retrieval.search"] }] }).success).toBe(false);
  });
});
