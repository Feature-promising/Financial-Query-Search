import type { ReportCitation } from "@research/contracts";
import type { ResearchEvent } from "./research-types";

/** Mirrors CitationReportComposer's stable first-occurrence numbering. */
export function evidenceIdForCitation(events: ResearchEvent[], citationNumber: number, citations?: ReportCitation[]): string | undefined {
  const persisted = citations?.find((citation) => citation.number === citationNumber);
  if (persisted) return persisted.evidenceId;
  const ids: string[] = [];
  for (const event of events) {
    if (event.type !== "claim_delta") continue;
    const evidenceIds = event.payload.evidenceIds;
    if (!Array.isArray(evidenceIds)) continue;
    for (const id of evidenceIds) if (typeof id === "string" && !ids.includes(id)) ids.push(id);
  }
  return ids[citationNumber - 1];
}

export function terminalAnswer(events: ResearchEvent[]): string | undefined {
  const event = [...events].reverse().find((item) => item.type === "completed" || item.type === "abstained");
  return typeof event?.payload.answer === "string" ? event.payload.answer : undefined;
}
