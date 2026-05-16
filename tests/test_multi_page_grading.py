"""
tests/test_multi_page_grading.py

Regression tests for the multi-page /mark endpoint contract (1-5 pages per
submission), the grade_submission_strict_multi Gemma wrapper, and the
annotate_pages per-page annotation pipeline.

All Vertex/GCS/Firestore calls are mocked. No network.
"""

from __future__ import annotations

import io
import json
from unittest.mock import MagicMock, patch

import pytest
from PIL import Image


# ─── App / client fixtures ────────────────────────────────────────────────────

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
    """Skip the Firestore token_version check inside require_role()."""
    with patch("shared.firestore_client.get_doc", return_value=None):
        yield


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _tiny_jpeg_bytes(label: str = "p") -> bytes:
    """Generate a minimal valid JPEG in-memory. Tests don't need real content —
    Gemma is mocked — but multipart handlers want actual bytes."""
    img = Image.new("RGB", (20, 20), color=(200, 200, 200))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=50)
    return buf.getvalue()


# Reusable fixtures for the /mark endpoint — match the existing test patterns
# in tests/test_homework_creation_flow.py that mock functions.auth.upsert etc.
TEACHER_ID = "mp-teacher-001"
STUDENT_ID = "mp-student-001"
CLASS_ID = "mp-class-001"
ANSWER_KEY_ID = "mp-key-001"


def _teacher_headers():
    # Match existing test pattern — create_jwt directly.
    from shared.auth import create_jwt
    token = create_jwt(TEACHER_ID, "teacher", 0)
    return {"Authorization": f"Bearer {token}"}


def _canonical_answer_key():
    return {
        "id": ANSWER_KEY_ID,
        "teacher_id": TEACHER_ID,
        "class_id": CLASS_ID,
        "title": "Multi-page Test",
        "subject": "Maths",
        "education_level": "Form 2",
        "total_marks": 10.0,
        "questions": [
            {"number": 1, "correct_answer": "42", "marks": 5, "marking_notes": ""},
            {"number": 2, "correct_answer": "100", "marks": 5, "marking_notes": ""},
        ],
    }


def _canonical_student():
    return {"id": STUDENT_ID, "class_id": CLASS_ID, "first_name": "A", "surname": "B"}


def _canonical_class():
    return {"id": CLASS_ID, "teacher_id": TEACHER_ID, "education_level": "Form 2"}


def _fake_verdicts_from_gemma(page_count: int):
    """Gemma would normally emit this — we stub it."""
    return [
        {
            "question_number": 1,
            "page_index": 0,
            "student_answer": "42",
            "expected_answer": "42",
            "verdict": "correct",
            "awarded_marks": 5,
            "max_marks": 5,
            "feedback": None,
        },
        {
            "question_number": 2,
            # if multi-page, put Q2 on the last page; else 0
            "page_index": max(page_count - 1, 0),
            "student_answer": "100",
            "expected_answer": "100",
            "verdict": "correct",
            "awarded_marks": 5,
            "max_marks": 5,
            "feedback": None,
        },
    ]


# Each test wires its own get_doc so answer_key / student / class lookups
# resolve. Duplicate-submission query must return empty.
def _make_fake_get_doc():
    def fake(collection, doc_id):
        if collection == "answer_keys" and doc_id == ANSWER_KEY_ID:
            return _canonical_answer_key()
        if collection == "students" and doc_id == STUDENT_ID:
            return _canonical_student()
        if collection == "classes" and doc_id == CLASS_ID:
            return _canonical_class()
        if collection == "mark_usage":
            return None
        return None
    return fake


def _post_mark(client, pages_data: list[tuple[str, bytes]], form: dict):
    """pages_data = [(field_name, bytes), ...]. form = extra multipart fields."""
    from io import BytesIO
    files = {field: (BytesIO(b), f"{field}.jpg") for field, b in pages_data}
    # flask test client multipart: data dict mixing files + strings
    data = {**form}
    for field, (bio, name) in files.items():
        data[field] = (bio, name)
    return client.post(
        "/api/mark",
        data=data,
        content_type="multipart/form-data",
        headers=_teacher_headers(),
    )


