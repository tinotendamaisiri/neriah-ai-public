"""Extract training pairs from graded exercise book photos.

For each image in the input directory we run a single Gemma 4 26B
vision call that reads the page in one pass:

- the printed/handwritten questions (or copies of the questions),
- the student's handwritten answers,
- the teacher's red-pen marks (ticks, crosses, partial ticks),
- any awarded marks the teacher wrote next to each question,
- any total score written at the top.

That structured payload becomes a *text-only* training row:

    user      "You are grading a student's homework in <subject> "
              "(<level>). Use the teacher's marks as ground truth.\n"
              "Q1: <question>\n"
              "A1: <student answer>\n"
              "Q2: ..."

    assistant '[{"question_number": 1, "verdict": "correct",
                 "awarded_marks": 1, "total_marks": 1, "feedback": "..."},
                ...]'

Why text-only when we have the image? Two reasons:
1. iOS LiteRT-LM has multimodal disabled (CLAUDE.md § 5.7), so the
   on-device E2B can't see images on iPhones. Text-only training
   transfers to both platforms.
2. The cloud Gemma 4 26B does the heavy vision OCR once at extraction
   time; we never need it again at inference. Cost is paid once per
   image, not per grading.

The original image is *not* persisted in the JSONL (privacy + size).
Image filenames are scrubbed from the source_id metadata to avoid
leaking student names that may be in the file path.

Run:

    # Local directory of images:
    python -m tools.dataset.from_exercise_books \\
        --input ./graded_books \\
        --output gs://neriah-ai-models/training/raw/exercise_books.jsonl

    # Kaggle dataset mount:
    python -m tools.dataset.from_exercise_books \\
        --input /kaggle/input/neriah-graded-homework \\
        --output /kaggle/working/exercise_books.jsonl
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Iterator

from tools.dataset.format import Example, write_examples
from tools.dataset.scrub import scrub


logger = logging.getLogger(__name__)


# ─── Configuration ───────────────────────────────────────────────────────────

_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}
_MAX_IMAGE_BYTES = 8 * 1024 * 1024   # 8 MB — Vertex multimodal cap

_VERDICT_VALUES = {"correct", "partial", "incorrect"}


_VISION_PROMPT = """You are reading a photo of a student's marked exercise book.

First, identify the subject and education level.
- subject: one of "Mathematics", "English", "Science", "Biology",
  "Chemistry", "Physics", "Geography", "History", "Shona", "Ndebele",
  or "Other" if you can't tell.
- education_level: best guess from the handwriting and content
  difficulty. Use one of "Grade 1"–"Grade 7" for primary, or
  "Form 1"–"Form 6" for secondary, or "general" if you can't tell.

Then extract every question on the visible page(s). For each question:
- question_number: integer (use 1, 2, 3 if not numbered).
- question_text: the printed or copied question (string; empty if absent).
- student_answer: the student's handwritten answer in plain text (string).
- teacher_mark: one of "correct", "partial", "incorrect" based on the
  red-pen tick/cross/partial-tick visible next to the answer. If no mark
  is visible, return "unmarked".
- awarded_marks: number the teacher wrote next to the answer; 0 if none.
- total_marks: out of how many; 1 if not specified.
- teacher_feedback: any handwritten teacher note (string; empty if none).

Return ONLY a JSON object, no fences, no surrounding prose:
{"subject": "Mathematics", "education_level": "Grade 4",
 "questions": [{"question_number": 1, "question_text": "...",
                "student_answer": "...", "teacher_mark": "correct",
                "awarded_marks": 1, "total_marks": 1,
                "teacher_feedback": ""}]}

If the image is unreadable or has no questions, return
{"subject": "Other", "education_level": "general", "questions": []}.
"""

_KNOWN_SUBJECTS = {
    "mathematics", "english", "science", "biology", "chemistry",
    "physics", "geography", "history", "shona", "ndebele", "other",
}
_LEVEL_PATTERN = re.compile(r"^(grade [1-7]|form [1-6]|general)$", re.IGNORECASE)


# ─── Source-record dataclass ────────────────────────────────────────────────


@dataclass(frozen=True)
class _PageRecord:
    """One image's worth of teacher-graded questions, parsed from
    Gemma's vision output."""
    image_id: str             # sha1(image_bytes) — stable, no PII from filename
    subject: str | None
    education_level: str | None
    questions: list[dict]


# ─── Vision caller (injected for tests) ─────────────────────────────────────


VisionCaller = Callable[[bytes, str], str]


