"""
Curriculum / syllabus management endpoints.

POST   /api/curriculum/upload         — upload a syllabus PDF/DOCX/TXT, chunk + embed
GET    /api/curriculum/list           — list uploaded syllabuses (filterable)
GET    /api/curriculum/<id>           — get syllabus details
DELETE /api/curriculum/<id>           — delete syllabus + its vector DB chunks
POST   /api/curriculum/<id>/reindex   — re-embed all chunks (use after changing models)

Auth: teacher JWT for read + upload.
      List, upload, DELETE, and reindex additionally accept a Bearer
      ADMIN_API_KEY for admin use (drives the /admin/curriculum web page).
"""

from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timezone

from flask import Blueprint, jsonify, request

from shared.auth import require_role
from shared.config import settings
from shared.firestore_client import delete_doc, get_doc, query, upsert
from shared.observability import instrument_route
from shared.vector_db import delete_collection, search_similar, store_document

logger = logging.getLogger(__name__)
curriculum_bp = Blueprint("curriculum", __name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Curriculum + level picker options (per teacher's country) ────────────────

@curriculum_bp.get("/curriculum/options")
@instrument_route("curriculum.options", "curriculum")
def curriculum_options():
    """
    Return the curriculum + level picker config for the calling teacher.

    Country is resolved from the teacher's phone number / school document
    via shared.user_context. Mobile teacher UI calls this on mount to
    populate the curriculum and level pills, so a Zimbabwe teacher sees
    ZIMSEC by default while a Kenya teacher sees KNEC (CBC) — without
    either of them seeing the other's options.

    Auth: teacher JWT.
    """
    teacher_id, err = require_role(request, "teacher")
    if err:
        return jsonify({"error": err}), 401

    from shared.country_profile import picker_options  # noqa: PLC0415
    from shared.user_context import detect_country_from_phone  # noqa: PLC0415

    teacher = get_doc("teachers", teacher_id) or {}
    school = get_doc("schools", teacher.get("school_id") or "") or {}
    # School document is authoritative; fall back to phone country detection.
    country = school.get("country") or detect_country_from_phone(teacher.get("phone", ""))
    if not country or country == "Unknown":
        country = None  # → Pan-African default

    return jsonify(picker_options(country)), 200


# ── Text extraction ────────────────────────────────────────────────────────────

def _extract_text(file_bytes: bytes, filename: str) -> str:
    """Extract plain text from PDF, DOCX, or TXT bytes. Returns empty string on failure."""
    name_lower = filename.lower()
    try:
        if name_lower.endswith(".pdf"):
            return _extract_pdf(file_bytes)
        if name_lower.endswith(".docx"):
            return _extract_docx(file_bytes)
        # Plain text / TXT
        return file_bytes.decode("utf-8", errors="replace")
    except Exception:
        logger.exception("[curriculum] Text extraction failed for %s", filename)
        return ""


def _extract_pdf(data: bytes) -> str:
    import io  # noqa: PLC0415
    import pdfplumber  # noqa: PLC0415
    pages: list[str] = []
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        for page in pdf.pages:
            text = page.extract_text()
            if text:
                pages.append(text)
    return "\n\n".join(pages)


def _extract_docx(data: bytes) -> str:
    import io  # noqa: PLC0415
    from docx import Document  # noqa: PLC0415
    doc = Document(io.BytesIO(data))
    return "\n\n".join(p.text for p in doc.paragraphs if p.text.strip())


# ── Text chunking ──────────────────────────────────────────────────────────────

def _chunk_text(text: str, max_words: int = 500) -> list[str]:
    """
    Split *text* into chunks of at most *max_words* words.

    Splits on double newlines (paragraphs / section breaks) first, then
    merges small paragraphs together until the word limit is reached.
    Preserves section boundaries — never splits mid-paragraph.
    """
    paragraphs = re.split(r"\n\s*\n", text.strip())
    chunks: list[str] = []
    current: list[str] = []
    current_words = 0

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        words = para.split()
        if current_words + len(words) > max_words and current:
            chunks.append("\n\n".join(current))
            current = [para]
            current_words = len(words)
        else:
            current.append(para)
            current_words += len(words)

    if current:
        chunks.append("\n\n".join(current))

    return [c for c in chunks if c.strip()]


# ── Auth helpers ───────────────────────────────────────────────────────────────

def _admin_auth() -> bool:
    """Return True if request has a valid ADMIN_API_KEY Bearer token."""
    key = settings.ADMIN_API_KEY
    if not key:
        return False
    auth = request.headers.get("Authorization", "")
    return auth == f"Bearer {key}"


def _require_teacher_or_admin():
    """
    Allow if (a) valid teacher JWT, or (b) ADMIN_API_KEY Bearer token.
    Returns (teacher_id_or_None, error_response_or_None).
    """
    if _admin_auth():
        return "admin", None
    teacher_id, err = require_role(request, "teacher")
    if err:
        return None, (jsonify({"error": err}), 401)
    return teacher_id, None


# ── POST /api/curriculum/upload ───────────────────────────────────────────────

@curriculum_bp.post("/curriculum/upload")
@instrument_route("curriculum.upload", "curriculum")
def upload_syllabus():
    """
    Upload a syllabus document. Chunks, embeds, and stores in the vector DB.

    Expects multipart/form-data:
      file          — required — PDF, DOCX, or TXT
      country       — required — e.g. "Zimbabwe"
      curriculum    — required — e.g. "ZIMSEC"
      subject       — required — e.g. "Mathematics"
      education_level — required — e.g. "form_2" or "all"
      year          — optional — syllabus version year e.g. "2026"
    """
    teacher_id, err_resp = _require_teacher_or_admin()
    if err_resp:
        return err_resp

    uploaded_file = request.files.get("file")
    if not uploaded_file:
        return jsonify({"error": "file is required"}), 400

    country       = (request.form.get("country") or "").strip()
    curriculum    = (request.form.get("curriculum") or "").strip()
    subject       = (request.form.get("subject") or "").strip()
    edu_level     = (request.form.get("education_level") or "").strip()
    year          = (request.form.get("year") or "").strip()

    if not all([country, curriculum, subject, edu_level]):
        return jsonify({"error": "country, curriculum, subject, education_level are required"}), 400

    # Sanitize all user-supplied path components to prevent path traversal.
    def _safe_path(s: str) -> str:
        return re.sub(r"[^a-zA-Z0-9_\-]", "_", s)[:64]

    country    = _safe_path(country)
    curriculum = _safe_path(curriculum)
    subject    = _safe_path(subject)
    raw_filename = uploaded_file.filename or "syllabus.pdf"
    filename = _safe_path(raw_filename.rsplit(".", 1)[0]) + (
        "." + raw_filename.rsplit(".", 1)[1].lower() if "." in raw_filename else ""
    )
    file_bytes = uploaded_file.read()

    if len(file_bytes) > 20 * 1024 * 1024:  # 20 MB limit
        return jsonify({"error": "File too large (max 20 MB)"}), 413

    # ── 1. Extract text ───────────────────────────────────────────────────────
    text = _extract_text(file_bytes, filename)
    if not text.strip():
        return jsonify({"error": "Could not extract text from file"}), 422

    # ── 2. Chunk ──────────────────────────────────────────────────────────────
    chunks = _chunk_text(text)
    if not chunks:
        return jsonify({"error": "No text content found in file"}), 422

    # ── 3. Generate a syllabus ID ─────────────────────────────────────────────
    syllabus_id = str(uuid.uuid4())

    # ── 4. Embed + store chunks in vector DB ──────────────────────────────────
    chunk_meta_base = {
        "country":         country,
        "curriculum":      curriculum,
        "subject":         subject,
        "education_level": edu_level,
        "year":            year,
        "syllabus_id":     syllabus_id,
        "doc_type":        "syllabus",
    }
    stored = 0
    for i, chunk_text in enumerate(chunks):
        chunk_id = f"{syllabus_id}-chunk-{i}"
        header = (
            f"[{curriculum} {subject} {edu_level}]\n"
            f"Country: {country}\n\n"
        )
        store_document(
            "syllabuses",
            chunk_id,
            header + chunk_text,
            {**chunk_meta_base, "chunk_index": i, "source_filename": filename},
        )
        stored += 1

    # ── 5. Store original file in GCS ─────────────────────────────────────────
    gcs_path = ""
    try:
        from shared.gcs_client import upload_bytes  # noqa: PLC0415
        bucket = settings.GCS_BUCKET_SYLLABUSES or settings.GCS_BUCKET_SUBMISSIONS
        blob_path = f"syllabuses/{country}/{curriculum}/{subject}/{syllabus_id}/{filename}"
        gcs_path = upload_bytes(bucket, blob_path, file_bytes,
                                content_type=uploaded_file.content_type or "application/octet-stream",
                                public=False)
    except Exception:
        logger.exception("[curriculum] GCS upload failed for syllabus %s", syllabus_id)
        # Non-fatal — vector DB was already populated

    # ── 6. Firestore metadata record ──────────────────────────────────────────
    now = _now_iso()
    syllabus_doc = {
        "id":              syllabus_id,
        "country":         country,
        "curriculum":      curriculum,
        "subject":         subject,
        "education_level": edu_level,
        "year":            year,
        "filename":        filename,
        "gcs_path":        gcs_path,
        "chunk_count":     stored,
        "uploaded_at":     now,
        "uploaded_by":     teacher_id,
    }
    upsert("syllabuses", syllabus_id, syllabus_doc)

    return jsonify({
        "status":      "uploaded",
        "syllabus_id": syllabus_id,
        "chunks":      stored,
        "subject":     subject,
        "curriculum":  curriculum,
    }), 201


# ── POST /api/curriculum/auto-upload ──────────────────────────────────────────
#
# Admin-only bulk-friendly upload. Accepts a single file with NO metadata,
# uses Gemma 4 to extract {country, curriculum, subject, education_level,
# year, title} from the document text, then runs the same chunk + embed +
# GCS + Firestore pipeline as /upload. The web /admin/curriculum page
# calls this once per file when the admin uses the bulk picker, so each
# file gets its own auto-extracted metadata. The manual /upload route is
# unchanged for the existing single-file form.

_METADATA_PROMPT = (
    "You are reading the first pages of an education-syllabus document.\n"
    "Return ONLY a JSON object (no markdown fences, no commentary):\n"
    '{"country": "...", "curriculum": "...", "subject": "...", '
    '"education_level": "...", "year": "..." or "", "title": "..."}\n'
    "Rules:\n"
    "- country: real country name (e.g. Zimbabwe, Kenya, South Africa). "
    "Use the issuing body / exam board / ministry to decide.\n"
    "- curriculum: exam-board or framework name. Examples: ZIMSEC, "
    "Cambridge International, IB, KNEC, WAEC, NECTA, Ministry of Education. "
    "If multiple are mentioned, pick the dominant one on the cover page.\n"
    "- subject: e.g. Mathematics, English Language, Biology, History, "
    "Combined Science. Use the canonical syllabus name on the document.\n"
    "- education_level: pick from {form_1, form_2, form_3, form_4, "
    "a_level, grade_1, grade_2, grade_3, grade_4, grade_5, grade_6, "
    "grade_7, primary, secondary, tertiary, all}. Use \"all\" when the "
    "syllabus spans multiple levels in one document.\n"
    "- year: 4-digit syllabus version year if printed (e.g. 2024); "
    "empty string if not stated.\n"
    "- title: official syllabus name on the cover page.\n"
    "Do not invent fields. Prefer the most likely real value over null.\n"
)


def _gemma_extract_syllabus_metadata(text: str) -> dict:
    """Ask Gemma to identify syllabus metadata. Missing fields come back
    as empty strings; the caller decides whether to reject the upload."""
    from shared.gemma_client import _generate, _parse_json  # noqa: PLC0415
    truncated = (text or "")[:8000]  # cover + a few intro pages is enough
    if not truncated.strip():
        return {}
    prompt = f"{_METADATA_PROMPT}\n\nDocument text:\n{truncated}"
    try:
        raw = _generate(prompt, complexity="complex")
        parsed = _parse_json(raw, {})
        if not isinstance(parsed, dict):
            return {}
        return {
            "country":         (parsed.get("country") or "").strip(),
            "curriculum":      (parsed.get("curriculum") or "").strip(),
            "subject":         (parsed.get("subject") or "").strip(),
            "education_level": (parsed.get("education_level") or "").strip().lower(),
            "year":            (parsed.get("year") or "").strip(),
            "title":           (parsed.get("title") or "").strip(),
        }
    except Exception:
        logger.exception("[curriculum] _gemma_extract_syllabus_metadata failed")
        return {}


def _safe_path_component(s: str) -> str:
    """Sanitize a single path component for the GCS blob path. Mirrors
    the inline _safe_path closure in upload_syllabus()."""
    return re.sub(r"[^a-zA-Z0-9_\-]", "_", s)[:64]


@curriculum_bp.post("/curriculum/auto-upload")
@instrument_route("curriculum.auto_upload", "curriculum")
def auto_upload_syllabus():
    """Admin bulk-friendly upload — server extracts metadata via Gemma."""
    if not _admin_auth():
        return jsonify({"error": "admin required"}), 401

    uploaded_file = request.files.get("file")
    if not uploaded_file:
        return jsonify({"error": "file is required"}), 400

    raw_filename = uploaded_file.filename or "syllabus.pdf"
    file_bytes = uploaded_file.read()

    if len(file_bytes) > 20 * 1024 * 1024:
        return jsonify({"error": "File too large (max 20 MB)"}), 413

    # 1. Extract text
    text = _extract_text(file_bytes, raw_filename)
    if not text.strip():
        return jsonify({"error": "Could not extract text from file"}), 422

    # 2. Gemma metadata extraction
    meta = _gemma_extract_syllabus_metadata(text)
    country    = meta.get("country") or ""
    curriculum = meta.get("curriculum") or ""
    subject    = meta.get("subject") or ""
    edu_level  = meta.get("education_level") or "all"
    year       = meta.get("year") or ""

    if not (country and curriculum and subject):
        return jsonify({
            "error": "Could not auto-extract metadata. Try the manual upload form.",
            "extracted": meta,
            "filename": raw_filename,
        }), 422

    # 3. Sanitize for path components
    country_s    = _safe_path_component(country)
    curriculum_s = _safe_path_component(curriculum)
    subject_s    = _safe_path_component(subject)
    filename = _safe_path_component(raw_filename.rsplit(".", 1)[0]) + (
        "." + raw_filename.rsplit(".", 1)[1].lower() if "." in raw_filename else ""
    )

    # 4. Chunk
    chunks = _chunk_text(text)
    if not chunks:
        return jsonify({"error": "No text content found in file"}), 422

    # 5. Embed + store chunks
    syllabus_id = str(uuid.uuid4())
    chunk_meta_base = {
        "country":         country_s,
        "curriculum":      curriculum_s,
        "subject":         subject_s,
        "education_level": edu_level,
        "year":            year,
        "syllabus_id":     syllabus_id,
        "doc_type":        "syllabus",
    }
    stored = 0
    for i, chunk_text in enumerate(chunks):
        chunk_id = f"{syllabus_id}-chunk-{i}"
        header = (
            f"[{curriculum_s} {subject_s} {edu_level}]\n"
            f"Country: {country_s}\n\n"
        )
        store_document(
            "syllabuses",
            chunk_id,
            header + chunk_text,
            {**chunk_meta_base, "chunk_index": i, "source_filename": filename},
        )
        stored += 1

    # 6. Store original in GCS
    gcs_path = ""
    try:
        from shared.gcs_client import upload_bytes  # noqa: PLC0415
        bucket = settings.GCS_BUCKET_SYLLABUSES or settings.GCS_BUCKET_SUBMISSIONS
        blob_path = f"syllabuses/{country_s}/{curriculum_s}/{subject_s}/{syllabus_id}/{filename}"
        gcs_path = upload_bytes(
            bucket, blob_path, file_bytes,
            content_type=uploaded_file.content_type or "application/octet-stream",
            public=False,
        )
    except Exception:
        logger.exception("[curriculum] GCS upload failed for syllabus %s", syllabus_id)

    # 7. Firestore metadata
    syllabus_doc = {
        "id":              syllabus_id,
        "country":         country_s,
        "curriculum":      curriculum_s,
        "subject":         subject_s,
        "education_level": edu_level,
        "year":            year,
        "title":           meta.get("title") or "",
        "filename":        filename,
        "gcs_path":        gcs_path,
        "chunk_count":     stored,
        "uploaded_at":     _now_iso(),
        "uploaded_by":     "admin",
        "auto_extracted":  True,
    }
    upsert("syllabuses", syllabus_id, syllabus_doc)

    return jsonify({
        "status":          "uploaded",
        "syllabus_id":     syllabus_id,
        "chunks":          stored,
        "country":         country,
        "curriculum":      curriculum,
        "subject":         subject,
        "education_level": edu_level,
        "year":            year,
        "title":           meta.get("title") or "",
        "filename":        raw_filename,
        "auto_extracted":  True,
    }), 201


# ── GET /api/curriculum/list ──────────────────────────────────────────────────

@curriculum_bp.get("/curriculum/list")
@instrument_route("curriculum.list", "curriculum")
def list_syllabuses():
    """
    List uploaded syllabuses.

    Query params (all optional):
      country    — filter by country
      curriculum — filter by curriculum
      subject    — filter by subject

    Auth: teacher JWT or ADMIN_API_KEY bearer (the /admin/curriculum web
    page proxies admin-bearer'd requests here to populate its table).
    The handler returns the same view either way — no per-uploader
    scoping happens at this endpoint.
    """
    _, err_resp = _require_teacher_or_admin()
    if err_resp:
        return err_resp

    filters: list[tuple] = []
    if c := request.args.get("country"):
        filters.append(("country", "==", c))
    if c := request.args.get("curriculum"):
        filters.append(("curriculum", "==", c))
    if s := request.args.get("subject"):
        filters.append(("subject", "==", s))

    syllabuses = query(
        "syllabuses",
        filters,
        order_by="uploaded_at",
        direction="DESCENDING",
    )

    # Strip gcs_path from public response
    for s in syllabuses:
        s.pop("gcs_path", None)

    return jsonify(syllabuses), 200


# ── GET /api/curriculum/<id> ──────────────────────────────────────────────────

@curriculum_bp.get("/curriculum/<syllabus_id>")
@instrument_route("curriculum.get", "curriculum")
def get_syllabus(syllabus_id: str):
    teacher_id, err = require_role(request, "teacher")
    if err:
        return jsonify({"error": err}), 401

    doc = get_doc("syllabuses", syllabus_id)
    if not doc:
        return jsonify({"error": "Syllabus not found"}), 404

    doc.pop("gcs_path", None)
    return jsonify(doc), 200


# ── DELETE /api/curriculum/<id> ────────────────────────────────────────────────

@curriculum_bp.delete("/curriculum/<syllabus_id>")
@instrument_route("curriculum.delete", "curriculum")
def delete_syllabus(syllabus_id: str):
    uploader, err_resp = _require_teacher_or_admin()
    if err_resp:
        return err_resp

    doc = get_doc("syllabuses", syllabus_id)
    if not doc:
        return jsonify({"error": "Syllabus not found"}), 404

    # Non-admin teachers can only delete their own uploads
    if uploader != "admin" and doc.get("uploaded_by") != uploader:
        return jsonify({"error": "forbidden"}), 403

    chunk_count = doc.get("chunk_count", 0)

    # Delete vector DB chunks (each stored as {syllabus_id}-chunk-{i})
    for i in range(chunk_count):
        chunk_id = f"{syllabus_id}-chunk-{i}"
        try:
            from shared.firestore_client import delete_doc as fs_delete  # noqa: PLC0415
            from shared.vector_db import _fs_collection  # noqa: PLC0415
            fs_delete(_fs_collection("syllabuses"), chunk_id)
        except Exception:
            logger.warning("[curriculum] Could not delete chunk %s", chunk_id)

    # Remove from ChromaDB cache if present
    try:
        from shared.vector_db import _chroma, _use_firestore_vectors  # noqa: PLC0415
        if not _use_firestore_vectors():
            col = _chroma.get_collection("syllabuses")
            ids = [f"{syllabus_id}-chunk-{i}" for i in range(chunk_count)]
            col.delete(ids=ids)
    except Exception:
        pass

    # Delete Firestore metadata record
    delete_doc("syllabuses", syllabus_id)

    # Delete GCS file (best-effort)
    gcs_path = doc.get("gcs_path", "")
    if gcs_path:
        try:
            from shared.gcs_client import get_client  # noqa: PLC0415
            bucket_name = settings.GCS_BUCKET_SYLLABUSES or settings.GCS_BUCKET_SUBMISSIONS
            blob_path = gcs_path.split(f"/{bucket_name}/", 1)[-1] if bucket_name in gcs_path else ""
            if blob_path:
                get_client().bucket(bucket_name).blob(blob_path).delete()
        except Exception:
            logger.warning("[curriculum] GCS delete failed for syllabus %s", syllabus_id)

    return jsonify({"message": "deleted", "syllabus_id": syllabus_id}), 200


# ── POST /api/curriculum/<id>/reindex ─────────────────────────────────────────

@curriculum_bp.post("/curriculum/<syllabus_id>/reindex")
@instrument_route("curriculum.reindex", "curriculum")
def reindex_syllabus(syllabus_id: str):
    """
    Re-embed all chunks for a syllabus.
    Useful after switching embedding models (e.g. local → Vertex AI).
    Re-downloads the file from GCS and re-processes it.
    """
    uploader, err_resp = _require_teacher_or_admin()
    if err_resp:
        return err_resp

    doc = get_doc("syllabuses", syllabus_id)
    if not doc:
        return jsonify({"error": "Syllabus not found"}), 404

    if uploader != "admin" and doc.get("uploaded_by") != uploader:
        return jsonify({"error": "forbidden"}), 403

    gcs_path = doc.get("gcs_path", "")
    if not gcs_path:
        return jsonify({"error": "Original file not found in GCS — cannot reindex"}), 422

    # Download from GCS
    try:
        from shared.gcs_client import get_client  # noqa: PLC0415
        bucket_name = settings.GCS_BUCKET_SYLLABUSES or settings.GCS_BUCKET_SUBMISSIONS
        blob_path = gcs_path.split(f"/{bucket_name}/", 1)[-1] if bucket_name in gcs_path else gcs_path
        blob = get_client().bucket(bucket_name).blob(blob_path)
        file_bytes = blob.download_as_bytes()
    except Exception:
        logger.exception("[curriculum] GCS download failed for reindex of %s", syllabus_id)
        return jsonify({"error": "Could not download original file from GCS"}), 500

    # Re-extract and re-chunk
    text = _extract_text(file_bytes, doc.get("filename", "syllabus.pdf"))
    if not text.strip():
        return jsonify({"error": "Could not extract text from file"}), 422

    chunks = _chunk_text(text)

    country    = doc.get("country", "")
    curriculum = doc.get("curriculum", "")
    subject    = doc.get("subject", "")
    edu_level  = doc.get("education_level", "")
    year       = doc.get("year", "")
    filename   = doc.get("filename", "")

    chunk_meta_base = {
        "country":         country,
        "curriculum":      curriculum,
        "subject":         subject,
        "education_level": edu_level,
        "year":            year,
        "syllabus_id":     syllabus_id,
        "doc_type":        "syllabus",
    }

    stored = 0
    for i, chunk_text in enumerate(chunks):
        chunk_id = f"{syllabus_id}-chunk-{i}"
        header = f"[{curriculum} {subject} {edu_level}]\nCountry: {country}\n\n"
        store_document(
            "syllabuses",
            chunk_id,
            header + chunk_text,
            {**chunk_meta_base, "chunk_index": i, "source_filename": filename},
        )
        stored += 1

    # Update chunk count in Firestore
    upsert("syllabuses", syllabus_id, {"chunk_count": stored})

    return jsonify({
        "status":      "reindexed",
        "syllabus_id": syllabus_id,
        "chunks":      stored,
    }), 200


# ── GET /api/curriculum/search (internal / debug) ─────────────────────────────

@curriculum_bp.get("/curriculum/search")
@instrument_route("curriculum.search", "curriculum")
def search_curriculum():
    """
    Semantic search across uploaded syllabuses.
    Primarily used for debugging RAG retrieval quality.

    Query params:
      q              — required — search query text
      curriculum     — optional filter
      subject        — optional filter
      education_level — optional filter
      top_k          — optional, default 5
    """
    teacher_id, err = require_role(request, "teacher")
    if err:
        return jsonify({"error": err}), 401

    q = (request.args.get("q") or "").strip()
    if not q:
        return jsonify({"error": "q is required"}), 400

    filters: dict = {}
    if c := request.args.get("curriculum"):
        filters["curriculum"] = c
    if s := request.args.get("subject"):
        filters["subject"] = s
    if e := request.args.get("education_level"):
        filters["education_level"] = e

    top_k = min(int(request.args.get("top_k", 5)), 20)

    results = search_similar("syllabuses", q, filters or None, top_k)
    return jsonify({"query": q, "results": results}), 200
