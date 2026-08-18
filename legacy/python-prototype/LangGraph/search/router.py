from search.models import SearchRequest
from search.providers.base import BaseSearchProvider

"""决定 provider 执行顺序"""

class SearchRouter:
    def __init__(
        self,
        tavily_provider: BaseSearchProvider,
        playwright_provider: BaseSearchProvider,
    ) -> None:
        self.tavily_provider = tavily_provider
        self.playwright_provider = playwright_provider

    def route(self, request: SearchRequest) -> list[BaseSearchProvider]:
        query = request.query.lower()

        site_specific_markers = ["官网", "site:", "文档", "github", "论文", "官方"]

        if any(marker in query for marker in site_specific_markers):
            return [self.tavily_provider, self.playwright_provider]

        if request.policy == "browser_first":
            return [self.playwright_provider]

        return [self.tavily_provider, self.playwright_provider]