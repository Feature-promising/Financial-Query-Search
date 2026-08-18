import { describe, expect, it } from "vitest";
import { consumeSse } from "./sse";

describe("consumeSse", () => {
  it("preserves standard SSE ids across arbitrarily split chunks", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("id: 4\nevent: plan_ready\ndata: {\"id\":\"a054a391-1e13-4164-b8ef-6635dfe95a97\",\"runId\":\"70c7a2ca-44e6-44b1-b3bb-728c8dbd63d9\","));
        controller.enqueue(encoder.encode("\"sequence\":4,\"type\":\"plan_ready\",\"at\":\"2026-08-15T00:00:00.000Z\",\"payload\":{\"summary\":\"Plan\",\"tasks\":[{\"id\":\"source\",\"title\":\"Source\",\"objective\":\"Retrieve source\",\"dependsOn\":[],\"allowedTools\":[\"filing.search\"],\"acceptanceCriteria\":[\"evidence\"],\"status\":\"pending\"}]}}\n\n"));
        controller.close();
      },
    });
    const received: unknown[] = [];

    await consumeSse(stream, (event) => received.push(event));

    expect(received).toEqual([{ runId: "70c7a2ca-44e6-44b1-b3bb-728c8dbd63d9", type: "plan_ready", payload: { summary: "Plan", tasks: [{ id: "source", title: "Source", objective: "Retrieve source", dependsOn: [], allowedTools: ["filing.search"], acceptanceCriteria: ["evidence"], status: "pending" }] }, sequence: 4 }]);
  });

  it("drops malformed server event payloads instead of rendering them", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("id: 5\nevent: run_started\ndata: {\"id\":\"a054a391-1e13-4164-b8ef-6635dfe95a97\",\"runId\":\"70c7a2ca-44e6-44b1-b3bb-728c8dbd63d9\",\"sequence\":5,\"type\":\"run_started\",\"at\":\"2026-08-15T00:00:00.000Z\",\"payload\":{}}\n\n"));
        controller.close();
      },
    });
    const received: unknown[] = [];

    await consumeSse(stream, (event) => received.push(event));

    expect(received).toEqual([]);
  });

  it("accepts a validated queue pause event so the timeline can render a durable state", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("id: 1\nevent: run_paused\ndata: {\"id\":\"a054a391-1e13-4164-b8ef-6635dfe95a97\",\"runId\":\"70c7a2ca-44e6-44b1-b3bb-728c8dbd63d9\",\"sequence\":1,\"type\":\"run_paused\",\"at\":\"2026-08-15T00:00:00.000Z\",\"payload\":{\"reason\":\"user_requested\",\"safeBoundary\":\"queued\"}}\n\n"));
        controller.close();
      },
    });
    const received: unknown[] = [];

    await consumeSse(stream, (event) => received.push(event));

    expect(received).toEqual([{ runId: "70c7a2ca-44e6-44b1-b3bb-728c8dbd63d9", type: "run_paused", payload: { reason: "user_requested", safeBoundary: "queued" }, sequence: 1 }]);
  });

  it("handles CRLF, heartbeat comments, and JSON split across data lines", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": keepalive\r\n\r\nid: 6\r\nevent: run_paused\r\ndata: {\"id\":\"a054a391-1e13-4164-b8ef-6635dfe95a97\",\"runId\":\"70c7a2ca-44e6-44b1-b3bb-728c8dbd63d9\",\r\ndata: \"sequence\":6,\"type\":\"run_paused\",\"at\":\"2026-08-15T00:00:00.000Z\",\"payload\":{\"reason\":\"user_requested\",\"safeBoundary\":\"queued\"}}\r\n\r\n"));
        controller.close();
      },
    });
    const received: unknown[] = [];

    await consumeSse(stream, (event) => received.push(event));

    expect(received).toEqual([{ runId: "70c7a2ca-44e6-44b1-b3bb-728c8dbd63d9", type: "run_paused", payload: { reason: "user_requested", safeBoundary: "queued" }, sequence: 6 }]);
  });
});