@pytest.fixture
def mark_mocks():
    """Common patches — mock Vertex, GCS, Firestore writes. Returns the
    saved-upserts dict so tests can assert on what was written."""
    saved: dict[tuple, dict] = {}

    def fake_upsert(collection, doc_id, data):
        saved[(collection, doc_id)] = {**saved.get((collection, doc_id), {}), **data}

    def fake_query(collection, filters, **kwargs):
        # No existing marks / submissions (clean register).
        return []

    def fake_upload_bytes(bucket, blob, content, public=False):
        return None

    def fake_signed_url(bucket, blob, expiry_minutes=None):
        return f"https://storage.googleapis.com/{bucket}/{blob}?sig=fake"

    def fake_route_ai_request(*args, **kwargs):
        return "cloud"

    with patch("functions.mark.upsert", side_effect=fake_upsert), \
         patch("functions.mark.query", side_effect=fake_query), \
         patch("functions.mark.get_doc", side_effect=_make_fake_get_doc()), \
         patch("functions.mark.upload_bytes", side_effect=fake_upload_bytes), \
         patch("functions.mark.generate_signed_url", side_effect=fake_signed_url), \
         patch("functions.mark.route_ai_request", side_effect=fake_route_ai_request), \
         patch("functions.mark.check_image_quality_strict",
               return_value={"pass": True, "reason": "", "suggestion": ""}), \
         patch("functions.mark.validate_output", return_value=(True, "")), \
         patch("functions.mark.log_ai_interaction"), \
         patch("functions.mark.get_user_context", return_value={}):
        yield saved


# ─── /mark endpoint — happy paths ─────────────────────────────────────────────


class TestMarkMultiPageEndpoint:
    def test_mark_endpoint_accepts_single_page(self, client, mark_mocks):
        """page_count=1, one file via page_0 field — the canonical single-page case."""
        with patch("functions.mark.grade_submission_strict_multi",
                   return_value=_fake_verdicts_from_gemma(1)):
            resp = _post_mark(
                client,
                [("page_0", _tiny_jpeg_bytes())],
                {"page_count": "1", "student_id": STUDENT_ID, "answer_key_id": ANSWER_KEY_ID},
            )
        assert resp.status_code == 200, resp.get_data(as_text=True)
        body = resp.get_json()
        assert body["page_count"] == 1
        assert len(body["page_urls"]) == 1
        assert len(body["annotated_urls"]) == 1
        assert body["marked_image_url"] == body["annotated_urls"][0]

    def test_mark_endpoint_accepts_three_pages(self, client, mark_mocks):
        with patch("functions.mark.grade_submission_strict_multi",
                   return_value=_fake_verdicts_from_gemma(3)):
            resp = _post_mark(
                client,
                [
                    ("page_0", _tiny_jpeg_bytes()),
                    ("page_1", _tiny_jpeg_bytes()),
                    ("page_2", _tiny_jpeg_bytes()),
                ],
                {"page_count": "3", "student_id": STUDENT_ID, "answer_key_id": ANSWER_KEY_ID},
            )
        assert resp.status_code == 200, resp.get_data(as_text=True)
        body = resp.get_json()
        assert body["page_count"] == 3
        assert len(body["page_urls"]) == 3
        assert len(body["annotated_urls"]) == 3

    def test_mark_endpoint_accepts_five_pages(self, client, mark_mocks):
        """Boundary — 5 is the max."""
        with patch("functions.mark.grade_submission_strict_multi",
                   return_value=_fake_verdicts_from_gemma(5)):
            resp = _post_mark(
                client,
                [(f"page_{i}", _tiny_jpeg_bytes()) for i in range(5)],
                {"page_count": "5", "student_id": STUDENT_ID, "answer_key_id": ANSWER_KEY_ID},
            )
        assert resp.status_code == 200, resp.get_data(as_text=True)
        body = resp.get_json()
        assert body["page_count"] == 5
        assert len(body["page_urls"]) == 5

    def test_mark_endpoint_accepts_base64_page(self, client, mark_mocks):
        """Android clients can't reliably multipart-upload file URIs on some
        Samsung builds, so they send pages as page_{i}_base64 text fields
        instead. Endpoint must accept that shape identically."""
        import base64 as _base64
        from io import BytesIO
        page_bytes = _tiny_jpeg_bytes()
        page_b64 = _base64.b64encode(page_bytes).decode("ascii")
        with patch("functions.mark.grade_submission_strict_multi",
                   return_value=_fake_verdicts_from_gemma(1)):
            resp = client.post(
                "/api/mark",
                data={
                    "page_count": "1",
                    "student_id": STUDENT_ID,
                    "answer_key_id": ANSWER_KEY_ID,
                    "page_0_base64": page_b64,  # text field, no file part
                },
                content_type="multipart/form-data",
                headers=_teacher_headers(),
            )
        assert resp.status_code == 200, resp.get_data(as_text=True)
        body = resp.get_json()
        assert body["page_count"] == 1

    def test_mark_endpoint_rejects_invalid_base64(self, client, mark_mocks):
        """Garbled base64 in page_{i}_base64 should return 422 rather than
        crash the handler."""
        resp = client.post(
            "/api/mark",
            data={
                "page_count": "1",
                "student_id": STUDENT_ID,
                "answer_key_id": ANSWER_KEY_ID,
                "page_0_base64": "!!!not-valid-base64!!!",
            },
            content_type="multipart/form-data",
            headers=_teacher_headers(),
        )
        # Malformed base64 is treated as a quality rejection; same error path
        # as a missing page field.
        assert resp.status_code == 422, resp.get_data(as_text=True)

    def test_mark_response_includes_student_id_and_name(self, client, mark_mocks):
        """Response body must include student_id + student_name so the mobile
        approval UI (MarkResultComponent) can render without depending on
        MarkingScreen's selectedStudent state being non-null at that moment."""
        with patch("functions.mark.grade_submission_strict_multi",
                   return_value=_fake_verdicts_from_gemma(1)):
            resp = _post_mark(
                client,
                [("page_0", _tiny_jpeg_bytes())],
                {"page_count": "1", "student_id": STUDENT_ID, "answer_key_id": ANSWER_KEY_ID},
            )
        assert resp.status_code == 200, resp.get_data(as_text=True)
        body = resp.get_json()
        # _canonical_student() → first_name "A", surname "B"
        assert body["student_id"] == STUDENT_ID
        assert body["student_name"] == "A B"

    # ── Rejection paths ──────────────────────────────────────────────────────

    def test_mark_endpoint_rejects_page_count_zero(self, client, mark_mocks):
        resp = _post_mark(
            client, [], {"page_count": "0", "student_id": STUDENT_ID, "answer_key_id": ANSWER_KEY_ID},
        )
        assert resp.status_code == 422, resp.get_data(as_text=True)
        body = resp.get_json()
        assert body.get("error_code") == "IMAGE_QUALITY_REJECTED"
        assert "1 and 5" in (body.get("error") or "")

    def test_mark_endpoint_rejects_page_count_six(self, client, mark_mocks):
        resp = _post_mark(
            client,
            [(f"page_{i}", _tiny_jpeg_bytes()) for i in range(6)],
            {"page_count": "6", "student_id": STUDENT_ID, "answer_key_id": ANSWER_KEY_ID},
        )
        assert resp.status_code == 422, resp.get_data(as_text=True)
        body = resp.get_json()
        assert body.get("error_code") == "IMAGE_QUALITY_REJECTED"

    def test_mark_endpoint_rejects_missing_page_field(self, client, mark_mocks):
        """page_count=3 claimed but only page_0 + page_1 sent → rejected."""
        resp = _post_mark(
            client,
            [("page_0", _tiny_jpeg_bytes()), ("page_1", _tiny_jpeg_bytes())],
            {"page_count": "3", "student_id": STUDENT_ID, "answer_key_id": ANSWER_KEY_ID},
        )
        assert resp.status_code == 422, resp.get_data(as_text=True)
        body = resp.get_json()
        assert body.get("error_code") == "IMAGE_QUALITY_REJECTED"
        assert "page 3" in (body.get("error") or "").lower() or "missing" in (body.get("error") or "").lower()


