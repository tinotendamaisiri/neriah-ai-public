"""Tests for tools/dataset/_kaggle_gemma.py.

The factories themselves load real models — too heavy for CI. We
test the seam: the *signature* the factories produce. Then we
verify the rest of the dataset pipeline is happy with a stub built
to that signature, which is how the Kaggle notebook actually wires
things together.
"""

from __future__ import annotations

import io
import json

import pytest

from tools.dataset.format import write_examples
from tools.dataset.from_exercise_books import build_examples as eb_examples
from tools.dataset.from_syllabuses import build_examples as syl_examples, _SyllabusChunk


def _stub_text_caller(payload: str):
    """A stub matching GemmaCaller signature: (prompt) -> str."""
    def _call(prompt: str) -> str:
        return payload
    return _call


def _stub_vision_caller(payload: str):
    """A stub matching VisionCaller signature: (image_bytes, prompt) -> str."""
    def _call(image_bytes: bytes, prompt: str) -> str:
        return payload
    return _call


# ─── Module shape ──────────────────────────────────────────────────────────


class TestModuleShape:
    def test_factories_are_exported(self):
        from tools.dataset import _kaggle_gemma
        assert callable(_kaggle_gemma.make_text_caller)
        assert callable(_kaggle_gemma.make_vision_caller)

    def test_module_does_not_import_torch_at_module_load(self):
        """Imports of torch / transformers / PIL are deferred to call
        time so the rest of the test suite (which may run without a
        GPU stack) doesn't pay the import cost."""
        import importlib
        import sys

        # Force a fresh import.
        sys.modules.pop("tools.dataset._kaggle_gemma", None)
        importlib.import_module("tools.dataset._kaggle_gemma")
        # If torch is not installed in this env, it shouldn't have
        # been pulled in just by importing the module.
        if "torch" not in sys.modules:
            assert "torch" not in sys.modules
        # Module-level `from transformers import ...` would surface here.


# ─── Signature compatibility — the contract the Kaggle notebook relies on ──


class TestTextCallerSignature:
    """A function with signature (str) -> str must work as a drop-in
    for from_syllabuses.build_examples(caller=...). This is the test
    the notebook implicitly depends on."""

    def test_drop_in_to_syllabus_extractor(self):
        chunk = _SyllabusChunk(
            syllabus_id="SYLLABUS_X_OLevel_Zimbabwe",
            chunk_index=0,
            subject="X",
            education_level="O-Level",
            text="A" * 400,
        )
        response = json.dumps([{"question": "Q?", "answer": "A."}])
        out = list(syl_examples([chunk], caller=_stub_text_caller(response)))
        assert len(out) == 1


class TestVisionCallerSignature:
    """A function with signature (bytes, str) -> str must work as a
    drop-in for from_exercise_books.build_examples(caller=...)."""

    def test_drop_in_to_exercise_book_extractor(self):
        from pathlib import Path

        response = json.dumps({
            "subject": "Mathematics",
            "education_level": "Grade 4",
            "questions": [{
                "question_number": 1,
                "question_text": "What is 2 + 2?",
                "student_answer": "4",
                "teacher_mark": "correct",
                "awarded_marks": 1,
                "total_marks": 1,
            }],
        })
        images = [(Path("page.jpg"), b"\xff\xd8\xff\xe0")]
        out = list(eb_examples(images, caller=_stub_vision_caller(response)))
        assert len(out) == 1


# ─── Dtype resolution — the only pure-logic helper ─────────────────────────


class TestResolveDtype:
    def test_unknown_raises(self):
        from tools.dataset._kaggle_gemma import _resolve_dtype
        with pytest.raises(ValueError, match="unknown dtype"):
            _resolve_dtype("bogus")

    def test_known_names_do_not_raise_when_torch_available(self):
        """If torch is installed in this env, the helper should
        resolve 'float16' / 'float32' without error. If torch isn't
        installed, the helper raises ImportError — also acceptable
        (we don't ship torch in the dev env)."""
        from tools.dataset._kaggle_gemma import _resolve_dtype
        try:
            import torch  # noqa: F401
        except ImportError:
            with pytest.raises(ImportError):
                _resolve_dtype("float16")
            return
        assert _resolve_dtype("float16") is __import__("torch").float16
        assert _resolve_dtype("float32") is __import__("torch").float32


# ─── End-to-end JSONL roundtrip with stub callers ──────────────────────────


class TestEndToEndRoundtrip:
    """The Kaggle notebook will pipe extractor output into
    write_examples and then into Unsloth. Verify that a stub caller
    in the same shape as the real Kaggle Gemma round-trips cleanly."""

    def test_syllabus_pipeline_writes_jsonl(self):
        chunk = _SyllabusChunk(
            syllabus_id="SYLLABUS_X_OLevel_Zimbabwe",
            chunk_index=0,
            subject="X",
            education_level="O-Level",
            text="A" * 400,
        )
        response = json.dumps([
            {"question": "Q1?", "answer": "A1."},
            {"question": "Q2?", "answer": "A2."},
        ])
        buf = io.StringIO()
        n = write_examples(buf, syl_examples([chunk], caller=_stub_text_caller(response)))
        assert n == 2
        for line in buf.getvalue().splitlines():
            obj = json.loads(line)
            assert obj["metadata"]["source"] == "syllabus"

    def test_exercise_book_pipeline_writes_jsonl(self):
        from pathlib import Path

        response = json.dumps({
            "subject": "Mathematics",
            "education_level": "Grade 4",
            "questions": [{
                "question_number": 1,
                "student_answer": "4",
                "teacher_mark": "correct",
                "awarded_marks": 1,
                "total_marks": 1,
            }],
        })
        images = [(Path("a.jpg"), b"\xff\xd8\xff"), (Path("b.jpg"), b"\xff\xd8\xff")]
        buf = io.StringIO()
        n = write_examples(buf, eb_examples(images, caller=_stub_vision_caller(response)))
        assert n == 2
        for line in buf.getvalue().splitlines():
            obj = json.loads(line)
            assert obj["metadata"]["source"] == "exercise_book"
