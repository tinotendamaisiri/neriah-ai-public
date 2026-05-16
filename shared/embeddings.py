"""
Text embedding wrapper.

Production (non-demo):
    Vertex AI gemini-embedding-001 — 768-dimensional embeddings
    (truncated from the native 3072 via output_dimensionality; the model
    uses Matryoshka Representation Learning so 768 preserves retrieval
    quality while keeping the Firestore vector-index schema at 768 dims).
    Uses the google-genai SDK with Vertex backend.

Demo (NERIAH_ENV=demo):
    sentence-transformers all-MiniLM-L6-v2 — 384-dimensional embeddings.
    Runs on CPU, no external service required.
    Model is ~80 MB and is downloaded once then cached to ~/.cache/torch/.

Task type:
    Callers indexing a corpus should use task_type="RETRIEVAL_DOCUMENT"
    (default). Callers embedding a real-time search query should pass
    task_type="RETRIEVAL_QUERY" — the asymmetric usage is required for
    best retrieval quality per Google's guidance on gemini-embedding-001.
    The demo sentence-transformers backend ignores task_type.

Usage:
    from shared.embeddings import get_embedding, embedding_dim

Both functions never raise — return [] / 0 on error.
"""

from __future__ import annotations

import logging
import os
from functools import lru_cache

from shared.config import is_demo

logger = logging.getLogger(__name__)

EMBEDDING_MODEL      = "gemini-embedding-001"
VERTEX_EMBEDDING_DIM = 768
LOCAL_EMBEDDING_DIM  = 384


def _use_vertex() -> bool:
    """True in production (non-demo). Demo uses local sentence-transformers."""
    return not is_demo()


@lru_cache(maxsize=1)
def _genai_client():
    """Build the google.genai client once per process. Client init includes
    credential resolution + JWT refresh — expensive; cache aggressively."""
    from google import genai  # noqa: PLC0415
    return genai.Client(
        vertexai=True,
        project=os.environ.get("GCP_PROJECT_ID"),
        location=os.environ.get("GCP_REGION", "us-central1"),
    )


@lru_cache(maxsize=1)
def _local_model():
    """Load sentence-transformers model once. Import is deferred to avoid adding
    ~200 ms of import overhead when the model is not needed."""
    from sentence_transformers import SentenceTransformer  # noqa: PLC0415
    logger.info("[embeddings] Loading sentence-transformers all-MiniLM-L6-v2")
    return SentenceTransformer("all-MiniLM-L6-v2")


def get_embedding(text: str, task_type: str = "RETRIEVAL_DOCUMENT") -> list[float]:
    """
    Generate an embedding vector for *text*.

    Args:
        text:      text to embed. Whitespace-only strings return [].
        task_type: Vertex gemini-embedding-001 task hint. Defaults to
                   RETRIEVAL_DOCUMENT (indexing); pass RETRIEVAL_QUERY when
                   embedding a real-time search query. Ignored by the demo
                   sentence-transformers backend.

    Returns a list[float]:
      - 768 floats in production (gemini-embedding-001 truncated to 768)
      - 384 floats in demo mode (sentence-transformers all-MiniLM-L6-v2)

    Returns [] on any failure — callers must handle this gracefully and not
    store a document or query the vector DB when the embedding is empty.
    """
    if not text or not text.strip():
        return []
    try:
        if _use_vertex():
            return _vertex_embed(text.strip(), task_type=task_type)
        return _local_embed(text.strip())
    except Exception:
        logger.exception("[embeddings] get_embedding failed for text: %.80s", text)
        return []


def embedding_dim() -> int:
    """Return the expected embedding dimension for the current backend."""
    return VERTEX_EMBEDDING_DIM if _use_vertex() else LOCAL_EMBEDDING_DIM


# ── Backend implementations ───────────────────────────────────────────────────

def _vertex_embed(text: str, task_type: str = "RETRIEVAL_DOCUMENT") -> list[float]:
    """Hit gemini-embedding-001 via google-genai with Vertex backend.

    Passes contents as a bare str (not list[str]) — list-form routes through a
    batch path that hangs for single-item requests on this model + region.
    """
    from google.genai import types  # noqa: PLC0415

    client = _genai_client()
    resp = client.models.embed_content(
        model=EMBEDDING_MODEL,
        contents=text,
        config=types.EmbedContentConfig(
            task_type=task_type,
            output_dimensionality=VERTEX_EMBEDDING_DIM,
        ),
    )
    return list(resp.embeddings[0].values)


def _local_embed(text: str) -> list[float]:
    return _local_model().encode(text, show_progress_bar=False).tolist()
