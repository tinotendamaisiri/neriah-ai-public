"""Tests for tools/dataset/from_exercise_books.py.

Covers vision-response parsing (including the row-validation
contract that drops un-graded entries), example construction, and
scrub integration. The vision caller is injected so tests stay
offline.
"""

from __future__ import annotations

import io
import json
from pathlib import Path

import pytest

from tools.dataset.format import write_examples
from tools.dataset.from_exercise_books import (
    _PageRecord,
    _format_assistant_completion,
    _format_user_prompt,
    _parse_vision_response,
    build_examples,
    iter_images,
)


# ─── Fixtures ────────────────────────────────────────────────────────────────


_CLEAN_VISION_RESPONSE = json.dumps({
    "subject": "Mathematics",
    "education_level": "Grade 4",
    "questions": [
        {
            "question_number": 1,
            "question_text": "What is 2 + 2?",
            "student_answer": "4",
            "teacher_mark": "correct",
            "awarded_marks": 1,
            "total_marks": 1,
            "teacher_feedback": "",
        },
        {
            "question_number": 2,
            "question_text": "What is 3 + 5?",
            "student_answer": "7",
            "teacher_mark": "incorrect",
            "awarded_marks": 0,
            "total_marks": 1,
            "teacher_feedback": "Check your addition.",
        },
    ],
})


def _stub_caller(payload):
    payloads = [payload] if isinstance(payload, str) else list(payload)
    state = {"i": 0}

    def _call(_image_bytes: bytes, _prompt: str) -> str:
        out = payloads[state["i"] % len(payloads)]
        state["i"] += 1
        return out

    return _call


def _img(*, path: str = "page1.jpg", body: bytes = b"\xff\xd8\xff\xe0fake jpeg"):
    return (Path(path), body)


# ─── Parser ────────────────────────────────────────────────────────────────


def _wrap(questions: list[dict], *, subject="Mathematics", education_level="Grade 4") -> str:
    return json.dumps({
        "subject": subject,
        "education_level": education_level,
        "questions": questions,
    })


