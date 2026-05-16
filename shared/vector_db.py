"""
Vector database service — stores and retrieves text+embedding documents.

Collections
-----------
  rag_syllabuses       — curriculum document chunks (ZIMSEC, Cambridge, etc.)
  rag_grading_examples — teacher-verified grading pairs

Backend: Firestore native vector search via find_nearest().
Requires a vector index per collection — create with:

    python scripts/create_vector_indexes.py

If the index does not exist, find_nearest() raises and RAG degrades gracefully
(grading continues without context — never blocks).

All public functions:
  store_document(collection, doc_id, text, metadata)
  search_similar(collection, query_text, filters, top_k) -> list[dict]
  search_with_user_context(collection, query_text, user_context, top_k) -> list[dict]
  delete_collection(collection)

All functions are synchronous and never raise — errors are logged and
empty results are returned so grading always proceeds.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from shared.embeddings import get_embedding

logger = logging.getLogger(__name__)


# ── Education level normalization ─────────────────────────────────────────────

def map_education_level(level: str) -> str | None:
    """
    Map a specific education level string to the syllabus tier used in indexed
    documents. Returns None for unknown levels (no filter applied).

    Examples:
        "grade_3"    → "primary"
        "form_2"     → "o_level"
        "form_5"     → "a_level"
        "university" → "tertiary"
    """
    if not level:
        return None
    lv = level.lower().strip().replace(" ", "_").replace("-", "_")

    # Primary: grade 1–7 or "primary" itself
    if lv == "primary":
        return "primary"
    if any(lv.startswith(p) for p in ("grade_", "grade")):
        return "primary"

    # O-Level: form 1–4
    if lv in ("form_1", "form_2", "form_3", "form_4",
              "form1", "form2", "form3", "form4"):
        return "o_level"
    if lv in ("o_level", "olevel", "ordinary_level"):
        return "o_level"

    # A-Level: form 5–6
    if lv in ("form_5", "form_6", "form5", "form6",
              "form_5_(a_level)", "form_6_(a_level)"):
        return "a_level"
    if lv in ("a_level", "alevel", "advanced_level"):
        return "a_level"
    if "a_level" in lv or "a-level" in lv:
        return "a_level"

    # Tertiary
    if lv in ("college", "university", "tertiary", "diploma",
              "degree", "college/university"):
        return "tertiary"

    # Form 1-to-4 ranges
    if "form_1_to_4" in lv or "forms_1_4" in lv or "forms14" in lv:
        return "o_level"

    return None

# Firestore collection names
_FS_COLLECTIONS = {
    "syllabuses":       "rag_syllabuses",
    "grading_examples": "rag_grading_examples",
}


def _fs_collection(logical_name: str) -> str:
    """Map logical collection name to Firestore collection name."""
    return _FS_COLLECTIONS.get(logical_name, f"rag_{logical_name}")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Public API ────────────────────────────────────────────────────────────────

def store_document(
    collection: str,
    doc_id: str,
    text: str,
    metadata: Optional[dict] = None,
) -> bool:
    """
    Embed *text* and store in Firestore with the vector.

    metadata should include: country, curriculum, subject, education_level,
    and any other searchable fields.

    Returns True when the document was written, False when the text was empty,
    the embedding failed (e.g. Vertex quota or transient error), or the
    Firestore write itself errored. Existing call sites that don't care about
    success can continue to ignore the return value.
    """
    if not text or not text.strip():
        logger.warning("[vector_db] store_document called with empty text (id=%s)", doc_id)
        return False

    embedding = get_embedding(text)
    if not embedding:
        logger.warning("[vector_db] Embedding failed for doc %s — not stored", doc_id)
        return False

    meta = metadata or {}

    try:
        from shared.firestore_client import get_db  # noqa: PLC0415

        fs_col = _fs_collection(collection)

        try:
            from google.cloud.firestore_v1.vector import Vector  # noqa: PLC0415
            embedding_field = Vector(embedding)
        except ImportError:
            embedding_field = embedding  # plain list fallback

        get_db().collection(fs_col).document(doc_id).set({
            "id":         doc_id,
            "text":       text,
            "embedding":  embedding_field,
            "metadata":   meta,
            "created_at": _now_iso(),
        })
        return True
    except Exception:
        logger.exception("[vector_db] Firestore store failed for doc %s", doc_id)
        return False


def search_similar(
    collection: str,
    query_text: str,
    filters: Optional[dict] = None,
    top_k: int = 5,
) -> list[dict]:
    """
    Find the top_k most similar documents to *query_text*.

    filters: optional dict of metadata equality filters,
             e.g. {"curriculum": "ZIMSEC", "subject": "Mathematics"}

    Returns list of {"text": str, "metadata": dict, "score": float}.
    Returns [] on any error — grading always continues without RAG context.
    """
    if not query_text or not query_text.strip():
        return []

    # Search path: embed with RETRIEVAL_QUERY so the vector lands in the
    # asymmetric "query side" of gemini-embedding-001's retrieval space.
    # Documents in Firestore were embedded with RETRIEVAL_DOCUMENT (the
    # default used by store_document → get_embedding). The mismatch between
    # query-task and doc-task is intentional and required for best cosine
    # similarity per Google's embedding guidance.
    query_embedding = get_embedding(query_text, task_type="RETRIEVAL_QUERY")
    if not query_embedding:
        return []

    return _firestore_search(collection, query_embedding, filters, top_k)


def _firestore_search(
    collection: str,
    query_embedding: list[float],
    filters: Optional[dict],
    top_k: int,
) -> list[dict]:
    try:
        from google.cloud.firestore_v1.base_vector_query import DistanceMeasure  # noqa: PLC0415
        from google.cloud.firestore_v1.vector import Vector  # noqa: PLC0415
        from shared.firestore_client import get_db  # noqa: PLC0415

        fs_col = _fs_collection(collection)
        query = get_db().collection(fs_col).find_nearest(
            vector_field="embedding",
            query_vector=Vector(query_embedding),
            distance_measure=DistanceMeasure.COSINE,
            limit=top_k,
        )
        results = []
        for snap in query.stream():
            d = snap.to_dict()
            meta = d.get("metadata") or {}
            # Apply metadata filters in Python (Firestore vector query can't pre-filter)
            if filters:
                match = True
                for k, v in filters.items():
                    doc_val = meta.get(k, "")
                    if k == "education_level":
                        # Compare normalized tiers (both sides may be raw or mapped)
                        if map_education_level(doc_val) != v and doc_val != v:
                            match = False; break
                    elif k == "subject":
                        # Case-insensitive substring match for subject
                        if v.lower() not in doc_val.lower() and doc_val.lower() not in v.lower():
                            match = False; break
                    else:
                        if doc_val != v:
                            match = False; break
                if not match:
                    continue
            results.append({
                "text":     d.get("text", ""),
                "metadata": meta,
                "score":    0.0,
            })
        return results
    except Exception as exc:
        exc_msg = str(exc).lower()
        if "index" in exc_msg or "find_nearest" in exc_msg:
            logger.warning(
                "[vector_db] Firestore vector index not ready for '%s'. "
                "Run scripts/create_vector_indexes.py to create it.",
                collection,
            )
        else:
            logger.warning(
                "[vector_db] Firestore vector search failed for '%s': %s",
                collection, exc,
            )
        return []


def delete_collection(collection: str) -> None:
    """Delete all documents in *collection* from Firestore."""
    try:
        from shared.firestore_client import get_db  # noqa: PLC0415
        fs_col = _fs_collection(collection)
        db = get_db()
        batch_size = 400
        while True:
            docs = list(db.collection(fs_col).limit(batch_size).stream())
            if not docs:
                break
            batch = db.batch()
            for doc in docs:
                batch.delete(doc.reference)
            batch.commit()
        logger.info("[vector_db] Deleted Firestore collection %s", fs_col)
    except Exception:
        logger.exception("[vector_db] Firestore collection delete failed for %s", collection)


def search_with_user_context(
    collection: str,
    query_text: str,
    user_context: dict,
    top_k: int = 5,
) -> list[dict]:
    """
    Build metadata filters from *user_context* and search.

    Normalizes education_level to syllabus tier (e.g. "form_2" → "o_level")
    so queries match the indexed document metadata.

    If strict filters return no results, retries with just curriculum filter
    to avoid returning nothing when the subject/level combo is too narrow.
    """
    filters: dict[str, str] = {}

    # Curriculum — pass through as-is
    curriculum = user_context.get("curriculum", "")
    if curriculum:
        filters["curriculum"] = curriculum

    # Subject — normalize to lowercase for matching
    subject = user_context.get("subject", "")
    if subject:
        filters["subject"] = subject

    # Education level — map to syllabus tier
    raw_level = user_context.get("education_level", "")
    mapped_level = map_education_level(raw_level)
    if mapped_level:
        filters["education_level"] = mapped_level

    # Try with all filters
    results = search_similar(collection, query_text, filters=filters or None, top_k=top_k)
    if results:
        return results

    # Fallback 1: drop education_level filter (subject match still useful)
    if "education_level" in filters and len(filters) > 1:
        relaxed = {k: v for k, v in filters.items() if k != "education_level"}
        results = search_similar(collection, query_text, filters=relaxed, top_k=top_k)
        if results:
            logger.debug("[vector_db] Relaxed level filter for '%s', got %d results", collection, len(results))
            return results

    # Fallback 2: curriculum only
    if curriculum:
        results = search_similar(collection, query_text, filters={"curriculum": curriculum}, top_k=top_k)
        if results:
            logger.debug("[vector_db] Relaxed to curriculum-only for '%s', got %d results", collection, len(results))
            return results

    # Fallback 3: no filters at all
    return search_similar(collection, query_text, filters=None, top_k=top_k)
