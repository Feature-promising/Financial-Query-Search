import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RunCostBudgetExceeded, RunCostLedger } from "@research/contracts";
import { BedrockStructuredModel, currentModelInvocationContext, estimateModelCost, withModelInvocationContext } from "../src/index.js";

describe("model invocation accounting", () => {
  it("uses exact configured input/output prices and preserves async run context", async () => {
    expect(estimateModelCost(1_000, 500, 0.003, 0.015)).toBeCloseTo(0.0105);
    expect(estimateModelCost(1_000, 500)).toBeNull();
    await withModelInvocationContext({ runId: "run-1", organizationId: "org-1" }, async () => {
      expect(currentModelInvocationContext()).toEqual({ runId: "run-1", organizationId: "org-1" });
    });
    expect(currentModelInvocationContext()).toBeUndefined();
  });

  it("reserves the maximum model cost before invoking Bedrock", async () => {
    let calls = 0;
    const model = new BedrockStructuredModel({
      region: "us-east-1", modelId: "test", maxTokens: 100,
      inputCostPer1kUsd: 1, outputCostPer1kUsd: 1,
      client: { send: async () => { calls += 1; return {}; } } as never,
    });
    const ledger = new RunCostLedger(0.01);

    await expect(withModelInvocationContext({ runId: "run-1", organizationId: "org-1", costLedger: ledger }, () => model.generate("system", "question", z.object({ ok: z.boolean() })))).rejects.toBeInstanceOf(RunCostBudgetExceeded);
    expect(calls).toBe(0);
  });

  it("forwards the run deadline abort signal to the Bedrock SDK", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const model = new BedrockStructuredModel({
      region: "us-east-1", modelId: "test",
      client: { send: async (_command: unknown, options: { abortSignal?: AbortSignal }) => {
        receivedSignal = options.abortSignal;
        return { output: { message: { content: [{ text: '{"ok":true}' }] } }, usage: {} };
      } } as never,
    });

    await expect(model.generate("system", "question", z.object({ ok: z.literal(true) }), { signal: controller.signal })).resolves.toEqual({ ok: true });
    expect(receivedSignal).toBe(controller.signal);
  });

  it("conservatively charges the reserved maximum when Bedrock fails after a request may have been accepted", async () => {
    const ledger = new RunCostLedger(1);
    const expectedMaximum = estimateModelCost("system".length + "question".length, 100, 1, 1)!;
    const model = new BedrockStructuredModel({
      region: "us-east-1", modelId: "test", maxTokens: 100, inputCostPer1kUsd: 1, outputCostPer1kUsd: 1,
      client: { send: async () => { throw new Error("network reset after submission"); } } as never,
    });

    await expect(withModelInvocationContext({ runId: "run-1", organizationId: "org-1", costLedger: ledger }, () => model.generate("system", "question", z.object({ ok: z.boolean() })))).rejects.toThrow("network reset after submission");
    expect(ledger.spent).toBeCloseTo(expectedMaximum);
    expect(ledger.reserved).toBe(0);
  });

  it("uses the reserved maximum in the audit ledger when a successful response omits usage", async () => {
    const auditEvents: Array<{ inputTokens: number; outputTokens: number; totalTokens: number; estimatedCostUsd: number | null }> = [];
    const ledger = new RunCostLedger(1);
    const expectedMaximum = estimateModelCost("system".length + "question".length, 100, 1, 1)!;
    const model = new BedrockStructuredModel({
      region: "us-east-1", modelId: "test", maxTokens: 100, inputCostPer1kUsd: 1, outputCostPer1kUsd: 1,
      audit: { write: async (event) => { auditEvents.push(event); } },
      client: { send: async () => ({ output: { message: { content: [{ text: '{"ok":true}' }] } }, usage: {} }) } as never,
    });

    await expect(withModelInvocationContext({ runId: "run-1", organizationId: "org-1", costLedger: ledger }, () => model.generate("system", "question", z.object({ ok: z.literal(true) })))).resolves.toEqual({ ok: true });
    expect(ledger.spent).toBeCloseTo(expectedMaximum);
    expect(auditEvents).toEqual([expect.objectContaining({ inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: expectedMaximum })]);
  });
});
