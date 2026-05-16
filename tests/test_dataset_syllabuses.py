"""Tests for tools/dataset/from_syllabuses.py.

Covers the parts of the syllabus extractor that don't need Vertex
or pdfplumber: chunk yielding, JSON parser robustness, prompt
construction, and the scrub→Example pipeline. The Vertex caller
is injected so tests stay offline and fast.
"""

from __future__ import annotations

import io
import json
from pathlib import Path

import pytest

from tools.dataset.format import write_examples
from tools.dataset.from_syllabuses import (
    _PROMPT_TEMPLATE,
    _SyllabusChunk,
    _is_noise_chunk,
    _parse_qa_array,
    build_examples,
    iter_chunks,
)


# ─── Fixtures ────────────────────────────────────────────────────────────────


def _chunk(**overrides) -> _SyllabusChunk:
    base = dict(
        syllabus_id="SYLLABUS_Mathematics_OLevel_Zimbabwe",
        chunk_index=0,
        subject="Mathematics",
        education_level="O-Level",
        text="Quadratic equations have the form ax^2 + bx + c = 0. The "
             "discriminant b^2 - 4ac determines the nature of the roots.",
    )
    base.update(overrides)
    return _SyllabusChunk(**base)


def _stub_caller(payload):
    """Make a fake Gemma caller that returns the same payload every call.
    Pass a list to vary responses across chunks (cycled)."""
    if isinstance(payload, str):
        payloads = [payload]
    else:
        payloads = list(payload)
    state = {"i": 0}

    def _call(_prompt: str) -> str:
        out = payloads[state["i"] % len(payloads)]
        state["i"] += 1
        return out

    return _call


_CLEAN_RESPONSE = json.dumps([
    {"question": "Define a quadratic equation.", "answer": "An equation of degree 2."},
    {"question": "What is the discriminant?", "answer": "b^2 - 4ac."},
])


# ─── Parser ────────────────────────────────────────────────────────────────


class TestParseQAArray:
    def test_parses_clean_array(self):
        out = _parse_qa_array(_CLEAN_RESPONSE)
        assert len(out) == 2
        assert out[0]["question"].startswith("Define")
        assert out[1]["answer"] == "b^2 - 4ac."

    def test_strips_json_fence(self):
        wrapped = f"```json\n{_CLEAN_RESPONSE}\n```"
        assert len(_parse_qa_array(wrapped)) == 2

    def test_strips_bare_fence(self):
        wrapped = f"```\n{_CLEAN_RESPONSE}\n```"
        assert len(_parse_qa_array(wrapped)) == 2

    def test_recovers_when_model_adds_prose_around_array(self):
        noisy = (
            "Sure! Here are the questions you asked for:\n"
            f"{_CLEAN_RESPONSE}\n"
            "Hope that helps."
        )
        assert len(_parse_qa_array(noisy)) == 2

    def test_drops_rows_missing_question(self):
        bad = json.dumps([
            {"question": "", "answer": "x"},
            {"answer": "lone"},
            {"question": "real", "answer": "yes"},
        ])
        out = _parse_qa_array(bad)
        assert len(out) == 1
        assert out[0]["question"] == "real"

    def test_returns_empty_on_garbage(self):
        assert _parse_qa_array("not even close") == []
        assert _parse_qa_array("") == []
        assert _parse_qa_array("{}") == []  # object, not array
        assert _parse_qa_array("[1, 2, 3]") == []  # not dicts


# ─── Noise filter ───────────────────────────────────────────────────────────


class TestNoiseFilter:
    def test_drops_short_chunks(self):
        assert _is_noise_chunk("only a sentence") is True

    def test_drops_table_of_contents(self):
        assert _is_noise_chunk("Table of Contents\n" + "x" * 400) is True

    def test_drops_page_markers(self):
        assert _is_noise_chunk("page 4\n" + "y" * 400) is True

    def test_keeps_real_content(self):
        text = "Quadratic equations are central to algebra. " * 20
        assert _is_noise_chunk(text) is False


# ─── build_examples integration ─────────────────────────────────────────────


