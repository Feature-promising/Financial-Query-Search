import asyncio
import time
import importlib.util
from urllib.parse import quote_plus

from playwright.async_api import async_playwright

from search.models import (
    NonRetryableSearchError,
    RetryableSearchError,
    SearchItem,
    SearchRequest,
    SearchResponse,
)
from search.providers.base import BaseSearchProvider

class PlaywrightProvider(BaseSearchProvider):
    name = "playwright"

    def __init__(
        self,
        enabled: bool = True,
        headless: bool = True,
        page_timeout_ms: int = 15000,
        max_results: int = 3,
    ) -> None:
        self.enabled = enabled
        self.headless = headless
        self.page_timeout_ms = page_timeout_ms
        self.max_results = max_results

    async def search(self, request: SearchRequest) -> SearchResponse:
        start = time.perf_counter()

        if not self.enabled:
            raise NonRetryableSearchError("PlaywrightProvider 已禁用")

        if not self._is_playwright_installed():
            raise NonRetryableSearchError(
                "Playwright 未安装。请先执行: pip install playwright && playwright install chromium"
            )

        try:
            # 本地playwright
            result = await self._search_with_browser(request)
        except NonRetryableSearchError:
            raise
        except Exception as exc:
            raise RetryableSearchError(f"Playwright 搜索失败: {exc}") from exc

        
        latency_ms = int((time.perf_counter() - start) * 1000)

        return SearchResponse(
            success=True,
            provider=self.name,
            answer=result.get("answer", ""),
            items=result.get("items", []),
            latency_ms=latency_ms,
            metadata=result.get("metadata", {}),
        )
    
    def _is_playwright_installed(self) -> bool:

        return importlib.util.find_spec("playwright") is not None
    
    async def _search_with_browser(self, request: SearchRequest) -> dict:
        """
        最小建议流程:
        1. 打开搜索引擎结果页
        2. 抓取前3条标题/链接/摘要
        3. 可选进入前1-2个页面抓正文
        4. 汇总成统一结果
        """

        query = request.query.strip()
        if not query:
            raise NonRetryableSearchError("搜索词为空，无法执行浏览器搜索")

        search_url = f"https://www.bing.com/search?q={quote_plus(query)}"

        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=self.headless)
            page = await browser.new_page()
            page.set_default_timeout(self.page_timeout_ms)

            try:
                await page.goto(search_url, wait_until="domcontentloaded")
                await page.wait_for_timeout(1500)

                items = await self._extract_bing_results(page)

                if not items:
                    raise RetryableSearchError("Playwright 未抓取到有效搜索结果")

                answer = self._build_answer(query, items)

                return {
                    "answer": answer,
                    "items": items,
                    "metadata": {
                        "mode": "browser_fallback",
                        "engine": "bing",
                        "query": query,
                        "search_url": search_url,
                    },
                }
            finally:
                await browser.close()

    async def _extract_bing_results(self, page) -> list[SearchItem]:
        results: list[SearchItem] = []

        cards = await page.query_selector_all("li.b_algo")
        for card in cards[: self.max_results]:
            title_el = await card.query_selector("h2")
            link_el = await card.query_selector("h2 a")
            snippet_el = await card.query_selector(".b_caption p")

            title = (await title_el.inner_text()) if title_el else ""
            url = (await link_el.get_attribute("href")) if link_el else ""
            content = (await snippet_el.inner_text()) if snippet_el else ""

            if title and url:
                results.append(
                    SearchItem(
                        title=title.strip(),
                        content=content.strip(),
                        url=url.strip(),
                    )
                )

        return results

    def _build_answer(self, query: str, items: list[SearchItem]) -> str:
        lines = [f"已通过浏览器兜底搜索获取与“{query}”相关的信息。"]

        for idx, item in enumerate(items, start=1):
            snippet = item.content or "无摘要"
            lines.append(f"{idx}. {item.title} - {snippet}")

        return "\n".join(lines)