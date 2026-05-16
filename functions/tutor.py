"""
POST /api/tutor/chat — Socratic-method AI tutor for students.

Students ask questions about their homework; Neriah guides them to the answer
using the Socratic method — never giving direct answers.

Free for all students enrolled at schools with an active Neriah subscription.
Rate limit: 50 messages per student per day.
"""

from __future__ import annotations

import base64
import logging
import time
import uuid
from datetime import datetime, timezone

from flask import Blueprint, jsonify, request

from functions.teacher_assistant import _sanitize_user_visible_text
from shared.auth import require_role
from shared.firestore_client import get_doc, increment_field, query, query_single, upsert
from shared.gemma_client import student_tutor
from shared.guardrails import (
    apply_confidence_hedge,
    check_rate_limit as guardrails_rate_limit,
    log_ai_interaction,
    validate_input,
    validate_output,
)
from shared.observability import instrument_route
from shared.router import AIRequestType, route_ai_request
from shared.user_context import get_user_context

logger = logging.getLogger(__name__)
tutor_bp = Blueprint("tutor", __name__)

_DAILY_LIMIT = 50
_RATE_LIMIT_MSG = (
    "You've been studying hard today! You've used all 50 tutor messages for today. "
    "They reset at midnight. Keep up the great work!"
)


# ─── Rate-limit helpers ───────────────────────────────────────────────────────

def _today_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _usage_doc_id(student_id: str) -> str:
    return f"{student_id}_{_today_utc()}"


def check_rate_limit(student_id: str) -> bool:
    """Returns True if the student is within the daily limit."""
    doc = get_doc("tutor_usage", _usage_doc_id(student_id))
    if not doc:
        return True
    return doc.get("count", 0) < _DAILY_LIMIT


def increment_usage(student_id: str) -> None:
    """Increment today's message count for this student. Creates the doc if missing."""
    doc_id = _usage_doc_id(student_id)
    existing = get_doc("tutor_usage", doc_id)
    if existing:
        increment_field("tutor_usage", doc_id, "count")
    else:
        upsert("tutor_usage", doc_id, {
            "student_id": student_id,
            "date": _today_utc(),
            "count": 1,
        })


# ─── Weakness query detection ─────────────────────────────────────────────────

_WEAKNESS_QUERY_PATTERNS = (
    "weak area",
    "weak spot",
    "what am i bad at",
    "what am i struggling",
    "what do i need to work on",
    "where do i need help",
    "where am i weak",
    "my weaknesses",
    "my weak points",
    "what should i practice",
    "what should i study",
    "what topics should i",
    "am i weakest",
    "am i worst",
)


def _is_weakness_query(message: str) -> bool:
    """Returns True if the student is asking about their own weak areas."""
    if not message:
        return False
    text = message.lower().strip()
    return any(p in text for p in _WEAKNESS_QUERY_PATTERNS)


def _student_weaknesses_aggregated(student_id: str) -> list[dict]:
    """
    Pool every approved verdict across the student's submissions, grouped by
    question_text[:50]. Mirrors the aggregation in functions/analytics.py.
    Topics with <2 attempts are dropped (insufficient signal).
    Returned weakest-first.
    """
    try:
        marks = query("marks", [("student_id", "==", student_id)], order_by="timestamp")
    except Exception:
        marks = query("marks", [("student_id", "==", student_id)])
    approved = [m for m in marks if m.get("approved") or m.get("status") in ("approved", "graded")]

    topic_stats: dict[str, dict] = {}
    for m in approved:
        m_ts = m.get("timestamp", "")
        for v in m.get("verdicts", []):
            qt = (v.get("question_text") or "").strip()[:50]
            if not qt:
                continue
            entry = topic_stats.setdefault(qt, {
                "topic": qt,
                "attempts": 0,
                "correct": 0,
                "last_seen_at": "",
            })
            entry["attempts"] += 1
            if v.get("verdict") == "correct":
                entry["correct"] += 1
            if m_ts and m_ts > entry["last_seen_at"]:
                entry["last_seen_at"] = m_ts

    out: list[dict] = []
    for entry in topic_stats.values():
        if entry["attempts"] < 2:
            continue
        accuracy_pct = round(entry["correct"] / entry["attempts"] * 100)
        out.append({
            "topic": entry["topic"],
            "attempts": entry["attempts"],
            "correct": entry["correct"],
            "accuracy_pct": accuracy_pct,
        })
    out.sort(key=lambda e: (e["accuracy_pct"], -e["attempts"]))
    return out


# ─── Eligibility check ────────────────────────────────────────────────────────

