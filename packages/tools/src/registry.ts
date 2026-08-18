import { createHash } from "node:crypto";
import { EvidenceItemSchema, RunCostBudgetExceeded, ToolFailureSchema, ToolManifestSchema, isClaimEvidenceEligible, isEvidenceAuthorized, type ResearchScope, type ToolManifest } from "@research/contracts";
import { toolFailure } from "./results.js";
import { validateApprovedToolManifestCatalog } from "./catalog.js";
import { defaultToolReliabilityPolicy, isTransientFailure, retryDelay, ToolCircuitBreaker, type ToolReliabilityPolicy } from "./reliability.js";
import type { Tool, ToolAuditSink, ToolContext, ToolResult } from "./types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly circuitBreaker = new ToolCircuitBreaker();
  private readonly reliability: ToolReliabilityPolicy;
  private catalogApplied = false;

  constructor(private readonly audit: ToolAuditSink, reliability: Partial<ToolReliabilityPolicy> = {}) {
    this.reliability = { ...defaultToolReliabilityPolicy, ...reliability };
  }

  register<I, O>(tool: Tool<I, O>): void {
    const manifest = ToolManifestSchema.parse(tool.manifest);
    if (this.catalogApplied) throw new Error("cannot register a tool after an approved catalog has been applied");
    if (this.tools.has(manifest.id)) throw new Error(`tool already registered: ${manifest.id}`);
    this.tools.set(manifest.id, { tool: tool as Tool<unknown, unknown>, manifest });
  }

  /**
   * Applies a deployment-time approval list to trusted code registrations.
   * A catalog cannot install a tool or increase its provider timeout/cost cap;
   * omission disables an agent-visible tool. Internal runtime tools are kept
   * separate and can never appear in the catalog.
   */
  applyApprovedCatalog(candidate: unknown): void {
    if (this.catalogApplied) throw new Error("an approved tool catalog has already been applied");
    const approved = validateApprovedToolManifestCatalog(candidate);
    const effective = new Map<string, RegisteredTool>();
    for (const [id, record] of this.tools) {
      if (visibilityOf(record.manifest) === "internal") effective.set(id, record);
    }
    for (const manifest of approved) {
      const record = this.tools.get(manifest.id);
      if (!record) throw new Error(`approved catalog references an unregistered tool: ${manifest.id}`);
      if (visibilityOf(record.manifest) === "internal") throw new Error(`approved catalog must not expose internal tool: ${manifest.id}`);
      assertApprovedManifestIsBounded(manifest, record.manifest);
      effective.set(manifest.id, { tool: record.tool, manifest });
    }
    this.tools.clear();
    for (const [id, record] of effective) this.tools.set(id, record);
    this.catalogApplied = true;
  }

  discover(scope: ResearchScope): ToolManifest[] {
    return [...this.tools.values()].map((record) => record.manifest)
      .filter((manifest) => manifest.enabled)
      .filter((manifest) => manifest.visibility !== "internal")
      .filter((manifest) => manifest.requiredEntitlements.every((item) => scope.entitlements.includes(item)));
  }

  async invoke<I, O>(toolId: string, input: I, context: ToolContext): Promise<ToolResult<O>> {
    const startedAt = Date.now();
    const inputHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const idempotencyKey = normalizedIdempotencyKey(context.idempotencyKey, context.runId, toolId, inputHash);
    const invocationContext: ToolContext = { ...context, idempotencyKey };
    const registered = this.tools.get(toolId);
    let result: ToolResult<unknown>;
    if (!registered) result = toolFailure("UNAVAILABLE", `tool is not registered: ${toolId}`);
    else if (!matchesRunManifestSnapshot(registered.manifest, invocationContext.toolManifestSnapshot)) {
      result = toolFailure("UNAVAILABLE", `tool is not authorized by this run's manifest snapshot: ${toolId}`);
    }
    else if (!registered.manifest.enabled) result = toolFailure("DISABLED", `tool is disabled: ${toolId}`);
    else if (invocationContext.remainingToolCalls < 1) result = toolFailure("BUDGET_EXCEEDED", "tool-call budget exhausted");
    else if (!registered.manifest.requiredEntitlements.every((item) => invocationContext.scope.entitlements.includes(item))) result = toolFailure("UNAUTHORIZED", `missing entitlement for ${toolId}`);
    else if (this.circuitBreaker.isOpen(toolId)) result = toolFailure("UNAVAILABLE", `tool circuit is open: ${toolId}`, true);
    else {
      const parsed = registered.tool.input.safeParse(input);
      if (!parsed.success) result = toolFailure("INVALID_INPUT", parsed.error.issues.map((issue) => issue.message).join("; "));
      else result = await this.invokeReliably(toolId, registered, parsed.data, invocationContext);
    }
    await this.audit.write({
      runId: invocationContext.runId, organizationId: invocationContext.scope.organizationId, toolId, idempotencyKey, at: new Date().toISOString(), ok: result.ok, inputHash,
      outputHash: result.ok ? createHash("sha256").update(JSON.stringify(result.value)).digest("hex") : undefined,
      evidenceIds: referencedEvidenceIds(input, result), estimatedCostUsd: result.estimatedCostUsd,
      durationMs: Date.now() - startedAt, failureCode: result.ok ? undefined : result.failure.code,
    });
    return result as ToolResult<O>;
  }

  private async invokeReliably(toolId: string, registered: RegisteredTool, input: unknown, context: ToolContext): Promise<ToolResult<unknown>> {
    const { tool, manifest } = registered;
    let result: ToolResult<unknown> = toolFailure("UNAVAILABLE", "tool did not produce a result", true);
    let totalEstimatedCostUsd = 0;
    const maximumAttemptCostUsd = manifest.maxEstimatedCostUsd ?? 0;
    for (let attempt = 1; attempt <= this.reliability.maxAttempts; attempt += 1) {
      const reservation = context.costLedger?.reserve(maximumAttemptCostUsd);
      if (reservation === undefined && context.costLedger) {
        return withCost(toolFailure("BUDGET_EXCEEDED", "tool cost budget exhausted before provider invocation", false), totalEstimatedCostUsd);
      }
      try {
        const rawResult: unknown = await this.withTimeout((signal) => tool.invoke(input, { ...context, signal }), manifest.timeoutMs, toolId, context.signal);
        result = validateToolResult(tool, rawResult, context.scope);
        const reportedCostUsd = reportedToolCost(rawResult);
        const actualCostUsd = reportedCostUsd ?? maximumAttemptCostUsd;
        totalEstimatedCostUsd += actualCostUsd;
        const settledWithinBudget = reservation == null || !context.costLedger || context.costLedger.settle(reservation, actualCostUsd);
        if (reportedCostUsd === undefined) result = contractFailure("tool returned an invalid estimated cost");
        if (actualCostUsd > maximumAttemptCostUsd || !settledWithinBudget) {
          result = toolFailure("BUDGET_EXCEEDED", "tool provider cost exceeded its authorized budget", false);
        }
        if (result.ok) {
          this.circuitBreaker.recordSuccess(toolId);
          return withCost(result, totalEstimatedCostUsd);
        }
      } catch (error) {
        result = error instanceof RunCostBudgetExceeded
          ? toolFailure("BUDGET_EXCEEDED", "shared run cost budget exhausted during tool execution", false)
          : error instanceof ToolTimeoutError
          ? toolFailure("TIMEOUT", error.message, true)
          : error instanceof ToolAbortedError
            ? toolFailure("TIMEOUT", error.message, false)
          : toolFailure("INTERNAL", error instanceof Error ? error.message : "tool invocation failed", true);
        // An interrupted provider call may already have incurred its declared
        // maximum cost. Settle conservatively before considering a retry.
        totalEstimatedCostUsd += maximumAttemptCostUsd;
        if (reservation != null && context.costLedger) context.costLedger.settle(reservation, maximumAttemptCostUsd);
      }
      const failure = (result as Extract<ToolResult<unknown>, { ok: false }>).failure;
      if (!isTransientFailure(failure)) return withCost(result, totalEstimatedCostUsd);
      if (attempt < this.reliability.maxAttempts) await retryDelay(attempt, this.reliability);
    }
    this.circuitBreaker.recordFailure(toolId, this.reliability);
    return withCost(result, totalEstimatedCostUsd);
  }

  private async withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, toolId: string, upstreamSignal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    let rejectUpstreamAbort: ((reason?: unknown) => void) | undefined;
    const upstreamAbort = new Promise<never>((_, reject) => { rejectUpstreamAbort = reject; });
    const abort = () => {
      controller.abort(upstreamSignal?.reason);
      rejectUpstreamAbort?.(new ToolAbortedError(toolId));
    };
    if (upstreamSignal?.aborted) abort();
    else upstreamSignal?.addEventListener("abort", abort, { once: true });
    let handle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { handle = setTimeout(() => { controller.abort(); reject(new ToolTimeoutError(toolId)); }, timeoutMs); });
    try { return await Promise.race([operation(controller.signal), timeout, upstreamAbort]); }
    finally {
      if (handle) clearTimeout(handle);
      upstreamSignal?.removeEventListener("abort", abort);
      controller.abort();
    }
  }
}

