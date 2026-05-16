"""Tests for tools/dataset/format.py.

The format module is the schema gate — every extractor goes through
``write_example`` so a regression in any one extractor can't push a
malformed row into ``gs://neriah-ai-models/training/``.
"""

from __future__ import annotations

import io
import json

import pytest

from tools.dataset.format import (
    Example,
    merge_redactions,
    write_example,
    write_examples,
)
from tools.dataset.scrub import RedactionEvent, scrub


def _example(**overrides) -> Example:
    base = dict(
        user="Generate 5 questions on photosynthesis.",
        assistant='[{"prompt": "What absorbs light?", "options": ["a","b","c","d"], "correct": 0}]',
        source="play_lesson",
        source_id="play-001",
        subject="Biology",
        education_level="Form 3",
        submitted_at="2026-04-01T00:00:00Z",
    )
    base.update(overrides)
    return Example(**base)


class TestSchemaShape:
    def test_jsonl_has_messages_and_metadata(self):
        ex = _example()
        out = ex.to_jsonl_dict()
        assert set(out.keys()) == {"messages", "metadata"}
        assert [m["role"] for m in out["messages"]] == ["user", "assistant"]

    def test_metadata_includes_all_required_fields(self):
        ex = _example()
        meta = ex.to_jsonl_dict()["metadata"]
        for key in ("source", "source_id", "subject", "education_level", "submitted_at", "redaction_stats"):
            assert key in meta, f"missing metadata key: {key}"

    def test_redaction_stats_aggregate_by_kind(self):
        ex = _example(redactions=[
            RedactionEvent(kind="NAME", span=(0, 4), original_excerpt="Tino"),
            RedactionEvent(kind="NAME", span=(5, 9), original_excerpt="Maisiri"),
            RedactionEvent(kind="PHONE", span=(10, 23), original_excerpt="+263779929952"),
        ])
        meta = ex.to_jsonl_dict()["metadata"]
        assert meta["redaction_stats"] == {"NAME": 2, "PHONE": 1}


class TestWriteExampleValidation:
    def test_writes_one_line_with_trailing_newline(self):
        buf = io.StringIO()
        write_example(buf, _example())
        out = buf.getvalue()
        assert out.endswith("\n")
        assert out.count("\n") == 1

    def test_round_trip_through_json(self):
        buf = io.StringIO()
        write_example(buf, _example())
        parsed = json.loads(buf.getvalue())
        assert parsed["messages"][0]["content"].startswith("Generate")
        assert parsed["metadata"]["source"] == "play_lesson"

    def test_rejects_empty_user(self):
        with pytest.raises(ValueError, match="empty user"):
            write_example(io.StringIO(), _example(user="   "))

    def test_rejects_empty_assistant(self):
        with pytest.raises(ValueError, match="empty assistant"):
            write_example(io.StringIO(), _example(assistant=""))

    def test_blocks_unscrubbed_phone_in_user(self):
        with pytest.raises(ValueError, match="unscrubbed phone"):
            write_example(io.StringIO(), _example(user="Call +263779929952 about Q3."))

    def test_blocks_unscrubbed_phone_in_assistant(self):
        with pytest.raises(ValueError, match="unscrubbed phone"):
            write_example(io.StringIO(), _example(assistant='[{"prompt":"+263779929952","options":["a","b","c","d"],"correct":0}]'))

    def test_blocks_unscrubbed_email(self):
        with pytest.raises(ValueError, match="unscrubbed email"):
            write_example(io.StringIO(), _example(user="Email alice@example.com for the answer."))

    def test_scrubbed_input_passes_through(self):
        """A row that's been through scrub() should write cleanly."""
        scrubbed = scrub("Call +263779929952 today, Tinotenda.", names=["Tinotenda"])
        buf = io.StringIO()
        write_example(io.StringIO(), _example(user=scrubbed.text))
        # No exception. Sanity: confirmed the placeholders are present.
        assert "[PHONE]" in scrubbed.text
        assert "[NAME]" in scrubbed.text


class TestWriteExamples:
    def test_writes_count_of_streamed_examples(self):
        buf = io.StringIO()
        examples = [_example(source_id=f"play-{i:03d}") for i in range(5)]
        n = write_examples(buf, examples)
        assert n == 5
        assert buf.getvalue().count("\n") == 5


class TestMergeRedactions:
    def test_concatenates_in_order(self):
        a = scrub("Call +263779929952.")
        b = scrub("Email alice@example.com.")
        merged = merge_redactions(a, b)
        kinds = [r.kind for r in merged]
        assert kinds == ["PHONE", "EMAIL"]
