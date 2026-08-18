/**
 * Describes a deletion workflow that could not be completed atomically across
 * PostgreSQL and the external evidence stores. It deliberately contains no
 * memory content, evidence locators, or upstream error messages.
 */
export class MemoryDeletionWorkflowError extends Error {
  constructor(
    readonly phase: "requested_audit" | "artifact_cleanup" | "record_delete" | "completed_audit",
    readonly details: {
      /** The relational memory delete resolved successfully. */
      memoryRecordDeleted: boolean;
      /** An external cleanup operation may have completed before another failed. */
      artifactCleanupMayBePartial: boolean;
      /** The terminal audit event could not be durably appended. */
      auditEventMayBeMissing: boolean;
      /** A best-effort failed audit append also failed. */
      failedAuditWrite?: unknown;
    },
    cause: unknown,
  ) {
    super("memory deletion workflow did not reach a durable terminal state", { cause });
    this.name = "MemoryDeletionWorkflowError";
  }
}

export function isMemoryDeletionWorkflowError(error: unknown): error is MemoryDeletionWorkflowError {
  return error instanceof MemoryDeletionWorkflowError;
}
