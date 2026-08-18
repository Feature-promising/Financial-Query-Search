"use client";

import type { ConversationDetailView } from "../lib/research-types";

export function ConversationTranscript({ conversation, activeReportRunId, readOnly = false, onEditQuestion, onOpenReport }: {
  conversation?: ConversationDetailView;
  activeReportRunId?: string;
  readOnly?: boolean;
  onEditQuestion: (question: string) => void;
  onOpenReport: (runId: string) => void;
}) {
  if (!conversation?.messages.length) return null;
  return <section className="conversation-transcript" aria-label="当前会话内容">
    <div className="transcript-heading"><h2>{conversation.conversation.title}</h2><span>{conversation.conversation.archivedAt ? "已归档" : "当前会话"}</span></div>
    <div className="transcript-list">{conversation.messages.map((message) => <article className={`transcript-message transcript-message--${message.role}`} key={message.id}>
      <div className="transcript-message-heading"><span>{message.role === "user" ? "你的问题" : "研究回答"}</span>{message.role === "user" && <button type="button" disabled={readOnly} title={readOnly ? "请先恢复归档会话" : undefined} onClick={() => onEditQuestion(message.content)}>{readOnly ? "会话已归档" : "修改并重新研究"}</button>}{message.role === "assistant" && message.runId && <button type="button" onClick={() => onOpenReport(message.runId!)}>{message.runId === activeReportRunId ? "正式报告已打开" : "查看正式报告"}</button>}</div>
      <p>{message.role === "assistant" && message.runId === activeReportRunId ? "正式研究报告与逐项引用已在下方打开。" : message.content}</p>
    </article>)}</div>
  </section>;
}