class TestMarkDocSchema:
    def test_mark_doc_stores_page_urls_array_and_annotated_urls_array(self, client, mark_mocks):
        with patch("functions.mark.grade_submission_strict_multi",
                   return_value=_fake_verdicts_from_gemma(2)):
            resp = _post_mark(
                client,
                [("page_0", _tiny_jpeg_bytes()), ("page_1", _tiny_jpeg_bytes())],
                {"page_count": "2", "student_id": STUDENT_ID, "answer_key_id": ANSWER_KEY_ID},
            )
        assert resp.status_code == 200
        mark_writes = [v for (c, _), v in mark_mocks.items() if c == "marks"]
        assert len(mark_writes) == 1
        mark_doc = mark_writes[0]
        assert mark_doc["page_count"] == 2
        assert isinstance(mark_doc["page_urls"], list) and len(mark_doc["page_urls"]) == 2
        assert isinstance(mark_doc["annotated_urls"], list) and len(mark_doc["annotated_urls"]) == 2

    def test_mark_doc_backward_compat_image_url_is_first_page(self, client, mark_mocks):
        """Legacy singular `marked_image_url` must equal annotated_urls[0]."""
        with patch("functions.mark.grade_submission_strict_multi",
                   return_value=_fake_verdicts_from_gemma(3)):
            resp = _post_mark(
                client,
                [(f"page_{i}", _tiny_jpeg_bytes()) for i in range(3)],
                {"page_count": "3", "student_id": STUDENT_ID, "answer_key_id": ANSWER_KEY_ID},
            )
        assert resp.status_code == 200
        mark_writes = [v for (c, _), v in mark_mocks.items() if c == "marks"]
        mark_doc = mark_writes[0]
        assert mark_doc["marked_image_url"] == mark_doc["annotated_urls"][0]