class TestParseVisionResponse:
    def test_parses_clean_response(self):
        out = _parse_vision_response(_CLEAN_VISION_RESPONSE)
        assert out["subject"] == "Mathematics"
        assert out["education_level"] == "Grade 4"
        assert len(out["questions"]) == 2
        assert out["questions"][0]["verdict"] == "correct"
        assert out["questions"][1]["verdict"] == "incorrect"

    def test_strips_json_fence(self):
        wrapped = f"```json\n{_CLEAN_VISION_RESPONSE}\n```"
        out = _parse_vision_response(wrapped)
        assert len(out["questions"]) == 2

    def test_recovers_when_model_adds_prose(self):
        noisy = f"Here you go!\n{_CLEAN_VISION_RESPONSE}\nHope that helps."
        out = _parse_vision_response(noisy)
        assert len(out["questions"]) == 2

    def test_drops_unmarked_entries(self):
        """Un-graded entries have no gold target — we must skip them
        rather than save a row with verdict='unmarked'."""
        body = _wrap([
            {
                "question_number": 1,
                "student_answer": "2",
                "teacher_mark": "unmarked",
                "awarded_marks": 0,
                "total_marks": 1,
            }
        ])
        assert _parse_vision_response(body)["questions"] == []

    def test_drops_entries_with_empty_student_answer(self):
        body = _wrap([{"question_number": 1, "student_answer": "",
                       "teacher_mark": "correct", "awarded_marks": 1, "total_marks": 1}])
        assert _parse_vision_response(body)["questions"] == []

    def test_drops_entries_with_invalid_verdict(self):
        body = _wrap([{"question_number": 1, "student_answer": "4",
                       "teacher_mark": "great", "awarded_marks": 1, "total_marks": 1}])
        assert _parse_vision_response(body)["questions"] == []

    def test_clamps_negative_awarded_to_zero(self):
        body = _wrap([{"question_number": 1, "student_answer": "x",
                       "teacher_mark": "incorrect", "awarded_marks": -3, "total_marks": 1}])
        out = _parse_vision_response(body)
        assert out["questions"][0]["awarded_marks"] == 0

    def test_clamps_awarded_above_total(self):
        body = _wrap([{"question_number": 1, "student_answer": "x",
                       "teacher_mark": "correct", "awarded_marks": 99, "total_marks": 2}])
        out = _parse_vision_response(body)
        assert out["questions"][0]["awarded_marks"] == 2

    def test_defaults_total_to_one_when_zero(self):
        body = _wrap([{"question_number": 1, "student_answer": "x",
                       "teacher_mark": "correct", "awarded_marks": 1, "total_marks": 0}])
        out = _parse_vision_response(body)
        assert out["questions"][0]["total_marks"] == 1

    def test_returns_empty_on_garbage(self):
        for body in ("not json", "", "{}"):
            out = _parse_vision_response(body)
            assert out["questions"] == []
            assert out["subject"] is None
            assert out["education_level"] is None

    def test_legacy_array_response_still_parses(self):
        """If Gemma returns the older array-only shape, we should
        still pull questions out — subject/level just come through
        as None (the caller's CLI args will fill them in)."""
        legacy = json.dumps([
            {"question_number": 1, "student_answer": "4",
             "teacher_mark": "correct", "awarded_marks": 1, "total_marks": 1}
        ])
        out = _parse_vision_response(legacy)
        assert len(out["questions"]) == 1
        assert out["subject"] is None
        assert out["education_level"] is None

    def test_invalid_subject_normalises_to_none(self):
        body = _wrap([{"question_number": 1, "student_answer": "x",
                       "teacher_mark": "correct", "awarded_marks": 1, "total_marks": 1}],
                     subject="MadeUpSubject")
        out = _parse_vision_response(body)
        assert out["subject"] is None
        assert len(out["questions"]) == 1

    def test_invalid_level_normalises_to_none(self):
        body = _wrap([{"question_number": 1, "student_answer": "x",
                       "teacher_mark": "correct", "awarded_marks": 1, "total_marks": 1}],
                     education_level="Year 7")
        out = _parse_vision_response(body)
        assert out["education_level"] is None
        assert len(out["questions"]) == 1

    def test_form_levels_pass_normalisation(self):
        body = _wrap([{"question_number": 1, "student_answer": "x",
                       "teacher_mark": "correct", "awarded_marks": 1, "total_marks": 1}],
                     education_level="Form 4")
        out = _parse_vision_response(body)
        assert out["education_level"] == "Form 4"


# ─── Example construction ──────────────────────────────────────────────────


