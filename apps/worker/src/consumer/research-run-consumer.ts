import type { QueueConsumer } from "@research/queue";
import { ResearchRunCommandSchema, type ResearchRunCommand } from "../commands/research-run.js";

export interface RunCommandHandler {
  handle(command: ResearchRunCommand, shutdownSignal?: AbortSignal): Promise<void>;
}

/** Validates decoded queue payloads before they become executable research work. */
export class ResearchRunConsumer implements QueueConsumer<ResearchRunCommand> {
  constructor(private readonly handler: RunCommandHandler) {}

  async handle(message: ResearchRunCommand, shutdownSignal?: AbortSignal): Promise<void> {
    await this.handler.handle(ResearchRunCommandSchema.parse(message), shutdownSignal);
  }
}
