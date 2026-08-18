import { describe, expect, it } from "vitest";
import { runUntilAborted } from "../src/runtime/run-loop.js";

describe("runUntilAborted", () => {
  it("stops quietly when shutdown aborts an idle long poll", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    await expect(runUntilAborted(controller.signal, async (signal) => {
      receivedSignal = signal;
      controller.abort();
      throw new Error("SQS receive aborted");
    })).resolves.toBeUndefined();

    expect(receivedSignal).toBe(controller.signal);
  });

  it("preserves unexpected polling failures while still accepting work", async () => {
    const controller = new AbortController();
    await expect(runUntilAborted(controller.signal, async () => { throw new Error("SQS unavailable"); })).rejects.toThrow("SQS unavailable");
  });
});