# ─── Dedup + clamp anti-abuse rules ────────────────────────────────────────────


class TestScoreClampAndDedupe:
    """The /mark endpoint must:
      1. Never return a score above the answer key's total_marks.
      2. Deduplicate verdicts by question_number when Gemma emits the same
         question on multiple pages (e.g. student photographs the same page
         twice).
      3. Drop verdicts for questions the teacher didn't set (hallucinations).
    """

    def test_duplicate_question_across_pages_counts_once(self, client, mark_mocks):
        """Student captures the same page twice — Gemma returns Q1 on both
        pages with a verdict each. Score must reflect Q1 + Q2 = 10, not
        Q1 + Q1 + Q2 = 15."""
        duplicated_q1 = [
            # Same Q1 seen on page 0 — 5/5.
            {"question_number": 1, "page_index": 0, "verdict": "correct",
             "awarded_marks": 5, "max_marks": 5, "student_answer": "42", "expected_answer": "42"},
            # Same Q1 seen on page 1 — also 5/5 (student copied page).
            {"question_number": 1, "page_index": 1, "verdict": "correct",
             "awarded_marks": 5, "max_marks": 5, "student_answer": "42", "expected_answer": "42"},
            # Q2 on page 1.
            {"question_number": 2, "page_index": 1, "verdict": "correct",
             "awarded_marks": 5, "max_marks": 5, "student_answer": "100", "expected_answer": "100"},
        ]
        with patch("functions.mark.grade_submission_strict_multi",
                   return_value=duplicated_q1):
            resp = _post_mark(
                client,
                [("page_0", _tiny_jpeg_bytes()), ("page_1", _tiny_jpeg_bytes())],
                {"page_count": "2", "student_id": STUDENT_ID, "answer_key_id": ANSWER_KEY_ID},
            )
        assert resp.status_code == 200, resp.get_data(as_text=True)
        body = resp.get_json()
        assert body["score"] == 10
        assert body["max_score"] == 10
        assert body["percentage"] == 100.0
        # Only two verdicts should survive — one per unique question_number.
        assert len({v["question_number"] for v in body["verdicts"]}) == 2

    def test_duplicate_question_keeps_highest_awarded(self, client, mark_mocks):
        """When the same question is graded twice with different marks, keep
        the higher one (benefit of the doubt — student's best attempt)."""
        duplicated_q1_mixed = [
            # First copy wrong, second copy right — student fixed it on page 2.
            {"question_number": 1, "page_index": 0, "verdict": "incorrect",
             "awarded_marks": 0, "max_marks": 5, "student_answer": "41", "expected_answer": "42"},
            {"question_number": 1, "page_index": 1, "verdict": "correct",
             "awarded_marks": 5, "max_marks": 5, "student_answer": "42", "expected_answer": "42"},
            {"question_number": 2, "page_index": 1, "verdict": "correct",
             "awarded_marks": 5, "max_marks": 5, "student_answer": "100", "expected_answer": "100"},
        ]
        with patch("functions.mark.grade_submission_strict_multi",
                   return_value=duplicated_q1_mixed):
            resp = _post_mark(
                client,
                [("page_0", _tiny_jpeg_bytes()), ("page_1", _tiny_jpeg_bytes())],
                {"page_count": "2", "student_id": STUDENT_ID, "answer_key_id": ANSWER_KEY_ID},
            )
        assert resp.status_code == 200, resp.get_data(as_text=True)
        body = resp.get_json()
        # Q1 kept the 5/5 verdict (higher), Q2 is 5/5 → total 10.
        assert body["score"] == 10
        q1 = next(v for v in body["verdicts"] if v["question_number"] == 1)
        assert q1["awarded_marks"] == 5
        assert q1["verdict"] == "correct"

    def test_awarded_marks_clamped_to_question_cap(self, client, mark_mocks):
        """Gemma hallucinates and awards 8/5 on Q1. The endpoint must clamp
        to the answer key's 5 so the student can't exceed what the teacher
        set."""
        inflated = [
            {"question_number": 1, "page_index": 0, "verdict": "correct",
             "awarded_marks": 8, "max_marks": 5, "student_answer": "42", "expected_answer": "42"},
            {"question_number": 2, "page_index": 0, "verdict": "correct",
             "awarded_marks": 5, "max_marks": 5, "student_answer": "100", "expected_answer": "100"},
        ]
        with patch("functions.mark.grade_submission_strict_multi",
                   return_value=inflated):
            resp = _post_mark(
                client,
                [("page_0", _tiny_jpeg_bytes())],
                {"page_count": "1", "student_id": STUDENT_ID, "answer_key_id": ANSWER_KEY_ID},
            )
        assert resp.status_code == 200, resp.get_data(as_text=True)
        body = resp.get_json()
        assert body["score"] == 10  # 5 (clamped) + 5
        q1 = next(v for v in body["verdicts"] if v["question_number"] == 1)
        assert q1["awarded_marks"] == 5
        assert q1["max_marks"] == 5

    def test_total_score_never_exceeds_total_marks(self, client, mark_mocks):
        """Even with multiple inflated per-question awards, the response
        score must be clamped to the answer key's total_marks."""
        inflated = [
            {"question_number": 1, "page_index": 0, "verdict": "correct",
             "awarded_marks": 100, "max_marks": 5, "student_answer": "42", "expected_answer": "42"},
            {"question_number": 2, "page_index": 0, "verdict": "correct",
             "awarded_marks": 100, "max_marks": 5, "student_answer": "100", "expected_answer": "100"},
        ]
        with patch("functions.mark.grade_submission_strict_multi",
                   return_value=inflated):
            resp = _post_mark(
                client,
                [("page_0", _tiny_jpeg_bytes())],
                {"page_count": "1", "student_id": STUDENT_ID, "answer_key_id": ANSWER_KEY_ID},
            )
        assert resp.status_code == 200, resp.get_data(as_text=True)
        body = resp.get_json()
        assert body["score"] <= 10
        assert body["max_score"] == 10
        assert body["percentage"] <= 100.0

    def test_verdicts_for_unknown_questions_dropped(self, client, mark_mocks):
        """Gemma hallucinates a Q3 that isn't in the answer key. It must be
        filtered out of both the score and the verdicts array."""
        with_extra = [
            {"question_number": 1, "page_index": 0, "verdict": "correct",
             "awarded_marks": 5, "max_marks": 5, "student_answer": "42", "expected_answer": "42"},
            {"question_number": 2, "page_index": 0, "verdict": "correct",
             "awarded_marks": 5, "max_marks": 5, "student_answer": "100", "expected_answer": "100"},
            # Hallucinated: the answer key only has Q1 + Q2.
            {"question_number": 3, "page_index": 0, "verdict": "correct",
             "awarded_marks": 5, "max_marks": 5, "student_answer": "xx", "expected_answer": "xx"},
        ]
        with patch("functions.mark.grade_submission_strict_multi",
                   return_value=with_extra):
            resp = _post_mark(
                client,
                [("page_0", _tiny_jpeg_bytes())],
                {"page_count": "1", "student_id": STUDENT_ID, "answer_key_id": ANSWER_KEY_ID},
            )
        assert resp.status_code == 200, resp.get_data(as_text=True)
        body = resp.get_json()
        assert body["score"] == 10
        qnums = {v["question_number"] for v in body["verdicts"]}
        assert qnums == {1, 2}
        assert 3 not in qnums


