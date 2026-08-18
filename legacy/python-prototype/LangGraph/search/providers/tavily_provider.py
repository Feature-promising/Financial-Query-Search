
import asyncio
import os
import time

from dotenv import load_dotenv
from tavily import TavilyClient

from search.models import (
    NonRetryableSearchError,
    RetryableSearchError,
    SearchItem,
    SearchRequest,
    SearchResponse,
)
from search.providers.base import BaseSearchProvider
load_dotenv()

class TavilyProvider(BaseSearchProvider):
    name = "tavily"

    def __init__(self, api_key: str | None = None) -> None:

        self.api_key = api_key or os.getenv("TAVILY_API_KEY")
        if not self.api_key:
            raise NonRetryableSearchError("TAVILY_API_KEY 未配置")
        self.client = TavilyClient(api_key=self.api_key)


    async def search(self, request: SearchRequest) -> SearchResponse:
        """使用Tavily API进行真实搜索"""
        start = time.perf_counter()

        try:
            response = await asyncio.to_thread(
                self.client.search,
                query=request.query,
                search_depth='basic',
                include_answer=True,
                include_raw_content=False,
                max_results=request.max_results,
            )

        except Exception as exc:
            message = str(exc).lower()

            if "429" in message or "rate limit" in message or "timeout" in message:
                raise RetryableSearchError(f"Tavily 临时失败: {exc}") from exc

            if "unauthorized" in message or "api key" in message:
                raise NonRetryableSearchError(f"Tavily 配置错误: {exc}") from exc

            raise RetryableSearchError(f"Tavily 调用失败: {exc}") from exc

        raw_results = response.get("results", []) or []
        answer = (response.get("answer", "") or "").strip()

        if not raw_results:
            raise RetryableSearchError("Tavily 返回空结果，回退到 Playwright")

        # 结果过少且没有摘要答案时，通常不足以支撑后续问答，交给浏览器检索兜底。
        if len(raw_results) < 2 and not answer:
            raise RetryableSearchError("Tavily 结果过弱，回退到 Playwright")

        items: list[SearchItem] = []
        for result in raw_results[: request.max_results]:
            items.append(
                SearchItem(
                    title=result.get("title", ""),
                    content=result.get("content", ""),
                    url=result.get("url", ""),
                )
            )

        latency_ms = int((time.perf_counter() - start) * 1000)

        return SearchResponse(
            success=True,
            provider=self.name,
            answer=answer,
            items=items,
            latency_ms=latency_ms,
            metadata={"raw_result_count": len(raw_results)},
        )