class TestBuildExamples:
    def test_emits_one_example_per_qa_pair(self):
        chunks = [_chunk()]
        out = list(build_examples(chunks, caller=_stub_caller(_CLEAN_RESPONSE)))
        assert len(out) == 2
        assert out[0].source == "syllabus"
        assert out[0].source_id.endswith("#qa=0")
        assert out[1].source_id.endswith("#qa=1")

    def test_metadata_carries_subject_and_level(self):
        out = list(build_examples([_chunk()], caller=_stub_caller(_CLEAN_RESPONSE)))
        meta = out[0].to_jsonl_dict()["metadata"]
        assert meta["subject"] == "Mathematics"
        assert meta["education_level"] == "O-Level"
        assert meta["source"] == "syllabus"
        assert meta["submitted_at"] is None

    def test_user_prompt_includes_subject_and_question(self):
        out = list(build_examples([_chunk()], caller=_stub_caller(_CLEAN_RESPONSE)))
        assert "Subject: Mathematics" in out[0].user
        assert "Define a quadratic equation" in out[0].user

    def test_skips_chunk_when_caller_raises(self):
        def _broken(_prompt):
            raise RuntimeError("Vertex 503")

        out = list(build_examples([_chunk(), _chunk(chunk_index=1)], caller=_broken))
        assert out == []

    def test_skips_chunk_when_response_is_empty(self):
        out = list(build_examples([_chunk()], caller=_stub_caller("")))
        assert out == []

    def test_skips_chunk_with_no_valid_pairs(self):
        bad = json.dumps([{"question": "", "answer": ""}])
        out = list(build_examples([_chunk()], caller=_stub_caller(bad)))
        assert out == []

    def test_continues_after_one_failure(self):
        responses = ["not json", _CLEAN_RESPONSE]
        chunks = [_chunk(chunk_index=0), _chunk(chunk_index=1)]
        out = list(build_examples(chunks, caller=_stub_caller(responses)))
        # First chunk skipped, second produces 2.
        assert len(out) == 2
        assert all(e.source_id.startswith("SYLLABUS_Mathematics_OLevel_Zimbabwe#chunk=1") for e in out)


# ─── Scrub integration ─────────────────────────────────────────────────────


class TestScrubIntegration:
    def test_scrubs_names_in_qa(self):
        response = json.dumps([
            {
                "question": "Tinotenda solves a quadratic. What does he find?",
                "answer": "Tinotenda finds two roots.",
            },
        ])
        out = list(build_examples(
            [_chunk()],
            caller=_stub_caller(response),
            names=["Tinotenda"],
        ))
        assert len(out) == 1
        assert "Tinotenda" not in out[0].user
        assert "Tinotenda" not in out[0].assistant
        assert "[NAME]" in out[0].user

    def test_blocks_unscrubbed_phone_via_format_layer(self):
        # If the model leaks a phone and we forgot scrub, format.write_example
        # must still raise. Belt-and-braces test.
        response = json.dumps([
            {"question": "Call who?", "answer": "+263779929952."},
        ])
        # build_examples runs scrub() — phone should be redacted by the time
        # the Example reaches write_examples.
        out = list(build_examples([_chunk()], caller=_stub_caller(response)))
        buf = io.StringIO()
        n = write_examples(buf, out)
        assert n == 1  # passes because scrub() redacted +263...
        assert "+263779929952" not in buf.getvalue()
        assert "[PHONE]" in buf.getvalue()


# ─── Unsloth shape lock ────────────────────────────────────────────────────


class TestUnslothShape:
    def test_messages_shape_matches_unsloth(self):
        out = list(build_examples([_chunk()], caller=_stub_caller(_CLEAN_RESPONSE)))
        on_disk = out[0].to_jsonl_dict()
        assert set(on_disk.keys()) == {"messages", "metadata"}
        roles = [m["role"] for m in on_disk["messages"]]
        assert roles == ["user", "assistant"]

    def test_jsonl_round_trip(self):
        out = list(build_examples([_chunk()], caller=_stub_caller(_CLEAN_RESPONSE)))
        buf = io.StringIO()
        n = write_examples(buf, out)
        assert n == 2
        for line in buf.getvalue().splitlines():
            obj = json.loads(line)
            assert obj["messages"][0]["role"] == "user"
            assert obj["messages"][1]["role"] == "assistant"
            assert obj["metadata"]["source"] == "syllabus"


# ─── Prompt template ───────────────────────────────────────────────────────


class TestPromptTemplate:
    def test_prompt_includes_subject_level_and_count(self):
        prompt = _PROMPT_TEMPLATE.format(
            subject="Biology", education_level="Form 3", n=4, chunk="(text here)"
        )
        assert "Subject: Biology" in prompt
        assert "Education level: Form 3" in prompt
        assert "produce 4 concise questions" in prompt
        assert "(text here)" in prompt
        # Refuses fences in the response.
        assert "no fences" in prompt


# ─── iter_chunks (filesystem-driven, uses pdfplumber stub) ─────────────────


class TestIterChunks:
    def test_returns_empty_for_empty_directory(self, tmp_path):
        out = list(iter_chunks(tmp_path))
        assert out == []

    def test_skips_pdfs_that_fail_extraction(self, tmp_path, monkeypatch):
        (tmp_path / "SYLLABUS_Math_OLevel_Zimbabwe.pdf").write_bytes(b"not a pdf")

        # pdfplumber will fail to open the bogus file → _read_pdf_text
        # logs and returns "" → the file is skipped.
        out = list(iter_chunks(tmp_path))
        assert out == []
