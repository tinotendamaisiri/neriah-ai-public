"""
Tests for POST /play/lessons/import.

The import endpoint accepts pre-built questions from the mobile sync
worker (lessons generated on-device while offline) and stores them as
status='ready' without calling the cloud Gemma generator. Validates +
sanitises every row.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest


STUDENT_ID = "import-student-001"
CLASS_ID = "import-class-001"


def _auth(student_id: str = STUDENT_ID) -> dict:
    from shared.auth import create_jwt
    return {"Authorization": f"Bearer {create_jwt(student_id, 'student', 1)}"}


def _student_doc(student_id: str = STUDENT_ID) -> dict:
    return {
        "id": student_id,
        "first_name": "Test",
        "surname": "Student",
        "class_id": CLASS_ID,
        "class_ids": [CLASS_ID],
        "role": "student",
        "token_version": 1,
    }


def _good_question(prompt: str = "What is 2+2?") -> dict:
    return {
        "prompt": prompt,
        "options": ["3", "4", "5", "6"],
        "correct": 1,
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


class TestImportLesson:
    def test_import_succeeds_with_valid_questions(self, client):
        saved: dict = {}
        student = _student_doc()
        questions = [_good_question(f"Q{i}") for i in range(15)]

        with patch(
            "functions.play.get_doc",
            side_effect=lambda c, d: student if (c, d) == ("students", STUDENT_ID) else None,
        ), patch(
            "functions.play.upsert",
            side_effect=lambda c, _id, data: saved.update({_id: {**saved.get(_id, {}), **data, "id": _id}}),
        ):
            resp = client.post(
                "/api/play/lessons/import",
                json={
                    "title": "Photosynthesis (offline)",
                    "subject": "Biology",
                    "grade": "Form 3",
                    "source_content": "...",
                    "questions": questions,
                    "was_expanded": True,
                },
                headers=_auth(),
            )

        assert resp.status_code == 201, resp.get_data(as_text=True)
        body = resp.get_json()
        assert body["status"] == "ready"
        assert body["question_count"] == 15
        assert body["was_expanded"] is True
        assert body["origin"] == "mine"
        # The lesson row was actually persisted with the questions.
        lesson_id = body["id"]
        assert lesson_id in saved
        assert len(saved[lesson_id]["questions"]) == 15

    def test_import_rejects_empty_questions_array(self, client):
        with patch("functions.play.get_doc", return_value=_student_doc()):
            resp = client.post(
                "/api/play/lessons/import",
                json={"title": "T", "questions": []},
                headers=_auth(),
            )
        assert resp.status_code == 400
        assert "questions" in resp.get_json()["error"].lower()

    def test_import_rejects_missing_title(self, client):
        with patch("functions.play.get_doc", return_value=_student_doc()):
            resp = client.post(
                "/api/play/lessons/import",
                json={"questions": [_good_question()]},
                headers=_auth(),
            )
        assert resp.status_code == 400
        assert "title" in resp.get_json()["error"].lower()

    def test_import_filters_malformed_rows(self, client):
        """Three valid rows + four bad rows → result has 3 questions."""
        saved: dict = {}
        bad_rows = [
            {"prompt": "no options"},                           # missing options
            {"prompt": "wrong arity", "options": ["a", "b", "c"], "correct": 0},  # 3 options
            {"prompt": "bad correct", "options": ["a", "b", "c", "d"], "correct": 9},  # out of range
            {"prompt": "", "options": ["a", "b", "c", "d"], "correct": 0},  # empty prompt
        ]
        good_rows = [_good_question(f"Q{i}") for i in range(3)]
        with patch(
            "functions.play.get_doc",
            side_effect=lambda c, d: _student_doc() if (c, d) == ("students", STUDENT_ID) else None,
        ), patch(
            "functions.play.upsert",
            side_effect=lambda c, _id, data: saved.update({_id: {**saved.get(_id, {}), **data, "id": _id}}),
        ):
            resp = client.post(
                "/api/play/lessons/import",
                json={
                    "title": "Mixed batch",
                    "questions": [*good_rows, *bad_rows],
                },
                headers=_auth(),
            )
        assert resp.status_code == 201
        assert resp.get_json()["question_count"] == 3

    def test_import_rejects_when_no_valid_rows_remain(self, client):
        with patch("functions.play.get_doc", return_value=_student_doc()):
            resp = client.post(
                "/api/play/lessons/import",
                json={
                    "title": "Garbage",
                    "questions": [{"prompt": "no options"}, {"foo": "bar"}],
                },
                headers=_auth(),
            )
        assert resp.status_code == 400
        assert "valid" in resp.get_json()["error"].lower()

    def test_import_requires_student_role(self, client):
        # No auth header → 401.
        resp = client.post(
            "/api/play/lessons/import",
            json={"title": "X", "questions": [_good_question()]},
        )
        assert resp.status_code == 401