class TestBuildExamples:
    def test_builds_one_example_per_page(self):
        images = [_img(path="page1.jpg")]
        out = list(build_examples(images, caller=_stub_caller(_CLEAN_VISION_RESPONSE)))
        assert len(out) == 1

    def test_user_prompt_includes_questions_and_answers(self):
        out = list(build_examples([_img()], caller=_stub_caller(_CLEAN_VISION_RESPONSE)))
        assert "Q1: What is 2 + 2?" in out[0].user
        assert "A1: 4" in out[0].user
        assert "Q2: What is 3 + 5?" in out[0].user
        assert "A2: 7" in out[0].user

    def test_assistant_is_verdict_json(self):
        out = list(build_examples([_img()], caller=_stub_caller(_CLEAN_VISION_RESPONSE)))
        verdicts = json.loads(out[0].assistant)
        assert isinstance(verdicts, list)
        assert verdicts[0]["verdict"] == "correct"
        assert verdicts[1]["verdict"] == "incorrect"
        assert verdicts[1]["feedback"] == "Check your addition."

    def test_subject_and_level_propagate_to_metadata(self):
        out = list(build_examples(
            [_img()],
            caller=_stub_caller(_CLEAN_VISION_RESPONSE),
            subject="Mathematics",
            education_level="Grade 4",
        ))
        meta = out[0].to_jsonl_dict()["metadata"]
        assert meta["subject"] == "Mathematics"
        assert meta["education_level"] == "Grade 4"
        assert meta["source"] == "exercise_book"

    def test_source_id_is_image_hash_not_filename(self):
        """File paths can carry student names — the dataset must key
        on the SHA of the bytes, not the filename."""
        out = list(build_examples(
            [_img(path="Tinotenda_Maisiri_homework.jpg", body=b"hello jpeg payload")],
            caller=_stub_caller(_CLEAN_VISION_RESPONSE),
        ))
        # Source id is a 16-char sha hex prefix — never the filename.
        assert "Tinotenda" not in out[0].source_id
        assert "Maisiri" not in out[0].source_id
        assert len(out[0].source_id) == 16

    def test_skips_image_when_caller_raises(self):
        def _broken(_b, _p):
            raise RuntimeError("Vertex 503")

        out = list(build_examples([_img(), _img(path="b.jpg")], caller=_broken))
        assert out == []

    def test_skips_image_when_response_is_empty(self):
        out = list(build_examples([_img()], caller=_stub_caller("")))
        assert out == []

    def test_skips_image_when_no_graded_entries(self):
        body = _wrap([{
            "question_number": 1,
            "student_answer": "x",
            "teacher_mark": "unmarked",
            "awarded_marks": 0,
            "total_marks": 1,
        }])
        out = list(build_examples([_img()], caller=_stub_caller(body)))
        assert out == []

    def test_uses_gemma_inferred_subject_when_cli_arg_missing(self):
        """When the user runs the extractor without subject/level
        flags (mixed dataset), we should keep whatever Gemma
        identified from the page itself."""
        out = list(build_examples([_img()], caller=_stub_caller(_CLEAN_VISION_RESPONSE)))
        meta = out[0].to_jsonl_dict()["metadata"]
        assert meta["subject"] == "Mathematics"
        assert meta["education_level"] == "Grade 4"

    def test_cli_arg_overrides_gemma_inferred(self):
        """When the caller pins subject/level explicitly, that wins
        over what Gemma saw — useful when the dataset is known to be
        a single subject and we don't trust per-image inference."""
        out = list(build_examples(
            [_img()],
            caller=_stub_caller(_CLEAN_VISION_RESPONSE),
            subject="English",
            education_level="Form 2",
        ))
        meta = out[0].to_jsonl_dict()["metadata"]
        assert meta["subject"] == "English"
        assert meta["education_level"] == "Form 2"

    def test_continues_after_one_failure(self):
        responses = ["not json", _CLEAN_VISION_RESPONSE]
        images = [_img(path="bad.jpg"), _img(path="good.jpg")]
        out = list(build_examples(images, caller=_stub_caller(responses)))
        assert len(out) == 1


# ─── Scrub integration ─────────────────────────────────────────────────────


class TestScrubIntegration:
    def test_scrubs_student_name_in_question(self):
        body = _wrap([{
            "question_number": 1,
            "question_text": "Tinotenda counted 5 sheep. How many?",
            "student_answer": "5",
            "teacher_mark": "correct",
            "awarded_marks": 1,
            "total_marks": 1,
        }])
        out = list(build_examples(
            [_img()],
            caller=_stub_caller(body),
            names=["Tinotenda"],
        ))
        assert "Tinotenda" not in out[0].user
        assert "[NAME]" in out[0].user

    def test_format_layer_blocks_unscrubbed_phone(self):
        """Belt-and-braces — if a phone number leaks through, the
        format-layer regex check in write_example refuses to write."""
        body = _wrap([{
            "question_number": 1,
            "question_text": "Call who?",
            "student_answer": "Call +263779929952",
            "teacher_mark": "incorrect",
            "awarded_marks": 0,
            "total_marks": 1,
        }])
        out = list(build_examples([_img()], caller=_stub_caller(body)))
        buf = io.StringIO()
        n = write_examples(buf, out)
        assert n == 1
        assert "+263779929952" not in buf.getvalue()
        assert "[PHONE]" in buf.getvalue()