# ─── Gemma multi-page call ────────────────────────────────────────────────────


class TestGradeSubmissionStrictMulti:
    def test_passes_all_pages_to_gemma_as_image_url_blocks(self):
        """Mocks _vertex_chat_completions and inspects the messages payload to
        confirm one text block + N image_url blocks in one user message."""
        from shared.gemma_client import grade_submission_strict_multi
        fake_pages = [_tiny_jpeg_bytes() for _ in range(3)]
        captured = {}

        def fake_chat_completions(messages, **kwargs):
            captured["messages"] = messages
            return json.dumps(_fake_verdicts_from_gemma(3))

        with patch("shared.gemma_client._vertex_chat_completions",
                   side_effect=fake_chat_completions), \
             patch("shared.gemma_client._build_rag_context", return_value=""):
            result = grade_submission_strict_multi(
                fake_pages, _canonical_answer_key(), "Form 2", user_context={},
            )

        assert len(result) == 2  # 2 verdicts
        content = captured["messages"][0]["content"]
        # One text block + 3 image_url blocks
        text_blocks = [c for c in content if c.get("type") == "text"]
        image_blocks = [c for c in content if c.get("type") == "image_url"]
        assert len(text_blocks) == 1
        assert len(image_blocks) == 3
        # Each image_url must be a data URL with base64-encoded JPEG
        for ib in image_blocks:
            assert ib["image_url"]["url"].startswith("data:image/jpeg;base64,")

    def test_defaults_page_index_when_missing_or_out_of_range(self):
        """Gemma emits a verdict without page_index (or with a bad one) →
        clamped to 0 so annotator doesn't crash."""
        from shared.gemma_client import grade_submission_strict_multi
        fake_pages = [_tiny_jpeg_bytes() for _ in range(2)]

        sloppy_verdicts = [
            {"question_number": 1, "verdict": "correct", "awarded_marks": 5, "max_marks": 5},
            # page_index missing ↑
            {"question_number": 2, "page_index": 99,  # out of range ↓
             "verdict": "incorrect", "awarded_marks": 0, "max_marks": 5},
            {"question_number": 3, "page_index": -1,  # negative ↓
             "verdict": "partial", "awarded_marks": 2, "max_marks": 5},
        ]

        with patch("shared.gemma_client._vertex_chat_completions",
                   return_value=json.dumps(sloppy_verdicts)), \
             patch("shared.gemma_client._build_rag_context", return_value=""):
            result = grade_submission_strict_multi(
                fake_pages, _canonical_answer_key(), "Form 2", user_context={},
            )

        assert all(0 <= v["page_index"] < 2 for v in result)
        # Missing + out-of-range + negative all default to 0
        for v in result:
            assert v["page_index"] == 0 or v["page_index"] == 1


