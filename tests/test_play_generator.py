"""
Unit tests for shared.play_generator.

Every test mocks the Vertex Gemma call (`_vertex_chat_completions`) and
the embeddings backend (`get_embedding`) so the suite never touches the
network.
"""

from __future__ import annotations

import json
from collections import Counter
from unittest.mock import patch

import pytest

# ─── Helpers ──────────────────────────────────────────────────────────────────

def _make_question(prompt: str, correct: int = 0) -> dict:
    """Build a minimal valid question dict with 4 unique short options."""
    return {
        "prompt": prompt,
        "options": ["alpha", "bravo", "charlie", "delta"],
        "correct": correct,
    }


def _gemma_returns_questions(questions: list[dict]) -> str:
    """Encode a list of question dicts as the JSON Gemma would return."""
    return json.dumps(questions)


def _gemma_call_factory(batches: list[list[dict]]):
    """Return a side_effect function that yields one batch per call."""
    iter_batches = iter(batches)

    def _call(messages, **kwargs):  # noqa: ARG001
        try:
            batch = next(iter_batches)
        except StopIteration:
            return _gemma_returns_questions([])  # empty → drives the low-yield stop
        return _gemma_returns_questions(batch)

    return _call


# ─── Tests ────────────────────────────────────────────────────────────────────

def test_position_randomization_uniform():
    """100 questions all generated with correct=0 should land roughly
    uniformly across A/B/C/D after position randomisation."""
    # 100 unique prompts, all correct=0.
    questions = [_make_question(f"Question number {i}", correct=0) for i in range(100)]

    with patch(
        "shared.play_generator._vertex_chat_completions",
        side_effect=_gemma_call_factory([questions, []]),
    ), patch(
        "shared.play_generator.get_embedding",
        return_value=[],  # disable semantic-dup checks
    ):
        from shared.play_generator import generate_lesson_questions
        out, count, _was_expanded = generate_lesson_questions(
            "Photosynthesis is the process by which plants convert light into energy.",
            target=100,
            minimum=70,
        )

    assert count == 100
    distribution = Counter(q.correct for q in out)
    # Every bucket should be filled.
    for slot in range(4):
        assert distribution[slot] >= 18, (
            f"correct={slot} only appeared {distribution[slot]} times — "
            f"expected ≥18 (target 25). Distribution: {dict(distribution)}"
        )
        assert distribution[slot] <= 32, (
            f"correct={slot} appeared {distribution[slot]} times — "
            f"expected ≤32 (target 25). Distribution: {dict(distribution)}"
        )


def test_dedup_rejects_exact_match():
    """Two questions with identical prompts → second is dropped."""
    batch = [
        _make_question("What is 2+2?"),
        _make_question("What is 2+2?"),  # exact dup
        _make_question("Capital of Zimbabwe?"),
    ]
    with patch(
        "shared.play_generator._vertex_chat_completions",
        side_effect=_gemma_call_factory([batch, []]),
    ), patch(
        "shared.play_generator.get_embedding",
        return_value=[],
    ):
        from shared.play_generator import generate_lesson_questions
        out, count, _was_expanded = generate_lesson_questions(
            "Test source content covering basic arithmetic and geography.",
            target=2,
        )

    assert count == 2
    prompts = [q.prompt for q in out]
    assert len(set(prompts)) == 2


def test_dedup_rejects_semantic_match():
    """Distinct prompts but cosine ≥ 0.85 → second is dropped."""
    batch = [
        _make_question("First semantic prompt"),
        _make_question("First semantic prompt rephrased"),
    ]

    # Mock embeddings: any input returns the same vector → cosine = 1.0.
    with patch(
        "shared.play_generator._vertex_chat_completions",
        side_effect=_gemma_call_factory([batch, []]),
    ), patch(
        "shared.play_generator.get_embedding",
        return_value=[1.0, 0.0, 0.0],
    ):
        from shared.play_generator import generate_lesson_questions
        out, count, _was_expanded = generate_lesson_questions(
            "Some source content for the test that's reasonably long.",
            target=1,
        )

    assert count == 1, f"semantic dedup failed — got {count} questions"


def test_validation_caps_lengths():
    """Over-long prompts and options are truncated to fit the limit."""
    long_prompt = "A" * 200
    long_option = "B" * 50

    batch = [{
        "prompt": long_prompt,
        "options": [long_option, "ok-2", "ok-3", "ok-4"],
        "correct": 0,
    }]

    with patch(
        "shared.play_generator._vertex_chat_completions",
        side_effect=_gemma_call_factory([batch, []]),
    ), patch(
        "shared.play_generator.get_embedding",
        return_value=[],
    ):
        from shared.play_generator import generate_lesson_questions
        out, count, _was_expanded = generate_lesson_questions(
            "Source content for the truncation test that's reasonably long.",
            target=1,
        )

    assert count == 1
    assert len(out[0].prompt) <= 80
    assert len(out[0].options[0]) <= 25


def test_safety_valve_raises_when_under_target():
    """Generator must hit `target` exactly. When all batches and tier
    escalations together can't produce 100 unique questions, the safety
    valve fires — the route returns a clear failure rather than saving a
    partial lesson."""
    # Two small batches followed by empty batches across every tier — the
    # generator burns its full _MAX_BATCHES budget without reaching 100.
    batch1 = [_make_question(f"Prompt {i}") for i in range(10)]
    batch2 = [_make_question(f"Prompt B {i}") for i in range(8)]
    empties = [[]] * 25

    with patch(
        "shared.play_generator._vertex_chat_completions",
        side_effect=_gemma_call_factory([batch1, batch2, *empties]),
    ), patch(
        "shared.play_generator.get_embedding",
        return_value=[],
    ):
        from shared.play_generator import (
            generate_lesson_questions,
            GenerationFellShortError,
        )
        with pytest.raises(GenerationFellShortError) as exc_info:
            generate_lesson_questions(
                "Short source body for the safety-valve test.",
                target=100,
            )
        assert exc_info.value.achieved == 18
        assert exc_info.value.target == 100


def test_use_on_device_raises():
    """Backend explicitly forbids on-device generation."""
    from shared.play_generator import generate_lesson_questions

    with pytest.raises(NotImplementedError):
        generate_lesson_questions("anything", use_on_device=True)