interface RegisteredTool {
  tool: Tool<unknown, unknown>;
  /** Effective manifest after the administrator catalog, if any. */
  manifest: ToolManifest;
}

function visibilityOf(manifest: ToolManifest): "agent" | "internal" {
  return manifest.visibility ?? "agent";
}

function assertApprovedManifestIsBounded(approved: ToolManifest, registered: ToolManifest): void {
  if (approved.id !== registered.id || approved.version !== registered.version || approved.capability !== registered.capability
    || visibilityOf(approved) !== visibilityOf(registered)
    || JSON.stringify([...approved.requiredEntitlements].sort()) !== JSON.stringify([...registered.requiredEntitlements].sort())) {
    throw new Error(`approved catalog manifest does not match trusted tool identity or permissions: ${approved.id}`);
  }
  if (approved.timeoutMs > registered.timeoutMs) throw new Error(`approved catalog may not increase timeout: ${approved.id}`);
  const approvedCost = approved.maxEstimatedCostUsd ?? 0;
  const registeredCost = registered.maxEstimatedCostUsd ?? 0;
  if (approvedCost > registeredCost) throw new Error(`approved catalog may not increase cost cap: ${approved.id}`);
}

/**
 * TypeScript tool signatures do not protect this boundary from a provider
 * adapter's runtime payload. Validate the entire result before evidence can
 * enter retrieval, model context, audit hashing, or a research report.
 */
