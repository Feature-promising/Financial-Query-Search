import type { RunEvent } from "@research/contracts";

/** Best-effort live fan-out; PostgreSQL remains the authoritative event ledger. */
export interface RunEventPublisher {
  publish(event: RunEvent): Promise<void>;
  close(): Promise<void>;
}

/** Wakes an SSE pump when a run receives an event; callers re-read PostgreSQL. */
export interface RunEventWakeup {
  start(): Promise<void>;
  waitFor(runId: string, timeoutMs: number): Promise<void>;
  close(): Promise<void>;
}

export interface RedisStreamMessage {
  id: string;
  message: Record<string, string>;
}

export interface RedisStreamRead {
  name: string;
  messages: RedisStreamMessage[];
}

export interface RedisStreamClient {
  readonly isOpen: boolean;
  connect(): Promise<void>;
  quit(): Promise<void>;
  xAdd(key: string, id: string, message: Record<string, string>, options: { TRIM: { strategy: "MAXLEN"; strategyModifier: "~"; threshold: number } }): Promise<string>;
  xRead(stream: { key: string; id: string }, options: { COUNT: number; BLOCK: number }): Promise<RedisStreamRead[] | null>;
}
