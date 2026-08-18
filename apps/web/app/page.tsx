"use client";

import { FormEvent, useEffect, useState } from "react";
import { ConversationSidebar } from "./components/conversation-sidebar";
import { ConversationTranscript } from "./components/conversation-transcript";
import { ResearchEvents } from "./components/research-events";
import { PreferencePanel } from "./components/preference-panel";
import { useConversations } from "./hooks/use-conversations";
import { useOidcSession } from "./hooks/use-oidc-session";
import { useResearchRun } from "./hooks/use-research-run";
import { isConversationArchived } from "./lib/conversation-state";

export default function ResearchPage() {
  const [question, setQuestion] = useState("");
  const session = useOidcSession();
  const conversations = useConversations();
  const research = useResearchRun(() => { void conversations.refresh(); });
  const needsSignIn = session.available && !session.authenticated;
  const conversationArchived = isConversationArchived(research.conversation);

  useEffect(() => {
    if (!session.loading && !needsSignIn) void conversations.refresh();
  }, [conversations.refresh, needsSignIn, session.loading]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const submitted = await research.submit(question);
    if (submitted) {
      setQuestion("");
      await conversations.refresh();
    }
  }

  async function selectConversation(conversationId: string): Promise<void> {
    await research.selectConversation(conversationId);
    setQuestion("");
  }

  async function archiveConversation(conversationId: string, archived: boolean): Promise<void> {
    await conversations.archive(conversationId, archived);
    if (research.conversationId === conversationId && archived) await research.selectConversation(undefined);
  }

  async function deleteConversation(conversationId: string): Promise<void> {
    await conversations.remove(conversationId);
    if (research.conversationId === conversationId) await research.selectConversation(undefined);
  }

  return <main className="workspace-shell product-workspace">
    <nav className="topbar" aria-label="主导航">
      <a className="brand" href="#research"><span className="brand-mark" aria-hidden="true">R</span><span>Research<span className="brand-muted">/terminal</span></span></a>
      <div className="topbar-actions">
        <span className={`connection-state ${needsSignIn ? "connection-state--idle" : ""}`}><i aria-hidden="true" />{needsSignIn ? "等待登录" : research.running ? "研究正在运行" : "证据链已就绪"}</span>
        {session.available && <button type="button" className="nav-button" onClick={() => void (session.authenticated ? session.signOut() : session.signIn())} disabled={session.loading}>{session.authenticated ? "退出登录" : "企业登录"}</button>}
        <PreferencePanel disabled={needsSignIn} />
      </div>
    </nav>

    <div className="workbench-grid">
      <ConversationSidebar active={conversations.active} archived={conversations.archived} activeHasMore={conversations.activeHasMore} archivedHasMore={conversations.archivedHasMore} selectedId={research.conversationId} loading={conversations.loading} loadingMore={conversations.loadingMore} error={conversations.error} onNew={() => void research.selectConversation(undefined)} onSelect={(id) => void selectConversation(id)} onRename={conversations.rename} onArchive={archiveConversation} onDelete={deleteConversation} onLoadMore={conversations.loadMore} />
      <section className="research-workbench" id="research">
        <header className="workspace-intro">
          <div><p className="eyebrow">Evidence-driven US equity research</p><h1>把每一个投资判断，<em>落到可审计的证据上。</em></h1></div>
          <p>会话、研究过程和最终报告分开保存。生成中的内容会标注为待审查，只有通过引用核验的结论才会发布。</p>
        </header>

        <ConversationTranscript conversation={research.conversation} activeReportRunId={research.report?.runId} readOnly={conversationArchived} onEditQuestion={(value) => { setQuestion(value); document.getElementById("research-question")?.focus(); }} onOpenReport={(runId) => void research.openReportForRun(runId)} />

        <section className="research-stage" aria-label="发起研究">
          <div className="stage-heading"><div><h2>{conversationArchived ? "会话已归档" : research.conversation ? "继续研究" : "开始新的研究"}</h2><p>{conversationArchived ? "归档会话仅可查看。请在左侧选择“恢复”后再继续研究。" : research.conversation ? "修改历史问题会创建新的可审计研究 turn。" : "从公司、财报、行业趋势或估值假设开始。"}</p></div><span className="draft-state">{question.length ? `${question.length} / 1600` : "草稿"}</span></div>
          <form className="research-form" onSubmit={(event) => void submit(event)}>
            <textarea id="research-question" value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={1_600} disabled={conversationArchived} placeholder={conversationArchived ? "请先恢复此会话再继续研究" : "例如：分析 NVDA 最新财报对长期增长假设的影响"} aria-label="研究问题" />
            <div className="form-footer"><span>最终输出包含可访问的原始证据与逐项引用定位。</span><div className="session-controls">{research.running && <button className="quiet-button" type="button" onClick={() => research.setStreamingPaused(!research.streamPaused)}>{research.streamPaused ? "继续展示" : "暂停展示"}</button>}{research.activeRun?.status === "queued" && <button className="quiet-button" type="button" disabled={research.runControlPending} onClick={() => void research.pauseQueuedRun()}>{research.runControlPending ? "正在暂停" : "暂停后台研究"}</button>}{research.activeRun?.status === "paused" && <button className="quiet-button" type="button" disabled={research.runControlPending || research.running} onClick={() => void research.resumeQueuedRun()}>{research.runControlPending ? "正在恢复" : "恢复后台研究"}</button>}<button className="primary-button" disabled={research.running || needsSignIn || conversationArchived}>{research.running ? "正在构建研究" : needsSignIn ? "请先登录" : conversationArchived ? "会话已归档" : "开始研究"}</button></div></div>
          </form>
          {research.streamPaused && <p className="stream-pause-notice">实时展示已暂停。研究仍在受控运行，新的 SSE 事件会暂存，继续展示后按顺序恢复。</p>}
          {research.activeRun?.status === "queued" && <p className="stream-pause-notice">研究正在等待执行。此时可安全暂停后台任务；一旦执行器领取任务，只能暂停展示。</p>}
          {research.activeRun?.status === "paused" && <p className="stream-pause-notice">后台研究已在队列中暂停，尚未调用模型或工具。恢复后将继续使用同一不可变研究任务。</p>}
          {research.runControlError && <p className="error">{research.runControlError}</p>}
          {research.submissionError && <p className="error">{research.submissionError}</p>}
        </section>

        <ResearchEvents events={research.events} report={research.report} reportError={research.reportError} streamPaused={research.streamPaused} loadEvidence={research.loadEvidence} />
      </section>
    </div>
  </main>;
}