function validateToolResult(tool: Tool<unknown, unknown>, candidate: unknown, scope: ResearchScope): ToolResult<unknown> {
  if (!isRecord(candidate)) return contractFailure("tool returned a non-object result");
  const estimatedCostUsd = finiteNonNegative(candidate.estimatedCostUsd);
  if (estimatedCostUsd === undefined) return contractFailure("tool returned an invalid estimated cost");

  if (candidate.ok === true) {
    const output = tool.output.safeParse(candidate.value);
    const evidence = EvidenceItemSchema.array().max(500).safeParse(candidate.evidence);
    if (!output.success || !evidence.success) return contractFailure("tool returned output outside its registered contract");
    if (!evidence.data.every((item) => isToolEvidenceAuthorized(scope, item))) {
      return toolFailure("UNAUTHORIZED", "tool returned evidence outside its authorized scope", false);
    }
    return { ok: true, value: output.data, evidence: evidence.data, estimatedCostUsd };
  }

  if (candidate.ok === false) {
    const failure = ToolFailureSchema.safeParse(candidate.failure);
    if (!failure.success) return contractFailure("tool returned a failure outside its registered contract");
    return { ok: false, failure: failure.data, estimatedCostUsd };
  }
  return contractFailure("tool result did not declare a boolean ok field");
}

