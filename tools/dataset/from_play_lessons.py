"""Extract training pairs from approved Play lessons.

Each ``play_lessons`` row that finished with ``status='ready'`` is a
ready-made (notes → 100 questions) example. The cloud generator
produced the questions in production; the on-device fine-tune
should learn to emit the same shape so it works offline.

Output schema is ``tools/dataset/format.Example`` — Unsloth
``messages`` JSONL.

Run locally (cheapest path):

    python -m tools.dataset.from_play_lessons \\
        --output gs://neriah-ai-models/training/raw/play_lessons.jsonl

Or to a local file for review first:

    python -m tools.dataset.from_play_lessons \\
        --output /tmp/play_lessons.jsonl --max-rows 50

Every prompt + completion goes through ``scrub`` before it's written.
The scrub layer's ``names`` and ``schools`` lists are hydrated from
the live Firestore collections so leftover fragments of student or
school names in source_content don't slip through.
"""

from __future__ import annotations

import argparse
import io
import json
import logging
import sys
from dataclasses import dataclass
from typing import Iterable

from tools.dataset.format import Example, write_examples
from tools.dataset.scrub import RedactionEvent, scrub


logger = logging.getLogger(__name__)


_PROMPT_TEMPLATE = (
    "You generate multiple-choice quiz questions for African school "
    "students. Subject: {subject}. Level: {grade}. "
    "Output exactly {target} fresh, distinct questions as STRICT JSON:\n"
    '[{{"prompt": "<≤80 chars>", "options": ["<≤25>", "<≤25>", "<≤25>", '
    '"<≤25>"], "correct": <0..3>}}]\n'
    "Rules: return ONLY the JSON array, no fences, no surrounding prose. "
    "Source notes follow:\n\n{source}"
)


@dataclass(frozen=True)
class _LessonRow:
    """Subset of the play_lessons doc this extractor needs.

    Modelled as a dataclass instead of using the full PlayLesson
    pydantic so the extractor stays decoupled from the cloud-only
    fields (``shared_with_class``, ``allow_copying``, etc.) that
    don't matter for training.
    """
    id: str
    title: str | None
    subject: str | None
    grade: str | None
    source_content: str | None
    questions: list[dict]
    status: str | None
    created_at: str | None


def _row_is_eligible(r: _LessonRow) -> bool:
    if (r.status or "").lower() != "ready":
        return False
    if not r.source_content or not r.source_content.strip():
        return False
    # Need at least 10 questions for the example to be worth keeping —
    # tiny banks (sparse-topic on-device fall-throughs) carry less
    # signal than a small extra batch from a cloud bank.
    if not isinstance(r.questions, list) or len(r.questions) < 10:
        return False
    return True


def _validate_questions(questions: list[dict]) -> list[dict]:
    """Defensive — reject malformed rows so the assistant message
    never includes garbage. Matches the contract on PlayQuestion:
    prompt, exactly 4 options, correct in [0,3]."""
    out: list[dict] = []
    for q in questions:
        if not isinstance(q, dict):
            continue
        prompt = q.get("prompt")
        options = q.get("options")
        correct = q.get("correct")
        if not isinstance(prompt, str) or not prompt.strip():
            continue
        if not isinstance(options, list) or len(options) != 4:
            continue
        if not all(isinstance(o, str) and o.strip() for o in options):
            continue
        try:
            correct_int = int(correct)
        except (TypeError, ValueError):
            continue
        if correct_int < 0 or correct_int > 3:
            continue
        out.append({"prompt": prompt, "options": options, "correct": correct_int})
    return out


