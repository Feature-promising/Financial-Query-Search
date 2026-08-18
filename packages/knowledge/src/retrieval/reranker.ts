import type { EvidenceItem } from "@research/contracts";
import type { RetrievalQuery } from "../types.js";

export interface RankedEvidence { item: EvidenceItem; score: number; }
export interface RerankQuery { text: string; asOfDate?: RetrievalQuery["asOfDate"]; }

/**
 * Deterministic pre-rerank signal. It favors source authority, explicit
 * temporal fit, entity match, and lexical relevance before a model reranker
 * can be introduced behind this same bounded interface.
 */
export function rerankEvidence(query: RerankQuery, candidates: EvidenceItem[], limit: number): EvidenceItem[] {
  const tokens = new Set(query.text.toLocaleLowerCase().split(/[^\p{L}\p{N}.]+/u).filter((token) => token.length > 1));
  return candidates
    .map((item): RankedEvidence => ({
      item,
      score: authorityScore(item.authority) + temporalScore(query.asOfDate, item) + lexicalScore(tokens, item.content) + entityScore(tokens, item.entity),
    }))
    .sort((left, right) => right.score - left.score || right.item.retrievedAt.localeCompare(left.item.retrievedAt))
    .slice(0, Math.max(1, Math.min(limit, 100)))
    .map(({ item }) => item);
}

function authorityScore(authority: EvidenceItem["authority"]): number { return authority === "primary" ? 10 : authority === "licensed" ? 6 : 1; }
function lexicalScore(tokens: Set<string>, content: string): number { const lower = content.toLocaleLowerCase(); return [...tokens].reduce((score, token) => score + (lower.includes(token) ? 1 : 0), 0); }
function entityScore(tokens: Set<string>, entity: string | null): number { return entity && tokens.has(entity.toLocaleLowerCase()) ? 3 : 0; }

/** Rewards the closest explicit source-as-of date without allowing time to outrank source authority. */
function temporalScore(requestedAsOf: string | undefined, item: EvidenceItem): number {
  if (!requestedAsOf || !/^\d{4}-\d{2}-\d{2}$/.test(requestedAsOf)) return 0;
  const candidate = item.asOfDate ?? metadataDate(item, "sourceAsOf") ?? metadataDate(item, "reportingPeriod");
  if (!candidate || !/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return 0;
  const distanceDays = Math.abs(Date.parse(`${requestedAsOf}T00:00:00.000Z`) - Date.parse(`${candidate}T00:00:00.000Z`)) / 86_400_000;
  return Math.max(0, 3 - distanceDays / 90);
}

function metadataDate(item: EvidenceItem, key: string): string | undefined {
  const value = item.metadata[key];
  return typeof value === "string" ? value : undefined;
}
