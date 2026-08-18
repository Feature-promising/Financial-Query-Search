from __future__ import annotations

from typing import Any

from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance,
    FieldCondition,
    Filter,
    MatchValue,
    PointStruct,
    VectorParams,
)

from rag.models import RAGChunk


class QdrantStore:
    def __init__(
        self,
        collection_name: str,
        embedding_dim: int,
        host: str = "localhost",
        port: int = 6333,
    ) -> None:
        self.collection_name = collection_name
        self.embedding_dim = embedding_dim
        self.client = QdrantClient(host=host, port=port)

    def ensure_collection(self) -> None:
        existing = [c.name for c in self.client.get_collections().collections]
        if self.collection_name in existing:
            return

        self.client.create_collection(
            collection_name=self.collection_name,
            vectors_config=VectorParams(
                size=self.embedding_dim,
                distance=Distance.COSINE,
            ),
        )

    def upsert_chunks(self, chunks: list[RAGChunk], vectors: list[list[float]]) -> None:
        points: list[PointStruct] = []
        for chunk, vector in zip(chunks, vectors):
            points.append(
                PointStruct(
                    id=f"{chunk.doc_id}_{chunk.chunk_id}",
                    vector=vector,
                    payload={
                        "doc_id": chunk.doc_id,
                        "chunk_id": chunk.chunk_id,
                        "title": chunk.title,
                        "content": chunk.content,
                        "source": chunk.source,
                        **chunk.metadata,
                    },
                )
            )

        self.client.upsert(
            collection_name=self.collection_name,
            points=points,
        )

    def search(
        self,
        query_vector: list[float],
        top_k: int = 4,
        filters: dict[str, Any] | None = None,
    ) -> list[RAGChunk]:
        qdrant_filter = self._build_filter(filters or {})

        results = self.client.search(
            collection_name=self.collection_name,
            query_vector=query_vector,
            query_filter=qdrant_filter,
            limit=top_k,
        )

        documents: list[RAGChunk] = []
        for item in results:
            payload = item.payload or {}
            documents.append(
                RAGChunk(
                    doc_id=str(payload.get("doc_id", "")),
                    chunk_id=int(payload.get("chunk_id", 0)),
                    title=str(payload.get("title", "")),
                    content=str(payload.get("content", "")),
                    source=str(payload.get("source", "")),
                    metadata=dict(payload),
                )
            )
        return documents

    def _build_filter(self, filters: dict[str, Any]) -> Filter | None:
        conditions: list[FieldCondition] = []
        for key, value in filters.items():
            if value in (None, "", "unknown"):
                continue
            conditions.append(
                FieldCondition(
                    key=key,
                    match=MatchValue(value=value),
                )
            )

        if not conditions:
            return None

        return Filter(must=conditions)
