import { RunEventSchema, type RunEvent } from "@research/contracts";
import { createRedisStreamClient } from "./redis-client.js";
import type { RedisStreamClient, RunEventPublisher, RunEventWakeup } from "./types.js";

const defaultStreamKey = "research:run-events:v1";
const defaultMaxLength = 20_000;

export interface RedisRunEventsOptions {
  url: string;
  streamKey?: string;
  maxLength?: number;
  createClient?: (url: string) => RedisStreamClient;
}

/**
 * Appends a validated copy of the durable event to a bounded Redis Stream.
 * The caller must persist the event before invoking this publisher.
 */
export class RedisRunEventPublisher implements RunEventPublisher {
  private readonly client: RedisStreamClient;
  private readonly streamKey: string;
  private readonly maxLength: number;

  constructor(options: RedisRunEventsOptions) {
    this.client = (options.createClient ?? createRedisStreamClient)(options.url);
    this.streamKey = options.streamKey ?? defaultStreamKey;
    this.maxLength = options.maxLength ?? defaultMaxLength;
  }

  async publish(event: RunEvent): Promise<void> {
    await this.ensureConnected();
    const validated = RunEventSchema.parse(event);
    await this.client.xAdd(this.streamKey, "*", { event: JSON.stringify(validated) }, {
      TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: this.maxLength },
    });
  }

  async close(): Promise<void> {
    if (this.client.isOpen) await this.client.quit();
  }

  private async ensureConnected(): Promise<void> {
    if (!this.client.isOpen) await this.client.connect();
  }
}

/**
 * A single Stream tailer coalesces live notifications for all SSE requests.
 * It deliberately carries no report content into the wakeup: SSE fetches the
 * authorized, persisted event from PostgreSQL after every notification.
 */
export class RedisRunEventWakeup implements RunEventWakeup {
  private readonly client: RedisStreamClient;
  private readonly streamKey: string;
  private readonly waiters = new Map<string, Set<() => void>>();
  private stopped = false;
  private loop?: Promise<void>;

  constructor(options: RedisRunEventsOptions) {
    this.client = (options.createClient ?? createRedisStreamClient)(options.url);
    this.streamKey = options.streamKey ?? defaultStreamKey;
  }

  async start(): Promise<void> {
    if (this.loop) return;
    this.stopped = false;
    if (!this.client.isOpen) await this.client.connect();
    this.loop = this.tail();
  }

  async waitFor(runId: string, timeoutMs: number): Promise<void> {
    if (this.stopped || !this.loop) return;
    const boundedTimeout = Math.max(1, Math.min(timeoutMs, 30_000));
    await new Promise<void>((resolve) => {
      const resolveAndRemove = () => {
        clearTimeout(timer);
        const listeners = this.waiters.get(runId);
        listeners?.delete(resolveAndRemove);
        if (listeners?.size === 0) this.waiters.delete(runId);
        resolve();
      };
      const timer = setTimeout(resolveAndRemove, boundedTimeout);
      const listeners = this.waiters.get(runId) ?? new Set<() => void>();
      listeners.add(resolveAndRemove);
      this.waiters.set(runId, listeners);
    });
  }

  async close(): Promise<void> {
    this.stopped = true;
    for (const listeners of this.waiters.values()) for (const resolve of listeners) resolve();
    this.waiters.clear();
    if (this.client.isOpen) await this.client.quit();
    await this.loop?.catch(() => undefined);
    this.loop = undefined;
  }

  private async tail(): Promise<void> {
    // Starting at zero removes the "$" cursor race. Stream retention bounds
    // startup work; missed history is still recovered from PostgreSQL.
    let cursor = "0-0";
    while (!this.stopped) {
      try {
        const groups = await this.client.xRead({ key: this.streamKey, id: cursor }, { COUNT: 100, BLOCK: 5_000 });
        for (const group of groups ?? []) for (const message of group.messages) {
          cursor = message.id;
          const event = parseRunEvent(message.message.event);
          if (event) this.notify(event.runId);
        }
      } catch {
        if (!this.stopped) await delay(1_000);
      }
    }
  }

  private notify(runId: string): void {
    const listeners = this.waiters.get(runId);
    if (!listeners) return;
    for (const resolve of [...listeners]) resolve();
  }
}

function parseRunEvent(value: string | undefined): RunEvent | undefined {
  if (!value) return undefined;
  try { return RunEventSchema.parse(JSON.parse(value)); }
  catch { return undefined; }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
