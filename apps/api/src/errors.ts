import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AuthenticationError } from "@research/auth";
import { isMemoryDeletionWorkflowError } from "@research/memory";
import type { ApiError } from "@research/contracts";

export function sendApiError(reply: FastifyReply, statusCode: number, code: string, message: string, requestId: string): FastifyReply {
  const body: ApiError = { code, message, requestId };
  return reply.code(statusCode).send(body);
}

function isZodError(error: unknown): boolean {
  return error instanceof Error && error.name === "ZodError";
}

/** Registers the public error contract for synchronous HTTP request handling. */
export function registerApiErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AuthenticationError) {
      app.log.warn({ requestId: request.id }, "request authentication failed");
      return sendApiError(reply, 401, "UNAUTHORIZED", "authentication required", request.id);
    }
    if (isZodError(error)) {
      return sendApiError(reply, 400, "INVALID_REQUEST", "request validation failed", request.id);
    }
    if (isMemoryDeletionWorkflowError(error)) {
      // A cross-store deletion cannot be retried blindly: an external artifact
      // or the memory row may already be gone. Keep the request id and phase
      // in protected logs for an operator-led reconciliation.
      const { failedAuditWrite, ...safeDetails } = error.details;
      app.log.error({
        requestId: request.id,
        phase: error.phase,
        ...safeDetails,
        failedAuditWrite: Boolean(failedAuditWrite),
      }, "memory deletion requires reconciliation");
      const code = error.phase === "artifact_cleanup" || error.phase === "record_delete"
        ? "MEMORY_DELETION_INCOMPLETE"
        : "MEMORY_DELETION_AUDIT_UNAVAILABLE";
      return sendApiError(reply, 503, code, "memory deletion requires support reconciliation; do not retry automatically", request.id);
    }
    // Error messages can contain credentials or upstream response bodies. Keep
    // production logs correlatable without making the log stream a data leak.
    app.log.error({ errorType: error instanceof Error ? error.name : "unknown", requestId: request.id }, "unhandled API request failure");
    return sendApiError(reply, 500, "INTERNAL", "internal server error", request.id);
  });
}
