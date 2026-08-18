import { verifyCitations } from "@research/knowledge";
import type { Claim, EvidenceItem } from "@research/contracts";
import type { ReportCitation, ReportComposer, ResearchReportDocument } from "./types.js";

/** Deterministic, evidence-bound Markdown renderer. It refuses to render invalid claims. */
export class CitationReportComposer implements ReportComposer {
  compose(input: Parameters<ReportComposer["compose"]>[0]): ResearchReportDocument {
    const invalid = verifyCitations(input.claims, input.evidence, input.scope).filter((result) => !result.valid);
    if (invalid.length) throw new Error(`cannot render report with invalid citations: ${invalid.map((result) => result.claimId).join(",")}`);
    const evidenceById = new Map(input.evidence.map((item) => [item.id, item]));
    const citedIds = unique(input.claims.flatMap((claim) => claim.evidenceIds));
    const citations = citedIds.flatMap((id, index) => {
      const item = evidenceById.get(id);
      return item ? [toCitation(index + 1, item)] : [];
    });
    const citationNumbers = new Map(citations.map((citation) => [citation.evidenceId, citation.number]));
    const body = input.claims.map((claim) => renderClaim(claim, citationNumbers)).join("\n\n");
    const sources = citations.map((citation) => renderCitation(citation)).join("\n");
    return {
      citations,
      markdown: `## 研究结论\n\n${body}\n\n## 证据与引用\n\n${sources}\n\n---\n*仅供研究与教育用途，不构成个性化投资建议。数据截至日期、授权范围和延迟以各引用来源为准。*`,
    };
  }
}

function renderClaim(claim: Claim, citationNumbers: ReadonlyMap<string, number>): string {
  const refs = claim.evidenceIds.map((id) => citationNumbers.get(id)).filter((number): number is number => number !== undefined).map((number) => `[${number}]`).join("");
  return `${claim.text}${claim.qualification ? `（${claim.qualification}）` : ""}${refs ? ` ${refs}` : ""}`;
}

function renderCitation(citation: ReportCitation): string {
  const url = citation.sourceUrl ? ` — ${citation.sourceUrl}` : "";
  const date = citation.asOfDate ? `；截至 ${citation.asOfDate}` : "";
  return `[${citation.number}] ${citation.title}；${citation.locator}${date}${url}；许可：${citation.license}`;
}

function toCitation(number: number, item: EvidenceItem): ReportCitation {
  return { number, evidenceId: item.id, title: item.title, locator: item.locator, sourceUrl: item.sourceUrl, asOfDate: item.asOfDate, license: item.license };
}
function unique<T>(values: T[]): T[] { return [...new Set(values)]; }
