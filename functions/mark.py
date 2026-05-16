"""
Marking pipeline endpoint — POST /api/mark

Pipeline:
  1. Image quality gate (Gemma 4 multimodal)
  2. Grade against answer key (Gemma 4 multimodal — reads handwriting directly)
  3. Optional: bounding boxes from Document AI for pixel-accurate annotation
  4. Annotate image (Pillow)
  5. Upload annotated image to Cloud Storage
  6. Write Mark to Firestore
  7. Return JSON result
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from datetime import datetime, timezone
from functools import wraps

from flask import Blueprint, jsonify, request
from google.api_core import exceptions as gcp_exc

from shared.auth import decode_jwt, require_role
from shared.config import settings
from shared.errors import (
    DuplicateSubmissionError,
    ImageQualityRejectedError,
    ImageTooLargeError,
    MarkingSchemeError,
    NeriahError,
    RateLimitError,
    StorageBucketMissingError,
    StorageUploadError,
    classify_vertex_exception,
)
from shared.firestore_client import delete_doc, get_doc, increment_field, query, upsert
from shared.gcs_client import generate_signed_url, upload_bytes
from shared.gemma_client import (
    check_image_quality,
    check_image_quality_strict,
    grade_submission,
    grade_submission_strict,
    grade_submission_strict_multi,
)
from shared.annotator import annotate_image, annotate_pages
from shared.guardrails import log_ai_interaction, validate_output
from shared.models import GradingVerdict, Mark
from shared.observability import instrument_route
from shared.router import AIRequestType, route_ai_request
from shared.user_context import get_user_context

logger = logging.getLogger(__name__)
mark_bp = Blueprint("mark", __name__)

# ─── Upload size limit ────────────────────────────────────────────────────────
_MAX_IMAGE_BYTES = 20 * 1024 * 1024  # 20 MB

# ─── Per-teacher daily rate limit ────────────────────────────────────────────
_MARK_DAILY_LIMIT = 500


def _today_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _mark_usage_doc_id(teacher_id: str) -> str:
    return f"mark_{teacher_id}_{_today_utc()}"


def _check_mark_rate_limit(teacher_id: str) -> bool:
    """Return True if the teacher is within the daily marking limit."""
    doc = get_doc("mark_usage", _mark_usage_doc_id(teacher_id))
    return not doc or doc.get("count", 0) < _MARK_DAILY_LIMIT


def _increment_mark_usage(teacher_id: str) -> None:
    doc_id = _mark_usage_doc_id(teacher_id)
    if get_doc("mark_usage", doc_id):
        increment_field("mark_usage", doc_id, "count")
    else:
        upsert("mark_usage", doc_id, {
            "teacher_id": teacher_id,
            "date": _today_utc(),
            "count": 1,
        })


def handle_neriah_errors(fn):
    """Catch NeriahError and return its typed JSON response. Convert known
    GCP exceptions to NeriahError too. Let anything else 500 with a generic
    message so we don't leak internals."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except NeriahError as err:
            logger.warning(
                "NeriahError in %s: code=%s technical=%s",
                fn.__name__, err.error_code, err.technical_detail,
            )
            return jsonify(err.to_response()), err.http_status
        except gcp_exc.NotFound as exc:
            err = StorageBucketMissingError(str(exc)) if "bucket" in str(exc).lower() \
                  else classify_vertex_exception(exc)
            logger.exception("GCP NotFound in %s", fn.__name__)
            return jsonify(err.to_response()), err.http_status
        except (gcp_exc.GoogleAPIError, gcp_exc.RetryError) as exc:
            err = classify_vertex_exception(exc)
            logger.exception("GCP API error in %s", fn.__name__)
            return jsonify(err.to_response()), err.http_status
        except Exception as exc:
            logger.exception("Unhandled error in %s", fn.__name__)
            return jsonify({
                "error": "An unexpected error occurred. Our team has been notified.",
                "error_code": "UNEXPECTED_ERROR",
                "retryable": True,
                "technical": f"{type(exc).__name__}: {str(exc)[:200]}",
            }), 500
    return wrapper


