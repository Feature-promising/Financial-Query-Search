import type { MemoryDeletionAudit } from "@research/contracts";
import type { MemoryDeletionAuditSink } from "./types.js";

/** Development/test sink; production uses the PostgreSQL implementation in @research/db. */
export class InMemoryMemoryDeletionAuditSink implements MemoryDeletionAuditSink {
  readonly events: MemoryDeletionAudit[] = [];
  async append(event: MemoryDeletionAudit): Promise<void> { this.events.push(event); }
}
