"""
End-to-end smoke test: Gemma 4 grading pipeline.

What this test does:
  1. Generates a synthetic exercise-book image using Pillow (no real photo needed).
  2. Defines a 3-question answer key (maths + geography + maths).
  3. Calls grade_submission() — a live Vertex AI / Gemma 4 call.
  4. Asserts the response has the correct structure on every verdict.

Requirements to run:
  - GCP_PROJECT_ID env var set (real project with Vertex AI enabled).
  - Application Default Credentials: `gcloud auth application-default login`.
  - google-cloud-aiplatform installed: `pip install -r requirements.txt`.

Run:
    pytest tests/test_grading.py -v
"""

from __future__ import annotations

import io
import os

import pytest
from PIL import Image, ImageDraw, ImageFont

# ── Skip entire module if GCP_PROJECT_ID is not configured ───────────────────
pytestmark = pytest.mark.skipif(
    not os.environ.get("GCP_PROJECT_ID"),
    reason="GCP_PROJECT_ID not set — skipping live Vertex AI tests",
)

# ── Test fixtures ─────────────────────────────────────────────────────────────

ANSWER_KEY = {
    "title": "Grade 4 General Knowledge Quiz",
    "total_marks": 3,
    "questions": [
        {
            "question_number": 1,
            "question_text": "What is 2 + 2?",
            "answer": "4",
            "marks": 1,
        },
        {
            "question_number": 2,
            "question_text": "What is the capital city of Zimbabwe?",
            "answer": "Harare",
            "marks": 1,
        },
        {
            "question_number": 3,
            "question_text": "What is 10 minus 3?",
            "answer": "7",
            "marks": 1,
        },
    ],
}

EDUCATION_LEVEL = "Grade 4"


def _make_exercise_book_image() -> bytes:
    """
    Generate a synthetic exercise-book page with clearly printed answers.
    Uses a white background with dark ink to maximise OCR-like readability
    for Gemma 4's vision.
    """
    width, height = 640, 900
    img = Image.new("RGB", (width, height), color=(252, 250, 245))  # off-white page
    draw = ImageDraw.Draw(img)

    # Try to load a legible font; fall back gracefully
    try:
        font_title  = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 24)
        font_label  = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 18)
        font_answer = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 22)
    except OSError:
        try:
            font_title  = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 24)
            font_label  = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 18)
            font_answer = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 22)
        except OSError:
            font_title = font_label = font_answer = ImageFont.load_default()

    ink   = (20, 20, 20)
    pen   = (30, 30, 180)   # student answers in blue
    rules = (180, 180, 180) # ruled lines

    # Ruled lines (notebook effect)
    for y in range(60, height, 36):
        draw.line([(30, y), (width - 30, y)], fill=rules, width=1)

    # Title
    draw.text((30, 15), "Grade 4 General Knowledge Quiz", font=font_title, fill=ink)

    # Name / date line
    draw.text((30, 62), "Name: Tendai Moyo          Date: 3 April 2026", font=font_label, fill=ink)

    # Questions with answers
    questions = [
        ("1.", "What is 2 + 2?",                    "4"),
        ("2.", "What is the capital city of Zimbabwe?", "Harare"),
        ("3.", "What is 10 minus 3?",                "7"),
    ]

    y = 115
    for num, question, answer in questions:
        draw.text((30,  y),      f"{num} {question}", font=font_label,  fill=ink)
        draw.text((60,  y + 30), f"Answer: {answer}", font=font_answer, fill=pen)
        y += 90

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=92)
    return buf.getvalue()


# ── Tests ─────────────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def verdicts():
    """Call grade_submission once; share the result across all tests in this module."""
    from shared.gemma_client import grade_submission
    image_bytes = _make_exercise_book_image()
    result = grade_submission(image_bytes, ANSWER_KEY, EDUCATION_LEVEL)
    return result


def test_grade_submission_returns_list(verdicts):
    """grade_submission must return a list, never None or a dict."""
    assert isinstance(verdicts, list), (
        f"Expected list, got {type(verdicts).__name__}. "
        "Check VERTEX_MODEL_ID and GCP credentials."
    )


def test_grade_submission_non_empty(verdicts):
    """Must return at least one verdict for a 3-question paper."""
    assert len(verdicts) > 0, (
        "grade_submission returned an empty list. "
        "Gemma 4 may have failed to parse the image or the answer key."
    )


def test_grade_submission_all_required_keys(verdicts):
    """Every verdict dict must contain all required keys."""
    required = {"question_number", "student_answer", "expected_answer",
                "verdict", "awarded_marks", "max_marks"}
    for i, v in enumerate(verdicts):
        assert isinstance(v, dict), f"verdict[{i}] is not a dict: {v!r}"
        missing = required - v.keys()
        assert not missing, (
            f"verdict[{i}] is missing keys {missing}.\nFull verdict: {v}"
        )


def test_grade_submission_verdict_values(verdicts):
    """verdict field must be one of the three allowed strings."""
    allowed = {"correct", "incorrect", "partial"}
    for i, v in enumerate(verdicts):
        assert v["verdict"] in allowed, (
            f"verdict[{i}]['verdict'] = {v['verdict']!r} is not one of {allowed}"
        )


def test_grade_submission_marks_are_numeric(verdicts):
    """awarded_marks and max_marks must both be numbers."""
    for i, v in enumerate(verdicts):
        assert isinstance(v["awarded_marks"], (int, float)), (
            f"verdict[{i}]['awarded_marks'] is not numeric: {v['awarded_marks']!r}"
        )
        assert isinstance(v["max_marks"], (int, float)), (
            f"verdict[{i}]['max_marks'] is not numeric: {v['max_marks']!r}"
        )


def test_grade_submission_scores_in_range(verdicts):
    """awarded_marks must be between 0 and max_marks (inclusive)."""
    for i, v in enumerate(verdicts):
        assert 0 <= v["awarded_marks"] <= v["max_marks"], (
            f"verdict[{i}] awarded_marks={v['awarded_marks']} is outside "
            f"[0, {v['max_marks']}]"
        )


def test_grade_submission_feedback_type(verdicts):
    """feedback must be a string or null — never another type."""
    for i, v in enumerate(verdicts):
        fb = v.get("feedback")
        assert fb is None or isinstance(fb, str), (
            f"verdict[{i}]['feedback'] is {type(fb).__name__}, expected str or null"
        )


def test_grade_submission_total_score_in_range(verdicts):
    """Total score must not exceed the answer key's total_marks."""
    total_awarded = sum(v["awarded_marks"] for v in verdicts)
    total_max     = ANSWER_KEY["total_marks"]
    assert 0 <= total_awarded <= total_max, (
        f"Total score {total_awarded} is outside [0, {total_max}]"
    )
