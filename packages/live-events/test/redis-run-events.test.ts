import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RedisRunEventPublisher, RedisRunEventWakeup, type RedisStreamClient } from "../src/index.js";

describe("Redis run events", () => {
  it("writes validated events to a bounded stream", async () => {
    const client = new FakeRedisStreamClient();
    const publisher = new RedisRunEventPublisher({ url: "redis://unused", streamKey: "test-events", maxLength: 12, createClient: () => client });
    const event = sampleEvent();

    await publisher.publish(event);
    expect(client.xAdds).toHaveLength(1);
    expect(client.xAdds[0]).toMatchObject({ key: "test-events", id: "*", threshold: 12 });
    expect(JSON.parse(client.xAdds[0]!.event)).toEqual(event);
    await publisher.close();
    expect(client.quitCalls).toBe(1);
  });

  it("wakes only waiters for a valid event's run", async () => {
    const client = new FakeRedisStreamClient();
    const wakeup = new RedisRunEventWakeup({ url: "redis://unused", createClient: () => client });
    await wakeup.start();
    const target = sampleEvent();
    const unrelated = sampleEvent();
    const waiting = wakeup.waitFor(target.runId, 1_000);

    client.resolveRead([{ name: "research:run-events:v1", messages: [{ id: "1-0", message: { event: JSON.stringify(unrelated) } }, { id: "2-0", message: { event: JSON.stringify(target) } }] }]);
    await waiting;
    await wakeup.close();
    expect(client.quitCalls).toBe(1);
  });
});

function sampleEvent() {
  return { id: randomUUID(), runId: randomUUID(), sequence: 1, type: "run_started" as const, at: "2026-08-14T00:00:00.000Z", payload: { question: "NVDA" } };
}

class FakeRedisStreamClient implements RedisStreamClient {
  isOpen = false;
  quitCalls = 0;
  readonly xAdds: Array<{ key: string; id: string; event: string; threshold: number }> = [];
  private resolveNextRead?: (value: Awaited<ReturnType<RedisStreamClient["xRead"]>>) => void;

  async connect(): Promise<void> { this.isOpen = true; }
  async quit(): Promise<void> { this.isOpen = false; this.quitCalls += 1; this.resolveNextRead?.(null); }
  async xAdd(key: string, id: string, message: Record<string, string>, options: { TRIM: { strategy: "MAXLEN"; strategyModifier: "~"; threshold: number } }): Promise<string> {
    this.xAdds.push({ key, id, event: message.event!, threshold: options.TRIM.threshold });
    return "1-0";
  }
  async xRead(): Promise<Awaited<ReturnType<RedisStreamClient["xRead"]>> | null> {
    return new Promise((resolve) => { this.resolveNextRead = resolve; });
  }
  resolveRead(value: NonNullable<Awaited<ReturnType<RedisStreamClient["xRead"]>>>): void { this.resolveNextRead?.(value); }
}
