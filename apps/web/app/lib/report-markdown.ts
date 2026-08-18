/**
 * A deliberately small report Markdown grammar. It renders the controlled
 * report format without accepting raw HTML, so untrusted provider or model
 * text remains React-escaped at the presentation boundary.
 */
export type ReportBlock =
  | { kind: "heading"; level: 1 | 2 | 3 | 4; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "unordered_list"; items: string[] }
  | { kind: "ordered_list"; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "code"; language?: string; text: string }
  | { kind: "table"; header: string[]; rows: string[][] };

export function parseControlledReportMarkdown(markdown: string): ReportBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReportBlock[] = [];
  let paragraph: string[] = [];
  const flushParagraph = () => {
    const text = paragraph.join(" ").trim();
    if (text) blocks.push({ kind: "paragraph", text });
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const next = lines[index + 1] ?? "";
    if (!line.trim()) { flushParagraph(); continue; }

    const fence = /^```\s*([^\s]*)\s*$/.exec(line);
    if (fence) {
      flushParagraph();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? "")) { code.push(lines[index] ?? ""); index += 1; }
      blocks.push({ kind: "code", ...(fence[1] ? { language: fence[1] } : {}), text: code.join("\n") });
      continue;
    }

    const heading = /^(#{1,4})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: "heading", level: heading[1]!.length as 1 | 2 | 3 | 4, text: heading[2]! });
      continue;
    }

    if (isTableHeader(line, next)) {
      flushParagraph();
      const header = parseTableCells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && isTableLine(lines[index] ?? "")) { rows.push(parseTableCells(lines[index] ?? "")); index += 1; }
      index -= 1;
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    const unordered = /^[-*+]\s+(.+)$/.exec(line);
    if (unordered) {
      flushParagraph();
      const items = [unordered[1]!];
      while (/^[-*+]\s+(.+)$/.test(lines[index + 1] ?? "")) { index += 1; items.push(/^[-*+]\s+(.+)$/.exec(lines[index] ?? "")![1]!); }
      blocks.push({ kind: "unordered_list", items });
      continue;
    }

    const ordered = /^\d+[.)]\s+(.+)$/.exec(line);
    if (ordered) {
      flushParagraph();
      const items = [ordered[1]!];
      while (/^\d+[.)]\s+(.+)$/.test(lines[index + 1] ?? "")) { index += 1; items.push(/^\d+[.)]\s+(.+)$/.exec(lines[index] ?? "")![1]!); }
      blocks.push({ kind: "ordered_list", items });
      continue;
    }

    const quote = /^>\s?(.+)$/.exec(line);
    if (quote) { flushParagraph(); blocks.push({ kind: "quote", text: quote[1]! }); continue; }
    paragraph.push(line.trim());
  }
  flushParagraph();
  return blocks;
}

export type ReportInlineToken = { kind: "text"; value: string } | { kind: "citation"; number: number };

export function tokenizeReportInlineText(text: string): ReportInlineToken[] {
  const tokens: ReportInlineToken[] = [];
  for (const part of text.split(/(\[\d+\])/g)) {
    const match = /^\[(\d+)\]$/.exec(part);
    if (match) tokens.push({ kind: "citation", number: Number(match[1]) });
    else if (part) tokens.push({ kind: "text", value: part });
  }
  return tokens;
}

function isTableHeader(line: string, next: string): boolean {
  return isTableLine(line) && /^\s*\|?\s*:?-{3,}:?(\s*\|\s*:?-{3,}:?)+\s*\|?\s*$/.test(next);
}

function isTableLine(line: string): boolean {
  return line.includes("|") && line.trim().length > 1;
}

function parseTableCells(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}
