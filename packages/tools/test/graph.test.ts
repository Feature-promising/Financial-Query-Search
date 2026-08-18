import { describe, expect, it } from "vitest";
import { GraphTool } from "../src/index.js";

describe("GraphTool", () => {
  it("returns relationship leads without treating them as source evidence", async () => {
    let entitlements: string[] | undefined;
    const tool = new GraphTool({ expand: async (_tenant, _entity, allowedEntitlements) => { entitlements = allowedEntitlements; return [{ subject: "NVDA", predicate: "COMPETES_WITH", object: "AMD", evidenceIds: ["e-1"] }]; }, deleteEvidenceReferences: async () => undefined });
    const result = await tool.invoke({ query: "NVDA competitors" }, { runId: "run-1", scope: { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: ["graph-read"] }, remainingToolCalls: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.evidence).toEqual([]);
    expect(entitlements).toEqual(["graph-read"]);
  });

  it("fails closed before graph access when the direct caller lacks graph-read", async () => {
    let calls = 0;
    const tool = new GraphTool({ expand: async () => { calls += 1; return []; }, deleteEvidenceReferences: async () => undefined });
    const result = await tool.invoke({ query: "NVDA competitors" }, { runId: "run-1", scope: { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] }, remainingToolCalls: 1 });

    expect(result).toMatchObject({ ok: false, failure: { code: "UNAUTHORIZED" } });
    expect(calls).toBe(0);
  });
});
