from evidence.models import EvidenceBundle, EvidenceItem
from mcp.types import MCPToolResult


def from_web_search_sources(source_items: list[dict[str, str]], provider: str) -> list[EvidenceItem]:
    evidence: list[EvidenceItem] = []

    for item in source_items:
        evidence.append(
            EvidenceItem(
                source_type="web_search",
                provider=provider,
                title=item.get("title", "") or "untitled",
                content=item.get("content", "") or "",
                url_or_path=item.get("url", "") or "",
                confidence=0.60,
                metadata={},
            )
        )
    return evidence

def from_web_extract_result(result: MCPToolResult) -> list[EvidenceItem]:
    evidence: list[EvidenceItem] = []

    for block in result.content:
        evidence.append(
            EvidenceItem(
                source_type="web_page",
                provider=result.tool_name,
                title=block.get("title", "") or "untitled page",
                content=block.get("main_text", "") or block.get("summary", "") or "",
                url_or_path=block.get("url", "") or "",
                published_at=block.get("published_at"),
                confidence=0.80,
                metadata={
                    "site_name": block.get("site_name"),
                    "summary": block.get("summary", ""),
                    "author": block.get("author"),
                    "language": block.get("language"),
                },
            )
        )
    return evidence

def from_local_docs_result(result: MCPToolResult) -> list[EvidenceItem]:
    evidence: list[EvidenceItem] = []
    for block in result.content:
        evidence.append(
            EvidenceItem(
                source_type="local_doc",
                provider=result.tool_name,
                title=block.get("title", "") or "untitled local doc",
                content=block.get("snippet", "") or "",
                url_or_path=block.get("path", "") or "",
                published_at=block.get("modified_at"),
                confidence=float(block.get("score", 0.70)),
                metadata={
                    "doc_id": block.get("doc_id"),
                    "file_type": block.get("file_type"),
                    "tags": block.get("tags", []),
                },
            )
        )
    return evidence

def from_filing_reader_result(result: MCPToolResult) -> list[EvidenceItem]:
    evidence: list[EvidenceItem] = []
    for block in result.content:
        evidence.append(
            EvidenceItem(
                source_type="filing",
                provider=result.tool_name,
                title=block.get("heading", "") or block.get("section", "") or "filing passage",
                content=block.get("content", "") or "",
                url_or_path=block.get("filing_url", "") or "",
                entity=block.get("company_name") or block.get("ticker"),
                published_at=block.get("filing_date"),
                confidence=0.90,
                metadata={
                    "ticker": block.get("ticker"),
                    "filing_type": block.get("filing_type"),
                    "section": block.get("section"),
                    "page": block.get("page"),
                    "anchor": block.get("anchor"),
                },
            )
        )
    return evidence

def from_financial_data_result(result: MCPToolResult) -> list[EvidenceItem]:
    evidence: list[EvidenceItem] = []
    for block in result.content:
        metric_name = block.get("name", "unknown_metric")
        metric_value = block.get("value")
        metric_unit = block.get("unit") or ""
        metric_currency = block.get("currency") or ""

        evidence.append(
            EvidenceItem(
                source_type="financial_data",
                provider=result.tool_name,
                title=f"{block.get('company_name', 'company')} - {metric_name}",
                content=f"{metric_name} = {metric_value} {metric_unit} {metric_currency}".strip(),
                url_or_path=block.get("source", "") or "financial_data",
                entity=block.get("ticker") or block.get("company_name"),
                published_at=block.get("as_of_date"),
                confidence=0.95,
                metadata={
                    "period": block.get("period"),
                    "metric_name": metric_name,
                    "raw_value": metric_value,
                    "unit": metric_unit,
                    "currency": metric_currency,
                },
            )
        )
    return evidence

def merge_evidence(
    search_items: list[dict[str, str]] | None = None,
    search_provider: str = "unknown",
    mcp_results: list[MCPToolResult] | None = None,
) -> EvidenceBundle:
    bundle = EvidenceBundle()
    mcp_results = mcp_results or []

    if search_items:
        bundle.extend(from_web_search_sources(search_items, search_provider))

    for result in mcp_results:
        if not result.success:
            continue
        if result.tool_name == "web_extract_mcp":
            bundle.extend(from_web_extract_result(result))
        elif result.tool_name == "local_docs_mcp":
            bundle.extend(from_local_docs_result(result))
        elif result.tool_name == "filing_reader_mcp":
            bundle.extend(from_filing_reader_result(result))
        elif result.tool_name == "financial_data_mcp":
            bundle.extend(from_financial_data_result(result))

    bundle.summary = bundle.to_prompt_text()
    bundle.metadata = {
        "search_provider": search_provider,
        "mcp_tools_used": [r.tool_name for r in mcp_results if r.success],
        "item_count": len(bundle.items),
    }
    return bundle