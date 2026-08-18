"use client";

import type { EvidenceView } from "../lib/research-types";
import { isHttpSourceUrl } from "@research/contracts";

export function EvidenceDrawer({ evidence, loading, error, onClose }: { evidence?: EvidenceView; loading: boolean; error?: string; onClose: () => void }) {
  if (!loading && !error && !evidence) return null;
  return <aside className="evidence-drawer" aria-live="polite">
    <div className="drawer-heading"><h3>原始证据</h3><button type="button" className="quiet-button" onClick={onClose}>关闭</button></div>
    {loading && <p>正在加载授权后的证据…</p>}
    {error && <p className="error">无法读取证据：{error}</p>}
    {evidence && <>
      <h4>{evidence.title}</h4>
      <p className="metadata">定位：{evidence.locator}{evidence.asOfDate ? ` · 截至 ${evidence.asOfDate}` : ""}</p>
      <p className="metadata">许可：{evidence.license}</p>
      {evidence.sourceUrl && isHttpSourceUrl(evidence.sourceUrl) && <a href={evidence.sourceUrl} target="_blank" rel="noreferrer">打开原始来源</a>}
      <pre>{evidence.content}</pre>
    </>}
  </aside>;
}
