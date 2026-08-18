import type { RunCheckpoint, RunCheckpointSink } from "./types.js";

export class InMemoryRunCheckpointSink implements RunCheckpointSink {
  readonly checkpoints: RunCheckpoint[] = [];
  async save(checkpoint: RunCheckpoint): Promise<void> { this.checkpoints.push(structuredClone(checkpoint)); }
  async latest(runId: string, organizationId: string): Promise<RunCheckpoint | undefined> { return this.checkpoints.filter((item) => item.runId === runId && item.organizationId === organizationId).at(-1); }
}
