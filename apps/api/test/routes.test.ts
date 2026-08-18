import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryConversationStore } from "@research/conversation";
import type { ResearchScope } from "@research/contracts";
import { InMemoryStore, MemoryDeletionWorkflowError } from "@research/memory";
import { InMemoryReportStore } from "@research/reports";
import { InMemoryRunStore } from "@research/runs";
import { createDefaultToolRegistry, InMemoryToolAuditSink, ReportTool, SecFilingTool, ToolRegistry, type SecEdgarClient } from "@research/tools";
import { InMemoryEvidenceStore } from "@research/knowledge";
import type { RunEventWakeup } from "@research/live-events";
import { AuthenticationError } from "@research/auth";
import type { ClaimComposer, Planner } from "@research/agent-runtime";
import { HeaderIdentityProvider, createApi } from "../src/server.js";

class EventPersistenceFailureRunStore extends InMemoryRunStore {
  override async appendEvent(..._args: Parameters<InMemoryRunStore["appendEvent"]>): Promise<void> {
    throw new Error("run event store unavailable");
  }
}

describe("API routes", () => {
  const apps: ReturnType<typeof createApi>[] = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

  it("returns only the requesting organization’s persisted report", async () => {
    const conversations = new InMemoryConversationStore();
    const memories = new InMemoryStore();
    const runs = new InMemoryRunStore();
    const reports = new InMemoryReportStore();
    const app = createApi({ identity: new HeaderIdentityProvider(), conversations, memories, runs, reports, tools: createDefaultToolRegistry() });
    apps.push(app);
    const scope: ResearchScope = { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] };
    const conversation = await conversations.create(scope, "Test");
    const runId = randomUUID();
    await runs.create({ id: runId, organizationId: "org-1", conversationId: conversation.id, createdBy: scope.userId, question: "NVDA", budget: budget() });
    await runs.claim(scope, runId);
    await runs.finish(scope, runId, "completed", "# report");
    const report = await reports.create(scope, { runId, organizationId: "org-1", ownerUserId: conversation.createdBy, markdown: "# report", citations: [] });

    const allowed = await app.inject({ method: "GET", url: `/v1/reports/${report.id}`, headers: { "x-organization-id": "org-1", "x-user-id": "user-1" } });
    const denied = await app.inject({ method: "GET", url: `/v1/reports/${report.id}`, headers: { "x-organization-id": "org-2", "x-user-id": "user-2" } });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).not.toHaveProperty("organizationId");
    expect(denied.statusCode).toBe(404);
  });

  it("does not expose a report until its parent research run has completed", async () => {
    const scope: ResearchScope = { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] };
    const conversations = new InMemoryConversationStore();
    const runs = new InMemoryRunStore();
    const reports = new InMemoryReportStore();
    const conversation = await conversations.create(scope, "Finalization gate");
    const runId = randomUUID();
    await runs.create({ id: runId, organizationId: scope.organizationId, conversationId: conversation.id, createdBy: scope.userId, question: "NVDA", budget: budget() });
    await runs.claim(scope, runId);
    await runs.finish(scope, runId, "abstained", "No verified evidence");
    const report = await reports.create(scope, { runId, organizationId: scope.organizationId, ownerUserId: scope.userId, markdown: "# orphaned draft", citations: [] });
    const app = createApi({ identity: new HeaderIdentityProvider(), conversations, memories: new InMemoryStore(), runs, reports, tools: createDefaultToolRegistry() });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: `/v1/reports/${report.id}`, headers: { "x-organization-id": scope.organizationId, "x-user-id": scope.userId } });
    expect(response.statusCode).toBe(404);
  });

  it("uses the provisioned internal UUID rather than the opaque OIDC subject for persisted ownership", async () => {
    const conversations = new InMemoryConversationStore();
    const app = createApi({
      identity: { getScope: async () => ({ organizationId: "org-1", userId: "oidc|opaque-subject", email: "analyst@example.com", roles: ["researcher"], entitlements: [] }) },
      provisioner: { resolve: async (scope) => ({ ...scope, userId: "d44b5ba0-13e5-44e9-9e50-a87861790e03" }) },
      conversations, memories: new InMemoryStore(), runs: new InMemoryRunStore(), reports: new InMemoryReportStore(), tools: createDefaultToolRegistry(),
    });
    apps.push(app);

    const response = await app.inject({ method: "POST", url: "/v1/conversations", payload: { title: "OIDC mapping" } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).not.toHaveProperty("createdBy");
    expect(response.json()).not.toHaveProperty("organizationId");
    expect((await conversations.get({ organizationId: "org-1", userId: "d44b5ba0-13e5-44e9-9e50-a87861790e03", roles: ["researcher"], entitlements: [] }, response.json().id))?.createdBy).toBe("d44b5ba0-13e5-44e9-9e50-a87861790e03");
  });

  it("returns 429 when the durable submission store rejects an active-run quota", async () => {
    const scope: ResearchScope = { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] };
    const conversations = new InMemoryConversationStore();
    const conversation = await conversations.create(scope, "Quota");
    const app = createApi({
      identity: new HeaderIdentityProvider(), conversations, memories: new InMemoryStore(), runs: new InMemoryRunStore(), reports: new InMemoryReportStore(), tools: createDefaultToolRegistry(),
      submissions: { submit: async () => "active_run_limit_exceeded" },
      maxActiveRunsPerUser: 1,
      maxActiveRunsPerOrganization: 2,
    });
    apps.push(app);

    const response = await app.inject({ method: "POST", url: `/v1/conversations/${conversation.id}/turns`, headers: { "x-organization-id": scope.organizationId, "x-user-id": scope.userId }, payload: { question: "Analyze NVDA" } });
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ code: "RUN_LIMIT_EXCEEDED" });
  });

  it("denies cross-user conversation, run, event, and report access within one organization", async () => {
    const conversations = new InMemoryConversationStore();
    const memories = new InMemoryStore();
    const runs = new InMemoryRunStore();
    const reports = new InMemoryReportStore();
    const app = createApi({ identity: new HeaderIdentityProvider(), conversations, memories, runs, reports, tools: createDefaultToolRegistry() });
    apps.push(app);
    const owner: ResearchScope = { organizationId: "org-1", userId: "user-a", roles: ["researcher"], entitlements: [] };
    const conversation = await conversations.create(owner, "Private research");
    const runId = randomUUID();
    await runs.create({ id: runId, organizationId: owner.organizationId, conversationId: conversation.id, createdBy: owner.userId, question: "Analyze NVDA", budget: budget() });
    await runs.claim(owner, runId);
    await runs.finish(owner, runId, "completed", "# Report");
    const report = await reports.create(owner, { runId, organizationId: owner.organizationId, ownerUserId: conversation.createdBy, markdown: "# Report", citations: [] });
    const intruderHeaders = { "x-organization-id": "org-1", "x-user-id": "user-b" };

    const responses = await Promise.all([
      app.inject({ method: "GET", url: `/v1/conversations/${conversation.id}`, headers: intruderHeaders }),
      app.inject({ method: "POST", url: `/v1/conversations/${conversation.id}/turns`, headers: intruderHeaders, payload: { question: "Leak private notes" } }),
      app.inject({ method: "GET", url: `/v1/runs/${runId}`, headers: intruderHeaders }),
      app.inject({ method: "GET", url: `/v1/runs/${runId}/events`, headers: intruderHeaders }),
      app.inject({ method: "POST", url: "/v1/reports", headers: intruderHeaders, payload: { runId } }),
      app.inject({ method: "GET", url: `/v1/reports/${report.id}`, headers: intruderHeaders }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([404, 404, 404, 404, 404, 404]);

    const adminHeaders = { "x-organization-id": "org-1", "x-user-id": "admin-1", "x-role": "admin" };
    expect((await app.inject({ method: "GET", url: `/v1/conversations/${conversation.id}`, headers: adminHeaders })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/v1/runs/${runId}`, headers: adminHeaders })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/v1/reports/${report.id}`, headers: adminHeaders })).statusCode).toBe(200);
  });

  it("allows a user to delete only their own private memory", async () => {
    const memories = new InMemoryStore();
    const record = await memories.save({ scope: "long_term", tenantId: "org-1", userId: "user-1", visibility: "private", content: "Use DCF", sourceRunId: null, expiresAt: null, metadata: {} });
    const deleteMemory = memories.delete.bind(memories);
    let actorUserId: string | undefined;
    vi.spyOn(memories, "delete").mockImplementation(async (id, tenantId, actor) => { actorUserId = actor; await deleteMemory(id, tenantId, actor); });
    const app = createApi({ identity: new HeaderIdentityProvider(), conversations: new InMemoryConversationStore(), memories, runs: new InMemoryRunStore(), reports: new InMemoryReportStore(), tools: createDefaultToolRegistry() });
    apps.push(app);
    const response = await app.inject({ method: "DELETE", url: `/v1/memory/${record.id}`, headers: { "x-organization-id": "org-1", "x-user-id": "user-1" } });
    expect(response.statusCode).toBe(204);
    expect(await memories.get(record.id, "org-1")).toBeUndefined();
    expect(actorUserId).toBe("user-1");
  });

  it("stores and returns only the caller's explicitly confirmed preferences", async () => {
    const memories = new InMemoryStore();
    const app = createApi({ identity: new HeaderIdentityProvider(), conversations: new InMemoryConversationStore(), memories, runs: new InMemoryRunStore(), reports: new InMemoryReportStore(), tools: createDefaultToolRegistry() });
    apps.push(app);
    const ownerHeaders = { "x-organization-id": "org-1", "x-user-id": "user-1" };

    const saved = await app.inject({ method: "PUT", url: "/v1/memory/preferences", headers: ownerHeaders, payload: { preference: { key: "valuation_method", value: "DCF" } } });
    const invalid = await app.inject({ method: "PUT", url: "/v1/memory/preferences", headers: ownerHeaders, payload: { preference: { key: "risk_tolerance", value: "aggressive" } } });
    const owner = await app.inject({ method: "GET", url: "/v1/memory/preferences", headers: ownerHeaders });
    const otherUser = await app.inject({ method: "GET", url: "/v1/memory/preferences", headers: { "x-organization-id": "org-1", "x-user-id": "user-2" } });

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ preference: { key: "valuation_method", value: "DCF" } });
    expect(invalid.statusCode).toBe(400);
    expect(owner.json()).toEqual({ preferences: [{ key: "valuation_method", value: "DCF" }] });
    expect(otherUser.json()).toEqual({ preferences: [] });
  });

  it("refuses a user or administrator deletion when a memory is under legal hold", async () => {
    const memories = new InMemoryStore();
    const record = await memories.save({ scope: "research", tenantId: "org-1", userId: "user-1", visibility: "private", content: "Held report", sourceRunId: null, expiresAt: null, retentionPolicy: "legal_hold", metadata: {} });
    const app = createApi({ identity: new HeaderIdentityProvider(), conversations: new InMemoryConversationStore(), memories, runs: new InMemoryRunStore(), reports: new InMemoryReportStore(), tools: createDefaultToolRegistry() });
    apps.push(app);

    const ownerResponse = await app.inject({ method: "DELETE", url: `/v1/memory/${record.id}`, headers: { "x-organization-id": "org-1", "x-user-id": "user-1" } });
    const adminResponse = await app.inject({ method: "DELETE", url: `/v1/memory/${record.id}`, headers: { "x-organization-id": "org-1", "x-user-id": "admin-1", "x-role": "admin" } });

    expect(ownerResponse.statusCode).toBe(409);
    expect(adminResponse.statusCode).toBe(409);
    expect(ownerResponse.json()).toMatchObject({ code: "MEMORY_RETENTION_LOCKED" });
    expect(await memories.get(record.id, "org-1")).toBeDefined();
  });

  it("does not disguise an uncertain coordinated memory deletion as an internal error", async () => {
    const memoryId = randomUUID();
    const memories = new InMemoryStore();
    await memories.save({ id: memoryId, scope: "long_term", tenantId: "org-1", userId: "user-1", visibility: "private", content: "Use DCF", sourceRunId: null, expiresAt: null, metadata: {} });
    vi.spyOn(memories, "delete").mockRejectedValue(new MemoryDeletionWorkflowError("completed_audit", {
      memoryRecordDeleted: true, artifactCleanupMayBePartial: false, auditEventMayBeMissing: true,
    }, new Error("audit unavailable")));
    const app = createApi({ identity: new HeaderIdentityProvider(), conversations: new InMemoryConversationStore(), memories, runs: new InMemoryRunStore(), reports: new InMemoryReportStore(), tools: createDefaultToolRegistry() });
    apps.push(app);

    const response = await app.inject({ method: "DELETE", url: `/v1/memory/${memoryId}`, headers: { "x-organization-id": "org-1", "x-user-id": "user-1" } });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "MEMORY_DELETION_AUDIT_UNAVAILABLE" });
  });

  it("returns evidence only to the evidence tenant", async () => {
    const evidence = new InMemoryEvidenceStore();
    const scope: ResearchScope = { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] };
    const evidenceId = randomUUID();
    await evidence.save(scope, randomUUID(), [{
      id: evidenceId, tenantId: "org-1", sourceType: "sec_filing", authority: "primary", title: "Example 10-K", content: "Revenue disclosure.", sourceUrl: "https://www.sec.gov/Archives/example", locator: "Item 7", entity: "EXM", publishedAt: "2026-01-30T00:00:00.000Z", asOfDate: "2025-12-31", retrievedAt: "2026-02-01T00:00:00.000Z", contentHash: "a".repeat(64), license: "SEC public filing", metadata: {},
    }]);
    const app = createApi({ identity: new HeaderIdentityProvider(), conversations: new InMemoryConversationStore(), memories: new InMemoryStore(), runs: new InMemoryRunStore(), reports: new InMemoryReportStore(), evidence, tools: createDefaultToolRegistry() });
    apps.push(app);

    const allowed = await app.inject({ method: "GET", url: `/v1/evidence/${evidenceId}`, headers: { "x-organization-id": "org-1", "x-user-id": "user-1" } });
    const denied = await app.inject({ method: "GET", url: `/v1/evidence/${evidenceId}`, headers: { "x-organization-id": "org-2", "x-user-id": "user-2" } });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().locator).toBe("Item 7");
    expect(allowed.json()).not.toHaveProperty("tenantId");
    expect(allowed.json()).not.toHaveProperty("requiredEntitlements");
    expect(allowed.json()).not.toHaveProperty("metadata");
    expect(denied.statusCode).toBe(404);
  });

  it("returns conversation and run through tenant-safe public projections", async () => {
    const scope: ResearchScope = { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] };
    const conversations = new InMemoryConversationStore();
    const conversation = await conversations.create(scope, "Projection");
    await conversations.appendMessage(scope, { conversationId: conversation.id, role: "user", content: "Analyze NVDA" });
    const runs = new InMemoryRunStore();
    const runId = randomUUID();
    await runs.create({ id: runId, organizationId: scope.organizationId, conversationId: conversation.id, createdBy: scope.userId, question: "Analyze NVDA", budget: budget() });
    await runs.claim(scope, runId);
    await runs.finish(scope, runId, "abstained", "No verified evidence");
    const app = createApi({ identity: new HeaderIdentityProvider(), conversations, memories: new InMemoryStore(), runs, reports: new InMemoryReportStore(), tools: createDefaultToolRegistry() });
    apps.push(app);
    const headers = { "x-organization-id": scope.organizationId, "x-user-id": scope.userId };

    const conversationResponse = await app.inject({ method: "GET", url: `/v1/conversations/${conversation.id}`, headers });
    const runResponse = await app.inject({ method: "GET", url: `/v1/runs/${runId}`, headers });

    expect(conversationResponse.statusCode).toBe(200);
    expect(conversationResponse.json().conversation).not.toHaveProperty("organizationId");
    expect(conversationResponse.json().conversation).not.toHaveProperty("createdBy");
    expect(conversationResponse.json().messages[0]).not.toHaveProperty("conversationId");
    expect(runResponse.statusCode).toBe(200);
    expect(runResponse.json()).not.toHaveProperty("organizationId");
    expect(runResponse.json()).not.toHaveProperty("createdBy");
  });

  it("lists, renames, archives, restores, and soft-deletes only the caller's conversations", async () => {
    const scope: ResearchScope = { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] };
    const conversations = new InMemoryConversationStore();
    const active = await conversations.create(scope, "Active research");
    const archived = await conversations.create(scope, "Archived research");
    const app = createApi({ identity: new HeaderIdentityProvider(), conversations, memories: new InMemoryStore(), runs: new InMemoryRunStore(), reports: new InMemoryReportStore(), tools: createDefaultToolRegistry() });
    apps.push(app);
    const headers = { "x-organization-id": scope.organizationId, "x-user-id": scope.userId };

    const renamed = await app.inject({ method: "PATCH", url: `/v1/conversations/${active.id}`, headers, payload: { title: "NVDA earnings" } });
    const archivedResult = await app.inject({ method: "POST", url: `/v1/conversations/${archived.id}/archive`, headers });
    const activeList = await app.inject({ method: "GET", url: "/v1/conversations", headers });
    const archivedList = await app.inject({ method: "GET", url: "/v1/conversations?archived=true", headers });
    const restored = await app.inject({ method: "POST", url: `/v1/conversations/${archived.id}/unarchive`, headers });
    const deleted = await app.inject({ method: "DELETE", url: `/v1/conversations/${active.id}`, headers });
    const unavailable = await app.inject({ method: "GET", url: `/v1/conversations/${active.id}`, headers });

    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ title: "NVDA earnings", archivedAt: null });
    expect(archivedResult.statusCode).toBe(200);
    expect(archivedResult.json().archivedAt).toEqual(expect.any(String));
    expect(activeList.json().conversations.map((item: { id: string }) => item.id)).toEqual([active.id]);
    expect(archivedList.json().conversations.map((item: { id: string }) => item.id)).toEqual([archived.id]);
    expect(restored.json()).toMatchObject({ archivedAt: null });
    expect(deleted.statusCode).toBe(204);
    expect(unavailable.statusCode).toBe(404);
  });

  it("returns tenant-filtered conversation pages with a stable continuation cursor", async () => {
    const scope: ResearchScope = { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] };
    const conversations = new InMemoryConversationStore();
    await Promise.all(["First", "Second", "Third"].map((title) => conversations.create(scope, title)));
    const app = createApi({ identity: new HeaderIdentityProvider(), conversations, memories: new InMemoryStore(), runs: new InMemoryRunStore(), reports: new InMemoryReportStore(), tools: createDefaultToolRegistry() });
    apps.push(app);
    const headers = { "x-organization-id": scope.organizationId, "x-user-id": scope.userId };

    const first = await app.inject({ method: "GET", url: "/v1/conversations?limit=1", headers });
    const firstCursor = first.json().nextCursor as string;
    const second = await app.inject({ method: "GET", url: `/v1/conversations?limit=1&cursor=${encodeURIComponent(firstCursor)}`, headers });
    const third = await app.inject({ method: "GET", url: `/v1/conversations?limit=1&cursor=${encodeURIComponent(second.json().nextCursor as string)}`, headers });

    expect(first.statusCode).toBe(200);
    expect(firstCursor).toEqual(expect.any(String));
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(200);
    expect(third.json().nextCursor).toBeNull();
    expect(new Set([first, second, third].map((response) => response.json().conversations[0].id))).toHaveLength(3);
  });

  it("requires an archived conversation to be restored before it can receive a new research turn", async () => {
    const scope: ResearchScope = { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] };
    const conversations = new InMemoryConversationStore();
    const conversation = await conversations.create(scope, "Archived report");
    await conversations.setArchived(scope, conversation.id, true);
    const app = createApi({ identity: new HeaderIdentityProvider(), conversations, memories: new InMemoryStore(), runs: new InMemoryRunStore(), reports: new InMemoryReportStore(), tools: createDefaultToolRegistry() });
    apps.push(app);

    const response = await app.inject({ method: "POST", url: `/v1/conversations/${conversation.id}/turns`, headers: { "x-organization-id": scope.organizationId, "x-user-id": scope.userId }, payload: { question: "Analyze NVDA" } });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "CONVERSATION_ARCHIVED" });
  });

  it("pauses and resumes an unclaimed run without allowing a running run to be paused", async () => {
    const scope: ResearchScope = { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] };
    const conversations = new InMemoryConversationStore();
    const conversation = await conversations.create(scope, "Queue controls");
    const runs = new InMemoryRunStore();
    const pausedRunId = randomUUID();
    const runningRunId = randomUUID();
    await runs.create({ id: pausedRunId, organizationId: scope.organizationId, conversationId: conversation.id, createdBy: scope.userId, question: "Analyze NVDA", budget: budget() });
    await runs.create({ id: runningRunId, organizationId: scope.organizationId, conversationId: conversation.id, createdBy: scope.userId, question: "Analyze AMD", budget: budget() });
    await runs.claim(scope, runningRunId);
    const app = createApi({ identity: new HeaderIdentityProvider(), conversations, memories: new InMemoryStore(), runs, reports: new InMemoryReportStore(), tools: createDefaultToolRegistry() });
    apps.push(app);
    const headers = { "x-organization-id": scope.organizationId, "x-user-id": scope.userId };

    const paused = await app.inject({ method: "POST", url: `/v1/runs/${pausedRunId}/pause`, headers });
    const resumed = await app.inject({ method: "POST", url: `/v1/runs/${pausedRunId}/resume`, headers });
    const running = await app.inject({ method: "POST", url: `/v1/runs/${runningRunId}/pause`, headers });

    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({ status: "paused", events: [{ type: "run_paused" }] });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({ status: "queued", events: [{ type: "run_paused" }, { type: "run_resumed" }] });
    expect(running.statusCode).toBe(409);
    expect(running.json()).toMatchObject({ code: "RUN_PAUSE_UNAVAILABLE" });
  });

  it("does not deliver licensed evidence without its data entitlement", async () => {
    const evidence = new InMemoryEvidenceStore();
    const owner: ResearchScope = { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: ["market-data"] };
    const evidenceId = randomUUID();
    await evidence.save(owner, randomUUID(), [{
      id: evidenceId, tenantId: "org-1", sourceType: "market_data", authority: "licensed", title: "Licensed price", content: "Close price: 100.", sourceUrl: null, locator: "price_history:1", entity: "EXM", publishedAt: null, asOfDate: "2026-08-13", retrievedAt: "2026-08-14T00:00:00.000Z", contentHash: "b".repeat(64), license: "Licensed vendor", requiredEntitlements: ["market-data"], metadata: {},
    }]);
    const app = createApi({ identity: new HeaderIdentityProvider(), conversations: new InMemoryConversationStore(), memories: new InMemoryStore(), runs: new InMemoryRunStore(), reports: new InMemoryReportStore(), evidence, tools: createDefaultToolRegistry() });
    apps.push(app);

    const unentitled = await app.inject({ method: "GET", url: `/v1/evidence/${evidenceId}`, headers: { "x-organization-id": "org-1", "x-user-id": "user-2" } });
    const entitled = await app.inject({ method: "GET", url: `/v1/evidence/${evidenceId}`, headers: { "x-organization-id": "org-1", "x-user-id": "user-1", "x-entitlements": "market-data" } });
    expect(unentitled.statusCode).toBe(404);
    expect(entitled.statusCode).toBe(200);
  });

  it("uses live event wakeups while keeping persisted events as the SSE source", async () => {
    const scope: ResearchScope = { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] };
    const conversations = new InMemoryConversationStore();
    const conversation = await conversations.create(scope, "SSE");
    const runs = new InMemoryRunStore();
    const runId = randomUUID();
    await runs.create({ id: runId, organizationId: scope.organizationId, conversationId: conversation.id, createdBy: scope.userId, question: "NVDA", budget: budget() });
    await runs.claim(scope, runId);
    let wakeups = 0;
    const liveEvents: RunEventWakeup = {
      start: async () => undefined,
      close: async () => undefined,
      waitFor: async () => { wakeups += 1; await runs.finish(scope, runId, "abstained", "No evidence"); },
    };
    const app = createApi({ identity: new HeaderIdentityProvider(), conversations, memories: new InMemoryStore(), runs, reports: new InMemoryReportStore(), tools: createDefaultToolRegistry(), liveEvents });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: `/v1/runs/${runId}/events`, headers: { accept: "text/event-stream", "x-organization-id": "org-1", "x-user-id": "user-1" } });
    expect(response.statusCode).toBe(200);
    expect(wakeups).toBe(1);
    expect((await runs.get(scope, runId))?.status).toBe("abstained");
  });

  it("assigns standard SSE ids to an in-process turn so browser clients can resume", async () => {
    const scope: ResearchScope = { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] };
    const conversations = new InMemoryConversationStore();
    const conversation = await conversations.create(scope, "SSE ids");
    const app = createApi({ identity: new HeaderIdentityProvider(), conversations, memories: new InMemoryStore(), runs: new InMemoryRunStore(), reports: new InMemoryReportStore(), tools: createDefaultToolRegistry() });
    apps.push(app);

    const response = await app.inject({ method: "POST", url: `/v1/conversations/${conversation.id}/turns`, headers: { accept: "text/event-stream", origin: "http://localhost:3000", "x-organization-id": "org-1", "x-user-id": "user-1" }, payload: { question: "Analyze NVDA" } });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatch(/^id: 1\nevent: run_started\n/m);
    const userMessage = (await conversations.listMessages(scope, conversation.id)).find((message) => message.role === "user" && message.content === "Analyze NVDA");
    expect(userMessage?.runId).toEqual(expect.any(String));
    expect(response.headers["x-research-run-id"]).toBe(userMessage?.runId);
    expect(response.headers["access-control-expose-headers"]).toContain("x-research-run-id");
  });

  it("finalizes an in-process run when its SSE event store is unavailable", async () => {
    const scope: ResearchScope = { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] };
    const conversations = new InMemoryConversationStore();
    const conversation = await conversations.create(scope, "SSE failure finalization");
    const runs = new EventPersistenceFailureRunStore();
    const app = createApi({ identity: new HeaderIdentityProvider(), conversations, memories: new InMemoryStore(), runs, reports: new InMemoryReportStore(), tools: createDefaultToolRegistry() });
    apps.push(app);

    const response = await app.inject({ method: "POST", url: `/v1/conversations/${conversation.id}/turns`, headers: { accept: "text/event-stream", "x-organization-id": scope.organizationId, "x-user-id": scope.userId }, payload: { question: "Analyze NVDA" } });
    const runId = (await conversations.listMessages(scope, conversation.id)).find((message) => message.role === "user")?.runId;

    expect(response.statusCode).toBe(200);
    expect((await runs.get(scope, runId!))?.status).toBe("failed");
  });

  it("persists cited evidence and the controlled report for a completed in-process turn", async () => {
    const scope: ResearchScope = { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] };
    const filingClient = {
      findFiling: async () => ({ ticker: "EXM", companyName: "Example Corp", cik: "0000000001", accessionNumber: "0000000001-26-000001", form: "10-K", filingDate: "2026-01-30", reportDate: "2025-12-31", primaryDocument: "annual.htm", url: "https://www.sec.gov/Archives/example" }),
      getFilingText: async () => "Example Corp reported revenue growth in its annual filing.",
    } as unknown as SecEdgarClient;
    const planner: Planner = {
      plan: async () => ({ summary: "Retrieve the primary filing.", tasks: [{ id: "filing", title: "Retrieve filing", objective: "Obtain a primary disclosure.", dependsOn: [], allowedTools: ["filing.search"], acceptanceCriteria: ["Evidence is locatable."], status: "pending" }] }),
    };
    const claimComposer: ClaimComposer = {
      compose: async (items) => [{ id: randomUUID(), text: "Example Corp reported revenue growth in its annual filing.", evidenceIds: [items[0]!.id], confidence: 0.9, qualification: null }],
    };
    const tools = new ToolRegistry(new InMemoryToolAuditSink());
    tools.register(new SecFilingTool(filingClient));
    tools.register(new ReportTool());
    const conversations = new InMemoryConversationStore();
    const conversation = await conversations.create(scope, "Persistence");
    const runs = new InMemoryRunStore();
    const reports = new InMemoryReportStore();
    const evidenceStore = new InMemoryEvidenceStore();
    const app = createApi({
      identity: new HeaderIdentityProvider(), conversations, memories: new InMemoryStore(), runs, reports, evidence: evidenceStore, tools,
      agentOverrides: {
        intentAnalyzer: { analyze: async () => ({ category: "company_analysis", entities: ["Example Corp"], tickers: ["EXM"], period: null, complexity: "simple", riskLevel: "low", requiredCapabilities: ["sec_filing_retrieval"] }) },
        planner,
        claimComposer,
      },
    });
    apps.push(app);

    const turn = await app.inject({ method: "POST", url: `/v1/conversations/${conversation.id}/turns`, headers: { accept: "text/event-stream", "x-organization-id": scope.organizationId, "x-user-id": scope.userId }, payload: { question: "Analyze EXM" } });
    const runId = (await conversations.listMessages(scope, conversation.id)).find((message) => message.role === "user")?.runId;

    expect(turn.statusCode).toBe(200);
    expect(runId).toEqual(expect.any(String));
    expect((await runs.get(scope, runId!))?.status).toBe("completed");
    const report = await reports.getByRun(scope, runId!);
    expect(report?.citations).toHaveLength(1);
    const evidenceId = report!.citations[0]!.evidenceId;
    expect((await evidenceStore.get(scope, evidenceId))?.locator).toContain("SEC 10-K");
    const delivered = await app.inject({ method: "POST", url: "/v1/reports", headers: { "x-organization-id": scope.organizationId, "x-user-id": scope.userId }, payload: { runId } });
    expect(delivered.statusCode).toBe(202);
    expect(delivered.json().citations).toEqual([expect.objectContaining({ evidenceId })]);
    expect(delivered.json()).not.toHaveProperty("organizationId");
  });

  it("permits only configured browser origins for CORS preflight", async () => {
    const app = createApi({ identity: new HeaderIdentityProvider(), conversations: new InMemoryConversationStore(), memories: new InMemoryStore(), runs: new InMemoryRunStore(), reports: new InMemoryReportStore(), tools: createDefaultToolRegistry() }, ["https://research.example"]);
    apps.push(app);

    const response = await app.inject({ method: "OPTIONS", url: "/v1/conversations", headers: { origin: "https://research.example", "access-control-request-method": "POST" } });
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("https://research.example");
  });

  it("returns a stable 401 response without exposing identity-provider details", async () => {
    const app = createApi({
      identity: { getScope: async () => { throw new AuthenticationError(); } },
      conversations: new InMemoryConversationStore(), memories: new InMemoryStore(), runs: new InMemoryRunStore(), reports: new InMemoryReportStore(), tools: createDefaultToolRegistry(),
    });
    apps.push(app);

    const response = await app.inject({ method: "POST", url: "/v1/conversations", payload: { title: "Sensitive" } });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "UNAUTHORIZED", message: "authentication required" });
    expect(response.json().requestId).toEqual(expect.any(String));
    expect(response.body).not.toContain("authentication failed");
  });

  it("returns a stable 400 response for invalid request bodies", async () => {
    const app = createApi({ identity: new HeaderIdentityProvider(), conversations: new InMemoryConversationStore(), memories: new InMemoryStore(), runs: new InMemoryRunStore(), reports: new InMemoryReportStore(), tools: createDefaultToolRegistry() });
    apps.push(app);

    const response = await app.inject({ method: "POST", url: "/v1/conversations", headers: { "x-organization-id": "org-1", "x-user-id": "user-1" }, payload: { title: 42 } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "INVALID_REQUEST", message: "request validation failed" });
    expect(response.json().requestId).toEqual(expect.any(String));
  });

  it("rejects unknown fields on all versioned write contracts", async () => {
    const conversations = new InMemoryConversationStore();
    const scope: ResearchScope = { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] };
    const conversation = await conversations.create(scope, "Strict contracts");
    const app = createApi({ identity: new HeaderIdentityProvider(), conversations, memories: new InMemoryStore(), runs: new InMemoryRunStore(), reports: new InMemoryReportStore(), tools: createDefaultToolRegistry() });
    apps.push(app);
    const headers = { "x-organization-id": scope.organizationId, "x-user-id": scope.userId };

    for (const request of [
      { method: "POST" as const, url: "/v1/conversations", payload: { title: "NVDA", unexpected: true } },
      { method: "POST" as const, url: `/v1/conversations/${conversation.id}/turns`, payload: { question: "Analyze NVDA", unexpected: true } },
      { method: "PUT" as const, url: "/v1/memory/preferences", payload: { preference: { key: "valuation_method", value: "DCF", unexpected: true } } },
      { method: "POST" as const, url: "/v1/reports", payload: { runId: randomUUID(), unexpected: true } },
    ]) {
      const response = await app.inject({ ...request, headers });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "INVALID_REQUEST", message: "request validation failed" });
    }
  });

  it("rejects malformed resource identifiers before accessing a tenant store", async () => {
    const app = createApi({ identity: new HeaderIdentityProvider(), conversations: new InMemoryConversationStore(), memories: new InMemoryStore(), runs: new InMemoryRunStore(), reports: new InMemoryReportStore(), tools: createDefaultToolRegistry() });
    apps.push(app);
    const headers = { "x-organization-id": "org-1", "x-user-id": "user-1" };

    for (const request of [
      { method: "GET" as const, url: "/v1/conversations/not-a-uuid" },
      { method: "POST" as const, url: "/v1/conversations/not-a-uuid/turns", payload: { question: "Analyze NVDA" } },
      { method: "GET" as const, url: "/v1/runs/not-a-uuid" },
      { method: "GET" as const, url: "/v1/runs/not-a-uuid/events" },
      { method: "GET" as const, url: "/v1/evidence/not-a-uuid" },
      { method: "DELETE" as const, url: "/v1/memory/not-a-uuid" },
      { method: "GET" as const, url: "/v1/reports/not-a-uuid" },
    ]) {
      const response = await app.inject({ ...request, headers });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "INVALID_REQUEST", message: "request validation failed" });
    }
  });

  it("returns a stable 500 response without exposing internal failures", async () => {
    const conversations = new InMemoryConversationStore();
    vi.spyOn(conversations, "create").mockRejectedValue(new Error("database connection password rejected"));
    const app = createApi({ identity: new HeaderIdentityProvider(), conversations, memories: new InMemoryStore(), runs: new InMemoryRunStore(), reports: new InMemoryReportStore(), tools: createDefaultToolRegistry() });
    apps.push(app);

    const response = await app.inject({ method: "POST", url: "/v1/conversations", headers: { "x-organization-id": "org-1", "x-user-id": "user-1" }, payload: { title: "NVDA" } });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: "INTERNAL", message: "internal server error" });
    expect(response.json().requestId).toEqual(expect.any(String));
    expect(response.body).not.toContain("database connection password rejected");
  });

  it("uses the error envelope for business and unknown-route 404 responses", async () => {
    const app = createApi({ identity: new HeaderIdentityProvider(), conversations: new InMemoryConversationStore(), memories: new InMemoryStore(), runs: new InMemoryRunStore(), reports: new InMemoryReportStore(), tools: createDefaultToolRegistry() });
    apps.push(app);

    const missingConversation = await app.inject({ method: "GET", url: "/v1/conversations/c0a41d68-4afc-428c-8ea8-1fd9a0b184f6", headers: { "x-organization-id": "org-1", "x-user-id": "user-1" } });
    const unknownRoute = await app.inject({ method: "GET", url: "/v1/does-not-exist" });
    for (const response of [missingConversation, unknownRoute]) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "NOT_FOUND" });
      expect(response.json().requestId).toEqual(expect.any(String));
    }
  });

  it("reports unavailable when a required readiness dependency cannot be reached", async () => {
    const app = createApi({
      identity: new HeaderIdentityProvider(), conversations: new InMemoryConversationStore(), memories: new InMemoryStore(), runs: new InMemoryRunStore(), reports: new InMemoryReportStore(), tools: createDefaultToolRegistry(),
      readiness: { check: async () => { throw new Error("database credentials must remain private"); } },
    });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "UNAVAILABLE", message: "service is not ready" });
    expect(response.json().requestId).toEqual(expect.any(String));
    expect(response.body).not.toContain("database credentials");
  });
});

function budget() { return { maxTasks: 12, maxToolCalls: 24, maxToolDurationMs: 20_000, maxRunDurationMs: 300_000, maxCriticRepairs: 1, maxEstimatedCostUsd: 5 }; }
