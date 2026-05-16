from abc import ABC, abstractmethod
from search.models import SearchRequest, SearchResponse


"""定义 provider 接口，所有搜索源都按这个协议实现"""

class BaseSearchProvider(ABC):
    name: str = "base"

    @abstractmethod
    async def search(self, request: SearchRequest) -> SearchResponse:
        raise NotImplementedError