_QUALITY_REJECTION: dict[str, str] = {
    "low light":     "The photo is too dark. Move to better lighting and try again.",
    "underexposed":  "The photo is too dark. Move to better lighting and try again.",
    "blur":          "The photo is blurry. Hold your phone steady and retake.",
    "out of focus":  "The photo is blurry. Hold your phone steady and retake.",
    "cut off":       "Part of the page is cut off. Step back and make sure the whole page is visible.",
    "glare":         "There is glare or shadow covering the text. Adjust the angle and retake.",
    "shadow":        "There is glare or shadow covering the text. Adjust the angle and retake.",
    "tilted":        "The page appears tilted. Straighten the book and retake.",
    "rotated":       "The page appears tilted. Straighten the book and retake.",
    "not a document": "That doesn't look like a page. Please photograph the student's exercise book.",
}


def _quality_message(reason: str) -> str:
    reason_lower = reason.lower()
    for keyword, msg in _QUALITY_REJECTION.items():
        if keyword in reason_lower:
            return msg
    return f"Image rejected: {reason}. Please retake."


@mark_bp.post("/mark")
@instrument_route("mark.submit_scan", "mark")
@handle_neriah_errors
def mark():
    teacher_id, err = require_role(request, "teacher")
    if err:
        return jsonify({"error": err}), 401

    # ── Rate limit ────────────────────────────────────────────────────────────
    if not _check_mark_rate_limit(teacher_id):
        raise RateLimitError(f"Teacher {teacher_id} hit daily limit of {_MARK_DAILY_LIMIT}")

    # ── Multi-page multipart ingestion ────────────────────────────────────────
    # Contract: form-data with fields page_0, page_1, ..., page_{N-1}, plus
    # page_count=N. Mobile ships with multi support in the same release — no
    # legacy single `file` field accepted.
    try:
        page_count = int(request.form.get("page_count", "1"))
    except (TypeError, ValueError):
        return jsonify({"error": "page_count must be an integer"}), 400

    if page_count < 1 or page_count > 5:
        err = ImageQualityRejectedError(f"page_count out of range: {page_count}")
        err.user_message = "You can submit between 1 and 5 pages per student. Please try again."
        err.extra = {"received": page_count}
        raise err

    student_id = (request.form.get("student_id") or "").strip()
    answer_key_id = (request.form.get("answer_key_id") or "").strip()

    if not student_id or not answer_key_id:
        return jsonify({"error": "student_id and answer_key_id are required"}), 400

    # Read every page up-front so we can enforce size limits before any
    # Vertex calls or GCS uploads happen.
    pages_bytes: list[bytes] = []
    import base64 as _base64
    for i in range(page_count):
        field = f"page_{i}"
        file_obj = request.files.get(field)
        if file_obj is not None:
            page_bytes = file_obj.read()
        else:
            # Android fallback: mobile clients that can't reliably multipart-
            # upload a file URI (a known issue on some Samsung builds) send
            # the image as a base64 form field instead. Keeps the endpoint
            # contract unified — still a multipart POST, just a text part.
            b64_data = request.form.get(f"{field}_base64", "")
            if not b64_data:
                err = ImageQualityRejectedError(f"Missing page field: {field}")
                err.user_message = (
                    f"The app said you submitted {page_count} page(s) but page "
                    f"{i + 1} was missing. Please retake and try again."
                )
                err.extra = {"missing_field": field, "page_count": page_count}
                raise err
            try:
                page_bytes = _base64.b64decode(b64_data, validate=False)
            except Exception:
                err = ImageQualityRejectedError(f"Invalid base64 for {field}")
                err.user_message = (
                    f"Page {i + 1} could not be decoded. Please retake and try again."
                )
                err.extra = {"bad_field": f"{field}_base64", "page_count": page_count}
                raise err
        if len(page_bytes) > _MAX_IMAGE_BYTES:
            raise ImageTooLargeError(
                f"page_{i} is {len(page_bytes)} bytes (max {_MAX_IMAGE_BYTES})"
            )
        pages_bytes.append(page_bytes)

    # Normalise orientation BEFORE quality check / grading / annotation.
    # See shared/orientation.py — bakes EXIF rotation into pixels and
    # uses a Gemma pre-check to catch the residual cases (no EXIF,
    # page rotated within the frame, photo held upside-down). Skipped
    # on the pre-graded path because the mobile teacher's already-
    # rendered local verdicts are coordinate-aware to whatever the
    # client showed; the cloud has nothing to add.
    from shared.orientation import normalize_to_upright
    if not request.form.get("pre_graded_verdicts"):
        pages_bytes = [normalize_to_upright(p) for p in pages_bytes]

    # ── Duplicate-submission guard ────────────────────────────────────────────
    # One graded submission per (student_id, answer_key_id). If one exists,
    # the client must opt into overwrite via replace=true. Keeps analytics
    # counts honest when a retry happens after a transient grading failure.
    replace_existing = (request.form.get("replace") or "").lower() in ("true", "1", "yes")

    existing_marks = query(
        "marks",
        [
            ("student_id", "==", student_id),
            ("answer_key_id", "==", answer_key_id),
        ],
    )

    if existing_marks and not replace_existing:
        existing = existing_marks[0]
        err = DuplicateSubmissionError(
            f"Existing mark {existing.get('id') or existing.get('mark_id')} for "
            f"student={student_id} answer_key={answer_key_id}"
        )
        err.extra = {
            "existing_mark_id": existing.get("id") or existing.get("mark_id"),
            "existing_status": existing.get("status") or (
                "approved" if existing.get("approved") else "graded"
            ),
            "existing_approved": bool(existing.get("approved")),
            "existing_timestamp": existing.get("timestamp"),
        }
        raise err

    if replace_existing and existing_marks:
        for old in existing_marks:
            old_id = old.get("id") or old.get("mark_id")
            if old_id:
                try:
                    delete_doc("marks", old_id)
                    logger.info("[mark] Replaced: deleted old mark %s", old_id)
                except Exception:
                    logger.exception("[mark] Failed to delete old mark %s", old_id)

        old_subs = query(
            "student_submissions",
            [
                ("student_id", "==", student_id),
                ("answer_key_id", "==", answer_key_id),
            ],
        )
        for old_sub in old_subs:
            sub_id = old_sub.get("id") or old_sub.get("submission_id")
            if sub_id:
                try:
                    delete_doc("student_submissions", sub_id)
                    logger.info("[mark] Replaced: deleted old submission %s", sub_id)
                except Exception:
                    logger.exception("[mark] Failed to delete old submission %s", sub_id)

    # ── Pre-graded path (offline-graded mobile clients) ──────────────────────
    # Mobile teachers running on E2B locally pass their verdicts in directly
    # via `pre_graded_verdicts` (JSON-encoded array). When the field is
    # present and valid we skip both the image-quality check and the cloud
    # grading call — the teacher's already-rendered local verdicts become
    # the canonical Mark, and we just need to run the dedupe/clamp guards,
    # annotate, upload, and persist. Reasons:
    #   1. The teacher already sees these verdicts on screen; re-grading in
    #      cloud would create a divergent record.
    #   2. Saves a Vertex call + bandwidth on the queue replay.
    # If pre_graded_verdicts is absent or malformed, fall through to the
    # normal cloud-grading pipeline.
    pre_graded_raw = request.form.get("pre_graded_verdicts")
    is_pre_graded = False
    pre_graded_verdicts: list[dict] | None = None
    if pre_graded_raw:
        try:
            parsed_verdicts = json.loads(pre_graded_raw)
            if isinstance(parsed_verdicts, list):
                pre_graded_verdicts = [v for v in parsed_verdicts if isinstance(v, dict)]
                if pre_graded_verdicts:
                    is_pre_graded = True
        except (TypeError, ValueError, json.JSONDecodeError):
            pre_graded_verdicts = None
            is_pre_graded = False

    # ── Route: cloud grading only fires when we don't already have verdicts ─
    if not is_pre_graded:
        route_ai_request(AIRequestType.GRADING)  # always AIRoute.CLOUD on the backend

        # ── 1. Image quality gate — page 0 only as a representative sample ────
        # Running the quality check against every page would triple-to-5x Vertex
        # calls before we even start grading. Page 0 acts as a cheap preflight;
        # Gemma's grading call later is tolerant of rough pages 2-N. Skipped
        # entirely on the pre-graded path because the teacher already saw the
        # local grade — re-rejecting on quality would orphan their submission.
        quality = check_image_quality_strict(pages_bytes[0])
        if not quality.get("pass", True):
            reason = (quality.get("reason") or "").lower()
            suggestion = quality.get("suggestion") or "Retake the photo in better lighting."
            user_msg = next(
                (msg for key, msg in _QUALITY_REJECTION.items() if key in reason),
                suggestion,
            )
            err = ImageQualityRejectedError(f"quality={reason}")
            err.user_message = user_msg
            raise err

    # ── Fetch answer key and class info ───────────────────────────────────────
    answer_key = get_doc("answer_keys", answer_key_id)
    if not answer_key:
        return jsonify({"error": "Answer key not found"}), 404
    if answer_key["teacher_id"] != teacher_id:
        return jsonify({"error": "forbidden"}), 403

    if not answer_key.get("questions"):
        raise MarkingSchemeError("Answer key missing or has no questions")

    student = get_doc("students", student_id)
    if not student:
        return jsonify({"error": "Student not found"}), 404

    class_doc = get_doc("classes", answer_key["class_id"])
    education_level = answer_key.get("education_level") or (
        class_doc.get("education_level") if class_doc else "Form 4"
    )

    # ── 2. Grade across all pages — skipped on the pre-graded path ────────────
    if is_pre_graded:
        raw_verdicts = pre_graded_verdicts or []
        _latency_ms = 0
    else:
        class_id_for_ctx = answer_key.get("class_id") or (class_doc.get("id") if class_doc else None)
        user_ctx = get_user_context(teacher_id, "teacher", class_id=class_id_for_ctx)
        _t0 = time.time()
        raw_verdicts = grade_submission_strict_multi(
            pages_bytes, answer_key, education_level, user_context=user_ctx,
        )
        _latency_ms = int((time.time() - _t0) * 1000)

    # ── Dedupe + clamp against the answer key ────────────────────────────────
    # Two anti-abuse rules applied here, regardless of what Gemma emitted:
    #   1. Each question_number is counted at most once, even if the same
    #      answer appears on multiple pages (e.g. student photographs two
    #      copies of the same page). When Gemma returns several verdicts for
    #      the same question, we keep the one with the highest awarded_marks
    #      (benefit-of-the-doubt: grade the student's best attempt).
    #   2. Per-question awarded_marks is clamped to the answer key's
    #      question marks, and the total score is clamped to the answer
    #      key's total_marks. A hallucinating model can never inflate the
    #      score above what the teacher set.
    # Answer key questions may use "number" or "question_number" for the id.
    max_per_q: dict[int, float] = {}
    for q in answer_key.get("questions", []):
        qn_raw = q.get("question_number") if q.get("question_number") is not None else q.get("number")
        try:
            qn = int(qn_raw) if qn_raw is not None else None
        except (TypeError, ValueError):
            qn = None
        if qn is not None:
            try:
                max_per_q[qn] = float(q.get("marks", 0) or 0)
            except (TypeError, ValueError):
                max_per_q[qn] = 0.0
    total_max = float(answer_key.get("total_marks") or sum(max_per_q.values()) or 1)

    deduped: dict[int, dict] = {}
    for v in raw_verdicts:
        if not isinstance(v, dict):
            continue
        qn_raw = v.get("question_number")
        try:
            qn = int(qn_raw) if qn_raw is not None else None
        except (TypeError, ValueError):
            qn = None
        if qn is None or qn not in max_per_q:
            # Drop verdicts for questions the teacher didn't set — Gemma
            # occasionally hallucinates extras, and we don't want them
            # contributing to the score or cluttering the annotator.
            continue
        try:
            awarded = float(v.get("awarded_marks", 0) or 0)
        except (TypeError, ValueError):
            awarded = 0.0
        prev = deduped.get(qn)
        if prev is None:
            deduped[qn] = v
            continue
        try:
            prev_awarded = float(prev.get("awarded_marks", 0) or 0)
        except (TypeError, ValueError):
            prev_awarded = 0.0
        if awarded > prev_awarded:
            deduped[qn] = v

    # Clamp each kept verdict, then sort by question_number for stable output.
    for qn, v in deduped.items():
        cap = max_per_q[qn]
        v["max_marks"] = cap
        try:
            a = float(v.get("awarded_marks", 0) or 0)
        except (TypeError, ValueError):
            a = 0.0
        v["awarded_marks"] = max(0.0, min(a, cap))

    raw_verdicts = sorted(deduped.values(), key=lambda v: int(v.get("question_number", 0)))

    # ── Output guardrails: validate grading JSON ──────────────────────────────
    _raw_json = json.dumps(raw_verdicts) if isinstance(raw_verdicts, list) else str(raw_verdicts)
    _total_awarded = sum(v.get("awarded_marks", 0) for v in raw_verdicts if isinstance(v, dict))
    _verdict_json = json.dumps({"score": _total_awarded})
    valid_out, _out_err = validate_output(
        _verdict_json, role="grading", context={"max_marks": total_max}
    )
    if not valid_out:
        log_ai_interaction(
            teacher_id, "teacher", "grading", answer_key_id, _raw_json,
            tokens_used=0, latency_ms=_latency_ms, blocked=True, block_reason=_out_err,
        )
        return jsonify({"error": "Grading response failed validation. Please retry."}), 422

    verdicts = [GradingVerdict(**v) for v in raw_verdicts if isinstance(v, dict)]
    # Score is the sum of clamped per-question awarded marks, then hard-capped
    # at the answer key's total_marks (belt-and-braces: even if the per-
    # question cap math somehow drifts, the total will never exceed the key).
    score = min(sum(v.awarded_marks for v in verdicts), total_max)
    max_score = total_max
    percentage = round(score / max_score * 100, 1) if max_score else 0.0

    # page_index is stashed on the raw_verdicts dicts but not on the Pydantic
    # GradingVerdict model. Pull it back from the raw list, aligned by
    # question_number so re-ordering by Pydantic construction doesn't scramble
    # it. Fallback to 0 when missing (defensive — grade_submission_strict_multi
    # already clamps).
    page_index_by_qn: dict = {}
    for rv in raw_verdicts:
        if isinstance(rv, dict) and "question_number" in rv:
            page_index_by_qn[rv["question_number"]] = int(rv.get("page_index", 0))
    verdicts_dicts = []
    for v in verdicts:
        vd = v.model_dump()
        vd["page_index"] = page_index_by_qn.get(v.question_number, 0)
        verdicts_dicts.append(vd)

    # ── 3. Annotate each page with only its own verdicts ──────────────────────
    annotated_pages = annotate_pages(pages_bytes, verdicts_dicts)

    # ── 4. Upload originals + annotated pages to Cloud Storage ───────────────
    mark_id = str(uuid.uuid4())
    page_urls: list[str] = []
    annotated_urls: list[str] = []
    try:
        for i, page_bytes in enumerate(pages_bytes):
            orig_blob = f"submissions/{student_id}/{mark_id}/page_{i}.jpg"
            upload_bytes(settings.GCS_BUCKET_SUBMISSIONS, orig_blob, page_bytes, public=False)
            page_urls.append(generate_signed_url(
                settings.GCS_BUCKET_SUBMISSIONS, orig_blob, expiry_minutes=60 * 24 * 7,
            ))
        for i, annotated_bytes in enumerate(annotated_pages):
            ann_blob = f"{mark_id}/annotated_{i}.jpg"
            upload_bytes(settings.GCS_BUCKET_MARKED, ann_blob, annotated_bytes, public=False)
            annotated_urls.append(generate_signed_url(
                settings.GCS_BUCKET_MARKED, ann_blob, expiry_minutes=60 * 24 * 7,
            ))
    except gcp_exc.NotFound as exc:
        raise StorageBucketMissingError(
            f"Bucket missing during multi-page upload: {exc}"
        ) from exc
    except Exception as exc:
        raise StorageUploadError(
            f"Multi-page upload failed: {exc}"
        ) from exc

    # ── 5. Write Mark to Firestore ───────────────────────────────────────────
    # approved=False: teacher sees the result immediately but the student
    # doesn't until approval. Matches the AI-batch flow.
    # marked_image_url and page_urls[0]/annotated_urls[0] are kept as legacy
    # singular aliases for any UI screen still reading the old field names.
    mark_source = "teacher_scan_offline" if is_pre_graded else "teacher_scan"
    # Role invariants: Mark.student_id MUST be in students, teacher_id
    # MUST be in teachers. Firestore can't enforce this; we do it here.
    from shared.role_invariants import assert_is_student, assert_is_teacher, RoleInvariantError
    try:
        assert_is_student(student_id)
        assert_is_teacher(teacher_id)
    except RoleInvariantError as e:
        return jsonify({"error": str(e), "error_code": "ROLE_INVARIANT_VIOLATION"}), 400
    mark_doc = Mark(
        id=mark_id,
        student_id=student_id,
        class_id=answer_key["class_id"],
        answer_key_id=answer_key_id,
        teacher_id=teacher_id,
        score=score,
        max_score=max_score,
        percentage=percentage,
        verdicts=verdicts,
        marked_image_url=annotated_urls[0] if annotated_urls else None,
        source=mark_source,
        approved=False,
        page_count=page_count,
        page_urls=page_urls,
        annotated_urls=annotated_urls,
    )
    upsert("marks", mark_doc.id, mark_doc.model_dump())

    # ── Companion student_submissions row ─────────────────────────────────────
    submission_id = f"sub_{uuid.uuid4().hex[:12]}"
    now_iso = datetime.now(timezone.utc).isoformat()
    upsert("student_submissions", submission_id, {
        "id": submission_id,
        "student_id": student_id,
        "class_id": answer_key["class_id"],
        "answer_key_id": answer_key_id,
        "teacher_id": teacher_id,
        "mark_id": mark_doc.id,
        "source": mark_source,
        "status": "graded",
        "image_urls": list(annotated_urls),  # all annotated pages in order
        "submitted_at": now_iso,
        "graded_at": now_iso,
    })

    _increment_mark_usage(teacher_id)

    # ── Audit log ─────────────────────────────────────────────────────────────
    log_ai_interaction(
        teacher_id, "teacher", "grading", answer_key_id, json.dumps(verdicts_dicts),
        tokens_used=len(verdicts_dicts) * 10, latency_ms=_latency_ms, blocked=False,
    )

    # ── 6. Notify student (only if already approved — see flow note above) ───
    if mark_doc.approved:
        try:
            from functions.push import send_student_notification
            student_doc = get_doc("students", student_id)
            _ = f"{(student_doc or {}).get('first_name', '')} {(student_doc or {}).get('surname', '')}".strip() or "Student"
            hw_title = answer_key.get("title") or answer_key.get("subject") or "Assignment"
            send_student_notification(
                student_id,
                "Your work has been marked",
                f"{hw_title}: {score}/{max_score} ({percentage}%)",
                {"screen": "StudentResults", "mark_id": mark_doc.id},
            )
        except Exception:
            pass  # non-fatal

    # ── 7. Return result ──────────────────────────────────────────────────────
    # student_id + student_name let MarkingScreen render the approval UI
    # without depending on its own `selectedStudent` state being non-null at
    # render time. student dict was already fetched above (line ~284).
    return jsonify({
        "mark_id": mark_doc.id,
        "student_id": student_id,
        "student_name": f"{student.get('first_name', '')} {student.get('surname', '')}".strip(),
        "score": score,
        "max_score": max_score,
        "percentage": percentage,
        "marked_image_url": annotated_urls[0] if annotated_urls else None,
        "page_count": page_count,
        "page_urls": page_urls,
        "annotated_urls": annotated_urls,
        "verdicts": verdicts_dicts,
    }), 200


