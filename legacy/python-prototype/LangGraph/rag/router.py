from rag.models import RAGRequest


class RAGRouter:
    def build_filters(
        self,
        market: str = "unknown",
        entity: str = "unknown",
        region: str = "unknown",
    ) -> dict:
        filters = {}
        if market != "unknown":
            filters["market"] = market
        if entity != "unknown":
            filters["entity"] = entity
        if region != "unknown":
            filters["region"] = region
        return filters

    def route(self, request: RAGRequest) -> dict:
        return {
            "top_k": request.top_k,
            "filters": request.filters,
        }