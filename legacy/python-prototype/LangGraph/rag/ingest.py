from llama_index.core import Document
from llama_index.core.node_parser import SemanticSplitterNodeParser
from llama_index.embeddings.openai import OpenAIEmbedding

from rag.models import RAGChunk
from rag.service import BaseEmbeddingProvider
from rag.store import QdrantStore


from pathlib import Path
from typing import Any

def load_text_documents_from_dir(
    data_dir: str,
    glob_pattern: str = "**/*.md",
) -> list[Document]:
    documents: list[Document] = []

    for path in Path(data_dir).glob(glob_pattern):
        if not path.is_file():
            continue

        text = path.read_text(encoding="utf-8")
        documents.append(
            Document(
                text=text,
                metadata={
                    "doc_id": path.stem,
                    "title": path.stem,
                    "source": str(path),
                    "file_name": path.name,
                    "extension": path.suffix.lower(),
                },
            )
        )

    return documents

def build_semantic_nodes(
    documents: list[Document],
    breakpoint_percentile_threshold: int = 95,
    buffer_size: int = 1,
) -> list[Any]:
    splitter = SemanticSplitterNodeParser.from_defaults(
        embed_model=OpenAIEmbedding(),
        breakpoint_percentile_threshold=breakpoint_percentile_threshold,
        buffer_size=buffer_size,
        include_metadata=True,
        include_prev_next_rel=True,
    )
    return splitter.get_nodes_from_documents(documents, show_progress=True)

def nodes_to_rag_chunks(nodes: list[Any]) -> list[RAGChunk]:
    chunks: list[RAGChunk] = []

    for idx, node in enumerate(nodes):
        metadata = dict(getattr(node, "metadata", {}) or {})
        doc_id = str(metadata.get("doc_id", f"doc_{idx}"))
        title = str(metadata.get("title", doc_id))
        source = str(metadata.get("source", "unknown"))

        chunks.append(
            RAGChunk(
                doc_id=doc_id,
                chunk_id=idx,
                title=title,
                content=node.get_content(),
                source=source,
                metadata=metadata,
            )
        )

    return chunks

def ingest_chunks(
    store: QdrantStore,
    embedding_provider: BaseEmbeddingProvider,
    chunks: list[RAGChunk],
) -> None:
    texts = [f"{chunk.title}\n{chunk.content}" for chunk in chunks]
    vectors = embedding_provider.embed_texts(texts)
    store.upsert_chunks(chunks, vectors)


def ingest_directory_to_qdrant(
    data_dir: str,
    store: QdrantStore,
    embedding_provider: BaseEmbeddingProvider,
    glob_pattern: str = "**/*.md",
    breakpoint_percentile_threshold: int = 95,
    buffer_size: int = 1,
) -> list[RAGChunk]:
    documents = load_text_documents_from_dir(
        data_dir=data_dir,
        glob_pattern=glob_pattern,
    )

    if not documents:
        return []

    nodes = build_semantic_nodes(
        documents=documents,
        breakpoint_percentile_threshold=breakpoint_percentile_threshold,
        buffer_size=buffer_size,
    )

    chunks = nodes_to_rag_chunks(nodes)
    ingest_chunks(
        store=store,
        embedding_provider=embedding_provider,
        chunks=chunks,
    )
    return chunks