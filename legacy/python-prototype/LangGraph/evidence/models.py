from dataclasses import dataclass, field
from typing import Any, Literal

EvidenceSourceType = Literal[
    "web_search",
    "web_page",
    "local_doc",
    "filing",
    "financial_data",
]

@dataclass
class EvidenceItem:
    source_type: EvidenceSourceType
    provider: str
    title: str
    content: str
    url_or_path: str
    entity: str | None = None
    published_at: str | None = None
    confidence: float = 0.5
    metadata: dict[str, Any] = field(default_factory=dict)

@dataclass
class EvidenceBundle:
    items: list[EvidenceItem] = field(default_factory=list)
    summary: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)

    def add(self, item: EvidenceItem) -> None:
        self.items.append(item)

    def extend(self, items: list[EvidenceItem]) -> None:
        self.items.extend(items)

    def to_prompt_text(self) -> str:
        if not self.items:
            return "没有可用证据。"

        lines = []
        for idx, item in enumerate(self.items, start=1):
            lines.append(
                "\n".join(
                    [
                        f"{idx}. [{item.source_type}] {item.title}",
                        f"provider: {item.provider}",
                        f"source: {item.url_or_path}",
                        f"published_at: {item.published_at or 'unknown'}",
                        f"entity: {item.entity or 'unknown'}",
                        f"confidence: {item.confidence:.2f}",
                        f"content: {item.content}",
                    ]
                )
            )
        return "\n\n".join(lines)