"""Unsloth-compatible JSONL format for the Neriah training pipeline.

Every extractor in ``tools/dataset/from_*.py`` writes its output
through ``write_example`` so the on-disk schema stays uniform across
sources. The JSONL we emit feeds straight into Unsloth's
``standardize_sharegpt`` / ``apply_chat_template`` pipeline, which
turns each row into Gemma 4's chat template:

    <start_of_turn>user
    {user content}<end_of_turn>
    <start_of_turn>model
    {assistant content}<end_of_turn>

Schema (one JSON object per line):

    {
      "messages": [
        {"role": "user",      "content": "..."},
        {"role": "assistant", "content": "..."}
      ],
      "metadata": {
        "source":         "training_archive" | "syllabus" | "tutor_event" | "play_lesson" | "exercise_book",
        "source_id":      "<stable id from the upstream record>",
        "subject":        "Mathematics" | None,
        "education_level":"Form 4" | None,
        "submitted_at":   "2026-04-15T08:30:00Z" | None,
        "redaction_stats":{"NAME": 2, "PHONE": 1, ...}   # from scrub()
      }
    }

The ``metadata`` block is *not* sent to Unsloth — ``assemble.py``
strips it before writing the train/val/test files. We keep it on
each raw row for:

- timestamp-based 80/10/10 split (newest in test, oldest in train —
  prevents data leakage from future homework into the training set),
- dedup audit,
- per-source row counts in ``dataset_card.md``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Iterable, Literal, TextIO

from .scrub import RedactionEvent, ScrubResult


SourceTag = Literal[
    "training_archive",
    "syllabus",
    "tutor_event",
    "play_lesson",
    "exercise_book",
]


@dataclass
class Example:
    """One training row before it hits disk."""
    user: str
    assistant: str
    source: SourceTag
    source_id: str
    subject: str | None = None
    education_level: str | None = None
    submitted_at: str | None = None
    redactions: list[RedactionEvent] = field(default_factory=list)

    def to_jsonl_dict(self) -> dict:
        """Build the on-disk JSON object. Metadata always present so
        the assemble step can split / dedup deterministically."""
        return {
            "messages": [
                {"role": "user",      "content": self.user},
                {"role": "assistant", "content": self.assistant},
            ],
            "metadata": {
                "source":          self.source,
                "source_id":       self.source_id,
                "subject":         self.subject,
                "education_level": self.education_level,
                "submitted_at":    self.submitted_at,
                "redaction_stats": _redaction_stats(self.redactions),
            },
        }


def _redaction_stats(redactions: Iterable[RedactionEvent]) -> dict[str, int]:
    out: dict[str, int] = {}
    for r in redactions:
        out[r.kind] = out.get(r.kind, 0) + 1
    return out


def merge_redactions(*results: ScrubResult) -> list[RedactionEvent]:
    """Concatenate redactions from multiple scrub passes (e.g. one
    pass over the user prompt + one over the assistant completion).
    Order preserved for audit replay."""
    out: list[RedactionEvent] = []
    for r in results:
        out.extend(r.redactions)
    return out


def write_example(out: TextIO, example: Example) -> None:
    """Write a single example to the open file handle.

    Validation: refuses to write if either side is empty, or if the
    user/assistant strings still contain unredacted phone / email
    patterns (paranoid double-check that catches an extractor that
    forgets to call ``scrub``).
    """
    if not example.user.strip():
        raise ValueError(f"empty user message for source_id={example.source_id}")
    if not example.assistant.strip():
        raise ValueError(f"empty assistant message for source_id={example.source_id}")

    # Defence in depth — every extractor MUST scrub before building
    # the Example, but a regression there shouldn't leak PII into
    # training data. Re-check for the cheapest patterns.
    _assert_no_obvious_pii(example.user, example.source_id, side="user")
    _assert_no_obvious_pii(example.assistant, example.source_id, side="assistant")

    out.write(json.dumps(example.to_jsonl_dict(), ensure_ascii=False))
    out.write("\n")


def _assert_no_obvious_pii(text: str, source_id: str, *, side: str) -> None:
    """Cheapest possible double-check. Mirrors the patterns in
    ``scrub.py`` but only the unconditional ones (phones, emails) —
    name and school redaction depends on the runtime list and isn't
    rechecked here."""
    import re
    if re.search(r"\+\d(?:[\s\-]?\d){5,14}", text):
        raise ValueError(f"unscrubbed phone in {side} for source_id={source_id}")
    if re.search(r"\b0(?:[\s\-]?\d){8,9}\b", text):
        raise ValueError(f"unscrubbed local phone in {side} for source_id={source_id}")
    if re.search(r"\b[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}\b", text, re.IGNORECASE):
        raise ValueError(f"unscrubbed email in {side} for source_id={source_id}")


def write_examples(out: TextIO, examples: Iterable[Example]) -> int:
    """Write a stream of examples, returning the count actually written."""
    n = 0
    for ex in examples:
        write_example(out, ex)
        n += 1
    return n
