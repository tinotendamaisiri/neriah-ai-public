"""Tests for tools/dataset/from_play_lessons.py."""

from __future__ import annotations

import io
import json

import pytest

from tools.dataset.format import write_examples
from tools.dataset.from_play_lessons import _LessonRow, build_examples


def _q(prompt: str = "What is X?") -> dict:
    return {
        "prompt": prompt,
        "options": ["a", "b", "c", "d"],
        "correct": 0,
    }


def _row(**overrides) -> _LessonRow:
    base = dict(
        id="play-001",
        title="Photosynthesis Drill",
        subject="Biology",
        grade="Form 3",
        source_content="Photosynthesis is the process by which plants make food.",
        questions=[_q(f"Q{i}") for i in range(20)],
        status="ready",
        created_at="2026-04-01T00:00:00Z",
    )
    base.update(overrides)
    return _LessonRow(**base)


class TestRowEligibility:
    def test_includes_ready_lesson_with_enough_questions(self):
        rows = [_row()]
        examples = list(build_examples(rows))
        assert len(examples) == 1

    def test_excludes_lesson_still_generating(self):
        rows = [_row(status="generating")]
        assert list(build_examples(rows)) == []

    def test_excludes_lesson_with_empty_source(self):
        rows = [_row(source_content="   ")]
        assert list(build_examples(rows)) == []

    def test_excludes_lesson_with_too_few_questions(self):
        rows = [_row(questions=[_q(f"Q{i}") for i in range(5)])]
        assert list(build_examples(rows)) == []


class TestQuestionValidation:
    def test_drops_malformed_rows_in_completion(self):
        questions = [
            _q("Q1"),
            {"prompt": "no options"},                                 # missing options
            {"prompt": "wrong arity", "options": ["a", "b"], "correct": 0},  # 2 options
            {"prompt": "bad correct", "options": ["a", "b", "c", "d"], "correct": 9},
            *(_q(f"Q{i}") for i in range(15)),
        ]
        rows = [_row(questions=questions)]
        examples = list(build_examples(rows))
        assert len(examples) == 1
        completion = examples[0].assistant
        parsed = json.loads(completion)
        # 1 + 15 valid questions; 3 garbage entries dropped.
        assert len(parsed) == 16


class TestUnslothShape:
    """The output JSONL must work with Unsloth's
    standardize_sharegpt + apply_chat_template path. Locking the
    shape here means an extractor regression can't break the
    fine-tune downstream."""

    def test_messages_shape_matches_unsloth_chat(self):
        rows = [_row()]
        examples = list(build_examples(rows))
        out = examples[0].to_jsonl_dict()
        assert "messages" in out
        roles = [m["role"] for m in out["messages"]]
        assert roles == ["user", "assistant"]
        for m in out["messages"]:
            assert isinstance(m["content"], str)
            assert m["content"].strip()

    def test_metadata_carries_split_fields(self):
        """assemble.py relies on submitted_at + source for the
        80/10/10 timestamp split and the per-source row counts."""
        rows = [_row()]
        examples = list(build_examples(rows))
        meta = examples[0].to_jsonl_dict()["metadata"]
        assert meta["source"] == "play_lesson"
        assert meta["source_id"] == "play-001"
        assert meta["submitted_at"] == "2026-04-01T00:00:00Z"
        assert meta["subject"] == "Biology"
        assert meta["education_level"] == "Form 3"


class TestScrubIntegration:
    def test_scrubs_names_in_source_content(self):
        rows = [_row(source_content="Tinotenda explains photosynthesis to Kundai.")]
        examples = list(build_examples(rows, names=["Tinotenda", "Kundai"]))
        assert len(examples) == 1
        assert "Tinotenda" not in examples[0].user
        assert "Kundai" not in examples[0].user
        assert examples[0].user.count("[NAME]") == 2

    def test_scrubs_school_in_source_content(self):
        rows = [_row(source_content="At Chiredzi High School, students study biology.")]
        examples = list(build_examples(rows, schools=["Chiredzi High School"]))
        assert "Chiredzi High School" not in examples[0].user
        assert "[SCHOOL]" in examples[0].user

    def test_scrub_redactions_propagate_to_metadata(self):
        rows = [_row(source_content="Tinotenda is in Form 3.")]
        examples = list(build_examples(rows, names=["Tinotenda"]))
        meta = examples[0].to_jsonl_dict()["metadata"]
        assert meta["redaction_stats"].get("NAME", 0) >= 1


class TestEndToEndJSONL:
    def test_roundtrip_through_write_examples(self):
        rows = [_row(id=f"play-{i:03d}") for i in range(3)]
        buf = io.StringIO()
        n = write_examples(buf, build_examples(rows))
        assert n == 3
        lines = buf.getvalue().splitlines()
        assert len(lines) == 3
        for line in lines:
            obj = json.loads(line)
            # Unsloth-friendly shape.
            assert "messages" in obj and "metadata" in obj
            assert obj["messages"][0]["role"] == "user"
            assert obj["messages"][1]["role"] == "assistant"