def _default_vision_caller() -> VisionCaller:
    def _call(image_bytes: bytes, prompt: str) -> str:
        from shared.gemma_client import _generate  # lazy — keeps unit tests offline
        return _generate(prompt, image_bytes=image_bytes, complexity="complex")
    return _call


# ─── Parsing ────────────────────────────────────────────────────────────────


def _normalise_subject(value) -> str | None:
    if not isinstance(value, str):
        return None
    v = value.strip()
    if not v:
        return None
    return v if v.lower() in _KNOWN_SUBJECTS else None


def _normalise_level(value) -> str | None:
    if not isinstance(value, str):
        return None
    v = value.strip()
    if not v:
        return None
    return v if _LEVEL_PATTERN.match(v) else None


def _parse_vision_response(raw: str) -> dict:
    """Defensive parser. Returns a dict with three keys:

        {"subject": str | None, "education_level": str | None,
         "questions": list[dict]}

    Tolerates ``\\`\\`\\`json`` fences and surrounding prose. Tolerates
    legacy array-only responses (older prompt) by returning them as
    ``{"subject": None, "education_level": None, "questions": [...]}``
    so older tests / callers keep working.
    """
    text = (raw or "").strip()
    text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*```$", "", text)
    parsed = None
    try:
        parsed = json.loads(text)
    except Exception:
        # Try to slice the first object or array.
        for opener, closer in (("{", "}"), ("[", "]")):
            start, end = text.find(opener), text.rfind(closer)
            if start == -1 or end == -1 or end <= start:
                continue
            try:
                parsed = json.loads(text[start : end + 1])
                break
            except Exception:
                continue

    if isinstance(parsed, list):
        question_rows = parsed
        subject_raw = None
        level_raw = None
    elif isinstance(parsed, dict):
        question_rows = parsed.get("questions") or []
        if not isinstance(question_rows, list):
            question_rows = []
        subject_raw = parsed.get("subject")
        level_raw = parsed.get("education_level")
    else:
        return {"subject": None, "education_level": None, "questions": []}

    out: list[dict] = []
    for row in question_rows:
        if not isinstance(row, dict):
            continue
        student = (row.get("student_answer") or "").strip()
        mark = (row.get("teacher_mark") or "").strip().lower()
        # Skip entries the teacher hasn't graded — we have no gold target.
        if mark not in _VERDICT_VALUES:
            continue
        # Skip entries with no student work to grade.
        if not student:
            continue

        try:
            question_number = int(row.get("question_number") or 0)
        except (TypeError, ValueError):
            question_number = 0
        try:
            awarded = float(row.get("awarded_marks") or 0)
        except (TypeError, ValueError):
            awarded = 0.0
        try:
            total = float(row.get("total_marks") or 1)
        except (TypeError, ValueError):
            total = 1.0
        if total <= 0:
            total = 1.0
        if awarded < 0:
            awarded = 0.0
        if awarded > total:
            awarded = total

        out.append({
            "question_number": question_number,
            "question_text": (row.get("question_text") or "").strip(),
            "student_answer": student,
            "verdict": mark,
            "awarded_marks": awarded,
            "total_marks": total,
            "teacher_feedback": (row.get("teacher_feedback") or "").strip(),
        })

    return {
        "subject": _normalise_subject(subject_raw),
        "education_level": _normalise_level(level_raw),
        "questions": out,
    }


# ─── Path walking ───────────────────────────────────────────────────────────


def _hash_bytes(b: bytes) -> str:
    return hashlib.sha1(b).hexdigest()[:16]


def iter_images(
    input_dir: Path,
    *,
    max_files: int | None = None,
) -> Iterator[tuple[Path, bytes]]:
    """Yield (path, bytes) for every supported image under input_dir.
    Skips files larger than the Vertex cap so a 50 MB scan can't kill
    the run."""
    yielded = 0
    for path in sorted(input_dir.rglob("*")):
        if not path.is_file():
            continue
        if path.suffix.lower() not in _IMAGE_EXTS:
            continue
        try:
            data = path.read_bytes()
        except Exception:
            logger.warning("[from_exercise_books] could not read %s", path, exc_info=True)
            continue
        if len(data) > _MAX_IMAGE_BYTES:
            logger.warning(
                "[from_exercise_books] skipping %s — %d bytes exceeds %d cap",
                path.name, len(data), _MAX_IMAGE_BYTES,
            )
            continue
        yield path, data
        yielded += 1
        if max_files is not None and yielded >= max_files:
            return


# ─── Example construction ───────────────────────────────────────────────────


def _format_user_prompt(record: _PageRecord) -> str:
    subject = record.subject or "any subject"
    level = record.education_level or "any level"
    lines = [
        f"You are grading a student's homework in {subject} ({level}). "
        f"Use the teacher's marks as ground truth.",
    ]
    for q in record.questions:
        lines.append(f"Q{q['question_number']}: {q['question_text']}".rstrip())
        lines.append(f"A{q['question_number']}: {q['student_answer']}")
    return "\n".join(lines)


def _format_assistant_completion(record: _PageRecord) -> str:
    """Strip the visible-text fields (which already appear in the user
    prompt) and keep only the graded verdict — mirrors the JSON shape
    `mark.py` produces in production."""
    verdicts = [
        {
            "question_number": q["question_number"],
            "verdict": q["verdict"],
            "awarded_marks": q["awarded_marks"],
            "total_marks": q["total_marks"],
            "feedback": q["teacher_feedback"],
        }
        for q in record.questions
    ]
    return json.dumps(verdicts, ensure_ascii=False)


def build_examples(
    images: Iterable[tuple[Path, bytes]],
    *,
    caller: VisionCaller,
    subject: str | None = None,
    education_level: str | None = None,
    names: Iterable[str] = (),
    schools: Iterable[str] = (),
) -> Iterator[Example]:
    """Streaming generator: image → vision call → parsed page →
    scrubbed Example. A failure on a single image is logged and the
    run continues (multi-hour Vertex jobs shouldn't die on one read
    error)."""
    for path, image_bytes in images:
        image_id = _hash_bytes(image_bytes)
        try:
            raw = caller(image_bytes, _VISION_PROMPT)
        except Exception:
            logger.warning(
                "[from_exercise_books] vision call failed for %s — skipping",
                path.name, exc_info=True,
            )
            continue
        parsed = _parse_vision_response(raw)
        questions = parsed.get("questions") or []
        if not questions:
            continue

        # Per-image subject/level wins when CLI didn't pin a global tag —
        # this is how the "mixed" Kaggle dataset gets correctly labelled
        # without manual sorting.
        record = _PageRecord(
            image_id=image_id,
            subject=subject if subject is not None else parsed.get("subject"),
            education_level=(
                education_level if education_level is not None
                else parsed.get("education_level")
            ),
            questions=questions,
        )

        user_text = _format_user_prompt(record)
        assistant_text = _format_assistant_completion(record)

        scrubbed_user = scrub(user_text, names=names, schools=schools)
        scrubbed_assistant = scrub(assistant_text, names=names, schools=schools)

        yield Example(
            user=scrubbed_user.text,
            assistant=scrubbed_assistant.text,
            source="exercise_book",
            source_id=image_id,
            subject=record.subject,
            education_level=record.education_level,
            submitted_at=None,  # exercise books carry no submission timestamp
            redactions=list(scrubbed_user.redactions) + list(scrubbed_assistant.redactions),
        )


# ─── CLI ─────────────────────────────────────────────────────────────────────


def _open_output(path: str) -> io.TextIOBase:
    if path.startswith("gs://"):
        from google.cloud import storage
        client = storage.Client()
        bucket_name, _, blob_name = path[5:].partition("/")
        return client.bucket(bucket_name).blob(blob_name).open("w")
    return open(path, "w", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Extract graded-exercise-book training pairs."
    )
    parser.add_argument("--input", required=True,
                        help="Directory of image files (local path or Kaggle mount).")
    parser.add_argument("--output", required=True,
                        help="Local path or gs:// URI for the JSONL output.")
    parser.add_argument("--subject", default=None,
                        help="Subject tag for every example (e.g. Mathematics).")
    parser.add_argument("--education-level", default=None,
                        help="Education level tag (e.g. Form 4 / Grade 7).")
    parser.add_argument("--max-files", type=int, default=None)
    args = parser.parse_args(argv)

    input_dir = Path(args.input).resolve()
    if not input_dir.is_dir():
        print(f"input dir not found: {input_dir}")
        return 2

    names: list[str] = []
    schools: list[str] = []
    try:
        from tools.dataset.from_play_lessons import _load_names_and_schools
        names, schools = _load_names_and_schools()
    except Exception:
        logger.warning(
            "[from_exercise_books] could not hydrate names/schools — "
            "proceeding with pattern-only redaction",
        )

    fh = _open_output(args.output)
    try:
        n = write_examples(
            fh,
            build_examples(
                iter_images(input_dir, max_files=args.max_files),
                caller=_default_vision_caller(),
                subject=args.subject,
                education_level=args.education_level,
                names=names,
                schools=schools,
            ),
        )
    finally:
        fh.close()

    print(f"wrote {n} examples to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