def _is_eligible(student_id: str) -> bool:
    """
    Returns True if the student is enrolled at a school with an active subscription.
    Traversal: student → class → teacher → school → subscription_active.
    Defaults to True when subscription_active is missing (MVP grace period).
    """
    student = get_doc("students", student_id)
    if not student:
        return False
    class_id = student.get("class_id")
    if not class_id:
        return False
    cls = get_doc("classes", class_id)
    if not cls:
        return False
    teacher_id = cls.get("teacher_id")
    if not teacher_id:
        return False
    teacher = get_doc("teachers", teacher_id)
    if not teacher:
        return False
    school_id = teacher.get("school_id")
    if not school_id:
        # Teacher not linked to a school — deny rather than assume
        return False
    school = get_doc("schools", school_id)
    if not school:
        # School not in Firestore — seed schools count as active for demos
        return True
    # Explicit False → deny. Missing or True → allow.
    return school.get("subscription_active", True) is not False


def _get_education_level(student_id: str) -> str:
    """Resolve the education level from the student's class."""
    student = get_doc("students", student_id)
    if not student:
        return "Form 4"
    cls = get_doc("classes", student.get("class_id", ""))
    if not cls:
        return "Form 4"
    return cls.get("education_level", "Form 4")


# ─── Endpoint ─────────────────────────────────────────────────────────────────

