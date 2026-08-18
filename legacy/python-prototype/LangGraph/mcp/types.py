from dataclasses import dataclass, field
from typing import Any, Literal


MCPToolName = Literal[
    "web_extract_mcp",
    "local_docs_mcp",
    "filing_reader_mcp",
    "financial_data_mcp",
]


@dataclass
class MCPToolCall:
    tool_name: MCPToolName
    arguments: dict[str, Any]
    request_id: str | None = None
    timeout_seconds: float = 20.0


@dataclass
class MCPToolResult:
    tool_name: MCPToolName
    success: bool
    content: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

# ---------- web_extract_mcp ----------

@dataclass
class WebExtractInput:
    url: str
    max_chars: int = 8000
    include_summary: bool = True
    include_published_at: bool = True

@dataclass
class WebExtractOutput:
    url: str
    title: str
    site_name: str
    published_at: str | None
    summary: str
    main_text: str
    language: str | None = None
    author: str | None = None


# ---------- local_docs_mcp ----------
@dataclass
class LocalDocsInput:
    query: str
    top_k: int = 5
    folder: str | None = None
    tags: list[str] = field(default_factory=list)
    file_types: list[str] = field(default_factory=lambda: ["pdf", "md", "txt", "csv"])

@dataclass
class LocalDocsHit:
    doc_id: str
    title: str
    path: str
    snippet: str
    score: float
    file_type: str
    tags: list[str] = field(default_factory=list)
    modified_at: str | None = None

@dataclass
class LocalDocsOutput:
    query: str
    hits: list[LocalDocsHit] = field(default_factory=list)


# ---------- filing_reader_mcp ----------
@dataclass
class FilingReaderInput:
    ticker: str | None = None
    company_name: str | None = None
    filing_type: str | None = None
    filing_url: str | None = None
    date_from: str | None = None
    date_to: str | None = None
    sections: list[str] = field(default_factory=list)
    max_passages: int = 5

@dataclass
class FilingPassage:
    section: str
    heading: str
    content: str
    page: int | None = None
    anchor: str | None = None


@dataclass
class FilingReaderOutput:
    company_name: str
    ticker: str | None
    filing_type: str
    filing_date: str | None
    filing_url: str | None
    passages: list[FilingPassage] = field(default_factory=list)


# ---------- financial_data_mcp ----------
@dataclass
class FinancialDataInput:
    ticker: str | None = None
    company_name: str | None = None
    metrics: list[str] = field(default_factory=list)
    period: Literal["latest", "ttm", "fy", "fq"] = "latest"
    fiscal_year: int | None = None
    fiscal_quarter: int | None = None

@dataclass
class FinancialMetric:
    name: str
    value: float | int | str | None
    unit: str | None = None
    currency: str | None = None
    as_of_date: str | None = None
    period: str | None = None

@dataclass
class FinancialDataOutput:
    company_name: str
    ticker: str | None
    metrics: list[FinancialMetric] = field(default_factory=list)