@mark_bp.put("/marks/<mark_id>")
@instrument_route("mark.update", "mark")
def update_mark(mark_id: str):
    """Teacher reviews and overrides a mark."""
    teacher_id, err = require_role(request, "teacher")
    if err:
        return jsonify({"error": err}), 401

    mark_doc = get_doc("marks", mark_id)
    if not mark_doc:
        return jsonify({"error": "Mark not found"}), 404
    if mark_doc["teacher_id"] != teacher_id:
        return jsonify({"error": "forbidden"}), 403

    body = request.get_json(silent=True) or {}
    allowed = {"score", "approved", "verdicts", "overall_feedback", "manually_edited", "feedback"}
    updates = {k: v for k, v in body.items() if k in allowed}

    # When the client sends edited verdicts, derive the aggregate score from
    # them. This keeps score and per-question awarded_marks in lockstep — the
    # mobile client no longer has to compute totals, it just sends the rows.
    if "verdicts" in updates and isinstance(updates["verdicts"], list):
        total_awarded = sum(float(v.get("awarded_marks", 0)) for v in updates["verdicts"] if isinstance(v, dict))
        total_max = sum(float(v.get("max_marks", 0)) for v in updates["verdicts"] if isinstance(v, dict))
        updates["score"] = total_awarded
        updates["max_score"] = total_max
        updates["percentage"] = round((total_awarded / total_max) * 100, 1) if total_max > 0 else 0.0
        updates["manually_edited"] = True
    elif "score" in updates and "max_score" in mark_doc:
        updates["percentage"] = round(
            float(updates["score"]) / float(mark_doc["max_score"]) * 100, 1
        )

    upsert("marks", mark_id, updates)

    # Sync the linked student_submissions row when the teacher flips approved
    # to True. HomeworkDetailScreen's amber/green split and downstream
    # analytics all filter on submission.status, so without this the UI keeps
    # showing "Awaiting approval" after approval. Only syncs up (graded →
    # approved); we never sync-downgrade because our model is delete, not
    # unapprove. Runs AFTER the mark upsert so a sync failure can't undo the
    # approval itself.
    if updates.get("approved") is True:
        try:
            linked_subs = query(
                "student_submissions",
                [("mark_id", "==", mark_id)],
            )
            for sub in linked_subs:
                if sub.get("status") != "approved":
                    upsert("student_submissions", sub["id"], {
                        "status": "approved",
                        "approved": True,
                        "approved_at": datetime.now(timezone.utc).isoformat(),
                    })
        except Exception:
            logger.exception(
                "update_mark: failed to sync student_submissions.status for mark %s",
                mark_id,
            )

        # Channel-aware student-facing reply. Mirrors the dispatch fired
        # from submissions.py:approve_submission so the email/WhatsApp
        # paths get the same treatment regardless of which approval
        # endpoint the mobile UI hits. The "Save & Approve" button in
        # MarkResult.tsx calls PUT /api/marks/{id} (this handler), not
        # POST /api/submissions/{id}/approve, so without this dispatch
        # email-channel students would never receive their grade reply.
        try:
            from functions.submissions import _dispatch_student_reply
            student_id = mark_doc.get("student_id", "")
            ak = get_doc("answer_keys", mark_doc.get("answer_key_id", "")) or {}
            # Score/max from the latest values — prefers the just-applied
            # update, falls back to the stored mark.
            sub_payload = {
                "score": updates.get("score", mark_doc.get("score", 0)),
                "max_score": updates.get("max_score", mark_doc.get("max_score", 0)),
            }
            if student_id:
                _dispatch_student_reply(
                    student_id=student_id,
                    mark_id=mark_id,
                    hw=ak,
                    sub=sub_payload,
                )
        except Exception:
            logger.exception(
                "update_mark: dispatch_student_reply failed for mark %s",
                mark_id,
            )

    return jsonify({**mark_doc, **updates}), 200