@tutor_bp.post("/tutor/chat")
@instrument_route("tutor.chat", "tutor")
def tutor_chat():
    student_id, err = require_role(request, "student")
    if err:
        return jsonify({"error": err}), 401

    # ── Eligibility ───────────────────────────────────────────────────────────
    if not _is_eligible(student_id):
        return jsonify({
            "error": (
                "AI tutor is available for students at subscribed schools. "
                "Ask your teacher about Neriah."
            )
        }), 403

    # ── Rate limit ────────────────────────────────────────────────────────────
    if not check_rate_limit(student_id):
        return jsonify({"error": _RATE_LIMIT_MSG}), 429

    # Guardrails per-minute rate limit (supplementary to daily limit above)
    allowed, retry_after = guardrails_rate_limit(student_id, "tutor", "student")
    if not allowed:
        return jsonify({"error": f"Too many requests. Retry after {retry_after}s"}), 429

    # ── Request body ──────────────────────────────────────────────────────────
    body = request.get_json(silent=True) or {}
    is_greeting = bool(body.get("is_greeting"))
    weak_topics_hint: list[str] = body.get("weak_topics") or []

    message = (body.get("message") or "").strip()

    # ── Attachment handling ───────────────────────────────────────────────────
    # Parsed up-front so the empty-message branch below can permit a
    # message-less request when there's a file to talk about.
    # Two shapes are accepted for backwards compatibility:
    #   1. Legacy: { image: "<base64>" } — always treated as a JPEG image.
    #   2. Unified: { file_data: "<base64>", media_type: "image"|"pdf"|"word" }
    #      — mirrors the teacher assistant contract so the same picker UI
    #      and extraction pipeline can be shared between roles.
    image_bytes: bytes | None = None
    file_text: str = ""
    file_media_type: str = ""

    raw_image = body.get("image")
    raw_file = (body.get("file_data") or "").strip()
    raw_media_type = (body.get("media_type") or "").strip().lower()

    if raw_image:
        try:
            image_bytes = base64.b64decode(raw_image)
            file_media_type = "image"
        except Exception:
            return jsonify({"error": "image must be valid base64"}), 400
    elif raw_file and raw_media_type in ("image", "pdf", "word"):
        from shared.file_attachments import extract_file_text  # noqa: PLC0415
        image_bytes, file_text = extract_file_text(raw_file, raw_media_type)
        file_media_type = raw_media_type
        if not image_bytes and not file_text:
            return jsonify({"error": "Could not read the attached file. Try a different file."}), 400

    has_attachment = bool(image_bytes) or bool(file_text)

    if is_greeting:
        # Build a personalised greeting message; no user text required
        if weak_topics_hint:
            topics_str = ", ".join(weak_topics_hint[:3])
            message = (
                f"[SYSTEM: Generate a warm, encouraging opening greeting for a student. "
                f"Mention that you noticed they could use extra practice on: {topics_str}. "
                f"Keep it short (2-3 sentences). Do not give answers — just invite them to ask questions.]"
            )
        else:
            message = (
                "[SYSTEM: Generate a warm, short (2-3 sentence) opening greeting for a student. "
                "Invite them to ask any questions about their homework. Socratic style.]"
            )
    elif not message and not has_attachment:
        return jsonify({"error": "message is required"}), 400
    elif not message and has_attachment:
        # Attachment with no caption — synthesize a generic prompt so the
        # model has something to anchor on. The image_attached_block in the
        # system prompt handles the acknowledgement-then-redirect flow.
        if file_media_type == "image":
            message = "What do you see here?"
        elif file_media_type == "pdf":
            message = "What is in this document?"
        elif file_media_type == "word":
            message = "What is in this document?"
        else:
            message = "What is in this attachment?"
    else:
        # ── Input guardrails (skip for system-generated greeting messages) ────
        # Resolve education_level early so age-band topic blocks fire correctly.
        early_level = _get_education_level(student_id)
        valid_in, cleaned_msg = validate_input(
            message, role="student", education_level=early_level,
        )
        if not valid_in:
            log_ai_interaction(
                student_id, "student", "tutor", message, "", 0, 0,
                blocked=True, block_reason=cleaned_msg,
            )
            return jsonify({"error": cleaned_msg}), 403
        message = cleaned_msg

    conversation_id = body.get("conversation_id") or f"conv_{uuid.uuid4().hex[:12]}"

    # ── Load conversation history ─────────────────────────────────────────────
    # Prefer history from request body (mobile client sends it for offline support);
    # fall back to Firestore-persisted history when not provided.
    client_history: list[dict] = body.get("history") or []
    if client_history:
        history: list[dict] = client_history
        conv_doc = None
    else:
        conv_doc = get_doc("tutor_conversations", conversation_id)
        history = conv_doc.get("messages", []) if conv_doc else []

    # ── Build user context (country, curriculum, subject, education_level) ────
    user_ctx = get_user_context(student_id, "student")
    education_level = user_ctx.get("education_level") or _get_education_level(student_id)

    # ── Attach weakness context for personalised tutor behaviour ─────────────
    student_doc = get_doc("students", student_id)
    if student_doc:
        raw_weaknesses = student_doc.get("weaknesses") or []
        # Pass up to 5 most recent weak topics for the system prompt
        weak_topics = [
            w["topic"] for w in raw_weaknesses[:5]
            if w.get("topic")
        ]
        if weak_topics:
            user_ctx = {**user_ctx, "weakness_topics": weak_topics}

    # ── Aggregated weakness data (for "What are my weak areas?" queries) ─────
    # When the student asks about their weak areas, we want to report the
    # actual data — accuracy, attempts, last seen — rather than ask them to
    # pick a subject. The mobile client also caches this via /api/analytics/me
    # so it's available offline.
    is_weakness_query = bool(body.get("is_weakness_query")) or _is_weakness_query(message)
    if is_weakness_query:
        weakness_data = _student_weaknesses_aggregated(student_id)
        # Top 8 weakest topics is plenty for a tutor reply
        user_ctx = {
            **user_ctx,
            "weakness_data": weakness_data[:8],
            "is_weakness_query": True,
            "student_first_name": (student_doc or {}).get("first_name") or "",
        }

    # ── Inline extracted file text (PDF / Word) into the user message ────────
    # Image attachments stay as image_bytes for the multimodal call. Document
    # attachments are extracted to text up-front and appended so the model
    # can reason about them as part of the conversation.
    if file_text:
        suffix = f"\n\n[Attached {file_media_type.upper()} content]\n{file_text}"
        message = (message + suffix) if message else suffix.lstrip()

    # ── Route: all AI calls in this endpoint go to cloud ─────────────────────
    route_ai_request(AIRequestType.TUTORING)  # always AIRoute.CLOUD on the backend

    # ── Call tutor ────────────────────────────────────────────────────────────
    # Tutor raises classified NeriahErrors on failure (no more fake "I'm
    # having a little trouble" string) so the client can render a real
    # error toast instead of a hardcoded reply in an AI bubble.
    _t0 = time.time()
    try:
        response_text = student_tutor(message, history, education_level, image_bytes,
                                      user_context=user_ctx)
    except Exception as exc:  # noqa: BLE001 — re-raised after structured response
        from shared.errors import NeriahError  # noqa: PLC0415
        if isinstance(exc, NeriahError):
            return jsonify(exc.to_response()), exc.http_status
        logger.exception("tutor: unexpected failure")
        return jsonify({
            "error": "Something went wrong. Please try again.",
            "error_code": "TUTOR_UNEXPECTED",
        }), 500
    _latency_ms = int((time.time() - _t0) * 1000)

    # ── Output guardrails ─────────────────────────────────────────────────────
    valid_out, response_text = validate_output(response_text, role="student", context={})
    if not valid_out:
        log_ai_interaction(
            student_id, "student", "tutor", message, "", 0, _latency_ms,
            blocked=True, block_reason=response_text,
        )
        return jsonify({"error": "Response failed safety check. Please try again."}), 422

    # Confidence hedge: append a verify-with-teacher note when the response
    # asserts specific facts (years, percentages) without already hedging.
    response_text = apply_confidence_hedge(response_text, role="student")

    # ── Persist updated history ───────────────────────────────────────────────
    now = datetime.now(timezone.utc).isoformat()
    updated_history = history + [
        {"role": "user", "content": message},
        {"role": "assistant", "content": response_text},
    ]
    upsert("tutor_conversations", conversation_id, {
        "id": conversation_id,
        "student_id": student_id,
        "messages": updated_history,
        "created_at": conv_doc.get("created_at", now) if conv_doc else now,
        "updated_at": now,
    })

    # ── Increment usage counter ───────────────────────────────────────────────
    increment_usage(student_id)

    # ── Audit log ─────────────────────────────────────────────────────────────
    _tokens = len(response_text) // 4
    log_ai_interaction(
        student_id, "student", "tutor", message, response_text,
        tokens_used=_tokens, latency_ms=_latency_ms, blocked=False,
    )

    return jsonify({
        "response": _sanitize_user_visible_text(response_text),
        "conversation_id": conversation_id,
    }), 200