# ─── Annotator multi-page ─────────────────────────────────────────────────────


class TestAnnotatePages:
    def test_annotate_pages_returns_one_output_per_page(self):
        from shared.annotator import annotate_pages
        pages = [_tiny_jpeg_bytes() for _ in range(3)]
        verdicts = [
            {"question_number": 1, "page_index": 0, "verdict": "correct",
             "awarded_marks": 5, "max_marks": 5},
            {"question_number": 2, "page_index": 1, "verdict": "incorrect",
             "awarded_marks": 0, "max_marks": 5},
            {"question_number": 3, "page_index": 2, "verdict": "partial",
             "awarded_marks": 3, "max_marks": 5},
        ]
        out = annotate_pages(pages, verdicts)
        assert len(out) == 3
        # Each output is bytes (actual JPEG contents; we don't inspect pixels)
        assert all(isinstance(b, bytes) and len(b) > 0 for b in out)

    def test_annotate_pages_filters_by_page_index(self):
        """Verdicts for page_index=2 must not land on page 0 or 1.
        Verified indirectly: annotate_image is called per-page with only
        its own verdicts."""
        from shared import annotator
        pages = [_tiny_jpeg_bytes() for _ in range(3)]
        verdicts = [
            {"question_number": 1, "page_index": 0, "verdict": "correct",
             "awarded_marks": 5, "max_marks": 5},
            {"question_number": 2, "page_index": 2, "verdict": "correct",
             "awarded_marks": 5, "max_marks": 5},
            {"question_number": 3, "page_index": 2, "verdict": "partial",
             "awarded_marks": 3, "max_marks": 5},
        ]

        calls: list = []

        def spy_annotate_image(page_bytes, page_verdicts, *args, **kwargs):
            calls.append([v["question_number"] for v in page_verdicts])
            return page_bytes  # pass-through

        with patch.object(annotator, "annotate_image", side_effect=spy_annotate_image):
            annotator.annotate_pages(pages, verdicts)

        # Page 0 gets Q1; page 1 gets nothing; page 2 gets Q2 + Q3.
        assert calls == [[1], [], [2, 3]]

    def test_annotate_pages_defaults_missing_page_index_to_zero(self):
        """A verdict without page_index should land on page 0."""
        from shared import annotator
        pages = [_tiny_jpeg_bytes() for _ in range(2)]
        verdicts = [
            {"question_number": 1, "verdict": "correct",
             "awarded_marks": 5, "max_marks": 5},  # no page_index
            {"question_number": 2, "page_index": 1, "verdict": "correct",
             "awarded_marks": 5, "max_marks": 5},
        ]
        calls: list = []
        def spy(page_bytes, page_verdicts, *a, **k):
            calls.append([v["question_number"] for v in page_verdicts])
            return page_bytes

        with patch.object(annotator, "annotate_image", side_effect=spy):
            annotator.annotate_pages(pages, verdicts)

        # Missing page_index defaults to 0 → Q1 on page 0, Q2 on page 1.
        assert calls == [[1], [2]]


# ─── Annotator per-verdict positioning ────────────────────────────────────────