function contractFailure(message: string): ToolResult<never> {
  // Do not retry malformed provider payloads: a retry cannot make an already
  // returned payload trustworthy, and upstream details must not reach clients.
  return toolFailure("INTERNAL", message, false);
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function reportedToolCost(candidate: unknown): number | undefined {
  return isRecord(candidate) ? finiteNonNegative(candidate.estimatedCostUsd) : undefined;
}

function withCost<T>(result: ToolResult<T>, estimatedCostUsd: number): ToolResult<T> {
  return result.ok
    ? { ...result, estimatedCostUsd }
    : { ...result, estimatedCostUsd };
}

/** Tool output must be safe for this exact run before storage or model use. */
function isToolEvidenceAuthorized(scope: ResearchScope, item: ReturnType<typeof EvidenceItemSchema.parse>): boolean {
  return item.tenantId === scope.organizationId
    && isClaimEvidenceEligible(item)
    && (item.authority === "primary" || Boolean(item.requiredEntitlements?.length))
    && isEvidenceAuthorized(scope, item);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedIdempotencyKey(provided: string | undefined, runId: string, toolId: string, inputHash: string): string {
  if (provided && /^[A-Za-z0-9._:-]{1,200}$/.test(provided)) return provided;
  return `derived:${createHash("sha256").update(`${runId}\u0000${toolId}\u0000${inputHash}`).digest("hex")}`;
}

/**
 * A snapshot is a security and reproducibility boundary, not a hint.  Compare
 * the full normalized manifest so a same-ID provider deployment cannot change
 * timeout, license requirements, cost guardrails, or visibility mid-run.
 * Undefined preserves the narrow direct-runtime/test path; all queued worker
 * runs receive a required snapshot through ResearchRunCommand.
 */
function matchesRunManifestSnapshot(current: ToolManifest, snapshot: ToolManifest[] | undefined): boolean {
  if (!snapshot) return true;
  const expected = snapshot.find((item) => item.id === current.id);
  if (!expected) return false;
  return stableManifestJson(ToolManifestSchema.parse(expected)) === stableManifestJson(ToolManifestSchema.parse(current));
}

function stableManifestJson(manifest: ToolManifest): string {
  return JSON.stringify({
    id: manifest.id,
    version: manifest.version,
    capability: manifest.capability,
    requiredEntitlements: [...manifest.requiredEntitlements].sort(),
    timeoutMs: manifest.timeoutMs,
    ...(manifest.maxEstimatedCostUsd === undefined ? {} : { maxEstimatedCostUsd: manifest.maxEstimatedCostUsd }),
    enabled: manifest.enabled,
    ...(manifest.visibility === undefined ? {} : { visibility: manifest.visibility }),
  });
}

/**
 * Audits opaque evidence identifiers, never content, for tools that consume
 * existing evidence (for example DCF and report rendering) as well as tools
 * that create evidence. The registry remains schema-first: this only runs
 * after the tool input has been validated or rejected in a normal invocation.
 */
function referencedEvidenceIds(input: unknown, result: ToolResult<unknown>): string[] {
  const ids = new Set<string>(result.ok ? result.evidence.map((item) => item.id) : []);
  if (!input || typeof input !== "object" || Array.isArray(input)) return [...ids];
  const record = input as Record<string, unknown>;
  for (const field of ["evidenceIds", "sourceEvidenceIds"]) {
    const values = record[field];
    if (Array.isArray(values)) for (const value of values) if (typeof value === "string") ids.add(value);
  }
  if (Array.isArray(record.evidence)) {
    for (const item of record.evidence) {
      if (item && typeof item === "object" && !Array.isArray(item) && typeof (item as Record<string, unknown>).id === "string") ids.add((item as Record<string, string>).id);
    }
  }
  return [...ids];
}

class ToolTimeoutError extends Error {
  constructor(toolId: string) { super(`tool timeout: ${toolId}`); }
}

class ToolAbortedError extends Error {
  constructor(toolId: string) { super(`tool invocation cancelled by the research-run deadline: ${toolId}`); }
}
