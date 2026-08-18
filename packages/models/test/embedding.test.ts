import { describe, expect, it } from "vitest";
import { RunCostBudgetExceeded, RunCostLedger } from "@research/contracts";
import { BedrockEmbeddingModel, withModelInvocationContext } from "../src/index.js";

describe("BedrockEmbeddingModel", () => {
  it("reserves the conservative embedding maximum before sending a request", async () => {
    let calls = 0;
    const model = new BedrockEmbeddingModel({
      region: "us-east-1", modelId: "embedding", inputCostPer1kUsd: 1,
      client: { send: async () => { calls += 1; return {}; } } as never,
    });

    await expect(withModelInvocationContext({ runId: "run-1", organizationId: "org-1", costLedger: new RunCostLedger(0.001) }, () => model.embed("NVDA"))).rejects.toBeInstanceOf(RunCostBudgetExceeded);
    expect(calls).toBe(0);
  });

  it("uses provider token usage for audit settlement and forwards the run cancellation signal", async () => {
    let receivedSignal: AbortSignal | undefined;
    const auditEvents: Array<{ operation: string; inputTokens: number; estimatedCostUsd: number | null }> = [];
    const ledger = new RunCostLedger(1);
    const model = new BedrockEmbeddingModel({
      region: "us-east-1", modelId: "embedding", inputCostPer1kUsd: 1,
      audit: { write: async (event) => { auditEvents.push(event); } },
      client: { send: async (_command: unknown, options: { abortSignal?: AbortSignal }) => {
        receivedSignal = options.abortSignal;
        return { body: new TextEncoder().encode(JSON.stringify({ embedding: [0.1, 0.2], inputTextTokenCount: 2 })) };
      } } as never,
    });
    const controller = new AbortController();

    await expect(withModelInvocationContext({ runId: "run-1", organizationId: "org-1", costLedger: ledger }, () => model.embed("NVDA", { signal: controller.signal }))).resolves.toEqual([0.1, 0.2]);
    expect(receivedSignal).toBe(controller.signal);
    expect(ledger.spent).toBeCloseTo(0.002);
    expect(auditEvents).toEqual([expect.objectContaining({ operation: "embedding_generation", inputTokens: 2, estimatedCostUsd: 0.002 })]);
  });

  it("charges the maximum when a submitted embedding request fails before usage is returned", async () => {
    const ledger = new RunCostLedger(1);
    const model = new BedrockEmbeddingModel({
      region: "us-east-1", modelId: "embedding", inputCostPer1kUsd: 1,
      client: { send: async () => { throw new Error("transport interrupted"); } } as never,
    });

    await expect(withModelInvocationContext({ runId: "run-1", organizationId: "org-1", costLedger: ledger }, () => model.embed("NVDA"))).rejects.toThrow("transport interrupted");
    expect(ledger.spent).toBeCloseTo(0.004);
    expect(ledger.reserved).toBe(0);
  });
});