def build_examples(
    rows: Iterable[_LessonRow],
    *,
    names: Iterable[str] = (),
    schools: Iterable[str] = (),
    target: int = 100,
) -> Iterable[Example]:
    """Convert raw play_lessons rows to scrubbed Examples ready for
    JSONL. Streaming generator so the caller can pipe directly to
    ``write_examples`` without holding the whole bank in memory."""
    for r in rows:
        if not _row_is_eligible(r):
            continue
        questions = _validate_questions(r.questions)
        if len(questions) < 10:
            continue

        # Scrub each side independently so we can attribute redactions
        # in the metadata and so a leak on one side doesn't camouflage
        # in the larger blob.
        prompt = _PROMPT_TEMPLATE.format(
            subject=r.subject or "any",
            grade=r.grade or "any",
            target=len(questions),
            source=r.source_content or "",
        )
        scrubbed_prompt = scrub(prompt, names=names, schools=schools)

        completion_blob = json.dumps(questions, ensure_ascii=False)
        scrubbed_completion = scrub(completion_blob, names=names, schools=schools)

        all_redactions: list[RedactionEvent] = list(scrubbed_prompt.redactions) + list(scrubbed_completion.redactions)

        yield Example(
            user=scrubbed_prompt.text,
            assistant=scrubbed_completion.text,
            source="play_lesson",
            source_id=r.id,
            subject=r.subject,
            education_level=r.grade,
            submitted_at=r.created_at,
            redactions=all_redactions,
        )


# ─── Firestore wiring ────────────────────────────────────────────────────────
#
# Live runs query Firestore for ``play_lessons`` + the names/schools
# lists. Tests inject fake rows directly to keep the unit tests fast
# and offline.


def _load_lesson_rows(limit: int | None) -> list[_LessonRow]:
    from shared.firestore_client import query

    raw = query(
        "play_lessons",
        [],
        order_by="created_at",
        direction="DESCENDING",
        limit=limit or 5000,
    )
    rows: list[_LessonRow] = []
    for d in raw or []:
        rows.append(_LessonRow(
            id=str(d.get("id") or ""),
            title=d.get("title"),
            subject=d.get("subject"),
            grade=d.get("grade"),
            source_content=d.get("source_content"),
            questions=list(d.get("questions") or []),
            status=d.get("status"),
            created_at=d.get("created_at"),
        ))
    return rows


def _load_names_and_schools() -> tuple[list[str], list[str]]:
    """Hydrate the curated lists from live Firestore. Empty lists when
    Firestore is unreachable (fine — pattern-only redaction still
    runs)."""
    from shared.firestore_client import query

    names: set[str] = set()
    schools: set[str] = set()
    try:
        for s in query("students", [], limit=10000) or []:
            for f in (s.get("first_name"), s.get("surname")):
                if isinstance(f, str) and f.strip():
                    names.add(f.strip())
    except Exception:
        logger.warning("[from_play_lessons] could not hydrate names from students")
    try:
        for t in query("teachers", [], limit=2000) or []:
            n = t.get("name")
            if isinstance(n, str) and n.strip():
                # Split on whitespace — the runtime list works as
                # individual tokens.
                for token in n.split():
                    if len(token) >= 3:
                        names.add(token)
    except Exception:
        logger.warning("[from_play_lessons] could not hydrate names from teachers")
    try:
        for sch in query("schools", [], limit=2000) or []:
            n = sch.get("name")
            if isinstance(n, str) and n.strip():
                schools.add(n.strip())
    except Exception:
        logger.warning("[from_play_lessons] could not hydrate schools")
    return sorted(names), sorted(schools)


def _open_output(path: str) -> io.TextIOBase:
    """Local file path or gs:// URI."""
    if path.startswith("gs://"):
        from google.cloud import storage  # lazy import — only needed for cloud writes
        client = storage.Client()
        bucket_name, _, blob_name = path[5:].partition("/")
        bucket = client.bucket(bucket_name)
        blob = bucket.blob(blob_name)
        return blob.open("w")
    return open(path, "w", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Extract Play-lesson training pairs.")
    parser.add_argument("--output", required=True, help="Local path or gs:// URI for the JSONL output.")
    parser.add_argument("--max-rows", type=int, default=None, help="Cap on lessons read (debug).")
    args = parser.parse_args(argv)

    rows = _load_lesson_rows(args.max_rows)
    names, schools = _load_names_and_schools()
    logger.info(
        "[from_play_lessons] loaded rows=%d names=%d schools=%d",
        len(rows), len(names), len(schools),
    )

    fh = _open_output(args.output)
    try:
        n = write_examples(fh, build_examples(rows, names=names, schools=schools))
    finally:
        fh.close()

    print(f"wrote {n} examples to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