@mark_bp.get("/marks/<mark_id>")
@instrument_route("mark.get", "mark")
@handle_neriah_errors
def get_mark(mark_id: str):
    """
    Retrieve a single mark by id, enriched with student_name, answer_key_title,
    and class_name for display.

    Authorisation:
      - Teacher: must own the mark.
      - Student: must be the student on the mark AND the mark must be approved
        (matches the visibility rule used by /marks/student/<id> and the
        Results-tab feedback flow). Without this, the mobile FeedbackScreen
        for graded student submissions returned 401 → triggered axios's
        401 → logout interceptor and silently signed students out the
        moment they tapped a graded entry.
    """
    user_id, err = require_role(request, "teacher", "student")
    if err:
        return jsonify({"error": err}), 401

    # Re-decode the JWT to read the role; require_role doesn't surface it.
    auth_header = request.headers.get("Authorization", "") or ""
    payload = decode_jwt(auth_header[7:]) if auth_header.startswith("Bearer ") else None
    role = (payload or {}).get("role")

    mark = get_doc("marks", mark_id)
    if not mark:
        return jsonify({"error": "Mark not found"}), 404

    if role == "teacher":
        if mark.get("teacher_id") != user_id:
            return jsonify({"error": "forbidden"}), 403
    else:
        # Student path: own mark + must be approved (teacher-visible only)
        if mark.get("student_id") != user_id:
            return jsonify({"error": "forbidden"}), 403
        if not mark.get("approved"):
            return jsonify({"error": "Mark not yet released"}), 403

    # Enrichment — student name, answer key title, class name.
    student_id = mark.get("student_id", "")
    student = get_doc("students", student_id) if student_id else None
    if student:
        mark["student_name"] = (
            f"{student.get('first_name', '')} {student.get('surname', '')}".strip()
        )
    else:
        mark["student_name"] = "Unknown"

    ak_id = mark.get("answer_key_id", "")
    ak = get_doc("answer_keys", ak_id) if ak_id else None
    if ak:
        mark["answer_key_title"] = ak.get("title") or ak.get("subject") or ""
        class_id = ak.get("class_id", "")
        cls = get_doc("classes", class_id) if class_id else None
        if cls:
            mark["class_name"] = cls.get("name", "")

    return jsonify(mark), 200


@mark_bp.get("/marks/student/<student_id>")
@instrument_route("mark.student_list", "mark")
def student_marks(student_id: str):
    """Student fetches their own marks."""
    req_student_id, err = require_role(request, "student")
    if err:
        return jsonify({"error": err}), 401

    if req_student_id != student_id:
        return jsonify({"error": "forbidden"}), 403

    results = query(
        "marks",
        [("student_id", "==", student_id), ("approved", "==", True)],
        order_by="timestamp",
        direction="DESCENDING",
    )
    return jsonify(results), 200