# ─── Unsloth shape lock ────────────────────────────────────────────────────


class TestUnslothShape:
    def test_jsonl_round_trip(self):
        out = list(build_examples([_img()], caller=_stub_caller(_CLEAN_VISION_RESPONSE)))
        buf = io.StringIO()
        n = write_examples(buf, out)
        assert n == 1
        obj = json.loads(buf.getvalue())
        assert [m["role"] for m in obj["messages"]] == ["user", "assistant"]
        assert obj["metadata"]["source"] == "exercise_book"


# ─── Filesystem walker ─────────────────────────────────────────────────────


class TestIterImages:
    def test_returns_empty_for_empty_dir(self, tmp_path):
        assert list(iter_images(tmp_path)) == []

    def test_picks_up_supported_extensions(self, tmp_path):
        (tmp_path / "a.jpg").write_bytes(b"x")
        (tmp_path / "b.PNG").write_bytes(b"y")
        (tmp_path / "c.txt").write_bytes(b"z")          # ignored
        (tmp_path / "d.heic").write_bytes(b"w")
        out = [p.name for p, _ in iter_images(tmp_path)]
        assert sorted(out) == ["a.jpg", "b.PNG", "d.heic"]

    def test_walks_subdirectories(self, tmp_path):
        sub = tmp_path / "form4" / "math"
        sub.mkdir(parents=True)
        (sub / "page1.jpg").write_bytes(b"x")
        out = [p.name for p, _ in iter_images(tmp_path)]
        assert out == ["page1.jpg"]

    def test_skips_files_above_max_size(self, tmp_path):
        from tools.dataset import from_exercise_books
        (tmp_path / "tiny.jpg").write_bytes(b"x")
        # Force the cap below the file we just wrote so we hit the skip path.
        # Use monkeypatch via attribute swap.
        cap_orig = from_exercise_books._MAX_IMAGE_BYTES
        try:
            from_exercise_books._MAX_IMAGE_BYTES = 0
            out = list(iter_images(tmp_path))
            assert out == []
        finally:
            from_exercise_books._MAX_IMAGE_BYTES = cap_orig

    def test_max_files_caps_yield(self, tmp_path):
        for i in range(5):
            (tmp_path / f"page_{i}.jpg").write_bytes(b"x")
        out = list(iter_images(tmp_path, max_files=3))
        assert len(out) == 3


# ─── Format helpers ────────────────────────────────────────────────────────


class TestFormatHelpers:
    def _record(self, **overrides) -> _PageRecord:
        base = dict(
            image_id="abc123",
            subject="Mathematics",
            education_level="Grade 4",
            questions=[
                {
                    "question_number": 1,
                    "question_text": "What is 2 + 2?",
                    "student_answer": "4",
                    "verdict": "correct",
                    "awarded_marks": 1,
                    "total_marks": 1,
                    "teacher_feedback": "",
                },
            ],
        )
        base.update(overrides)
        return _PageRecord(**base)

    def test_user_prompt_uses_subject_and_level(self):
        out = _format_user_prompt(self._record())
        assert "Mathematics" in out
        assert "Grade 4" in out

    def test_user_prompt_falls_back_when_subject_missing(self):
        out = _format_user_prompt(self._record(subject=None, education_level=None))
        assert "any subject" in out
        assert "any level" in out

    def test_assistant_completion_drops_visible_text_fields(self):
        completion = _format_assistant_completion(self._record())
        parsed = json.loads(completion)
        # Visible text fields stay in the user prompt only — never in the
        # assistant target.
        assert "question_text" not in parsed[0]
        assert "student_answer" not in parsed[0]
        assert parsed[0]["verdict"] == "correct"
        assert parsed[0]["awarded_marks"] == 1
