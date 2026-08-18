"use client";

import type { ReportCitation } from "@research/contracts";

/** Renders the persisted citation appendix rather than reconstructing it from stream order. */
export function CitationIndex({ citations, onCitation }: { citations: ReportCitation[]; onCitation: (number: number) => void }) {
  if (!citations.length) return null;
  return <section className="citation-index" aria-label="证据与引用">
    <h4>证据与引用</h4>
    <ol>{citations.map((citation) => <li key={citation.number}>
      <button type="button" className="citation-link" onClick={() => onCitation(citation.number)}>[{citation.number}] {citation.title}</button>
      <span className="metadata"> · {citation.locator}{citation.asOfDate ? ` · 截至 ${citation.asOfDate}` : ""} · 许可：{citation.license}</span>
    </li>)}</ol>
  </section>;
}
