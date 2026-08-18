import type { RetrievalQuery } from "../types.js";

const FINANCIAL_SYNONYMS: Record<string, string[]> = {
  revenue: ["sales", "net revenue"], earnings: ["net income", "EPS"], valuation: ["multiple", "DCF"], guidance: ["outlook", "forecast"],
};

/** Controlled expansion preserves specified dates and only adds financial aliases/tickers. */
export function expandQuery(query: RetrievalQuery): string[] {
  const normalized = query.text.trim().replace(/\s+/g, " ");
  const terms = new Set([normalized]);
  for (const [term, synonyms] of Object.entries(FINANCIAL_SYNONYMS)) {
    if (new RegExp(`\\b${term}\\b`, "i").test(normalized)) synonyms.forEach((synonym) => terms.add(`${normalized} ${synonym}`));
  }
  for (const entity of query.entities ?? []) {
    if (/^[A-Z.]{1,10}$/.test(entity)) terms.add(`${normalized} ${entity}`);
  }
  return [...terms].slice(0, 8);
}
