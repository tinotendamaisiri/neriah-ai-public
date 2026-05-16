"""
Update a student's weakness and strength profile after a submission is approved.

Called synchronously after approval (wrapped in try/except — never blocks or
breaks the approve flow).

Weaknesses  — up to 20 most recent incorrect/partial verdict entries, newest first.
Strengths   — topics the student has answered correctly 3+ times, tracked via
              a per-topic tally on the student document.

Verdict entries stored on the student document:
  weaknesses: [
    {
      "topic": "short topic label",
      "question_text": "full question text (may be None)",
      "feedback": "AI feedback on what went wrong",
      "score": awarded_marks,
      "max_score": max_marks,
      "subject": "Mathematics",
      "education_level": "form_2",
      "homework_title": "Chapter 5 Test",
      "date": "2026-04-09T12:00:00Z"
    },
    ...
  ]
  strengths: ["Solving linear equations", ...]
  topic_correct_counts: {"Solving linear equations": 3, ...}

Maximum 20 weaknesses — oldest drop off as new homework is graded.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

_MAX_WEAKNESSES = 20
_STRENGTH_THRESHOLD = 3


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _extract_topic(verdict: dict, subject: str) -> str:
    """Derive a short readable topic label from a verdict."""
    q_text = (verdict.get("question_text") or "").strip()
    feedback = (verdict.get("feedback") or "").strip()
    q_num = verdict.get("question_number", "?")

    if q_text:
        # Use first sentence / first 70 chars of question text
        first_sentence = q_text.split(".")[0].split("?")[0].split("\n")[0]
        label = first_sentence.strip()[:70]
        if label:
            return label

    if feedback:
        # The AI feedback usually names the concept, e.g. "Simplify 3(2x+4)"
        first_sentence = feedback.split(".")[0].split("\n")[0]
        label = first_sentence.strip()[:70]
        if label and len(label) > 8:
            return label

    return f"{subject} — Question {q_num}"


def update_student_weaknesses(student_id: str, sub: dict) -> None:
    """
    Process verdicts from an approved submission and update the student's
    weakness/strength profile in Firestore.

    sub — the student_submissions document (must have mark_id and answer_key_id).

    Silently returns on any error — approval must never be blocked.
    """
    if not student_id:
        return
    try:
        _do_update(student_id, sub)
    except Exception:
        logger.exception(
            "[weakness_tracker] update failed for student=%s sub=%s",
            student_id, sub.get("id"),
        )


def _do_update(student_id: str, sub: dict) -> None:
    from shared.firestore_client import get_doc, upsert  # noqa: PLC0415

    # ── Fetch mark document (contains verdicts) ──────────────────────────────
    mark_id = sub.get("mark_id")
    if not mark_id:
        logger.debug("[weakness_tracker] no mark_id on sub %s — skipping", sub.get("id"))
        return

    mark = get_doc("marks", mark_id)
    if not mark:
        logger.debug("[weakness_tracker] mark %s not found — skipping", mark_id)
        return

    verdicts: list[dict] = mark.get("verdicts") or []
    if not verdicts:
        return

    # ── Fetch answer key for subject / edu_level / title ──────────────────────
    ak_id = sub.get("answer_key_id") or mark.get("answer_key_id", "")
    answer_key = get_doc("answer_keys", ak_id) if ak_id else None
    subject = (
        (answer_key.get("subject") or "") if answer_key else ""
    ) or sub.get("subject", "")
    education_level = (
        (answer_key.get("education_level") or "") if answer_key else ""
    ) or sub.get("education_level", "")
    homework_title = (
        (answer_key.get("title") or answer_key.get("subject") or "Assignment") if answer_key
        else "Assignment"
    )

    # ── Load current student doc ──────────────────────────────────────────────
    student = get_doc("students", student_id) or {}
    existing_weaknesses: list[dict] = list(student.get("weaknesses") or [])
    existing_strengths: list[str] = list(student.get("strengths") or [])
    topic_counts: dict[str, int] = dict(student.get("topic_correct_counts") or {})

    now = _now_iso()
    new_weaknesses: list[dict] = []

    for verdict in verdicts:
        v_type = (verdict.get("verdict") or "").lower()
        awarded = float(verdict.get("awarded_marks", 0))
        max_m = float(verdict.get("max_marks", 1))
        topic = _extract_topic(verdict, subject or "General")

        if v_type in ("incorrect", "partial"):
            # Add to weaknesses
            entry: dict = {
                "topic": topic,
                "question_text": (verdict.get("question_text") or "").strip() or None,
                "feedback": (verdict.get("feedback") or "").strip() or None,
                "score": awarded,
                "max_score": max_m,
                "subject": subject,
                "education_level": education_level,
                "homework_title": homework_title,
                "date": now,
            }
            new_weaknesses.append(entry)
            # A weak result resets the topic's correct count
            topic_counts[topic] = 0

        elif v_type == "correct":
            # Track correct count for strength detection
            topic_counts[topic] = topic_counts.get(topic, 0) + 1
            if topic_counts[topic] >= _STRENGTH_THRESHOLD and topic not in existing_strengths:
                existing_strengths.append(topic)

    if not new_weaknesses:
        # All correct — only update strengths if anything changed
        if topic_counts != dict(student.get("topic_correct_counts") or {}):
            upsert("students", student_id, {
                "strengths": existing_strengths,
                "topic_correct_counts": topic_counts,
            })
        return

    # Merge: new weaknesses at the front, cap at _MAX_WEAKNESSES
    merged = new_weaknesses + existing_weaknesses
    merged = merged[:_MAX_WEAKNESSES]

    upsert("students", student_id, {
        "weaknesses": merged,
        "strengths": existing_strengths,
        "topic_correct_counts": topic_counts,
    })

    logger.info(
        "[weakness_tracker] updated student=%s: +%d weak, strengths=%d",
        student_id, len(new_weaknesses), len(existing_strengths),
    )
