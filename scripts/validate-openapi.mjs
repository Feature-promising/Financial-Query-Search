import { readFile } from "node:fs/promises";

const specification = JSON.parse(await readFile(new URL("../docs/openapi/v1.json", import.meta.url), "utf8"));
const requiredPaths = [
  "/health",
  "/ready",
  "/v1/conversations",
  "/v1/conversations/{conversationId}",
  "/v1/conversations/{conversationId}/archive",
  "/v1/conversations/{conversationId}/unarchive",
  "/v1/conversations/{conversationId}/turns",
  "/v1/runs/{runId}",
  "/v1/runs/{runId}/pause",
  "/v1/runs/{runId}/resume",
  "/v1/runs/{runId}/events",
  "/v1/evidence/{evidenceId}",
  "/v1/memory/preferences",
  "/v1/memory/{memoryId}",
  "/v1/reports",
  "/v1/reports/{reportId}"
];
const eventTypes = ["run_started", "run_recovered", "run_paused", "run_resumed", "intent_ready", "plan_ready", "task_started", "tool_completed", "evidence_ready", "claim_delta", "critic_result", "completed", "abstained", "failed"];

if (specification.openapi !== "3.1.0") throw new Error("OpenAPI version must be 3.1.0");
for (const path of requiredPaths) if (!specification.paths?.[path]) throw new Error(`OpenAPI is missing path: ${path}`);
const runEvent = specification.components?.schemas?.RunEvent;
const documentedEvents = Object.keys(runEvent?.discriminator?.mapping ?? {});
if (JSON.stringify(documentedEvents) !== JSON.stringify(eventTypes)) throw new Error("RunEvent types have drifted from the API contract");
if (!Array.isArray(runEvent?.oneOf) || runEvent.oneOf.length !== eventTypes.length || runEvent?.properties?.payload?.additionalProperties === true) {
  throw new Error("RunEvent must document a closed, discriminated payload union");
}
for (const eventType of eventTypes) {
  const reference = runEvent.discriminator.mapping[eventType];
  if (typeof reference !== "string" || !reference.startsWith("#/components/schemas/")) throw new Error(`RunEvent is missing a schema mapping for ${eventType}`);
  const schemaName = reference.slice("#/components/schemas/".length);
  if (!specification.components?.schemas?.[schemaName]) throw new Error(`RunEvent references missing schema ${schemaName}`);
}
if (!specification.components?.securitySchemes?.bearerAuth) throw new Error("OpenAPI must document OIDC bearer authentication");
const eventResponse = specification.components?.responses?.RunEvents;
if (!eventResponse?.content?.["text/event-stream"]) throw new Error("OpenAPI must document the replayable SSE stream");
const apiError = specification.components?.schemas?.ApiError;
if (!apiError?.required?.includes("code") || !apiError.required.includes("message") || !apiError.required.includes("requestId")) {
  throw new Error("OpenAPI must document the stable API error envelope");
}
const authenticatedOperations = [
  ["/v1/conversations", "post"],
  ["/v1/conversations", "get"],
  ["/v1/conversations/{conversationId}", "get"],
  ["/v1/conversations/{conversationId}", "patch"],
  ["/v1/conversations/{conversationId}", "delete"],
  ["/v1/conversations/{conversationId}/archive", "post"],
  ["/v1/conversations/{conversationId}/unarchive", "post"],
  ["/v1/conversations/{conversationId}/turns", "post"],
  ["/v1/runs/{runId}", "get"],
  ["/v1/runs/{runId}/pause", "post"],
  ["/v1/runs/{runId}/resume", "post"],
  ["/v1/runs/{runId}/events", "get"],
  ["/v1/evidence/{evidenceId}", "get"],
  ["/v1/memory/preferences", "get"],
  ["/v1/memory/preferences", "put"],
  ["/v1/memory/{memoryId}", "delete"],
  ["/v1/reports", "post"],
  ["/v1/reports/{reportId}", "get"],
];
for (const [path, method] of authenticatedOperations) {
  const responses = specification.paths?.[path]?.[method]?.responses;
  if (!responses?.["401"] || !responses?.["500"]) throw new Error(`OpenAPI must document 401 and 500 responses for ${method.toUpperCase()} ${path}`);
}
for (const [path, method] of [["/v1/conversations", "post"], ["/v1/conversations", "get"], ["/v1/conversations/{conversationId}", "get"], ["/v1/conversations/{conversationId}", "patch"], ["/v1/conversations/{conversationId}", "delete"], ["/v1/conversations/{conversationId}/archive", "post"], ["/v1/conversations/{conversationId}/unarchive", "post"], ["/v1/conversations/{conversationId}/turns", "post"], ["/v1/runs/{runId}", "get"], ["/v1/runs/{runId}/pause", "post"], ["/v1/runs/{runId}/resume", "post"], ["/v1/runs/{runId}/events", "get"], ["/v1/evidence/{evidenceId}", "get"], ["/v1/memory/preferences", "put"], ["/v1/memory/{memoryId}", "delete"], ["/v1/reports", "post"], ["/v1/reports/{reportId}", "get"]]) {
  if (!specification.paths?.[path]?.[method]?.responses?.["400"]) throw new Error(`OpenAPI must document request validation failure for ${method.toUpperCase()} ${path}`);
}
const reportView = specification.components?.schemas?.ResearchReportView;
if (!reportView || reportView.properties?.organizationId || reportView.required?.includes("organizationId")) {
  throw new Error("OpenAPI must expose reports through a tenant-safe public projection");
}
for (const [path, method] of [["/v1/reports", "post"], ["/v1/reports/{reportId}", "get"]]) {
  const schema = specification.paths?.[path]?.[method]?.responses?.[method === "post" ? "202" : "200"]?.content?.["application/json"]?.schema?.$ref;
  if (schema !== "#/components/schemas/ResearchReportView") throw new Error(`OpenAPI must use the public report projection for ${method.toUpperCase()} ${path}`);
}
for (const schemaName of ["ConversationView", "ResearchRunView", "EvidenceView"]) {
  const schema = specification.components?.schemas?.[schemaName];
  if (!schema || schema.properties?.organizationId || schema.properties?.tenantId || schema.properties?.createdBy) {
    throw new Error(`OpenAPI must expose ${schemaName} as a tenant-safe public projection`);
  }
}
if (!specification.components?.schemas?.EvidenceView?.properties?.license) throw new Error("OpenAPI must document evidence license disclosure");
if (!specification.paths?.["/ready"]?.get?.responses?.["503"]) throw new Error("OpenAPI must document readiness dependency failure");
if (!specification.paths?.["/v1/conversations/{conversationId}/turns"]?.post?.responses?.["429"] || !apiError?.properties?.code?.enum?.includes("RUN_LIMIT_EXCEEDED")) {
  throw new Error("OpenAPI must document active-run quota rejection");
}
const memoryDeletion = specification.paths?.["/v1/memory/{memoryId}"]?.delete;
if (!memoryDeletion?.responses?.["503"] || !apiError?.properties?.code?.enum?.includes("MEMORY_DELETION_INCOMPLETE") || !apiError.properties.code.enum.includes("MEMORY_DELETION_AUDIT_UNAVAILABLE")) {
  throw new Error("OpenAPI must document uncertain coordinated memory deletion");
}
if (!memoryDeletion?.responses?.["409"] || !apiError?.properties?.code?.enum?.includes("MEMORY_RETENTION_LOCKED")) {
  throw new Error("OpenAPI must document legal-hold protection for memory deletion");
}
const preferences = specification.paths?.["/v1/memory/preferences"];
if (!preferences?.get?.responses?.["200"] || !preferences?.put?.requestBody || !specification.components?.schemas?.ConfirmedPreference?.oneOf) {
  throw new Error("OpenAPI must document the closed confirmed-preference API");
}

console.log("OpenAPI v1 contract validated");
