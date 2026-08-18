import { IntentSchema, type Intent } from "@research/contracts";
import { redactSensitiveText } from "@research/knowledge";
import type { StructuredModel } from "./bedrock.js";

export class BedrockIntentAnalyzer {
  constructor(private readonly model: StructuredModel) {}

  async analyze(question: string, signal?: AbortSignal): Promise<Intent> {
    const safeQuestion = redactSensitiveText(question).text;
    return this.model.generate(
      "You classify US-equity research questions. Extract only stated or strongly unambiguous constraints. Never invent a ticker, reporting period, or financial fact.",
      `Question:\n${safeQuestion}\n\nReturn {category, entities, tickers, period, complexity, riskLevel, requiredCapabilities}.`,
      IntentSchema,
      { operation: "intent_analysis", signal },
    );
  }
}
