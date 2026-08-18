import { describe, expect, it } from "vitest";
import { analysisDcfTool, createDefaultToolRegistry, createSubmissionToolRegistry, InMemoryToolAuditSink, listTrustedAgentToolManifests, parseApprovedToolManifestCatalog, ReportTool, ToolRegistry, type Tool, type ToolContext } from "../src/index.js";
import { RunCostLedger } from "@research/contracts";
import { z } from "zod";

const context: ToolContext = { runId: "run-1", scope: { organizationId: "org-1", userId: "user-1", roles: ["researcher"], entitlements: [] }, remainingToolCalls: 1 };

describe("ToolRegistry", () => {
  it("fails closed when a data provider is not configured", async () => {
    const result = await createDefaultToolRegistry().invoke("filing.search", { query: "NVDA 10-K" }, context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("UNAVAILABLE");
  });

  it("keeps the controlled report renderer out of agent tool discovery but audits runtime invocation", async () => {
    const audit = new InMemoryToolAuditSink();
    const registry = new ToolRegistry(audit);
    registry.register(new ReportTool());
    const evidenceId = "721b922f-070c-4fd5-a2af-9dbb62a76dbd";

    expect(registry.discover(context.scope).map((manifest) => manifest.id)).not.toContain("report.compose");
    const result = await registry.invoke("report.compose", {
      question: "Analyze NVDA",
      claims: [{ id: "c25fdcc1-6510-4a99-bc90-cfcc452beafc", text: "Revenue increased.", evidenceIds: [evidenceId], confidence: 0.9, qualification: null }],
      evidence: [{ id: evidenceId, sourceType: "sec_filing", authority: "primary", title: "10-K", content: "Revenue increased.", sourceUrl: "https://www.sec.gov/example", locator: "p. 42", entity: "NVDA", publishedAt: null, asOfDate: "2026-01-31", retrievedAt: "2026-08-14T08:00:00.000Z", contentHash: "a".repeat(64), license: "SEC EDGAR", tenantId: "org-1", metadata: {} }],
    }, context);

    expect(result).toMatchObject({ ok: true, value: { templateVersion: "citation-report-v1" } });
    expect(audit.events[0]).toMatchObject({ toolId: "report.compose", ok: true, evidenceIds: [evidenceId] });
  });

  it("refuses a report whose cited licensed evidence is outside the caller entitlement", async () => {
    const registry = new ToolRegistry(new InMemoryToolAuditSink());
    registry.register(new ReportTool());
    const evidenceId = "35c601bd-03f0-4b26-95c7-919380da25fb";
    const result = await registry.invoke("report.compose", {
      question: "Analyze NVDA",
      claims: [{ id: "cf81fbc8-6ce8-45ea-a8af-1dafab839cb8", text: "Licensed data supports this claim.", evidenceIds: [evidenceId], confidence: 0.9, qualification: null }],
      evidence: [{ id: evidenceId, sourceType: "market_data", authority: "licensed", title: "Licensed data", content: "Revenue increased.", sourceUrl: null, locator: "provider:row-1", entity: "NVDA", publishedAt: null, asOfDate: "2026-01-31", retrievedAt: "2026-08-14T08:00:00.000Z", contentHash: "b".repeat(64), license: "licensed-test", tenantId: "org-1", requiredEntitlements: ["market-data"], metadata: {} }],
    }, context);

    expect(result).toMatchObject({ ok: false, failure: { code: "INVALID_INPUT" } });
  });

  it("derives and audits a stable idempotency key when a caller has none", async () => {
    const audit = new InMemoryToolAuditSink();
    const registry = new ToolRegistry(audit);
    registry.register({
      manifest: { id: "test.idempotent", version: "1", capability: "test", requiredEntitlements: [], timeoutMs: 500, enabled: true },
      input: z.object({ query: z.string() }), output: z.object({ ok: z.literal(true) }),
      async invoke() { return { ok: true as const, value: { ok: true as const }, evidence: [], estimatedCostUsd: 0 }; },
    });

    await registry.invoke("test.idempotent", { query: "NVDA" }, context);
    await registry.invoke("test.idempotent", { query: "NVDA" }, context);
    expect(audit.events.map((event) => event.idempotencyKey)).toEqual([audit.events[0]!.idempotencyKey, audit.events[0]!.idempotencyKey]);
    expect(audit.events[0]!.idempotencyKey).toMatch(/^derived:[a-f0-9]{64}$/);
  });

  it("fails closed when a queued run's approved manifest no longer matches the registered provider", async () => {
    const audit = new InMemoryToolAuditSink();
    const registry = new ToolRegistry(audit);
    const manifest = { id: "test.snapshot", version: "v1", capability: "test", requiredEntitlements: [], timeoutMs: 500, enabled: true };
    registry.register({
      manifest,
      input: z.object({ query: z.string() }), output: z.object({ ok: z.literal(true) }),
      async invoke() { return { ok: true as const, value: { ok: true as const }, evidence: [], estimatedCostUsd: 0 }; },
    });

    const rejected = await registry.invoke("test.snapshot", { query: "NVDA" }, {
      ...context,
      toolManifestSnapshot: [{ ...manifest, version: "v2" }],
    });
    expect(rejected).toMatchObject({ ok: false, failure: { code: "UNAVAILABLE" } });

    const accepted = await registry.invoke("test.snapshot", { query: "NVDA" }, {
      ...context,
      toolManifestSnapshot: [manifest],
    });
    expect(accepted).toMatchObject({ ok: true, value: { ok: true } });
    expect(audit.events.map((event) => event.ok)).toEqual([false, true]);
  });

  it("allows an administrator catalog only to retain and tighten trusted agent tools", () => {
    const registry = new ToolRegistry(new InMemoryToolAuditSink());
    registry.register(testTool("test.approved", { timeoutMs: 500, maxEstimatedCostUsd: 1 }));
    registry.register(testTool("test.unapproved"));
    registry.register(new ReportTool());

    registry.applyApprovedCatalog([{
      id: "test.approved", version: "1", capability: "test", requiredEntitlements: [], timeoutMs: 250, maxEstimatedCostUsd: 0.5, enabled: true,
    }]);

    expect(registry.discover(context.scope)).toEqual([{
      id: "test.approved", version: "1", capability: "test", requiredEntitlements: [], timeoutMs: 250, maxEstimatedCostUsd: 0.5, enabled: true,
    }]);
  });

  it("rejects invalid catalog JSON, unknown/internal tools, and expanded timeout or cost", () => {
    expect(() => parseApprovedToolManifestCatalog("not json")).toThrow("valid JSON");
    const registry = new ToolRegistry(new InMemoryToolAuditSink());
    registry.register(testTool("test.bounded", { timeoutMs: 500, maxEstimatedCostUsd: 1 }));
    registry.register(new ReportTool());

    expect(() => registry.applyApprovedCatalog([{ id: "test.unknown", version: "1", capability: "test", requiredEntitlements: [], timeoutMs: 500, enabled: true }])).toThrow("unregistered");
    expect(() => registry.applyApprovedCatalog([{ ...new ReportTool().manifest }])).toThrow("internal");
    expect(() => registry.applyApprovedCatalog([{ id: "test.bounded", version: "1", capability: "test", requiredEntitlements: [], timeoutMs: 501, maxEstimatedCostUsd: 1, enabled: true }])).toThrow("timeout");
    expect(() => registry.applyApprovedCatalog([{ id: "test.bounded", version: "1", capability: "test", requiredEntitlements: [], timeoutMs: 500, maxEstimatedCostUsd: 1.01, enabled: true }])).toThrow("cost cap");
  });

  it("uses the same trusted inventory for API submission snapshots and rejects catalog-installed tools", () => {
    const approved = listTrustedAgentToolManifests();
    const registry = createSubmissionToolRegistry(approved);
    const fullyEntitled = { ...context.scope, entitlements: ["market-data", "graph-read"] };

    expect(registry.discover(fullyEntitled)).toEqual(approved);
    expect(() => createSubmissionToolRegistry([...approved, {
      id: "test.catalog-install", version: "1", capability: "arbitrary_network_access", requiredEntitlements: [], timeoutMs: 500, enabled: true,
    }])).toThrow("unregistered");
  });

  it("fails closed and audits no evidence when an external tool returns malformed evidence or cost", async () => {
    const audit = new InMemoryToolAuditSink();
    const registry = new ToolRegistry(audit);
    registry.register({
      manifest: { id: "test.malformed-result", version: "1", capability: "test", requiredEntitlements: [], timeoutMs: 500, enabled: true },
      input: z.object({ query: z.string() }), output: z.object({ ok: z.literal(true) }),
      // Deliberately bypass the compile-time signature to model an untrusted
      // network/provider adapter returning malformed runtime JSON.
      async invoke() { return { ok: true, value: { ok: true }, evidence: [{ id: "not-a-uuid" }], estimatedCostUsd: Number.NaN } as never; },
    });

    const result = await registry.invoke("test.malformed-result", { query: "NVDA" }, context);
    expect(result).toMatchObject({ ok: false, failure: { code: "INTERNAL", retryable: false }, estimatedCostUsd: 0 });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({ ok: false, failureCode: "INTERNAL", evidenceIds: [], estimatedCostUsd: 0 });
  });

  it("does not invoke a billable provider when its declared maximum cannot be reserved", async () => {
    let calls = 0;
    const audit = new InMemoryToolAuditSink();
    const registry = new ToolRegistry(audit);
    registry.register({
      manifest: { id: "test.cost-reserve", version: "1", capability: "test", requiredEntitlements: [], timeoutMs: 500, maxEstimatedCostUsd: 0.2, enabled: true },
      input: z.object({ query: z.string() }), output: z.object({ ok: z.literal(true) }),
      async invoke() { calls += 1; return { ok: true as const, value: { ok: true as const }, evidence: [], estimatedCostUsd: 0.2 }; },
    });

    const result = await registry.invoke("test.cost-reserve", { query: "NVDA" }, { ...context, costLedger: new RunCostLedger(0.1) });
    expect(calls).toBe(0);
    expect(result).toMatchObject({ ok: false, failure: { code: "BUDGET_EXCEEDED" }, estimatedCostUsd: 0 });
    expect(audit.events[0]).toMatchObject({ ok: false, failureCode: "BUDGET_EXCEEDED", estimatedCostUsd: 0 });
  });

  it("settles the shared ledger and audit trail with the provider's actual cost", async () => {
    const audit = new InMemoryToolAuditSink();
    const ledger = new RunCostLedger(1);
    const registry = new ToolRegistry(audit);
    registry.register({
      manifest: { id: "test.cost-settle", version: "1", capability: "test", requiredEntitlements: [], timeoutMs: 500, maxEstimatedCostUsd: 0.5, enabled: true },
      input: z.object({ query: z.string() }), output: z.object({ ok: z.literal(true) }),
      async invoke() { return { ok: true as const, value: { ok: true as const }, evidence: [], estimatedCostUsd: 0.2 }; },
    });

    const result = await registry.invoke("test.cost-settle", { query: "NVDA" }, { ...context, costLedger: ledger });
    expect(result).toMatchObject({ ok: true, estimatedCostUsd: 0.2 });
    expect(ledger.spent).toBeCloseTo(0.2);
    expect(ledger.reserved).toBe(0);
    expect(audit.events[0]).toMatchObject({ ok: true, estimatedCostUsd: 0.2 });
  });

  it("charges the declared maximum when a provider times out after work may have started", async () => {
    const audit = new InMemoryToolAuditSink();
    const ledger = new RunCostLedger(1);
    const registry = new ToolRegistry(audit, { maxAttempts: 1 });
    registry.register({
      manifest: { id: "test.cost-timeout", version: "1", capability: "test", requiredEntitlements: [], timeoutMs: 1, maxEstimatedCostUsd: 0.3, enabled: true },
      input: z.object({ query: z.string() }), output: z.object({ ok: z.literal(true) }),
      async invoke() { await new Promise((resolve) => setTimeout(resolve, 20)); return { ok: true as const, value: { ok: true as const }, evidence: [], estimatedCostUsd: 0.1 }; },
    });

    const result = await registry.invoke("test.cost-timeout", { query: "NVDA" }, { ...context, costLedger: ledger });
    expect(result).toMatchObject({ ok: false, failure: { code: "TIMEOUT" }, estimatedCostUsd: 0.3 });
    expect(ledger.spent).toBeCloseTo(0.3);
    expect(audit.events[0]).toMatchObject({ failureCode: "TIMEOUT", estimatedCostUsd: 0.3 });
  });

  it("rejects evidence when a provider exceeds its registered cost ceiling", async () => {
    const audit = new InMemoryToolAuditSink();
    const ledger = new RunCostLedger(1);
    const registry = new ToolRegistry(audit);
    registry.register({
      manifest: { id: "test.cost-overage", version: "1", capability: "test", requiredEntitlements: [], timeoutMs: 500, maxEstimatedCostUsd: 0.1, enabled: true },
      input: z.object({ query: z.string() }), output: z.object({ ok: z.literal(true) }),
      async invoke() { return { ok: true as const, value: { ok: true as const }, evidence: [], estimatedCostUsd: 0.2 }; },
    });

    const result = await registry.invoke("test.cost-overage", { query: "NVDA" }, { ...context, costLedger: ledger });
    expect(result).toMatchObject({ ok: false, failure: { code: "BUDGET_EXCEEDED" }, estimatedCostUsd: 0.2 });
    expect(ledger.spent).toBeCloseTo(0.2);
    expect(audit.events[0]).toMatchObject({ ok: false, failureCode: "BUDGET_EXCEEDED", evidenceIds: [], estimatedCostUsd: 0.2 });
  });

  it("does not allow a tool to inject cross-tenant or unentitled evidence into a run", async () => {
    const audit = new InMemoryToolAuditSink();
    const registry = new ToolRegistry(audit);
    registry.register({
      manifest: { id: "test.cross-tenant-result", version: "1", capability: "test", requiredEntitlements: [], timeoutMs: 500, enabled: true },
      input: z.object({ query: z.string() }), output: z.object({ ok: z.literal(true) }),
      async invoke() {
        return {
          ok: true as const,
          value: { ok: true as const },
          evidence: [{ id: "614ea856-35ce-4059-a8ed-89536c7c51ec", sourceType: "sec_filing" as const, authority: "primary" as const, title: "Foreign filing", content: "Unrelated tenant content.", sourceUrl: null, locator: "p. 1", entity: "NVDA", publishedAt: null, asOfDate: null, retrievedAt: "2026-08-15T00:00:00.000Z", contentHash: "f".repeat(64), license: "SEC", tenantId: "other-org", metadata: {} }],
          estimatedCostUsd: 0,
        };
      },
    });

    const result = await registry.invoke("test.cross-tenant-result", { query: "NVDA" }, context);
    expect(result).toMatchObject({ ok: false, failure: { code: "UNAUTHORIZED", retryable: false } });
    expect(audit.events[0]).toMatchObject({ ok: false, failureCode: "UNAUTHORIZED", evidenceIds: [] });
  });

  it("does not allow a tool to turn research-memory or graph leads into claim evidence", async () => {
    const audit = new InMemoryToolAuditSink();
    const registry = new ToolRegistry(audit);
    registry.register({
      manifest: { id: "test.lead-result", version: "1", capability: "test", requiredEntitlements: [], timeoutMs: 500, enabled: true },
      input: z.object({ query: z.string() }), output: z.object({ ok: z.literal(true) }),
      async invoke() {
        return {
          ok: true as const,
          value: { ok: true as const },
          evidence: [{ id: "8e2ffc2f-2e62-4a04-bb48-cad7d0b7db83", sourceType: "research_memory" as const, authority: "primary" as const, title: "Prior report", content: "Prior conclusion.", sourceUrl: null, locator: "report", entity: "NVDA", publishedAt: null, asOfDate: null, retrievedAt: "2026-08-15T00:00:00.000Z", contentHash: "e".repeat(64), license: "internal", tenantId: "org-1", metadata: {} }],
          estimatedCostUsd: 0,
        };
      },
    });

    const result = await registry.invoke("test.lead-result", { query: "NVDA" }, context);
    expect(result).toMatchObject({ ok: false, failure: { code: "UNAUTHORIZED", retryable: false } });
    expect(audit.events[0]).toMatchObject({ ok: false, failureCode: "UNAUTHORIZED", evidenceIds: [] });
  });

  it("runs deterministic DCF only with valid inputs", async () => {
    const result = await analysisDcfTool.invoke({ ticker: "NVDA", freeCashFlow: 100, growthRate: 0.1, terminalGrowthRate: 0.03, discountRate: 0.1, years: 5, fiscalPeriod: "FY2025", asOfDate: "2026-02-20", sourceEvidenceIds: ["19d706d2-039e-4a7d-b5a7-3b1f5af4e1f8"] }, context);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.enterpriseValue).toBeGreaterThan(0);
  });

  it("classifies a timed-out tool as retryable TIMEOUT", async () => {
    const registry = new ToolRegistry(new InMemoryToolAuditSink());
    registry.register(slowTool);
    const result = await registry.invoke("test.slow", { query: "NVDA" }, context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("TIMEOUT");
  });

  it("retries a transient read-only tool failure before returning success", async () => {
    let calls = 0;
    const registry = new ToolRegistry(new InMemoryToolAuditSink(), { maxAttempts: 2, retryDelayMs: 0 });
    registry.register({
      manifest: { id: "test.flaky", version: "1", capability: "test", requiredEntitlements: [], timeoutMs: 500, enabled: true }, input: z.object({ query: z.string() }), output: z.object({ ok: z.literal(true) }),
      async invoke() {
        calls += 1;
        return calls === 1
          ? { ok: false as const, failure: { code: "UNAVAILABLE" as const, message: "temporary outage", retryable: true }, estimatedCostUsd: 0 }
          : { ok: true as const, value: { ok: true as const }, evidence: [], estimatedCostUsd: 0 };
      },
    });

    const result = await registry.invoke("test.flaky", { query: "NVDA" }, context);
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("opens a circuit after repeated transient failures", async () => {
    let calls = 0;
    const registry = new ToolRegistry(new InMemoryToolAuditSink(), { maxAttempts: 1, circuitFailureThreshold: 2, circuitCooldownMs: 60_000 });
    registry.register({
      manifest: { id: "test.down", version: "1", capability: "test", requiredEntitlements: [], timeoutMs: 500, enabled: true }, input: z.object({ query: z.string() }), output: z.object({ ok: z.literal(true) }),
      async invoke() { calls += 1; return { ok: false as const, failure: { code: "UNAVAILABLE" as const, message: "outage", retryable: true }, estimatedCostUsd: 0 }; },
    });

    await registry.invoke("test.down", { query: "NVDA" }, context);
    await registry.invoke("test.down", { query: "NVDA" }, context);
    const result = await registry.invoke("test.down", { query: "NVDA" }, context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.message).toContain("circuit is open");
    expect(calls).toBe(2);
  });

  it("aborts tool work when its timeout elapses", async () => {
    let aborted = false;
    const registry = new ToolRegistry(new InMemoryToolAuditSink(), { maxAttempts: 1 });
    registry.register({
      manifest: { id: "test.abortable", version: "1", capability: "test", requiredEntitlements: [], timeoutMs: 1, enabled: true }, input: z.object({ query: z.string() }), output: z.object({ ok: z.literal(true) }),
      async invoke(_input, toolContext) {
        return new Promise((resolve) => toolContext.signal?.addEventListener("abort", () => { aborted = true; resolve({ ok: false as const, failure: { code: "TIMEOUT" as const, message: "aborted", retryable: true }, estimatedCostUsd: 0 }); }, { once: true }));
      },
    });

    const result = await registry.invoke("test.abortable", { query: "NVDA" }, context);
    expect(result.ok).toBe(false);
    expect(aborted).toBe(true);
  });

  it("stops retrying when the enclosing research run aborts the tool", async () => {
    const controller = new AbortController();
    let aborted = false;
    const registry = new ToolRegistry(new InMemoryToolAuditSink(), { maxAttempts: 2, retryDelayMs: 0 });
    registry.register({
      manifest: { id: "test.run-abort", version: "1", capability: "test", requiredEntitlements: [], timeoutMs: 500, enabled: true }, input: z.object({ query: z.string() }), output: z.object({ ok: z.literal(true) }),
      async invoke(_input, toolContext) {
        return new Promise((resolve) => toolContext.signal?.addEventListener("abort", () => { aborted = true; resolve({ ok: false as const, failure: { code: "TIMEOUT" as const, message: "aborted", retryable: true }, estimatedCostUsd: 0 }); }, { once: true }));
      },
    });

    const invocation = registry.invoke("test.run-abort", { query: "NVDA" }, { ...context, signal: controller.signal });
    controller.abort();
    const result = await invocation;
    expect(aborted).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toMatchObject({ code: "TIMEOUT", retryable: false });
  });
});

const slowTool: Tool<{ query: string }, { ok: true }> = {
  manifest: { id: "test.slow", version: "1", capability: "test", requiredEntitlements: [], timeoutMs: 1, enabled: true },
  input: z.object({ query: z.string() }), output: z.object({ ok: z.literal(true) }),
  async invoke() { await new Promise((resolve) => setTimeout(resolve, 20)); return { ok: true, value: { ok: true }, evidence: [], estimatedCostUsd: 0 }; },
};

function testTool(id: string, overrides: Partial<Tool<{ query: string }, { ok: true }>['manifest']> = {}): Tool<{ query: string }, { ok: true }> {
  return {
    manifest: { id, version: "1", capability: "test", requiredEntitlements: [], timeoutMs: 500, enabled: true, ...overrides },
    input: z.object({ query: z.string() }), output: z.object({ ok: z.literal(true) }),
    async invoke() { return { ok: true as const, value: { ok: true as const }, evidence: [], estimatedCostUsd: 0 }; },
  };
}
