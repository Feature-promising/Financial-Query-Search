import { describe, expect, it } from "vitest";
import { restrictPlanToAuthorizedTools } from "../src/index.js";

describe("restrictPlanToAuthorizedTools", () => {
  it("retains only submission-authorized agent tools and marks unsupported tasks skipped", () => {
    const plan = restrictPlanToAuthorizedTools({
      summary: "test",
      tasks: [
        { id: "allowed", title: "Allowed", objective: "Retrieve", dependsOn: [], allowedTools: ["filing.search", "shell.exec"], acceptanceCriteria: ["source"], status: "pending" },
        { id: "blocked", title: "Blocked", objective: "Render", dependsOn: [], allowedTools: ["report.compose"], acceptanceCriteria: ["source"], status: "pending" },
      ],
    }, [
      { id: "filing.search", version: "v1", capability: "filing", requiredEntitlements: [], timeoutMs: 20_000, enabled: true },
      { id: "report.compose", version: "v1", capability: "report", requiredEntitlements: [], timeoutMs: 5_000, enabled: true, visibility: "internal" },
    ]);

    expect(plan.tasks[0]).toMatchObject({ allowedTools: ["filing.search"], status: "pending" });
    expect(plan.tasks[1]).toMatchObject({ allowedTools: ["report.compose"], status: "skipped" });
  });
});
