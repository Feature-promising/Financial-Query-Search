"use client";

import { useRef, useState } from "react";
import { getAccessTokenOrRedirect, oidcEnabled } from "../auth/oidc-session";
import { latestAssistantReportRunId } from "../lib/conversation-reports";
import { isConversationArchived } from "../lib/conversation-state";
import { createResearchApiClient } from "../lib/research-api";
import { consumeSse } from "../lib/sse";
import type { ConversationDetailView, EvidenceView, ResearchEvent, ResearchReportView, ResearchRunView } from "../lib/research-types";

export type { ResearchEvent } from "../lib/research-types";

type TerminalEvent = "completed" | "abstained" | "failed" | "run_paused";
type ActiveRun = Pick<ResearchRunView, "id" | "status">;

/**
 * Owns one currently viewed run. The server remains authoritative: this hook
 * renders persisted SSE events and offers the queue-safe pause transition only
 * before a Worker has claimed the run.
 */
export function useResearchRun(onConversationChanged?: (conversationId: string) => void) {
  const [conversationId, setConversationId] = useState<string>();
  const [conversation, setConversation] = useState<ConversationDetailView>();
  const [events, setEvents] = useState<ResearchEvent[]>([]);
  const [report, setReport] = useState<ResearchReportView>();
  const [reportError, setReportError] = useState<string>();
  const [submissionError, setSubmissionError] = useState<string>();
  const [running, setRunning] = useState(false);
  const [streamPaused, setStreamPaused] = useState(false);
  const [activeRun, setActiveRun] = useState<ActiveRun>();
  const [runControlError, setRunControlError] = useState<string>();
  const [runControlPending, setRunControlPending] = useState(false);
  const apiRef = useRef<ReturnType<typeof createResearchApiClient> | undefined>(undefined);
  const pausedRef = useRef(false);
  const bufferedEventsRef = useRef<ResearchEvent[]>([]);
  const bufferedReportRef = useRef<ResearchReportView | undefined>(undefined);
  const latestSequenceRef = useRef(0);

  async function submit(question: string): Promise<boolean> {
    if (!question.trim() || running) return false;
    if (isConversationArchived(conversation)) {
      setSubmissionError("该会话已归档。请先从左侧会话列表恢复，再继续研究。");
      return false;
    }
    resetRunView();
    setSubmissionError(undefined);
    setRunning(true);
    let requestAccepted = false;
    try {
      const api = await authorizedApi();
      if (!api) return false;
      const id = await ensureConversation(conversationId, setConversationId, api, onConversationChanged);
      const response = await api.createTurn(id, question);
      if (!response.ok || !response.body) throw new Error("Research request failed");
      requestAccepted = true;
      const runId = response.headers.get("x-research-run-id") ?? undefined;
      if (runId) setActiveRun({ id: runId, status: "queued" });
      const outcome = await followRunStream(api, response, runId);
      await publishCompletedArtifacts(api, id, outcome);
      return true;
    } catch {
      setEvents([{ type: "failed", payload: { code: "CLIENT_REQUEST_FAILED", message: "Unable to start or resume the research run. Please try again." } }]);
      setSubmissionError(requestAccepted ? undefined : "研究尚未创建成功；你的问题已保留，可以直接重试。");
      return requestAccepted;
    } finally {
      setRunning(false);
    }
  }

  async function pauseQueuedRun(): Promise<void> {
    if (!activeRun || activeRun.status !== "queued" || runControlPending) return;
    setRunControlPending(true); setRunControlError(undefined);
    try {
      const api = await authorizedApi();
      if (!api) return;
      const paused = await api.pauseQueuedRun(activeRun.id);
      setActiveRun({ id: paused.id, status: paused.status });
    } catch {
      setRunControlError("研究已被执行器领取，无法安全暂停。你仍可暂停展示。");
    } finally {
      setRunControlPending(false);
    }
  }

  async function resumeQueuedRun(): Promise<void> {
    if (!activeRun || activeRun.status !== "paused" || running || runControlPending) return;
    setRunControlPending(true); setRunControlError(undefined); setRunning(true);
    try {
      const api = await authorizedApi();
      if (!api) return;
      const resumed = await api.resumeQueuedRun(activeRun.id);
      setActiveRun({ id: resumed.id, status: resumed.status });
      for (const event of resumed.events) receiveEvent(event);
      const response = await api.resumeRunEvents(resumed.id, latestSequenceRef.current);
      if (!response.ok || !response.body) throw new Error("Research resume stream failed");
      const outcome = await followRunStream(api, response, resumed.id);
      if (conversationId) await publishCompletedArtifacts(api, conversationId, outcome);
    } catch {
      setRunControlError("恢复研究失败；该运行仍保留在服务端，可稍后重试。");
    } finally {
      setRunControlPending(false); setRunning(false);
    }
  }

  async function selectConversation(id: string | undefined): Promise<void> {
    setConversationId(id);
    resetRunView();
    if (!id) { setConversation(undefined); return; }
    const api = await authorizedApi();
    if (!api) return;
    const selected = await api.getConversation(id);
    setConversation(selected);
    // Reopening a conversation should lead with the most recent published,
    // cited report when one exists. Failed/abstained turns remain visible as
    // normal transcript messages and never masquerade as a report.
    const latestAssistantRunId = latestAssistantReportRunId(selected);
    if (latestAssistantRunId) await restorePublishedReport(api, latestAssistantRunId);
  }

  async function openReportForRun(runId: string): Promise<void> {
    const api = await authorizedApi();
    if (!api) return;
    setEvents([]); setReport(undefined); setReportError(undefined);
    try {
      await loadPublishedReportAndReplay(api, runId);
    } catch {
      setReportError("该轮研究未发布可引用报告；请在会话记录中查看其拒答或失败说明。");
    }
  }

  function setStreamingPaused(paused: boolean): void {
    pausedRef.current = paused;
    setStreamPaused(paused);
    if (paused) return;
    const bufferedEvents = bufferedEventsRef.current;
    bufferedEventsRef.current = [];
    if (bufferedEvents.length) setEvents((previous) => [...previous, ...bufferedEvents.filter((event) => !event.sequence || !previous.some((item) => item.sequence === event.sequence))]);
    if (bufferedReportRef.current) {
      setReport(bufferedReportRef.current);
      bufferedReportRef.current = undefined;
    }
  }

  async function loadEvidence(evidenceId: string): Promise<EvidenceView> {
    const api = apiRef.current ?? await authorizedApi();
    if (!api) throw new Error("请先登录");
    return api.getEvidence(evidenceId);
  }

  async function authorizedApi(): Promise<ReturnType<typeof createResearchApiClient> | undefined> {
    if (apiRef.current) return apiRef.current;
    const accessToken = await getAccessTokenOrRedirect(window.location.pathname);
    if (!accessToken && oidcEnabled()) return undefined;
    const api = createResearchApiClient(accessToken);
    apiRef.current = api;
    return api;
  }

  async function followRunStream(api: ReturnType<typeof createResearchApiClient>, initialResponse: Response, initialRunId?: string): Promise<{ runId?: string; terminalType: TerminalEvent }> {
    let runId = initialRunId;
    let terminalType: TerminalEvent | undefined;
    const receive = (event: ResearchEvent): void => {
      runId ??= event.runId;
      receiveEvent(event, runId);
      if (isTerminalEvent(event.type)) terminalType = event.type;
    };
    await consumeSse(initialResponse.body!, receive);
    for (let attempt = 0; runId && !terminalType && attempt < 2; attempt += 1) {
      const resumed = await api.resumeRunEvents(runId, latestSequenceRef.current);
      if (!resumed.ok || !resumed.body) throw new Error("研究事件流恢复失败");
      await consumeSse(resumed.body, receive);
    }
    if (!terminalType) throw new Error("研究事件流意外结束");
    return { runId, terminalType };
  }

  function receiveEvent(event: ResearchEvent, knownRunId?: string): void {
    const runId = event.runId ?? knownRunId;
    latestSequenceRef.current = Math.max(latestSequenceRef.current, event.sequence ?? 0);
    if (runId) setActiveRun((previous) => ({ id: runId, status: statusAfterEvent(event.type, previous?.status ?? "queued") }));
    if (pausedRef.current) {
      if (!event.sequence || !bufferedEventsRef.current.some((item) => item.sequence === event.sequence)) bufferedEventsRef.current.push(event);
      return;
    }
    setEvents((previous) => event.sequence && previous.some((item) => item.sequence === event.sequence) ? previous : [...previous, event]);
  }

  async function publishCompletedArtifacts(api: ReturnType<typeof createResearchApiClient>, id: string, outcome: { runId?: string; terminalType: TerminalEvent }): Promise<void> {
    if (outcome.runId && outcome.terminalType === "completed") {
      try {
        const nextReport = await api.getReportForRun(outcome.runId);
        if (pausedRef.current) bufferedReportRef.current = nextReport;
        else setReport(nextReport);
      } catch {
        setReportError("研究已完成，但最终报告附件暂不可用；请稍后刷新。");
      }
    }
    setConversation(await api.getConversation(id));
  }

  async function restorePublishedReport(api: ReturnType<typeof createResearchApiClient>, runId: string): Promise<void> {
    try {
      await loadPublishedReportAndReplay(api, runId);
    } catch {
      // A transcript can contain an abstained or failed turn, which correctly
      // has no report. Opening a conversation must not turn that normal state
      // into a page-level error.
    }
  }

  async function loadPublishedReportAndReplay(api: ReturnType<typeof createResearchApiClient>, runId: string): Promise<void> {
    const [publishedReport, run] = await Promise.all([api.getReportForRun(runId), api.getRun(runId)]);
    setReport(publishedReport);
    setEvents(run.events);
    latestSequenceRef.current = Math.max(0, ...run.events.map((event) => event.sequence));
    setActiveRun({ id: run.id, status: run.status });
  }

  function resetRunView(): void {
    setEvents([]); setReport(undefined); setReportError(undefined); setStreamPaused(false); setActiveRun(undefined); setRunControlError(undefined);
    pausedRef.current = false; bufferedEventsRef.current = []; bufferedReportRef.current = undefined; latestSequenceRef.current = 0;
  }

  return {
    conversationId, conversation, events, report, reportError, submissionError, running, streamPaused, activeRun, runControlError, runControlPending,
    submit, selectConversation, setStreamingPaused, pauseQueuedRun, resumeQueuedRun, openReportForRun, loadEvidence,
  };
}

function isTerminalEvent(type: ResearchEvent["type"]): type is TerminalEvent {
  return type === "completed" || type === "abstained" || type === "failed" || type === "run_paused";
}

function statusAfterEvent(type: ResearchEvent["type"], previous: ResearchRunView["status"]): ResearchRunView["status"] {
  if (type === "run_started") return "running";
  if (type === "run_paused") return "paused";
  if (type === "run_resumed") return "queued";
  if (type === "completed" || type === "abstained" || type === "failed") return type;
  return previous;
}

async function ensureConversation(currentId: string | undefined, setConversationId: (id: string) => void, api: ReturnType<typeof createResearchApiClient>, onConversationChanged?: (conversationId: string) => void): Promise<string> {
  if (currentId) return currentId;
  const conversation = await api.createConversation();
  setConversationId(conversation.id);
  onConversationChanged?.(conversation.id);
  return conversation.id;
}
