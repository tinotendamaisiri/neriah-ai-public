"""Extract synthetic Q/A training pairs from the ZIMSEC syllabus PDFs.

Reads every PDF under ``syllabuses/``, chunks it at sentence
boundaries, and asks Vertex Gemma 4 26B to emit ZIMSEC-style
instruction Q/A pairs grounded in each chunk. The 26B → 2B
distillation is the whole point — the on-device model learns the
patterns the cloud model already nails.

Reuses two helpers from ``scripts/index_syllabuses.py``:
- ``parse_filename`` — recovers ``subject`` + ``education_level`` from
  ``SYLLABUS_<Subject>_<Level>_<Country>.pdf``.
- ``chunk_text`` — sentence-boundary chunking with overlap.

Output schema: same Unsloth ``messages`` JSONL as every other
extractor (``tools/dataset/format.Example``).

Run:

    # Production:
    python -m tools.dataset.from_syllabuses \\
        --output gs://neriah-ai-models/training/raw/syllabuses.jsonl

    # Local debug (skips Vertex, uses an injected stub):
    python -m tools.dataset.from_syllabuses \\
        --output /tmp/syllabuses.jsonl --max-chunks 5 --dry-run
"""

from __future__ import annotations

import argparse
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


# ─── Tunables ────────────────────────────────────────────────────────────────

DEFAULT_CHUNK_CHARS = 1500
DEFAULT_OVERLAP_CHARS = 200
QUESTIONS_PER_CHUNK = 3   # 26B → 2B distillation, modest yield per chunk

# Skip chunks that are too short to ground useful questions, or too
# meta (table of contents, "page 4 of 60", etc.).
_MIN_CHUNK_CHARS = 300
_NOISE_PATTERNS = (
    re.compile(r"^\s*page\s+\d+", re.IGNORECASE),
    re.compile(r"^\s*table of contents", re.IGNORECASE),
)


_PROMPT_TEMPLATE = (
    "You are writing ZIMSEC-style assessment questions for African school "
    "students.\n"
    "Subject: {subject}\n"
    "Education level: {education_level}\n\n"
    "Read the syllabus excerpt below and produce {n} concise questions a "
    "teacher could ask in class, with model answers. Cover concepts directly "
    "stated in the excerpt — do not invent topics not in the text.\n\n"
    "Output ONLY a JSON array, no fences, no surrounding prose. Each entry:\n"
    '[{{"question": "...", "answer": "..."}}, ...]\n\n'
    "Syllabus excerpt:\n{chunk}"
)


# ─── Source-record dataclass ────────────────────────────────────────────────


@dataclass(frozen=True)
class _SyllabusChunk:
    """One chunk of one PDF, ready for Vertex."""
    syllabus_id: str
    chunk_index: int
    subject: str
    education_level: str
    text: str

    @property
    def stable_id(self) -> str:
        # Used as the metadata.source_id so dedup later can spot a
        # chunk that produced multiple Q/A pairs.
        return f"{self.syllabus_id}#chunk={self.chunk_index}"


# ─── PDF + chunk pipeline ───────────────────────────────────────────────────


def _is_noise_chunk(text: str) -> bool:
    if len(text.strip()) < _MIN_CHUNK_CHARS:
        return True
    for pat in _NOISE_PATTERNS:
        if pat.search(text):
            return True
    return False


def _read_pdf_text(pdf_path: Path) -> str:
    """Pull plain text out of a PDF. Returns '' on extraction failure
    so the caller can skip the file rather than crash the whole run."""
    try:
        import pdfplumber
        with pdfplumber.open(pdf_path) as pdf:
            return "\n".join(page.extract_text() or "" for page in pdf.pages)
    except Exception:
        logger.warning("[from_syllabuses] failed to extract %s", pdf_path.name, exc_info=True)
        return ""


def iter_chunks(
    syllabus_dir: Path,
    *,
    chunk_chars: int = DEFAULT_CHUNK_CHARS,
    overlap_chars: int = DEFAULT_OVERLAP_CHARS,
    max_chunks: int | None = None,
) -> Iterator[_SyllabusChunk]:
    """Walk the syllabus directory and yield clean, sized chunks."""
    from scripts.index_syllabuses import parse_filename, chunk_text  # reuse, don't fork

    yielded = 0
    for path in sorted(syllabus_dir.glob("*.pdf")):
        meta = parse_filename(path.name)
        subject = (meta.get("subject") or "").strip() or "General"
        education_level = (meta.get("education_level") or "").strip() or "general"

        text = _read_pdf_text(path)
        if not text.strip():
            continue
        for i, chunk in enumerate(chunk_text(text, chunk_chars, overlap_chars)):
            if _is_noise_chunk(chunk):
                continue
            yield _SyllabusChunk(
                syllabus_id=path.stem,
                chunk_index=i,
                subject=subject,
                education_level=education_level,
                text=chunk,
            )
            yielded += 1
            if max_chunks is not None and yielded >= max_chunks:
                return


# ─── Vertex caller ──────────────────────────────────────────────────────────


GemmaCaller = Callable[[str], str]


