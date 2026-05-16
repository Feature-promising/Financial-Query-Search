from __future__ import annotations

from llama_index.core.base.embeddings.base import BaseEmbedding

from rag.models import RAGRequest, RAGResponse
from rag.store import QdrantStore


class LlamaIndexEmbeddingProvider:
    """Wrap one LlamaIndex embedding model for chunking and vector retrieval."""

    def __init__(self, embed_model: BaseEmbedding) -> None:
        self.embed_model = embed_model

    def embed_query(self, text: str) -> list[float]:
        return self.embed_model.get_query_embedding(text)

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        return [self.embed_model.get_text_embedding(text) for text in texts]


class RAGService:
    def __init__(
        self,
        store: QdrantStore,
        embedding_provider: LlamaIndexEmbeddingProvider,
    ) -> None:
        self.store = store
        self.embedding_provider = embedding_provider

    def retrieve(self, request: RAGRequest) -> RAGResponse:
        if not request.query.strip():
            return RAGResponse(success=False, error="query ??")

        try:
            query_vector = self.embedding_provider.embed_query(request.query)
            docs = self.store.search(
                query_vector=query_vector,
                top_k=request.top_k,
                filters=request.filters,
            )
        except Exception as exc:
            return RAGResponse(success=False, error=f"RAG ????: {exc}")

        if not docs:
            return RAGResponse(success=False, error="???????")

        return RAGResponse(
            success=True,
            answer_context="\n\n".join(doc.content for doc in docs),
            documents=docs,
            metadata={"hit_count": len(docs)},
        )
