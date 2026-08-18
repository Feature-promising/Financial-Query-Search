import {
  CreatedConversationSchema,
  ConversationDetailViewSchema,
  ConversationListResponseSchema,
  ConversationViewSchema,
  EvidenceViewSchema,
  PreferenceListResponseSchema,
  PreferenceResponseSchema,
  ResearchReportViewSchema,
  ResearchRunViewSchema,
  type ConfirmedPreference,
  type ConversationListResponse,
} from "@research/contracts";
import type { ConversationDetailView, ConversationView, EvidenceView, ResearchReportView, ResearchRunView } from "./research-types";

export interface ConversationListRequest {
  archived?: boolean;
  limit?: number;
  cursor?: string;
}

export interface ResearchApiClient {
  createConversation(): Promise<{ id: string }>;
  listConversations(request?: ConversationListRequest): Promise<ConversationListResponse>;
  getConversation(conversationId: string): Promise<ConversationDetailView>;
  renameConversation(conversationId: string, title: string): Promise<ConversationView>;
  archiveConversation(conversationId: string, archived: boolean): Promise<ConversationView>;
  deleteConversation(conversationId: string): Promise<void>;
  createTurn(conversationId: string, question: string): Promise<Response>;
  getRun(runId: string): Promise<ResearchRunView>;
  pauseQueuedRun(runId: string): Promise<ResearchRunView>;
  resumeQueuedRun(runId: string): Promise<ResearchRunView>;
  resumeRunEvents(runId: string, afterSequence: number): Promise<Response>;
  getEvidence(evidenceId: string): Promise<EvidenceView>;
  getReportForRun(runId: string): Promise<ResearchReportView>;
  listPreferences(): Promise<ConfirmedPreference[]>;
  savePreference(preference: ConfirmedPreference): Promise<ConfirmedPreference>;
}

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/** All browser API requests use the same Bearer-token policy. */
export function createResearchApiClient(accessToken?: string): ResearchApiClient {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  return {
    async createConversation() {
      const response = await fetch(`${apiUrl}/v1/conversations`, { method: "POST", headers, body: JSON.stringify({ title: "Research session" }) });
      if (!response.ok) throw new Error("Unable to create conversation");
      return CreatedConversationSchema.parse(await response.json());
    },
    async listConversations(request = {}) {
      const query = new URLSearchParams({ archived: String(request.archived ?? false), limit: String(request.limit ?? 50) });
      if (request.cursor) query.set("cursor", request.cursor);
      const response = await fetch(`${apiUrl}/v1/conversations?${query.toString()}`, { headers });
      if (!response.ok) throw new Error("会话列表读取失败");
      return ConversationListResponseSchema.parse(await response.json());
    },
    async getConversation(conversationId) {
      const response = await fetch(`${apiUrl}/v1/conversations/${encodeURIComponent(conversationId)}`, { headers });
      if (!response.ok) throw new Error(response.status === 404 ? "会话不存在或无权访问" : "会话读取失败");
      return ConversationDetailViewSchema.parse(await response.json());
    },
    async renameConversation(conversationId, title) {
      const response = await fetch(`${apiUrl}/v1/conversations/${encodeURIComponent(conversationId)}`, { method: "PATCH", headers, body: JSON.stringify({ title }) });
      if (!response.ok) throw new Error("会话重命名失败");
      return ConversationViewSchema.parse(await response.json());
    },
    async archiveConversation(conversationId, archived) {
      const suffix = archived ? "archive" : "unarchive";
      const response = await fetch(`${apiUrl}/v1/conversations/${encodeURIComponent(conversationId)}/${suffix}`, { method: "POST", headers });
      if (!response.ok) throw new Error("会话状态更新失败");
      return ConversationViewSchema.parse(await response.json());
    },
    async deleteConversation(conversationId) {
      const response = await fetch(`${apiUrl}/v1/conversations/${encodeURIComponent(conversationId)}`, { method: "DELETE", headers });
      if (!response.ok && response.status !== 404) throw new Error("会话删除失败");
    },
    createTurn(conversationId, question) {
      return fetch(`${apiUrl}/v1/conversations/${conversationId}/turns`, { method: "POST", headers: { ...headers, accept: "text/event-stream" }, body: JSON.stringify({ question }) });
    },
    async getRun(runId) {
      const response = await fetch(`${apiUrl}/v1/runs/${encodeURIComponent(runId)}`, { headers });
      if (!response.ok) throw new Error(response.status === 404 ? "研究运行不存在或无权访问" : "研究运行读取失败");
      return ResearchRunViewSchema.parse(await response.json());
    },
    async pauseQueuedRun(runId) {
      const response = await fetch(`${apiUrl}/v1/runs/${encodeURIComponent(runId)}/pause`, { method: "POST", headers });
      if (!response.ok) throw new Error("RUN_PAUSE_UNAVAILABLE");
      return ResearchRunViewSchema.parse(await response.json());
    },
    async resumeQueuedRun(runId) {
      const response = await fetch(`${apiUrl}/v1/runs/${encodeURIComponent(runId)}/resume`, { method: "POST", headers });
      if (!response.ok) throw new Error("RUN_RESUME_UNAVAILABLE");
      return ResearchRunViewSchema.parse(await response.json());
    },
    resumeRunEvents(runId, afterSequence) {
      return fetch(`${apiUrl}/v1/runs/${encodeURIComponent(runId)}/events`, { headers: { ...headers, accept: "text/event-stream", "last-event-id": String(afterSequence) } });
    },
    async getEvidence(evidenceId) {
      const response = await fetch(`${apiUrl}/v1/evidence/${encodeURIComponent(evidenceId)}`, { headers });
      if (!response.ok) throw new Error(response.status === 404 ? "证据不存在或无权访问" : "证据请求失败");
      return EvidenceViewSchema.parse(await response.json());
    },
    async getReportForRun(runId) {
      const response = await fetch(`${apiUrl}/v1/reports`, { method: "POST", headers, body: JSON.stringify({ runId }) });
      if (!response.ok) throw new Error(response.status === 404 ? "最终报告尚未可用" : "最终报告请求失败");
      return ResearchReportViewSchema.parse(await response.json());
    },
    async listPreferences() {
      const response = await fetch(`${apiUrl}/v1/memory/preferences`, { headers });
      if (!response.ok) throw new Error("偏好读取失败");
      const body = PreferenceListResponseSchema.parse(await response.json());
      return body.preferences;
    },
    async savePreference(preference) {
      const response = await fetch(`${apiUrl}/v1/memory/preferences`, { method: "PUT", headers, body: JSON.stringify({ preference }) });
      if (!response.ok) throw new Error("偏好保存失败");
      const body = PreferenceResponseSchema.parse(await response.json());
      return body.preference;
    },
  };
}
