import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { RunCostBudgetExceeded } from "@research/contracts";
import type { EmbeddingModel } from "@research/knowledge";
import { currentModelInvocationContext, estimateModelCost, type ModelAuditSink } from "../audit.js";

/** Bedrock embedding adapter with strict response validation. */
export class BedrockEmbeddingModel implements EmbeddingModel {
  private readonly client: BedrockRuntimeClient;

  constructor(private readonly options: { region: string; modelId: string; inputCostPer1kUsd?: number; audit?: ModelAuditSink; client?: BedrockRuntimeClient }) {
    this.client = options.client ?? new BedrockRuntimeClient({ region: options.region });
  }

  async embed(text: string, request: { signal?: AbortSignal } = {}): Promise<number[]> {
    const context = currentModelInvocationContext();
    // Character count deliberately over-reserves relative to normal tokenizers.
    const maximumCostUsd = estimateModelCost(text.length, 0, this.options.inputCostPer1kUsd, 0);
    const reservation = context?.costLedger?.reserve(maximumCostUsd ?? 0);
    if (reservation === undefined && context?.costLedger) throw new RunCostBudgetExceeded();
    let settled = false;
    try {
      const response = await this.client.send(
        new InvokeModelCommand({ modelId: this.options.modelId, contentType: "application/json", accept: "application/json", body: new TextEncoder().encode(JSON.stringify({ inputText: text })) }),
        { abortSignal: request.signal },
      );
      const decoded = JSON.parse(new TextDecoder().decode(response.body)) as { embedding?: unknown; inputTextTokenCount?: unknown };
      const inputTokens = validTokenCount(decoded.inputTextTokenCount) ? decoded.inputTextTokenCount : undefined;
      const cost = await this.recordUsage(inputTokens, maximumCostUsd);
      const settledWithinBudget = reservation == null || !context?.costLedger || context.costLedger.settle(reservation, cost ?? 0);
      settled = true;
      if (!settledWithinBudget) throw new RunCostBudgetExceeded();
      if (!Array.isArray(decoded.embedding) || !decoded.embedding.length || decoded.embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))) throw new Error("Bedrock embedding response is invalid");
      return decoded.embedding;
    } catch (error) {
      // Bedrock may have accepted the embedding request before a transport
      // failure. Retain the maximum reservation instead of treating it free.
      if (!settled && reservation != null && context?.costLedger) {
        context.costLedger.settle(reservation, maximumCostUsd ?? 0);
        await this.recordUsage(undefined, maximumCostUsd).catch(() => undefined);
      }
      throw error;
    }
  }

  private async recordUsage(inputTokens: number | undefined, fallbackCostUsd: number | null): Promise<number | null> {
    const context = currentModelInvocationContext();
    const estimatedCostUsd = inputTokens === undefined
      ? fallbackCostUsd
      : estimateModelCost(inputTokens, 0, this.options.inputCostPer1kUsd, 0);
    if (!context || !this.options.audit) return estimatedCostUsd;
    await this.options.audit.write({
      runId: context.runId,
      organizationId: context.organizationId,
      modelId: this.options.modelId,
      operation: "embedding_generation",
      invokedAt: new Date().toISOString(),
      inputTokens: inputTokens ?? 0,
      outputTokens: 0,
      totalTokens: inputTokens ?? 0,
      estimatedCostUsd,
    });
    return estimatedCostUsd;
  }
}

function validTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
