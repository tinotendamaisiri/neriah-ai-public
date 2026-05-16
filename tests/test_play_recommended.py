"""
Tests for POST /play/lessons/recommended.

The endpoint reads the student's weakness profile (populated by
shared.weakness_tracker after every approved submission) and feeds it
into the same generation pipeline that drives notes-based lessons.
Below the minimum-weakness threshold it returns a friendly
not-enough-data error; above it, it spawns the generation worker.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest


STUDENT_ID = "rec-student-001"


def _auth(student_id: str = STUDENT_ID) -> dict:
    from shared.auth import create_jwt
    return {"Authorization": f"Bearer {create_jwt(student_id, 'student', 1)}"}


def _student_with_weaknesses(count: int) -> dict:
    return {
        "id": STUDENT_ID,
        "first_name": "Test",
        "surname": "Student",
        "role": "student",
        "token_version": 1,
        "weaknesses": [
            {
                "topic": f"Weak topic {i}",
                "question_text": f"Sample question {i}",
                "feedback": f"Where the student went wrong: {i}",
                "subject": "Mathematics",
            }
            for i in range(count)
        ],
    }


@pytest.fixture(scope="module")
def app():
    from main import app as flask_app
    flask_app.config["TESTING"] = True
    return flask_app


@pytest.fixture(scope="module")
def client(app):
    return app.test_client()


@pytest.fixture(autouse=True)
def bypass_token_version_check():
    with patch("shared.firestore_client.get_doc", return_value=None):
        yield


class TestRecommendedLesson:
    def test_returns_not_enough_data_below_threshold(self, client):
        student = _student_with_weaknesses(3)  # below 10 threshold
        with patch(
            "functions.play.get_doc",
            side_effect=lambda c, d: student if (c, d) == ("students", STUDENT_ID) else None,
        ):
            resp = client.post(
                "/api/play/lessons/recommended",
                json={},
                headers=_auth(),
            )
        assert resp.status_code == 400
        body = resp.get_json()
        assert body["error_code"] == "not_enough_data"
        # Friendly human-readable message in `error` (the mobile axios
        # interceptor surfaces this as the alert body).
        assert "10" in body["error"]
        assert body["weakness_count"] == 3

    def test_kicks_generation_when_threshold_met(self, client):
        student = _student_with_weaknesses(12)
        saved: dict = {}
        spawn_calls: list[dict] = []

        with patch(
            "functions.play.get_doc",
            side_effect=lambda c, d: student if (c, d) == ("students", STUDENT_ID) else None,
        ), patch(
            "functions.play.upsert",
            side_effect=lambda c, _id, data: saved.update({_id: {**saved.get(_id, {}), **data, "id": _id}}),
        ), patch(
            "functions.play._spawn_generation_worker",
            side_effect=lambda **kw: spawn_calls.append(kw),
        ):
            resp = client.post(
                "/api/play/lessons/recommended",
                json={},
                headers=_auth(),
            )

        assert resp.status_code == 201, resp.get_data(as_text=True)
        body = resp.get_json()
        assert body["status"] == "generating"
        assert body["origin"] == "mine"
        assert body["recommended"] is True
        assert body["title"] == "Recommended for me"
        # Worker was kicked off for this lesson.
        assert len(spawn_calls) == 1
        assert spawn_calls[0]["student_id"] == STUDENT_ID
        # Source content was built from weakness entries (uses up to 10).
        assert "Topic: Weak topic 0" in spawn_calls[0]["source_content"]
        # Topic hint reflects "weakness review · <subject>".
        assert "weakness review" in spawn_calls[0]["topic_hint"]

    def test_requires_student_role(self, client):
        resp = client.post("/api/play/lessons/recommended", json={})
        assert resp.status_code == 401
