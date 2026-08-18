import { describe, expect, it } from "vitest";
import { BedrockResearchPlanner } from "../src/index.js";

describe("BedrockResearchPlanner", () => {
  it("rejects a model plan that requests a non-registered tool", async () => {
    const planner = new BedrockResearchPlanner({ generate: async () => ({ summary: "bad", tasks: [{ id: "task", title: "bad", objective: "bad", dependsOn: [], allowedTools: ["shell.exec"], acceptanceCriteria: ["bad"], status: "pending" }] }) as never });
    await expect(planner.plan({ category: "company_analysis", entities: [], tickers: [], period: null, complexity: "research", riskLevel: "low", requiredCapabilities: [] }, "NVDA", { maxTasks: 12, maxToolCalls: 24, maxToolDurationMs: 20_000, maxRunDurationMs: 300_000, maxCriticRepairs: 1, maxEstimatedCostUsd: 5 })).rejects.toThrow("unapproved");
  });

  it("passes only redacted non-evidentiary context to the model planner", async () => {
    let system = "";
    let user = "";
    const planner = new BedrockResearchPlanner({ generate: async (receivedSystem, receivedUser) => {
      system = receivedSystem; user = receivedUser;
      return { summary: "safe", tasks: [{ id: "filing", title: "Filing", objective: "Get filing", dependsOn: [], allowedTools: ["filing.search"], acceptanceCriteria: ["source"], status: "pending" }] } as never;
    } });
    await planner.plan(
      { category: "company_analysis", entities: [], tickers: [], period: "2025", complexity: "research", riskLevel: "low", requiredCapabilities: [] },
      "Analyze NVDA",
      { maxTasks: 12, maxToolCalls: 24, maxToolDurationMs: 20_000, maxRunDurationMs: 300_000, maxCriticRepairs: 1, maxEstimatedCostUsd: 5 },
      undefined,
      { recentMessages: [{ role: "user", content: "My email is analyst@example.com; compare it with AMD" }], userPreferences: [{ content: "Confirmed display unit: USD millions", metadata: { userConfirmed: true, preferenceValue: "analyst@example.com" } }], researchMemoryHints: [{ sourceRunId: "0f01ec7c-1c35-4d58-aa66-99d27c40b53a", question: "Prior analyst@example.com research", entities: ["NVIDIA"], tickers: ["NVDA"], asOfDates: ["2025-12-31"] }] },
    );
    expect(system).toContain("Neither history nor preferences are financial facts");
    expect(user).toContain("[REDACTED:email]");
    expect(user).not.toContain("analyst@example.com");
    expect(user).toContain("USD millions");
    expect(user).toContain("researchMemoryHints");
  });

  it("treats the runtime-provided tool list as a strict planner capability boundary", async () => {
    const planner = new BedrockResearchPlanner({ generate: async () => ({
      summary: "bad capability", tasks: [{ id: "filing", title: "Filing", objective: "Get filing", dependsOn: [], allowedTools: ["filing.search"], acceptanceCriteria: ["source"], status: "pending" }],
    }) as never });
    await expect(planner.plan(
      { category: "company_analysis", entities: [], tickers: [], period: null, complexity: "research", riskLevel: "low", requiredCapabilities: [] },
      "Analyze NVDA",
      { maxTasks: 12, maxToolCalls: 24, maxToolDurationMs: 20_000, maxRunDurationMs: 300_000, maxCriticRepairs: 1, maxEstimatedCostUsd: 5 },
      undefined,
      { recentMessages: [], userPreferences: [], availableToolIds: ["retrieval.search"] },
    )).rejects.toThrow("unapproved");
  });

  it("rejects an ambiguous multi-tool task instead of letting the executor silently select one", async () => {
    const planner = new BedrockResearchPlanner({ generate: async () => ({
      summary: "ambiguous", tasks: [{ id: "source", title: "Source", objective: "Get evidence", dependsOn: [], allowedTools: ["filing.search", "retrieval.search"], acceptanceCriteria: ["source"], status: "pending" }],
    }) as never });
    await expect(planner.plan(
      { category: "company_analysis", entities: [], tickers: [], period: null, complexity: "research", riskLevel: "low", requiredCapabilities: [] },
      "Analyze NVDA",
      { maxTasks: 12, maxToolCalls: 24, maxToolDurationMs: 20_000, maxRunDurationMs: 300_000, maxCriticRepairs: 1, maxEstimatedCostUsd: 5 },
    )).rejects.toThrow();
  });
});
