"use client";

import { useState } from "react";
import { evidenceIdForCitation, terminalAnswer } from "../lib/citations";
import type { EvidenceView, ResearchEvent } from "../lib/research-types";
import type { ResearchReportView } from "../lib/research-types";
import { CitationIndex } from "./citation-index";
import { EvidenceDrawer } from "./evidence-drawer";
import { ReportViewer } from "./report-viewer";
import { RunTimeline } from "./run-timeline";
import { StreamingClaims } from "./streaming-claims";

export function ResearchEvents({ events, report, reportError, streamPaused, loadEvidence }: { events: ResearchEvent[]; report?: ResearchReportView; reportError?: string; streamPaused: boolean; loadEvidence: (evidenceId: string) => Promise<EvidenceView> }) {
  const [evidence, setEvidence] = useState<EvidenceView>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const answer = report?.markdown ?? terminalAnswer(events);

  async function openCitation(number: number): Promise<void> {
    const evidenceId = evidenceIdForCitation(events, number, report?.citations);
    if (!evidenceId) { setError("该引用尚未对应可访问的证据记录。"); return; }
    setLoading(true); setError(undefined); setEvidence(undefined);
    try { setEvidence(await loadEvidence(evidenceId)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "证据请求失败"); }
    finally { setLoading(false); }
  }

  return <section className="events" aria-live="polite">
    {answer && <ReportViewer answer={answer} onCitation={(number) => void openCitation(number)} />}
    {!report && <StreamingClaims events={events} paused={streamPaused} />}
    {report && <CitationIndex citations={report.citations} onCitation={(number) => void openCitation(number)} />}
    {reportError && <p className="error">{reportError}</p>}
    {events.length ? <RunTimeline events={events} /> : !report && <div className="empty-state"><div className="empty-state-orbit" aria-hidden="true" /><div><h2>研究将在这里展开</h2><p>提交问题后，任务计划、工具结果、证据和引用校验会按时间线呈现。</p></div></div>}
    <EvidenceDrawer evidence={evidence} loading={loading} error={error} onClose={() => { setEvidence(undefined); setError(undefined); }} />
  </section>;
}
