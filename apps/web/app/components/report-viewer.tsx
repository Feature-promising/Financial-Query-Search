"use client";

import { Fragment } from "react";
import { parseControlledReportMarkdown, tokenizeReportInlineText, type ReportBlock } from "../lib/report-markdown";

export function ReportViewer({ answer, onCitation }: { answer: string; onCitation: (number: number) => void }) {
  return <article className="report"><h3>研究报告</h3><div className="report-body">{parseControlledReportMarkdown(answer).map((block, index) => <ReportBlockView block={block} key={`${block.kind}-${index}`} onCitation={onCitation} />)}</div></article>;
}

function ReportBlockView({ block, onCitation }: { block: ReportBlock; onCitation: (number: number) => void }) {
  if (block.kind === "heading") {
    const Heading = (`h${block.level}` as const);
    return <Heading><InlineText text={block.text} onCitation={onCitation} /></Heading>;
  }
  if (block.kind === "paragraph") return <p><InlineText text={block.text} onCitation={onCitation} /></p>;
  if (block.kind === "quote") return <blockquote><InlineText text={block.text} onCitation={onCitation} /></blockquote>;
  if (block.kind === "code") return <pre data-language={block.language}><code>{block.text}</code></pre>;
  if (block.kind === "unordered_list") return <ul>{block.items.map((item, index) => <li key={index}><InlineText text={item} onCitation={onCitation} /></li>)}</ul>;
  if (block.kind === "ordered_list") return <ol>{block.items.map((item, index) => <li key={index}><InlineText text={item} onCitation={onCitation} /></li>)}</ol>;
  return <div className="report-table-wrap"><table><thead><tr>{block.header.map((cell, index) => <th key={index}><InlineText text={cell} onCitation={onCitation} /></th>)}</tr></thead><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{block.header.map((_, cellIndex) => <td key={cellIndex}><InlineText text={row[cellIndex] ?? ""} onCitation={onCitation} /></td>)}</tr>)}</tbody></table></div>;
}

function InlineText({ text, onCitation }: { text: string; onCitation: (number: number) => void }) {
  return <>{tokenizeReportInlineText(text).map((token, index) => token.kind === "citation"
    ? <button key={`${token.number}-${index}`} type="button" className="citation" onClick={() => onCitation(token.number)}>[{token.number}]</button>
    : <Fragment key={index}>{token.value}</Fragment>)}</>;
}