def _default_gemma_caller() -> GemmaCaller:
    """Wrap shared.gemma_client._generate so the rest of the module
    stays test-friendly. Tests inject a stub instead of importing
    Vertex SDK code paths."""

    def _call(prompt: str) -> str:
        from shared.gemma_client import _generate  # lazy import — keeps unit tests offline
        return _generate(prompt, complexity="complex")

    return _call


def _parse_qa_array(raw: str) -> list[dict]:
    r"""Parse Gemma's response. Strict — drops anything that doesn't
    fit the {question, answer} contract. Tolerates ``\`\`\`json`` fences
    and leading/trailing prose by slicing the first JSON array."""
    text = (raw or "").strip()
    text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*```$", "", text)
    try:
        parsed = json.loads(text)
    except Exception:
        start = text.find("[")
        end = text.rfind("]")
        if start == -1 or end == -1 or end <= start:
            return []
        try:
            parsed = json.loads(text[start : end + 1])
        except Exception:
            return []
    if not isinstance(parsed, list):
        return []
    out: list[dict] = []
    for row in parsed:
        if not isinstance(row, dict):
            continue
        q = (row.get("question") or "").strip()
        a = (row.get("answer") or "").strip()
        if not q or not a:
            continue
        out.append({"question": q, "answer": a})
    return out


# ─── Example construction ───────────────────────────────────────────────────


def build_examples(
    chunks: Iterable[_SyllabusChunk],
    *,
    caller: GemmaCaller,
    names: Iterable[str] = (),
    schools: Iterable[str] = (),
    questions_per_chunk: int = QUESTIONS_PER_CHUNK,
) -> Iterator[Example]:
    """Streaming generator: chunk → Gemma → parsed Q/A → scrubbed
    Examples. Vertex failures on a single chunk are logged and skipped
    so a flaky network call doesn't kill a multi-hour run."""
    for chunk in chunks:
        prompt = _PROMPT_TEMPLATE.format(
            subject=chunk.subject,
            education_level=chunk.education_level,
            n=questions_per_chunk,
            chunk=chunk.text,
        )
        try:
            raw = caller(prompt)
        except Exception:
            logger.warning(
                "[from_syllabuses] vertex call failed for %s — skipping",
                chunk.stable_id, exc_info=True,
            )
            continue
        pairs = _parse_qa_array(raw)
        if not pairs:
            continue
        for pair_index, pair in enumerate(pairs):
            user_text = (
                f"Subject: {chunk.subject}. Level: {chunk.education_level}.\n"
                f"Question: {pair['question']}"
            )
            assistant_text = pair["answer"]

            scrubbed_user = scrub(user_text, names=names, schools=schools)
            scrubbed_assistant = scrub(assistant_text, names=names, schools=schools)

            yield Example(
                user=scrubbed_user.text,
                assistant=scrubbed_assistant.text,
                source="syllabus",
                source_id=f"{chunk.stable_id}#qa={pair_index}",
                subject=chunk.subject,
                education_level=chunk.education_level,
                submitted_at=None,  # syllabus content has no submission date
                redactions=list(scrubbed_user.redactions) + list(scrubbed_assistant.redactions),
            )


# ─── CLI ─────────────────────────────────────────────────────────────────────


def _open_output(path: str) -> io.TextIOBase:
    if path.startswith("gs://"):
        from google.cloud import storage  # lazy: only needed for gs:// writes
        client = storage.Client()
        bucket_name, _, blob_name = path[5:].partition("/")
        return client.bucket(bucket_name).blob(blob_name).open("w")
    return open(path, "w", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Extract syllabus Q/A training pairs.")
    parser.add_argument("--output", required=True, help="Local path or gs:// URI.")
    parser.add_argument("--syllabus-dir", default="syllabuses", help="Directory of *.pdf files.")
    parser.add_argument("--max-chunks", type=int, default=None)
    parser.add_argument("--questions-per-chunk", type=int, default=QUESTIONS_PER_CHUNK)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Skip Vertex; emit empty Q/A. Useful for validating the chunker.",
    )
    args = parser.parse_args(argv)

    syllabus_dir = Path(args.syllabus_dir).resolve()
    if not syllabus_dir.is_dir():
        print(f"syllabus dir not found: {syllabus_dir}")
        return 2

    chunks = iter_chunks(syllabus_dir, max_chunks=args.max_chunks)

    if args.dry_run:
        chunk_count = sum(1 for _ in chunks)
        print(f"dry-run: would process {chunk_count} chunks")
        return 0

    # Hydrate names + schools at runtime — same as from_play_lessons.
    names: list[str] = []
    schools: list[str] = []
    try:
        from tools.dataset.from_play_lessons import _load_names_and_schools  # reuse hydration
        names, schools = _load_names_and_schools()
    except Exception:
        logger.warning("[from_syllabuses] could not hydrate names/schools — proceeding with pattern-only redaction")

    fh = _open_output(args.output)
    try:
        n = write_examples(
            fh,
            build_examples(
                chunks,
                caller=_default_gemma_caller(),
                names=names,
                schools=schools,
                questions_per_chunk=args.questions_per_chunk,
            ),
        )
    finally:
        fh.close()

    print(f"wrote {n} examples to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
