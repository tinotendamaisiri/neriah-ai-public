"""
GET /api/students/{student_id}/suggestions

Returns personalised study suggestions derived from the student's most recent
weakness/strength profile (stored on the student document by weakness_tracker).

Auth: student JWT — student can only see their own suggestions.
"""

from __future__ import annotations

import logging

from flask import Blueprint, jsonify, request

from shared.auth import require_role
from shared.firestore_client import get_doc
from shared.observability import instrument_route

logger = logging.getLogger(__name__)
suggestions_bp = Blueprint("suggestions", __name__)

_PRIORITY_HIGH   = "high"
_PRIORITY_MEDIUM = "medium"


def _priority(entry: dict) -> str:
    """high = scored 0 (incorrect), medium = scored partial marks."""
    score   = float(entry.get("score", 0))
    max_s   = float(entry.get("max_score", 1))
    if score == 0 or max_s == 0:
        return _PRIORITY_HIGH
    if score < max_s:
        return _PRIORITY_MEDIUM
    return _PRIORITY_MEDIUM  # fallback (should not happen — stored only for incorrect/partial)


def _build_tutor_prompt(entry: dict) -> str:
    """Pre-built prompt the student can tap to open the tutor on this topic."""
    topic   = entry.get("topic", "")
    subject = entry.get("subject", "")
    q_text  = entry.get("question_text") or ""

    if q_text and len(q_text) < 120:
        return f"Help me understand this question: {q_text}"
    if subject:
        return f"Help me understand {topic} in {subject}"
    return f"Help me understand {topic}"


def _build_reason(entry: dict) -> str:
    """Human-readable reason shown under each suggestion chip."""
    score   = entry.get("score", 0)
    max_s   = entry.get("max_score", 1)
    title   = entry.get("homework_title", "your last homework")
    subject = entry.get("subject", "")

    score_str = f"{int(score)}/{int(max_s)}"
    ctx = f" in {subject} — {title}" if subject else f" in {title}"
    return f"You scored {score_str}{ctx}"


@suggestions_bp.get("/students/<student_id>/suggestions")
@instrument_route("suggestions.list", "suggestions")
def get_suggestions(student_id: str):
    req_student_id, err = require_role(request, "student")
    if err:
        return jsonify({"error": err}), 401

    if req_student_id != student_id:
        return jsonify({"error": "forbidden"}), 403

    student = get_doc("students", student_id)
    if not student:
        return jsonify({"error": "Student not found"}), 404

    raw_weaknesses: list[dict] = student.get("weaknesses") or []
    raw_strengths:  list[str]  = student.get("strengths") or []

    if not raw_weaknesses:
        return jsonify({"suggestions": [], "strengths": []}), 200

    # Deduplicate by topic — keep the most recent entry per topic
    seen_topics: set[str] = set()
    deduped: list[dict] = []
    for entry in raw_weaknesses:  # already newest-first from tracker
        topic = (entry.get("topic") or "").strip()
        if topic and topic not in seen_topics:
            seen_topics.add(topic)
            deduped.append(entry)

    # Build suggestion objects, sort: high → medium, then by recency (already ordered)
    suggestions = []
    for entry in deduped:
        priority = _priority(entry)
        suggestions.append({
            "topic":    entry.get("topic", ""),
            "reason":   _build_reason(entry),
            "subject":  entry.get("subject", ""),
            "priority": priority,
            "prompt":   _build_tutor_prompt(entry),
            "date":     entry.get("date", ""),
        })

    # High before medium, preserve recency order within each group
    suggestions.sort(key=lambda s: 0 if s["priority"] == _PRIORITY_HIGH else 1)

    # Strengths — each as a small object for consistent shape
    strengths = [
        {
            "topic":  t,
            "reason": "You got this right 3 times in a row",
        }
        for t in raw_strengths
    ]

    return jsonify({"suggestions": suggestions, "strengths": strengths}), 200
