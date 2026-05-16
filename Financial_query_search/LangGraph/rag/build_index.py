from llama_index.embeddings.dashscope import DashScopeEmbedding

from rag.ingest import ingest_directory_to_qdrant
from rag.service import LlamaIndexEmbeddingProvider
from rag.store import QdrantStore

import os

def main():
    data_dir = r"C:\你的金融知识库目录"

    rag_embed_model = DashScopeEmbedding(
        model_name="text-embedding-v4",
        api_key=os.getenv("DASHSCOPE_API_KEY"),
    )
    rag_embedding_provider = LlamaIndexEmbeddingProvider(embed_model=rag_embed_model)

    rag_store = QdrantStore(
        collection_name="agent_memory",
        embedding_dim=3072,
        host="localhost",
        port=6333,
    )
    rag_store.ensure_collection()

    chunks = ingest_directory_to_qdrant(
        data_dir=data_dir,
        store=rag_store,
        embedding_provider=rag_embedding_provider,
        glob_pattern="**/*.md",
        default_metadata={
            "category": "financial_knowledge",
            "market": "unknown",
            "region": "unknown",
        },
        breakpoint_percentile_threshold=95,
        buffer_size=1,
    )

    print(f"建库完成，入库 chunk 数量: {len(chunks)}")


if __name__ == "__main__":
    main()
