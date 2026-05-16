"""
Neriah Play — student-facing arcade-mode endpoints.

A "play lesson" is a bank of exactly 100 multiple-choice questions
generated from a chunk of source content (notes, chapter excerpts,
syllabus topics) the student supplies. Generation is one-shot: when the
source is sparse, the generator silently expands within the same domain
until the bank is full. There is no draft state and no expand/append
endpoints — every saved lesson is complete.

Routes (all mounted under /api/play):

  POST   /play/lessons                         create lesson + run cloud generator
  GET    /play/lessons                         list mine + class-shared lessons
  GET    /play/lessons/<id>                    fetch full lesson (incl. questions)
  DELETE /play/lessons/<id>                    owner-only cascade delete
  PATCH  /play/lessons/<id>/sharing            toggle class-share / allow-copy
  POST   /play/sessions                        record a play session outcome
  GET    /play/lessons/<id>/stats              best/last/total for the calling student

All routes require a student JWT. Authorisation is enforced per route:
the owner can do everything; classmates can only GET shared lessons.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from flask import Blueprint, jsonify, request

from shared.auth import require_role
from shared.firestore_client import (
    delete_doc,
    get_doc,
    query,
    upsert,
)
from shared.models import PlayLesson, PlaySession
from shared.observability import instrument_route

logger = logging.getLogger(__name__)
play_bp = Blueprint("play", __name__)


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _student_class_ids(student_doc: dict) -> list[str]:
    """Return the union of ``class_id`` and ``class_ids`` on a student doc.

    Older student records only had a single ``class_id``; newer multi-class
    enrolments use the plural list. We always merge so authorisation
    checks against both.
    """
    out: list[str] = []
    primary = student_doc.get("class_id")
    if primary:
        out.append(primary)
    for cid in student_doc.get("class_ids") or []:
        if cid and cid not in out:
            out.append(cid)
    return out


def _lesson_summary(lesson: dict, origin: str) -> dict:
    """Strip questions + source content for the list endpoint.

    Returning the full lesson for every list response would push tens of
    KB per student per call; the detail endpoint is the right place for it.
    """
    return {
        "id": lesson.get("id"),
        "title": lesson.get("title"),
        "subject": lesson.get("subject"),
        "grade": lesson.get("grade"),
        "owner_id": lesson.get("owner_id"),
        "question_count": lesson.get("question_count", 0),
        "created_at": lesson.get("created_at"),
        "shared_with_class": bool(lesson.get("shared_with_class", False)),
        "allow_copying": bool(lesson.get("allow_copying", False)),
        "class_id": lesson.get("class_id"),
        "origin": origin,  # 'mine' | 'class' | 'shared'
    }


def _can_read_lesson(lesson: dict, student_id: str, student_doc: dict) -> bool:
    """Owner can always read; classmates only when shared with their class."""
    if lesson.get("owner_id") == student_id:
        return True
    if not lesson.get("shared_with_class"):
        return False
    cid = lesson.get("class_id")
    if not cid:
        return False
    return cid in _student_class_ids(student_doc)


# ─── POST /play/lessons ───────────────────────────────────────────────────────

@play_bp.post("/play/lessons")
@instrument_route("play.lessons.create", "play")
def play_create_lesson():
    """Generate a new play lesson from supplied source content.

    Body:
        {
          "title": "Photosynthesis",
          "source_content": "...",
          "subject": "Biology",     # optional
          "grade":   "Form 3"       # optional
        }
    """
    student_id, err = require_role(request, "student")
    if err:
        return jsonify({"error": err}), 401

    body = request.get_json(silent=True) or {}
    title = (body.get("title") or "").strip()
    source_content = (body.get("source_content") or "").strip()
    subject = body.get("subject")
    grade = body.get("grade")

    if not title:
        return jsonify({"error": "title is required"}), 400
    if len(title) > 120:
        return jsonify({"error": "title must be ≤ 120 characters"}), 400
    if not source_content:
        return jsonify({"error": "source_content is required"}), 400

    # Load student to populate class_ids if the lesson is later shared.
    student = get_doc("students", student_id) or {}

    # Build a topic_hint for tier-1+ broader-concept generation. We DROP
    # the title from this hint because students often supply gibberish or
    # placeholder titles ("Bzbs", "Test", "Hw 1") — those poison the hint
    # and Gemma can't infer broader concepts from them. Subject + level
    # + the first sentence of the source content gives the model enough
    # signal to anchor on the actual topic.
    first_sentence = source_content.split(".", 1)[0].strip()
    if len(first_sentence) > 140:
        first_sentence = first_sentence[:140].rstrip() + "…"
    topic_hint = " · ".join(
        part for part in (
            first_sentence or None,
            subject if isinstance(subject, str) and subject.strip() else None,
            grade if isinstance(grade, str) and grade.strip() else None,
        ) if part
    )

    # Async fire-and-forget pattern. We create the lesson row with
    # status='generating' and return immediately so the mobile client
    # can navigate straight to the polling progress screen — even if
    # the user backgrounds the phone, the worker thread keeps running
    # to completion (Cloud Function deployed with --no-cpu-throttling
    # so CPU stays allocated outside the active request). The mobile
    # polls GET /play/lessons/<id> every few seconds and renders
    # final state when status flips to 'ready' or 'failed'.
    lesson = PlayLesson(
        title=title,
        subject=subject if isinstance(subject, str) and subject.strip() else None,
        grade=grade if isinstance(grade, str) and grade.strip() else None,
        owner_id=student_id,
        owner_role="student",
        source_content=source_content,
        questions=[],
        question_count=0,
        status="generating",
    )
    upsert("play_lessons", lesson.id, lesson.model_dump())

    _spawn_generation_worker(
        lesson_id=lesson.id,
        source_content=source_content,
        topic_hint=topic_hint or None,
        student_id=student_id,
    )

    out = lesson.model_dump()
    out["origin"] = "mine"
    primary_class_ids = _student_class_ids(student)
    out["primary_class_id"] = primary_class_ids[0] if primary_class_ids else None
    return jsonify(out), 201


def _spawn_generation_worker(
    *,
    lesson_id: str,
    source_content: str,
    topic_hint: Optional[str],
    student_id: str,
) -> None:
    """Kick off the actual question-bank generation in a daemon thread.
    Updates the play_lessons doc when done — status='ready' on success
    with the full question bank attached, status='failed' on safety-
    valve trip or unexpected error with `error_message` populated.
    """
    import threading

    def _worker():
        try:
            from shared.play_generator import (
                generate_lesson_questions,
                GenerationFellShortError,
            )
            try:
                questions, count, was_expanded = generate_lesson_questions(
                    source_content=source_content,
                    target=100,
                    topic_hint=topic_hint,
                )
            except GenerationFellShortError as exc:
                logger.warning(
                    "[play] generation fell short for lesson=%s student=%s: %d/%d",
                    lesson_id, student_id, exc.achieved, exc.target,
                )
                upsert("play_lessons", lesson_id, {
                    "status": "failed",
                    "error_message": (
                        "We couldn't build a full game from that topic. Try "
                        "adding more detail to your notes or pick a slightly "
                        "broader topic."
                    ),
                })
                return
            except Exception:
                logger.exception(
                    "[play] generation worker failed for lesson=%s student=%s",
                    lesson_id, student_id,
                )
                upsert("play_lessons", lesson_id, {
                    "status": "failed",
                    "error_message": (
                        "We couldn't build a quiz from that content right "
                        "now. Please try again in a minute."
                    ),
                })
                return

            upsert("play_lessons", lesson_id, {
                "status": "ready",
                "questions": [q.model_dump() for q in questions],
                "question_count": count,
                "was_expanded": was_expanded,
            })
        except Exception:
            # Never let the worker thread leak an exception that would
            # leave the lesson stuck in 'generating'.
            logger.exception(
                "[play] worker outer exception for lesson=%s", lesson_id,
            )
            try:
                upsert("play_lessons", lesson_id, {
                    "status": "failed",
                    "error_message": "Generation worker crashed unexpectedly.",
                })
            except Exception:
                pass

    t = threading.Thread(target=_worker, name=f"play-gen-{lesson_id}", daemon=True)
    t.start()


# ─── POST /play/lessons/import ────────────────────────────────────────────────

_MIN_IMPORT_QUESTIONS = 1
_MAX_IMPORT_QUESTIONS = 200


def _sanitise_imported_questions(raw: list) -> list[dict]:
    """Validate each row against the PlayQuestion contract; drop bad ones.

    The mobile sync worker can hand us partially-malformed rows when the
    on-device LiteRT-LM generator wedges or the JSON parser repairs an
    answer that's off-spec. We never accept invalid questions into the
    persisted lesson — we filter them out and let the caller decide
    whether the survivors are enough to call the lesson "ready".
    """
    from pydantic import ValidationError
    from shared.models import PlayQuestion

    out: list[dict] = []
    if not isinstance(raw, list):
        return out
    for row in raw:
        if not isinstance(row, dict):
            continue
        try:
            q = PlayQuestion(
                prompt=row.get("prompt") or "",
                options=row.get("options") or [],
                correct=row.get("correct") if isinstance(row.get("correct"), int) else -1,
            )
        except ValidationError:
            continue
        out.append(q.model_dump())
    return out


@play_bp.post("/play/lessons/import")
@instrument_route("play.lessons.import", "play")
def play_import_lesson():
    """Persist a lesson generated on-device.

    The mobile sync worker calls this after `lessonGenerator.ts` finishes
    its offline run. We never invoke Vertex from here — the bank is taken
    as-is from the body and validated client-of-record (PlayQuestion).
    """
    student_id, err = require_role(request, "student")
    if err:
        return jsonify({"error": err}), 401

    body = request.get_json(silent=True) or {}
    title = (body.get("title") or "").strip()
    if not title:
        return jsonify({"error": "title is required"}), 400
    if len(title) > 120:
        return jsonify({"error": "title must be ≤ 120 characters"}), 400

    raw_questions = body.get("questions")
    if not isinstance(raw_questions, list) or len(raw_questions) < _MIN_IMPORT_QUESTIONS:
        return jsonify({"error": "questions must be a non-empty list"}), 400
    if len(raw_questions) > _MAX_IMPORT_QUESTIONS:
        return jsonify({
            "error": f"questions must contain at most {_MAX_IMPORT_QUESTIONS} entries",
        }), 400

    questions = _sanitise_imported_questions(raw_questions)
    if not questions:
        return jsonify({
            "error": "no valid questions in payload after validation",
        }), 400

    student = get_doc("students", student_id) or {}

    subject = body.get("subject")
    grade = body.get("grade")
    source_content = (body.get("source_content") or "").strip()
    was_expanded = bool(body.get("was_expanded", False))

    lesson = PlayLesson(
        title=title,
        subject=subject if isinstance(subject, str) and subject.strip() else None,
        grade=grade if isinstance(grade, str) and grade.strip() else None,
        owner_id=student_id,
        owner_role="student",
        source_content=source_content,
        questions=[],  # supplied separately below as raw dicts
        question_count=len(questions),
        status="ready",
        was_expanded=was_expanded,
    )
    payload = lesson.model_dump()
    payload["questions"] = questions
    upsert("play_lessons", lesson.id, payload)

    out = {**payload, "origin": "mine"}
    primary_class_ids = _student_class_ids(student)
    out["primary_class_id"] = primary_class_ids[0] if primary_class_ids else None
    return jsonify(out), 201


# ─── POST /play/lessons/recommended ───────────────────────────────────────────

_RECOMMENDED_WEAKNESS_THRESHOLD = 10
_RECOMMENDED_SOURCE_LIMIT = 10


def _build_weakness_source(weaknesses: list) -> str:
    """Render the first N weakness entries into a generator-friendly prompt."""
    lines: list[str] = []
    for entry in weaknesses[:_RECOMMENDED_SOURCE_LIMIT]:
        if not isinstance(entry, dict):
            continue
        topic = (entry.get("topic") or "").strip()
        feedback = (entry.get("feedback") or "").strip()
        question_text = (entry.get("question_text") or "").strip()
        if not topic:
            continue
        line = f"Topic: {topic}"
        if question_text:
            line += f"\n  Question they missed: {question_text}"
        if feedback:
            line += f"\n  Where they went wrong: {feedback}"
        lines.append(line)
    return "\n\n".join(lines)


def _weakness_subject_anchor(weaknesses: list) -> Optional[str]:
    """Pick the most common subject across the weakness entries (or first)."""
    counts: dict[str, int] = {}
    first: Optional[str] = None
    for entry in weaknesses:
        if not isinstance(entry, dict):
            continue
        subj = (entry.get("subject") or "").strip()
        if not subj:
            continue
        if first is None:
            first = subj
        counts[subj] = counts.get(subj, 0) + 1
    if not counts:
        return first
    return max(counts.items(), key=lambda kv: kv[1])[0]


@play_bp.post("/play/lessons/recommended")
@instrument_route("play.lessons.recommended", "play")
def play_recommended_lesson():
    """Build a weakness-driven lesson personalised to the calling student.

    Reads ``student.weaknesses`` (populated by ``shared/weakness_tracker``
    after every approved submission). Below the minimum threshold the
    student doesn't have enough graded work to drive a useful lesson and
    we tell them so; above it we kick the same generation worker the
    notes-based path uses.
    """
    student_id, err = require_role(request, "student")
    if err:
        return jsonify({"error": err}), 401

    student = get_doc("students", student_id) or {}
    weaknesses = student.get("weaknesses") or []
    weakness_count = len(weaknesses) if isinstance(weaknesses, list) else 0

    if weakness_count < _RECOMMENDED_WEAKNESS_THRESHOLD:
        return jsonify({
            "error": (
                "Not enough info yet — submit at least "
                f"{_RECOMMENDED_WEAKNESS_THRESHOLD} graded assignments "
                "and Neriah will build a personalised game for you."
            ),
            "error_code": "not_enough_data",
            "weakness_count": weakness_count,
            "threshold": _RECOMMENDED_WEAKNESS_THRESHOLD,
        }), 400

    source_content = _build_weakness_source(weaknesses)
    if not source_content:
        # All weakness rows were malformed — fall through to the same
        # error path so the mobile shows the friendly message.
        return jsonify({
            "error": (
                "Not enough info yet — submit at least "
                f"{_RECOMMENDED_WEAKNESS_THRESHOLD} graded assignments "
                "and Neriah will build a personalised game for you."
            ),
            "error_code": "not_enough_data",
            "weakness_count": weakness_count,
            "threshold": _RECOMMENDED_WEAKNESS_THRESHOLD,
        }), 400

    subject = _weakness_subject_anchor(weaknesses)
    topic_hint = "weakness review"
    if subject:
        topic_hint = f"weakness review · {subject}"

    lesson = PlayLesson(
        title="Recommended for me",
        subject=subject,
        grade=None,
        owner_id=student_id,
        owner_role="student",
        source_content=source_content,
        questions=[],
        question_count=0,
        status="generating",
        recommended=True,
    )
    upsert("play_lessons", lesson.id, lesson.model_dump())

    _spawn_generation_worker(
        lesson_id=lesson.id,
        source_content=source_content,
        topic_hint=topic_hint,
        student_id=student_id,
    )

    out = lesson.model_dump()
    out["origin"] = "mine"
    primary_class_ids = _student_class_ids(student)
    out["primary_class_id"] = primary_class_ids[0] if primary_class_ids else None
    return jsonify(out), 201


# ─── GET /play/lessons ────────────────────────────────────────────────────────

@play_bp.get("/play/lessons")
@instrument_route("play.lessons.list", "play")
def play_list_lessons():
    """Return the calling student's own lessons + any class-shared ones.

    Each entry is tagged ``origin: 'mine' | 'class'`` so the FE can pick a
    different card style per group. Detail (questions, source_content) is
    NOT included — the detail endpoint serves that.
    """
    student_id, err = require_role(request, "student")
    if err:
        return jsonify({"error": err}), 401

    student = get_doc("students", student_id) or {}
    class_ids = _student_class_ids(student)

    mine = query(
        "play_lessons",
        [("owner_id", "==", student_id)],
        order_by="created_at",
        direction="DESCENDING",
    )

    # Firestore "in" supports up to 30 values; classroom counts are well
    # under that, so a single query covers every class the student is in.
    shared: list[dict] = []
    if class_ids:
        try:
            shared = query(
                "play_lessons",
                [
                    ("class_id", "in", class_ids),
                    ("shared_with_class", "==", True),
                ],
                order_by="created_at",
                direction="DESCENDING",
            )
        except Exception:
            logger.exception("[play] shared lessons query failed for student=%s", student_id)
            shared = []

    out: list[dict] = []
    seen: set[str] = set()
    for lesson in mine:
        lid = lesson.get("id")
        if not lid or lid in seen:
            continue
        seen.add(lid)
        out.append(_lesson_summary(lesson, "mine"))
    for lesson in shared:
        lid = lesson.get("id")
        if not lid or lid in seen:
            continue
        # Defensive: don't double-tag a lesson the student happens to own.
        if lesson.get("owner_id") == student_id:
            continue
        seen.add(lid)
        out.append(_lesson_summary(lesson, "class"))

    out.sort(key=lambda r: r.get("created_at") or "", reverse=True)
    return jsonify(out), 200


# ─── GET /play/lessons/<id> ──────────────────────────────────────────────────

@play_bp.get("/play/lessons/<lesson_id>")
@instrument_route("play.lessons.detail", "play")
def play_lesson_detail(lesson_id: str):
    """Full lesson incl. questions + source_content. Owner OR class-shared."""
    student_id, err = require_role(request, "student")
    if err:
        return jsonify({"error": err}), 401

    lesson = get_doc("play_lessons", lesson_id)
    if not lesson:
        return jsonify({"error": "Lesson not found"}), 404

    student = get_doc("students", student_id) or {}
    if not _can_read_lesson(lesson, student_id, student):
        return jsonify({"error": "forbidden"}), 403

    # Tag origin so a single FE component handles both "mine" and "class".
    origin = "mine" if lesson.get("owner_id") == student_id else "class"
    lesson_out = dict(lesson)
    lesson_out["origin"] = origin
    return jsonify(lesson_out), 200


# ─── DELETE /play/lessons/<id> ───────────────────────────────────────────────

@play_bp.delete("/play/lessons/<lesson_id>")
@instrument_route("play.lessons.delete", "play")
def play_lesson_delete(lesson_id: str):
    """Owner only. Cascade-deletes every play_session attached to the
    lesson so leaderboard/stats queries can't hang on orphan rows.
    """
    student_id, err = require_role(request, "student")
    if err:
        return jsonify({"error": err}), 401

    lesson = get_doc("play_lessons", lesson_id)
    if not lesson:
        return jsonify({"error": "Lesson not found"}), 404
    if lesson.get("owner_id") != student_id:
        return jsonify({"error": "forbidden"}), 403

    # Cascade-delete every linked session. This is a best-effort sweep;
    # individual delete failures are logged but don't abort the lesson
    # deletion (which is the user-visible action).
    sessions = query("play_sessions", [("lesson_id", "==", lesson_id)])
    deleted_sessions = 0
    for s in sessions:
        sid = s.get("id")
        if not sid:
            continue
        try:
            delete_doc("play_sessions", sid)
            deleted_sessions += 1
        except Exception:
            logger.exception("[play] failed to delete session %s", sid)

    try:
        delete_doc("play_lessons", lesson_id)
    except Exception:
        logger.exception("[play] failed to delete lesson %s", lesson_id)
        return jsonify({"error": "Delete failed"}), 500

    return jsonify({
        "deleted": True,
        "lesson_id": lesson_id,
        "sessions_deleted": deleted_sessions,
    }), 200


# ─── PATCH /play/lessons/<id>/sharing ────────────────────────────────────────

@play_bp.patch("/play/lessons/<lesson_id>/sharing")
@instrument_route("play.lessons.sharing", "play")
def play_lesson_sharing(lesson_id: str):
    """Owner-only toggle for class sharing + allow-copy.

    Body:
        {
          "shared_with_class": true,
          "allow_copying":     false,
          "class_id":          "cls_..."   # required when shared_with_class=true
                                            # (falls back to student's first class)
        }
    """
    student_id, err = require_role(request, "student")
    if err:
        return jsonify({"error": err}), 401

    lesson = get_doc("play_lessons", lesson_id)
    if not lesson:
        return jsonify({"error": "Lesson not found"}), 404
    if lesson.get("owner_id") != student_id:
        return jsonify({"error": "forbidden"}), 403

    body = request.get_json(silent=True) or {}
    shared_with_class = bool(body.get("shared_with_class", False))
    allow_copying = bool(body.get("allow_copying", False))
    class_id: Optional[str] = body.get("class_id") or lesson.get("class_id")

    if shared_with_class:
        if not class_id:
            student = get_doc("students", student_id) or {}
            class_ids = _student_class_ids(student)
            class_id = class_ids[0] if class_ids else None
        if not class_id:
            return jsonify({
                "error": "class_id is required to share — your account is not enrolled in any class."
            }), 400

    updates = {
        "shared_with_class": shared_with_class,
        "allow_copying": allow_copying,
        "class_id": class_id if shared_with_class else None,
    }
    upsert("play_lessons", lesson_id, updates)

    merged = {**lesson, **updates}
    return jsonify({
        "lesson_id": lesson_id,
        "shared_with_class": merged["shared_with_class"],
        "allow_copying": merged["allow_copying"],
        "class_id": merged.get("class_id"),
    }), 200


# ─── POST /play/sessions ─────────────────────────────────────────────────────

@play_bp.post("/play/sessions")
@instrument_route("play.sessions.create", "play")
def play_session_create():
    """Record a play session. Server stamps id + player_id; lesson access
    is verified before the row is written."""
    student_id, err = require_role(request, "student")
    if err:
        return jsonify({"error": err}), 401

    body = request.get_json(silent=True) or {}
    lesson_id = (body.get("lesson_id") or "").strip()
    if not lesson_id:
        return jsonify({"error": "lesson_id is required"}), 400

    lesson = get_doc("play_lessons", lesson_id)
    if not lesson:
        return jsonify({"error": "Lesson not found"}), 404

    student = get_doc("students", student_id) or {}
    if not _can_read_lesson(lesson, student_id, student):
        return jsonify({"error": "forbidden"}), 403

    session_id = f"play_{uuid.uuid4().hex[:12]}"
    try:
        session = PlaySession(
            id=session_id,
            lesson_id=lesson_id,
            player_id=student_id,
            game_format=body.get("game_format") or "",
            started_at=body.get("started_at") or _now_iso(),
            ended_at=body.get("ended_at") or _now_iso(),
            duration_seconds=int(body.get("duration_seconds") or 0),
            final_score=int(body.get("final_score") or 0),
            questions_attempted=int(body.get("questions_attempted") or 0),
            questions_correct=int(body.get("questions_correct") or 0),
            end_reason=body.get("end_reason") or "",
        )
    except (TypeError, ValueError) as exc:
        return jsonify({"error": f"invalid session payload: {exc}"}), 400

    upsert("play_sessions", session.id, session.model_dump())
    return jsonify(session.model_dump()), 201


# ─── GET /play/lessons/<id>/stats ────────────────────────────────────────────

@play_bp.get("/play/lessons/<lesson_id>/stats")
@instrument_route("play.lessons.stats", "play")
def play_lesson_stats(lesson_id: str):
    """Return the calling student's best/last/total for the lesson."""
    student_id, err = require_role(request, "student")
    if err:
        return jsonify({"error": err}), 401

    lesson = get_doc("play_lessons", lesson_id)
    if not lesson:
        return jsonify({"error": "Lesson not found"}), 404

    student = get_doc("students", student_id) or {}
    if not _can_read_lesson(lesson, student_id, student):
        return jsonify({"error": "forbidden"}), 403

    sessions = query(
        "play_sessions",
        [("player_id", "==", student_id), ("lesson_id", "==", lesson_id)],
        order_by="started_at",
        direction="DESCENDING",
    )

    best_score = 0
    last_played: Optional[str] = None
    for s in sessions:
        try:
            score = int(s.get("final_score") or 0)
        except (TypeError, ValueError):
            score = 0
        if score > best_score:
            best_score = score
        ts = s.get("started_at")
        if ts and (last_played is None or ts > last_played):
            last_played = ts

    return jsonify({
        "lesson_id": lesson_id,
        "best_score": best_score,
        "last_played": last_played,
        "total_sessions": len(sessions),
    }), 200
