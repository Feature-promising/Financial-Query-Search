import { consumeBatch, type Queue } from "@research/queue";
import type { ResearchRunCommand } from "../commands/research-run.js";
import type { ResearchRunConsumer } from "../consumer/research-run-consumer.js";

export interface PollingWorkerOptions {
  batchSize?: number;
}

/**
 * A research run can use its full five-minute lease. Keep one in flight per
 * worker process so a second SQS message cannot expire while waiting behind it.
 * ECS service scaling, rather than hidden in-process concurrency, supplies
 * throughput.
 */
export class PollingResearchWorker {
  constructor(
    private readonly queue: Queue<ResearchRunCommand>,
    private readonly consumer: ResearchRunConsumer,
    private readonly options: PollingWorkerOptions = {},
  ) {}

  async processOnce(signal?: AbortSignal): Promise<number> {
    return consumeBatch(this.queue, this.consumer, this.options.batchSize ?? 1, signal);
  }
}
