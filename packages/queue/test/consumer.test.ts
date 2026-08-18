import { describe, expect, it } from "vitest";
import { consumeBatch, InMemoryQueue } from "../src/index.js";

describe("consumeBatch", () => {
  it("acknowledges only successfully handled messages", async () => {
    const queue = new InMemoryQueue<{ id: string }>();
    await queue.enqueue({ id: "one" });
    await queue.enqueue({ id: "two" });
    const handled: string[] = [];

    await expect(consumeBatch(queue, {
      handle: async (message) => {
        handled.push(message.id);
        if (message.id === "two") throw new Error("transient failure");
      },
    }, 2)).rejects.toThrow("transient failure");

    expect(handled).toEqual(["one", "two"]);
    const retry = await queue.receive(1);
    expect(retry).toHaveLength(1);
    expect(retry[0]?.body.id).toBe("two");
    expect(retry[0]?.attempts).toBe(2);
  });
});
