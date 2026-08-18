import { describe, expect, it } from "vitest";
import { chunkFilingText } from "../../src/index.js";

describe("chunkFilingText", () => {
  it("uses deterministic whitespace boundaries and offsets in normalized filing text", () => {
    const text = "Revenue increased materially in the quarter. Margin expanded with demand. Cash flow improved.";
    const chunks = chunkFilingText(text, { maxChars: 45, maxChunks: 4 });

    expect(chunks).toEqual([
      { startOffset: 0, endOffset: 44, content: "Revenue increased materially in the quarter." },
      { startOffset: 45, endOffset: 83, content: "Margin expanded with demand. Cash flow" },
      { startOffset: 84, endOffset: 93, content: "improved." },
    ]);
    expect(chunks.map((chunk) => text.slice(chunk.startOffset, chunk.endOffset))).toEqual(chunks.map((chunk) => chunk.content));
  });

  it("enforces a bounded fragment count", () => {
    const chunks = chunkFilingText("word ".repeat(2_000), { maxChars: 400, maxChunks: 3 });
    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.content.length <= 400)).toBe(true);
  });
});
