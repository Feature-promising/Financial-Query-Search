import { IntentSchema, type Intent } from "@research/contracts";
import type { IntentAnalyzer } from "./types.js";

/** Safe bootstrap analyzer. Replace through dependency injection with Bedrock structured output. */
export class RuleBasedIntentAnalyzer implements IntentAnalyzer {
  async analyze(question: string): Promise<Intent> {
    const normalized = question.toLowerCase();
    const tickerMatches = question.match(/\b[A-Z]{1,5}\b/g) ?? [];
    const category: Intent["category"] = /估值|dcf|valuation/.test(normalized) ? "valuation"
      : /对比|比较|versus| vs /.test(normalized) ? "comparison"
      : /财报|earnings|10-k|10-q/.test(normalized) ? "earnings"
      : /行业|industry|trend/.test(normalized) ? "industry"
      : /报告|report/.test(normalized) ? "report" : "company_analysis";
    return IntentSchema.parse({
      category,
      entities: [],
      tickers: [...new Set(tickerMatches)],
      period: extractRequestedPeriod(question),
      complexity: category === "report" || category === "valuation" ? "deep_research" : "research",
      riskLevel: category === "valuation" ? "high" : "medium",
      requiredCapabilities: ["sec_filing_retrieval", "licensed_financial_data", "hybrid_retrieval"],
    });
  }
}

/**
 * A requested reporting period is a hard research constraint.  Keep this
 * parser deliberately narrow: it only returns unambiguous ISO dates or years
 * and otherwise lets the planner request clarification instead of guessing.
 */
export function extractRequestedPeriod(question: string): string | null {
  const date = question.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1];
  if (date) return date;
  return question.match(/\b(20\d{2})\b/)?.[1] ?? null;
}
