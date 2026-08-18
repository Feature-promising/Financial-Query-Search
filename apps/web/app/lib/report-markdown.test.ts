import { describe, expect, it } from "vitest";
import { parseControlledReportMarkdown, tokenizeReportInlineText } from "./report-markdown";

describe("controlled report Markdown", () => {
  it("parses the allowed report structures without interpreting raw HTML", () => {
    const blocks = parseControlledReportMarkdown("# Investment view [1]\n\nSummary <script>alert(1)</script> [2]\n\n- Growth improved [3]\n- Margin expanded\n\n| Metric | Value |\n| --- | --- |\n| Revenue | $10bn [4] |\n\n```text\nraw <tag>\n```");

    expect(blocks).toMatchObject([
      { kind: "heading", level: 1, text: "Investment view [1]" },
      { kind: "paragraph", text: "Summary <script>alert(1)</script> [2]" },
      { kind: "unordered_list", items: ["Growth improved [3]", "Margin expanded"] },
      { kind: "table", header: ["Metric", "Value"], rows: [["Revenue", "$10bn [4]"]] },
      { kind: "code", language: "text", text: "raw <tag>" },
    ]);
  });

  it("keeps citation tokens separate from plain text", () => {
    expect(tokenizeReportInlineText("Claim [12], supported by [3].")).toEqual([
      { kind: "text", value: "Claim " }, { kind: "citation", number: 12 }, { kind: "text", value: ", supported by " }, { kind: "citation", number: 3 }, { kind: "text", value: "." },
    ]);
  });
});
