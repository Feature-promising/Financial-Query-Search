from dataclasses import dataclass, field
from typing import Any, Optional

"""统一定义搜索请求、搜索结果、错误分类。"""

@dataclass
class SearchItem:
    title:str
    content:str
    url:str


@dataclass
class SearchRequest:
    query: str
    user_query: Optional[str] = None
    trace_id: Optional[str] = None
    policy: str = "default"
    max_results: int = 5
    timeout_seconds: float = 20.0


@dataclass
class SearchResponse:
    success: bool
    provider: str
    answer: str = ""
    items: list[SearchItem] = field(default_factory=list)
    error: Optional[str] = None
    latency_ms: int = 0
    retry_count: int = 0
    from_cache: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_prompt_text(self) -> str:
        parts = [f"搜索提供方: {self.provider}"]

        if self.answer:
            parts.append(
                "搜索摘要参考(不可直接视为最终证据，需以后续条目内容为准):\n"
                f"{self.answer}"
            )

        if self.items:
            lines = ["检索条目证据(优先依据以下内容进行验证与回答):"]
            for idx, item in enumerate(self.items, start=1):
                lines.append(
                    f"{idx}. {item.title}\n{item.content}\n来源: {item.url}"
                )
            parts.append("\n".join(lines))

        if self.error and not self.success:
            parts.append(f"错误信息: {self.error}")

        return "\n\n".join(parts)


class SearchError(Exception):
    pass


class RetryableSearchError(SearchError):
    pass


class NonRetryableSearchError(SearchError):
    pass
