import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { z } from "zod";
import { RunCostBudgetExceeded, type RunCostLedger } from "@research/contracts";
import { currentModelInvocationContext, estimateModelCost, type ModelAuditSink } from "./audit.js";

export interface StructuredModel {
  generate<T>(system: string, user: string, schema: z.ZodType<T>, options?: { operation?: string; signal?: AbortSignal }): Promise<T>;
}

/** Model text remains untrusted until it passes the caller-provided Zod schema. */
export class BedrockStructuredModel implements StructuredModel {
  private readonly client: BedrockRuntimeClient;

  constructor(private readonly options: { region: string; modelId: string; maxTokens?: number; temperature?: number; inputCostPer1kUsd?: number; outputCostPer1kUsd?: number; audit?: ModelAuditSink; client?: BedrockRuntimeClient }) {
    this.client = options.client ?? new BedrockRuntimeClient({ region: options.region });
  }

  async generate<T>(system: string, user: string, schema: z.ZodType<T>, generateOptions: { operation?: string; signal?: AbortSignal } = {}): Promise<T> {
    const context = currentModelInvocationContext();
    const maxTokens = this.options.maxTokens ?? 1_200;
    const maximumCostUsd = maximumModelCost(system, user, maxTokens, this.options.inputCostPer1kUsd, this.options.outputCostPer1kUsd);
    const reservation = context?.costLedger?.reserve(maximumCostUsd ?? 0);
    if (reservation === undefined && context?.costLedger) throw new RunCostBudgetExceeded();
    let settled = false;
    try {
      const response = await this.client.send(new ConverseCommand({
        modelId: this.options.modelId,
        system: [{ text: `${system}\nReturn one JSON object only. Do not include markdown fences or commentary.` }],
        messages: [{ role: "user", content: [{ text: user }] }],
        inferenceConfig: { maxTokens, temperature: this.options.temperature ?? 0 },
      }), { abortSignal: generateOptions.signal });
      const cost = await this.recordUsage(response.usage, generateOptions.operation ?? "structured_generate", maximumCostUsd);
      const settledWithinBudget = reservation == null || !context?.costLedger || context.costLedger.settle(reservation, cost ?? 0);
      settled = true;
      if (!settledWithinBudget) throw new RunCostBudgetExceeded();
      const text = response.output?.message?.content?.find((block) => "text" in block)?.text;
      if (!text) throw new Error("Bedrock returned no text content");
      let decoded: unknown;
      try { decoded = JSON.parse(text); }
      catch { throw new Error("Bedrock returned invalid JSON"); }
      return schema.parse(decoded);
    } catch (error) {
      // A network/SDK failure can occur after Bedrock accepted the request. If
      // no validated usage was received, account for the predeclared maximum
      // rather than releasing the reservation as if the request were free.
      if (!settled && reservation != null && context?.costLedger) {
        context.costLedger.settle(reservation, maximumCostUsd ?? 0);
        settled = true;
        await this.recordUsage(undefined, generateOptions.operation ?? "structured_generate", maximumCostUsd).catch(() => undefined);
      }
      throw error;
    }
  }

  private async recordUsage(usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined, operation: string, fallbackCostUsd: number | null): Promise<number | null> {
    const context = currentModelInvocationContext();
    const normalizedUsage = normalizeUsage(usage);
    const inputTokens = normalizedUsage?.inputTokens ?? 0;
    const outputTokens = normalizedUsage?.outputTokens ?? 0;
    const totalTokens = normalizedUsage?.totalTokens ?? 0;
    // Missing or malformed provider accounting must not silently turn a
    // billable model request into a zero-cost run. The recorded cost is the
    // conservative reservation maximum when exact usage is unavailable.
    const estimatedCostUsd = normalizedUsage
      ? estimateModelCost(inputTokens, outputTokens, this.options.inputCostPer1kUsd, this.options.outputCostPer1kUsd)
      : fallbackCostUsd;
    if (!this.options.audit || !context) return estimatedCostUsd;
    await this.options.audit.write({
      runId: context.runId,
      organizationId: context.organizationId,
      modelId: this.options.modelId,
      operation,
      invokedAt: new Date().toISOString(),
      inputTokens,
      outputTokens,
      totalTokens,
      estimatedCostUsd,
    });
    return estimatedCostUsd;
  }
}

/** Uses character count as a deliberately conservative upper bound on input tokens. */
function maximumModelCost(
  system: string,
  user: string,
  maxOutputTokens: number,
  inputCostPer1kUsd?: number,
  outputCostPer1kUsd?: number,
): number | null {
  return estimateModelCost(system.length + user.length, maxOutputTokens, inputCostPer1kUsd, outputCostPer1kUsd);
}

function normalizeUsage(usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined): { inputTokens: number; outputTokens: number; totalTokens: number } | undefined {
  if (!usage || !isTokenCount(usage.inputTokens) || !isTokenCount(usage.outputTokens) || !isTokenCount(usage.totalTokens)) return undefined;
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens };
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
