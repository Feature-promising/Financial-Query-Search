from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class RAGChunk:
    doc_id: str
    chunk_id: int
    title: str
    content: str
    source: str
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class RAGRequest:
    query: str
    user_query: Optional[str] = None
    top_k: int = 5
    filters: dict[str, Any] = field(default_factory=dict)


@dataclass
class RAGResponse:
    success: bool
    answer_context: str = ""
    documents: list[RAGChunk] = field(default_factory=list)
    error: Optional[str] = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_prompt_text(self) -> str:
        parts = ["RAG ????:"]
        for idx, doc in enumerate(self.documents, start=1):
            parts.append(
                f"{idx}. {doc.title}\n{doc.content}\n??: {doc.source}"
            )
        return "\n\n".join(parts)
