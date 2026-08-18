import asyncio
import logging
import random
import time

from search.models import (
    RetryableSearchError,
    SearchRequest,
    SearchResponse,
)
from search.router import SearchRouter

"""统一处理超时、重试、provider fallback、日志"""
logger = logging.getLogger(__name__)

class SearchService:
    def __init__(
        self,
        router: SearchRouter,
        per_provider_timeout: float = 8.0,
        max_retries: int = 2,
        base_backoff: float = 0.8,
    ) -> None:
        self.router = router
        self.per_provider_timeout = per_provider_timeout
        self.max_retries = max_retries
        self.base_backoff = base_backoff

    async def search(self, request: SearchRequest) -> SearchResponse:
        providers = self.router.route(request)
        last_error = None

        for provider in providers:
                    
            try:
                response = await self._call_provider_with_retry(provider, request)
                self._log_success(request, response)
                return response
            except Exception as exc:
                last_error = exc
                self._log_failure(request, provider.name, exc)
                continue
        
        return SearchResponse(
            success=False,
            provider="none",
            error=f"所有搜索提供方均失败: {last_error}",
            metadata={"trace_id": request.trace_id},
        )
    
    ## 重试
    async def _call_provider_with_retry(self, provider, request: SearchRequest) -> SearchResponse:
        last_exc = None

        for attempt in range(self.max_retries + 1):
            try:
                start = time.perf_counter()

                response = await asyncio.wait_for(
                    provider.search(request),
                    timeout=self.per_provider_timeout,
                )

                response.retry_count = attempt
                if response.latency_ms == 0:
                    response.latency_ms = int((time.perf_counter() - start) * 1000)

                return response

            except asyncio.TimeoutError as exc:
                last_exc = RetryableSearchError(
                    f"{provider.name} 超时，超过 {self.per_provider_timeout} 秒"
                )
            except RetryableSearchError as exc:
                last_exc = exc
            except Exception as exc:
                raise exc

            if attempt < self.max_retries:
                await asyncio.sleep(self._backoff(attempt))

        raise last_exc

    def _backoff(self, attempt: int) -> float:
        jitter = random.uniform(0, 0.3)
        return self.base_backoff * (2 ** attempt) + jitter
    
    ## 日志
    def _log_success(self, request: SearchRequest, response: SearchResponse) -> None:
        logger.info(
            "search_success trace_id=%s provider=%s query=%s latency_ms=%s retry_count=%s",
            request.trace_id,
            response.provider,
            request.query,
            response.latency_ms,
            response.retry_count,
        )

    def _log_failure(self, request: SearchRequest, provider_name: str, exc: Exception) -> None:
        logger.warning(
            "search_failure trace_id=%s provider=%s query=%s error=%s",
            request.trace_id,
            provider_name,
            request.query,
            exc,
        )