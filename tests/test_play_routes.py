"""
Integration tests for functions/play.py.

All Firestore reads/writes go through patched ``shared.firestore_client``
helpers; the Gemma generator is mocked at the import site inside
``functions.play`` so the routes never call out to Vertex.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

from shared.models import PlayQuestion


# ─── Constants ────────────────────────────────────────────────────────────────

OWNER_ID = "play-student-owner"
CLASSMATE_ID = "play-student-classmate"
OUTSIDER_ID = "play-student-outsider"
CLASS_ID = "play-class-001"
LESSON_ID = "play-lesson-001"


# ─── Shared fixtures ──────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def app():
    from main import app as flask_app
    flask_app.config["TESTING"] = True
    return flask_app


@pytest.fixture(scope="module")
def client(app):
    return app.test_client()


def _auth(student_id: str) -> dict:
    from shared.auth import create_jwt
    return {"Authorization": f"Bearer {create_jwt(student_id, 'student', 1)}"}


@pytest.fixture(autouse=True)
def bypass_token_version_check():
    """``require_role`` does a Firestore round-trip to validate
    token_version. Stub it across the whole suite — we patch get_doc per
    test for our own data, but the auth-layer call only needs to return
    None to be treated as 'no version recorded'."""
    with patch("shared.firestore_client.get_doc", return_value=None):
        yield


# ─── Helpers to build mock Firestore data ─────────────────────────────────────

def _student_doc(student_id: str, class_ids: list[str] | None = None) -> dict:
    primary = (class_ids or [None])[0]
    return {
        "id": student_id,
        "first_name": "Test",
        "surname": "Student",
        "class_id": primary,
        "class_ids": class_ids or [],
        "role": "student",
        "token_version": 1,
    }


def _question_dict(prompt: str) -> dict:
    return PlayQuestion(
        prompt=prompt,
        options=["alpha", "bravo", "charlie", "delta"],
        correct=0,
    ).model_dump()


def _lesson_doc(
    *,
    owner_id: str = OWNER_ID,
    shared: bool = False,
    class_id: str | None = None,
    questions: int = 100,
) -> dict:
    qs = [_question_dict(f"Prompt {i}") for i in range(questions)]
    return {
        "id": LESSON_ID,
        "title": "Photosynthesis Drill",
        "subject": "Biology",
        "grade": "Form 3",
        "owner_id": owner_id,
        "owner_role": "student",
        "source_content": "Photosynthesis is the process...",
        "questions": qs,
        "question_count": len(qs),
        "created_at": "2026-04-01T00:00:00+00:00",
        "shared_with_class": shared,
        "allow_copying": False,
        "class_id": class_id,
    }


# ─── Tests ────────────────────────────────────────────────────────────────────

class TestCreateLesson:
    """POST /play/lessons + GET /play/lessons listing logic."""

    def test_create_lesson_owner_only_visible_in_my_list(self, client):
        """A freshly created lesson by OWNER must appear with origin='mine'
        in OWNER's list, and must NOT appear (un-shared) in CLASSMATE's
        list."""
        saved: dict = {}
        # Synthetic generator output — exactly 100 questions per the contract.
        generated = [
            PlayQuestion(
                prompt=f"Prompt {i}",
                options=["a", "b", "c", "d"],
                correct=0,
            )
            for i in range(100)
        ]

        owner_student = _student_doc(OWNER_ID, [CLASS_ID])
        classmate_student = _student_doc(CLASSMATE_ID, [CLASS_ID])

        # ── Stage 1: OWNER creates lesson ────────────────────────────────────
        # The route is async — it spawns a worker thread and returns 201
        # with status='generating' immediately. We patch the spawner to
        # run the equivalent generation synchronously so the test can
        # observe the full final state in `saved`.
        from shared.models import PlayLesson  # local import to avoid cycles

        def _sync_worker(*, lesson_id, source_content, topic_hint, student_id):  # noqa: ARG001
            # Mirror the worker body but synchronous: write a 'ready'
            # row with the generated questions.
            current = saved.get(lesson_id, {})
            current.update({
                "status": "ready",
                "questions": [q.model_dump() for q in generated],
                "question_count": 100,
                "was_expanded": False,
            })
            saved[lesson_id] = current

        with patch(
            "shared.play_generator.generate_lesson_questions",
            return_value=(generated, 100, False),
        ), patch(
            "functions.play.get_doc",
            side_effect=lambda c, d: owner_student if (c, d) == ("students", OWNER_ID) else None,
        ), patch(
            "functions.play.upsert",
            side_effect=lambda c, _id, data: saved.update({_id: {**saved.get(_id, {}), **data, "id": _id}}),
        ), patch(
            "functions.play._spawn_generation_worker",
            side_effect=_sync_worker,
        ):
            resp = client.post(
                "/api/play/lessons",
                headers=_auth(OWNER_ID),
                json={
                    "title": "Photosynthesis Drill",
                    "source_content": "Photosynthesis is the process by which plants convert sunlight to sugar.",
                    "subject": "Biology",
                    "grade": "Form 3",
                },
            )

        assert resp.status_code == 201, resp.get_data(as_text=True)
        body = resp.get_json()
        new_lesson_id = body["id"]
        assert body["owner_id"] == OWNER_ID
        assert "is_draft" not in body
        assert new_lesson_id in saved
        # The final state in `saved` is what the worker wrote — full bank,
        # ready status. The route response itself is the placeholder row
        # (status='generating') that the mobile would poll on.
        assert saved[new_lesson_id]["question_count"] == 100
        assert saved[new_lesson_id]["status"] == "ready"

        saved_lesson = saved[new_lesson_id]
        # ── Stage 2: list as OWNER ───────────────────────────────────────────
        def _query_for_owner(collection, filters, **kwargs):
            if collection != "play_lessons":
                return []
            for f in filters:
                if f[0] == "owner_id" and f[1] == "==" and f[2] == OWNER_ID:
                    return [saved_lesson]
                if f[0] == "shared_with_class":
                    return []
            return []

        with patch(
            "functions.play.get_doc",
            side_effect=lambda c, d: owner_student if (c, d) == ("students", OWNER_ID) else None,
        ), patch("functions.play.query", side_effect=_query_for_owner):
            list_resp = client.get("/api/play/lessons", headers=_auth(OWNER_ID))
        assert list_resp.status_code == 200
        rows = list_resp.get_json()
        assert any(r["id"] == new_lesson_id and r["origin"] == "mine" for r in rows), rows

        # ── Stage 3: list as CLASSMATE — un-shared lesson must NOT appear ───
        def _query_for_classmate(collection, filters, **kwargs):
            if collection != "play_lessons":
                return []
            # CLASSMATE has no lessons of their own, and the un-shared lesson
            # should never come back from a shared_with_class==true query.
            return []

        with patch(
            "functions.play.get_doc",
            side_effect=lambda c, d: classmate_student if (c, d) == ("students", CLASSMATE_ID) else None,
        ), patch("functions.play.query", side_effect=_query_for_classmate):
            classmate_list = client.get("/api/play/lessons", headers=_auth(CLASSMATE_ID))
        assert classmate_list.status_code == 200
        assert classmate_list.get_json() == []


class TestSharingAndAccess:
    """Sharing toggle + class-shared visibility + non-classmate denial."""

    def test_lesson_shared_with_class_appears_for_classmates(self, client):
        shared_lesson = _lesson_doc(
            owner_id=OWNER_ID,
            shared=True,
            class_id=CLASS_ID,
            questions=80,
        )
        classmate = _student_doc(CLASSMATE_ID, [CLASS_ID])

        def _query(collection, filters, **kwargs):
            if collection != "play_lessons":
                return []
            for f in filters:
                if f[0] == "owner_id":
                    # Classmate has no own lessons.
                    return []
                if f[0] == "shared_with_class":
                    return [shared_lesson]
            return []

        with patch(
            "functions.play.get_doc",
            side_effect=lambda c, d: classmate if (c, d) == ("students", CLASSMATE_ID) else None,
        ), patch("functions.play.query", side_effect=_query):
            resp = client.get("/api/play/lessons", headers=_auth(CLASSMATE_ID))

        assert resp.status_code == 200
        rows = resp.get_json()
        assert len(rows) == 1
        assert rows[0]["id"] == LESSON_ID
        assert rows[0]["origin"] == "class"
        assert rows[0]["shared_with_class"] is True

    def test_lesson_not_shared_returns_403_to_classmate_via_get_detail(self, client):
        """An un-shared lesson is forbidden to anyone but the owner — even
        a classmate of the owner."""
        unshared = _lesson_doc(owner_id=OWNER_ID, shared=False, class_id=None)
        classmate = _student_doc(CLASSMATE_ID, [CLASS_ID])

        def _get_doc(collection, doc_id):
            if (collection, doc_id) == ("play_lessons", LESSON_ID):
                return unshared
            if (collection, doc_id) == ("students", CLASSMATE_ID):
                return classmate
            return None

        with patch("functions.play.get_doc", side_effect=_get_doc):
            resp = client.get(
                f"/api/play/lessons/{LESSON_ID}",
                headers=_auth(CLASSMATE_ID),
            )
        assert resp.status_code == 403

    def test_share_toggle_persists_class_id(self, client):
        """PATCH /play/lessons/<id>/sharing with shared_with_class=true
        falls back to the owner's first class when class_id is omitted,
        and the resulting upsert payload includes the class_id."""
        lesson = _lesson_doc(owner_id=OWNER_ID, shared=False, class_id=None)
        owner = _student_doc(OWNER_ID, [CLASS_ID, "play-class-002"])
        captured: dict = {}

        def _get_doc(collection, doc_id):
            if (collection, doc_id) == ("play_lessons", LESSON_ID):
                return lesson
            if (collection, doc_id) == ("students", OWNER_ID):
                return owner
            return None

        with patch("functions.play.get_doc", side_effect=_get_doc), patch(
            "functions.play.upsert",
            side_effect=lambda c, _id, data: captured.update({"col": c, "id": _id, "data": data}),
        ):
            resp = client.patch(
                f"/api/play/lessons/{LESSON_ID}/sharing",
                headers=_auth(OWNER_ID),
                json={"shared_with_class": True, "allow_copying": True},
            )

        assert resp.status_code == 200, resp.get_data(as_text=True)
        body = resp.get_json()
        assert body["shared_with_class"] is True
        assert body["allow_copying"] is True
        assert body["class_id"] == CLASS_ID
        # And the persisted data also carries class_id.
        assert captured["data"]["class_id"] == CLASS_ID
        assert captured["data"]["shared_with_class"] is True


class TestDeleteCascade:
    def test_delete_cascades_play_sessions(self, client):
        """DELETE /play/lessons/<id> deletes every linked play_session."""
        lesson = _lesson_doc(owner_id=OWNER_ID, shared=False)
        sessions = [
            {"id": "play_sess_a", "lesson_id": LESSON_ID, "player_id": OWNER_ID},
            {"id": "play_sess_b", "lesson_id": LESSON_ID, "player_id": CLASSMATE_ID},
            {"id": "play_sess_c", "lesson_id": LESSON_ID, "player_id": OWNER_ID},
        ]
        deleted: list[tuple[str, str]] = []

        def _get_doc(collection, doc_id):
            if (collection, doc_id) == ("play_lessons", LESSON_ID):
                return lesson
            return None

        def _query(collection, filters, **kwargs):
            if collection == "play_sessions":
                return sessions
            return []

        with patch("functions.play.get_doc", side_effect=_get_doc), patch(
            "functions.play.query", side_effect=_query,
        ), patch(
            "functions.play.delete_doc",
            side_effect=lambda c, _id: deleted.append((c, _id)),
        ):
            resp = client.delete(
                f"/api/play/lessons/{LESSON_ID}",
                headers=_auth(OWNER_ID),
            )

        assert resp.status_code == 200, resp.get_data(as_text=True)
        body = resp.get_json()
        assert body["deleted"] is True
        assert body["sessions_deleted"] == 3
        # Three sessions + the lesson itself.
        assert len(deleted) == 4
        assert ("play_lessons", LESSON_ID) in deleted
        for s in sessions:
            assert ("play_sessions", s["id"]) in deleted
