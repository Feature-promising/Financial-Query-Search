import { afterEach, describe, expect, it, vi } from "vitest";
import { createResearchApiClient } from "./research-api";

describe("ResearchApiClient preferences", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("uses the authenticated closed preference endpoints", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ preferences: [{ key: "valuation_method", value: "DCF" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ preference: { key: "display_unit", value: "USD millions" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const client = createResearchApiClient("access-token");

    await expect(client.listPreferences()).resolves.toEqual([{ key: "valuation_method", value: "DCF" }]);
    await expect(client.savePreference({ key: "display_unit", value: "USD millions" })).resolves.toEqual({ key: "display_unit", value: "USD millions" });

    expect(fetch).toHaveBeenNthCalledWith(1, expect.stringMatching(/\/v1\/memory\/preferences$/), expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer access-token" }) }));
    expect(fetch).toHaveBeenNthCalledWith(2, expect.stringMatching(/\/v1\/memory\/preferences$/), expect.objectContaining({ method: "PUT", body: JSON.stringify({ preference: { key: "display_unit", value: "USD millions" } }) }));
  });

  it("retrieves only the Worker-persisted report for a completed run", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "144d8a8a-cd10-49a9-ab1f-7a0bff2aa8b8", runId: "a424ce0a-e21e-4b42-9027-ccbd521ce811", version: 1,
      markdown: "## 研究结论", citations: [], createdAt: "2026-08-15T00:00:00.000Z",
    }), { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    const client = createResearchApiClient("access-token");

    await expect(client.getReportForRun("a424ce0a-e21e-4b42-9027-ccbd521ce811")).resolves.toMatchObject({ version: 1, citations: [] });
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/v1\/reports$/), expect.objectContaining({
      method: "POST", headers: expect.objectContaining({ authorization: "Bearer access-token" }),
      body: JSON.stringify({ runId: "a424ce0a-e21e-4b42-9027-ccbd521ce811" }),
    }));
  });
});

describe("ResearchApiClient conversation lifecycle", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("uses the authenticated list, rename, archive, restore, and delete contracts", async () => {
    const id = "144d8a8a-cd10-49a9-ab1f-7a0bff2aa8b8";
    const active = { id, title: "NVDA earnings", createdAt: "2026-08-15T00:00:00.000Z", updatedAt: "2026-08-15T00:00:00.000Z", archivedAt: null };
    const archived = { ...active, archivedAt: "2026-08-16T00:00:00.000Z" };
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ conversations: [active], nextCursor: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ conversations: [archived], nextCursor: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(active), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(archived), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(active), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const client = createResearchApiClient("access-token");

    await expect(client.listConversations()).resolves.toEqual({ conversations: [active], nextCursor: null });
    await expect(client.listConversations({ archived: true })).resolves.toEqual({ conversations: [archived], nextCursor: null });
    await expect(client.renameConversation(id, "NVDA earnings")).resolves.toEqual(active);
    await expect(client.archiveConversation(id, true)).resolves.toEqual(archived);
    await expect(client.archiveConversation(id, false)).resolves.toEqual(active);
    await expect(client.deleteConversation(id)).resolves.toBeUndefined();

    expect(fetch).toHaveBeenNthCalledWith(1, expect.stringMatching(/\/v1\/conversations\?archived=false&limit=50$/), expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer access-token" }) }));
    expect(fetch).toHaveBeenNthCalledWith(2, expect.stringMatching(/\/v1\/conversations\?archived=true&limit=50$/), expect.any(Object));
    expect(fetch).toHaveBeenNthCalledWith(3, expect.stringMatching(new RegExp(`/v1/conversations/${id}$`)), expect.objectContaining({ method: "PATCH", body: JSON.stringify({ title: "NVDA earnings" }) }));
    expect(fetch).toHaveBeenNthCalledWith(4, expect.stringMatching(new RegExp(`/v1/conversations/${id}/archive$`)), expect.objectContaining({ method: "POST" }));
    expect(fetch).toHaveBeenNthCalledWith(5, expect.stringMatching(new RegExp(`/v1/conversations/${id}/unarchive$`)), expect.objectContaining({ method: "POST" }));
    expect(fetch).toHaveBeenNthCalledWith(6, expect.stringMatching(new RegExp(`/v1/conversations/${id}$`)), expect.objectContaining({ method: "DELETE" }));
  });

  it("uses the server-provided keyset cursor when loading additional conversations", async () => {
    const id = "144d8a8a-cd10-49a9-ab1f-7a0bff2aa8b8";
    const cursor = "2026-08-17T00:00:00.000Z|2026-08-15T00:00:00.000Z|144d8a8a-cd10-49a9-ab1f-7a0bff2aa8b8";
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      conversations: [{ id, title: "Older research", createdAt: "2026-08-14T00:00:00.000Z", updatedAt: "2026-08-14T00:00:00.000Z", archivedAt: null }], nextCursor: null,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await createResearchApiClient("access-token").listConversations({ cursor, limit: 20 });

    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/archived=false&limit=20&cursor=/), expect.any(Object));
  });
});

describe("ResearchApiClient queued-run controls", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("uses the authenticated, server-authoritative pause and resume endpoints", async () => {
    const runId = "a424ce0a-e21e-4b42-9027-ccbd521ce811";
    const base = { id: runId, conversationId: "144d8a8a-cd10-49a9-ab1f-7a0bff2aa8b8", question: "Analyze NVDA", budget: { maxTasks: 12, maxToolCalls: 24, maxToolDurationMs: 20_000, maxRunDurationMs: 300_000, maxCriticRepairs: 1, maxEstimatedCostUsd: 5 }, events: [] };
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...base, status: "paused" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...base, status: "queued" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const client = createResearchApiClient("access-token");

    await expect(client.pauseQueuedRun(runId)).resolves.toMatchObject({ id: runId, status: "paused" });
    await expect(client.resumeQueuedRun(runId)).resolves.toMatchObject({ id: runId, status: "queued" });

    expect(fetch).toHaveBeenNthCalledWith(1, expect.stringMatching(new RegExp(`/v1/runs/${runId}/pause$`)), expect.objectContaining({ method: "POST", headers: expect.objectContaining({ authorization: "Bearer access-token" }) }));
    expect(fetch).toHaveBeenNthCalledWith(2, expect.stringMatching(new RegExp(`/v1/runs/${runId}/resume$`)), expect.objectContaining({ method: "POST" }));
  });

  it("loads a persisted run replay before rendering a historical report", async () => {
    const runId = "a424ce0a-e21e-4b42-9027-ccbd521ce811";
    const payload = { id: runId, conversationId: "144d8a8a-cd10-49a9-ab1f-7a0bff2aa8b8", question: "Analyze NVDA", status: "completed", budget: { maxTasks: 12, maxToolCalls: 24, maxToolDurationMs: 20_000, maxRunDurationMs: 300_000, maxCriticRepairs: 1, maxEstimatedCostUsd: 5 }, events: [] };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await expect(createResearchApiClient("access-token").getRun(runId)).resolves.toMatchObject({ id: runId, status: "completed" });
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`/v1/runs/${runId}$`)), expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer access-token" }) }));
  });
});