class TestAnnotatorPositioning:
    """Gemma now returns question_x / question_y per verdict so the symbol
    lands near the actual question on the page. Missing/invalid values fall
    back to evenly-spaced left margin."""

    def test_annotator_forces_x_to_right_margin_ignoring_verdict_qx(self):
        """X is *always* forced to the right margin (0.92 of width) so
        every tick stacks down the right side of the page like a
        teacher's pen-marks. The model's question_x is ignored — using
        it put symbols on top of the student's handwriting on the left.
        Y is still honoured so each tick aligns vertically with the
        answer it grades."""
        from shared.annotator import _resolve_verdict_position
        verdict = {
            "question_number": 1,
            "verdict": "correct",
            "awarded_marks": 5, "max_marks": 5,
            "question_x": 0.10,  # ignored
            "question_y": 0.30,  # honoured
        }
        cx, cy = _resolve_verdict_position(verdict, index=0, total=1, width=800, height=1000)
        assert cx == 736  # 0.92 * 800 — forced right margin
        assert cy == 300  # 0.30 * 1000 — verdict's qy

    def test_annotator_falls_back_when_no_coordinates(self):
        """Verdict missing question_x/question_y → right-margin fallback:
        x = 0.92 * width, y = (index + 0.5) / total * height. Right
        margin matches the mobile LocalAnnotationOverlay's default and
        keeps the symbol next to the answer column rather than in the
        gutter on portrait scans."""
        from shared.annotator import _resolve_verdict_position
        verdict = {
            "question_number": 1,
            "verdict": "correct",
            "awarded_marks": 5, "max_marks": 5,
        }
        cx, cy = _resolve_verdict_position(verdict, index=0, total=1, width=800, height=1000)
        assert cx == 736  # 0.92 * 800 (right margin default)
        assert cy == 500  # (0 + 0.5) / 1 * 1000 (evenly-spaced single row)

        # Second-of-two fallback position
        cx2, cy2 = _resolve_verdict_position(verdict, index=1, total=2, width=800, height=1000)
        assert cx2 == 736
        assert cy2 == 750  # (1 + 0.5) / 2 * 1000

    def test_annotator_clamps_out_of_range_qy(self):
        """qy outside [0.05, 0.95] is clamped, so the symbol never
        bleeds off the top/bottom edge even if the model hallucinates.
        qx is no longer model-driven (forced right margin), so only
        qy clamping matters now."""
        from shared.annotator import _resolve_verdict_position
        verdict = {
            "question_number": 1,
            "verdict": "correct",
            "awarded_marks": 5, "max_marks": 5,
            "question_x": 1.5,      # ignored — qx is always forced
            "question_y": -0.2,     # < 0.05, clamps up
        }
        cx, cy = _resolve_verdict_position(verdict, index=0, total=1, width=800, height=1000)
        assert cx == 736  # 0.92 * 800 — forced right margin
        assert cy == 50   # 0.05 * 1000 — clamped from -0.2

# ─── Pre-graded path (offline-graded mobile clients) ───────────────────────────


