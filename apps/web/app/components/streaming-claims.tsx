"use client";

import type { ResearchEvent } from "../lib/research-types";

/** Claim deltas are visibly provisional until the Critic and citation gate publish a report. */
export function StreamingClaims({ events, paused }: { events: ResearchEvent[]; paused: boolean }) {
  const claims = events.filter((event) => event.type === "claim_delta").flatMap((event) => typeof event.payload.text === "string" ? [event.payload.text] : []);
  if (!claims.length) return null;
  return <section className="streaming-claims" aria-live="polite">
    <div className="streaming-claims-heading"><h3>正在形成的研究结论</h3><span>{paused ? "展示已暂停" : "等待引用审查"}</span></div>
    <div>{claims.map((claim, index) => <p key={`${claim}-${index}`}>{claim}</p>)}</div>
    <small>以下内容尚未通过来源、数值与引用校验，不能作为最终研究结论。</small>
  </section>;
}