class TestPreGradedPath:
    """Mobile teachers grading offline on E2B post their verdicts directly
    on /api/mark via the `pre_graded_verdicts` form field. Backend must:
      1. Skip the cloud grading call entirely (no Vertex spend).
      2. Skip the image-quality gate (teacher already saw the local grade —
         re-rejecting on quality would orphan their submission).
      3. Apply the same dedupe + clamp guards to the supplied verdicts as
         it does for cloud-graded ones (defense against tampering /
         model hallucination).
      4. Tag the resulting Mark + student_submission with
         source="teacher_scan_offline" so analytics can distinguish.
    """

    def test_pre_graded_skips_cloud_grading_call(self, client, mark_mocks):
        """When pre_graded_verdicts is present, grade_submission_strict_multi
        must not be invoked. We patch it to raise so the test fails loudly
        if the backend forgets and falls through to cloud grading."""
        from io import BytesIO
        verdicts_json = json.dumps([
            {"question_number": 1, "page_index": 0, "verdict": "correct",
             "awarded_marks": 5, "max_marks": 5, "student_answer": "42", "expected_answer": "42"},
            {"question_number": 2, "page_index": 0, "verdict": "correct",
             "awarded_marks": 5, "max_marks": 5, "student_answer": "100", "expected_answer": "100"},
        ])
        def must_not_be_called(*a, **kw):
            raise AssertionError("Cloud grading was invoked despite pre_graded_verdicts being supplied.")
        with patch("functions.mark.grade_submission_strict_multi", side_effect=must_not_be_called), \
             patch("functions.mark.check_image_quality_strict",
                   side_effect=must_not_be_called):
            resp = client.post(
                "/api/mark",
                data={
                    "page_count": "1",
                    "student_id": STUDENT_ID,
                    "answer_key_id": ANSWER_KEY_ID,
                    "pre_graded_verdicts": verdicts_json,
                    "page_0": (BytesIO(_tiny_jpeg_bytes()), "page_0.jpg"),
                },
                content_type="multipart/form-data",
                headers=_teacher_headers(),
            )
        assert resp.status_code == 200, resp.get_data(as_text=True)
        body = resp.get_json()
        assert body["score"] == 10
        assert body["max_score"] == 10

    def test_pre_graded_clamp_still_applied(self, client, mark_mocks):
        """Even on the pre-graded path, awarded_marks > max_marks is clamped
        — same anti-abuse rule as the cloud path. Teacher-supplied (or
        E2B-hallucinated) verdicts can never inflate the score above what
        the answer key allows."""
        inflated_json = json.dumps([
            {"question_number": 1, "page_index": 0, "verdict": "correct",
             "awarded_marks": 99, "max_marks": 5, "student_answer": "42", "expected_answer": "42"},
            {"question_number": 2, "page_index": 0, "verdict": "correct",
             "awarded_marks": 99, "max_marks": 5, "student_answer": "100", "expected_answer": "100"},
        ])
        with patch("functions.mark.grade_submission_strict_multi") as cloud_grade:
            from io import BytesIO
            resp = client.post(
                "/api/mark",
                data={
                    "page_count": "1",
                    "student_id": STUDENT_ID,
                    "answer_key_id": ANSWER_KEY_ID,
                    "pre_graded_verdicts": inflated_json,
                    "page_0": (BytesIO(_tiny_jpeg_bytes()), "page_0.jpg"),
                },
                content_type="multipart/form-data",
                headers=_teacher_headers(),
            )
        cloud_grade.assert_not_called()
        assert resp.status_code == 200, resp.get_data(as_text=True)
        body = resp.get_json()
        assert body["score"] == 10
        assert body["max_score"] == 10

    def test_pre_graded_tags_mark_source_offline(self, client, mark_mocks):
        """Mark + student_submission docs persisted with the pre-graded path
        must use source=teacher_scan_offline so analytics can split offline
        vs cloud accuracy tiers."""
        verdicts_json = json.dumps([
            {"question_number": 1, "page_index": 0, "verdict": "correct",
             "awarded_marks": 5, "max_marks": 5, "student_answer": "42", "expected_answer": "42"},
            {"question_number": 2, "page_index": 0, "verdict": "incorrect",
             "awarded_marks": 0, "max_marks": 5, "student_answer": "wrong", "expected_answer": "100"},
        ])
        from io import BytesIO
        resp = client.post(
            "/api/mark",
            data={
                "page_count": "1",
                "student_id": STUDENT_ID,
                "answer_key_id": ANSWER_KEY_ID,
                "pre_graded_verdicts": verdicts_json,
                "page_0": (BytesIO(_tiny_jpeg_bytes()), "page_0.jpg"),
            },
            content_type="multipart/form-data",
            headers=_teacher_headers(),
        )
        assert resp.status_code == 200, resp.get_data(as_text=True)
        mark_writes = [v for (c, _), v in mark_mocks.items() if c == "marks"]
        sub_writes = [v for (c, _), v in mark_mocks.items() if c == "student_submissions"]
        assert len(mark_writes) == 1
        assert mark_writes[0]["source"] == "teacher_scan_offline"
        assert len(sub_writes) == 1
        assert sub_writes[0]["source"] == "teacher_scan_offline"

    def test_pre_graded_falls_back_to_cloud_when_verdicts_invalid(self, client, mark_mocks):
        """Garbled JSON in pre_graded_verdicts → fall through to the normal
        cloud grading flow rather than rejecting. Defensive so a buggy
        client doesn't lose the submission entirely."""
        from io import BytesIO
        with patch("functions.mark.grade_submission_strict_multi",
                   return_value=_fake_verdicts_from_gemma(1)):
            resp = client.post(
                "/api/mark",
                data={
                    "page_count": "1",
                    "student_id": STUDENT_ID,
                    "answer_key_id": ANSWER_KEY_ID,
                    "pre_graded_verdicts": "{not valid json",
                    "page_0": (BytesIO(_tiny_jpeg_bytes()), "page_0.jpg"),
                },
                content_type="multipart/form-data",
                headers=_teacher_headers(),
            )
        assert resp.status_code == 200
        mark_writes = [v for (c, _), v in mark_mocks.items() if c == "marks"]
        assert mark_writes[0]["source"] == "teacher_scan"  # fell back

