#!/usr/bin/env python3
"""
Index syllabus PDFs into Firestore rag_syllabuses collection.

Discovers all PDFs in syllabuses/ directory, extracts text, chunks it,
embeds each chunk via shared/embeddings.py, and stores in Firestore.

Usage:
    python scripts/index_syllabuses.py [--dry-run] [--force]

Env vars:
    GCP_PROJECT_ID       — Google Cloud project (read by shared.config)
    INFERENCE_BACKEND     — "vertex" for production embeddings
"""

from __future__ import annotations

import argparse
import hashlib
import logging
import os
import re
import sys
import time
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")
logger = logging.getLogger(__name__)

SYLLABUSES_DIR = Path(__file__).resolve().parent.parent / "syllabuses"
CHUNK_SIZE = 500       # approximate tokens (chars / 4)
CHUNK_OVERLAP = 50     # overlap tokens
CHARS_PER_TOKEN = 4    # rough estimate

# ── Filename parser ───────────────────────────────────────────────────────────

_LEVEL_PATTERNS = {
    "Primary":  "primary",
    "OLevel":   "o_level",
    "O_Level":  "o_level",
    "ALevel":   "a_level",
    "A_Level":  "a_level",
    "Form1":    "form_1",
    "Form2":    "form_2",
    "Form3":    "form_3",
    "Form4":    "form_4",
    "Forms14":  "form_1_to_4",
}


def parse_filename(filename: str) -> dict:
    """
    Extract subject and education_level from a syllabus filename.
    Format: SYLLABUS_<Subject>_<Level>_<Country>.pdf
    """
    stem = Path(filename).stem  # remove .pdf
    parts = stem.split("_")

    # Remove "SYLLABUS" prefix
    if parts and parts[0].upper() == "SYLLABUS":
        parts = parts[1:]

    # Last part is usually country
    country = parts[-1] if parts else "Unknown"
    parts = parts[:-1]  # remove country

    # Find education level by matching known patterns
    education_level = ""
    level_idx = -1
    for i, part in enumerate(parts):
        for pattern, level in _LEVEL_PATTERNS.items():
            if pattern.lower() in part.lower():
                education_level = level
                level_idx = i
                break
        if education_level:
            break

    # Everything before the level part is the subject
    if level_idx > 0:
        subject = " ".join(parts[:level_idx])
    elif level_idx == 0:
        subject = " ".join(parts[1:]) if len(parts) > 1 else "General"
    else:
        subject = " ".join(parts) if parts else "Unknown"

    # Clean up subject: split camelCase
    subject = re.sub(r"([a-z])([A-Z])", r"\1 \2", subject)
    # Remove parenthesized numbers like (1), (2)
    subject = re.sub(r"\(\d+\)", "", subject).strip()

    return {
        "subject": subject,
        "education_level": education_level or "general",
        "country": country,
        "curriculum": "ZIMSEC" if country.lower() == "zimbabwe" else country,
    }


# ── Text chunking ─────────────────────────────────────────────────────────────

def chunk_text(text: str, chunk_chars: int, overlap_chars: int) -> list[str]:
    """Split text into overlapping chunks at sentence boundaries."""
    if not text.strip():
        return []

    sentences = re.split(r'(?<=[.!?])\s+', text)
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0

    for sentence in sentences:
        slen = len(sentence)
        if current_len + slen > chunk_chars and current:
            chunks.append(" ".join(current))
            # Keep overlap
            overlap_text = " ".join(current)
            keep = overlap_text[-overlap_chars:] if len(overlap_text) > overlap_chars else overlap_text
            current = [keep]
            current_len = len(keep)
        current.append(sentence)
        current_len += slen

    if current:
        chunks.append(" ".join(current))

    return [c.strip() for c in chunks if c.strip()]


# ── Chunk quality filter ──────────────────────────────────────────────────────

def is_valid_chunk(text: str) -> bool:
    """Reject chunks that are almost certainly not useful to index.

    Catches the usual PDF-extraction garbage: answer-line fill-ins (___),
    column-reorder fragments, OCR noise, and glyph-stream blobs where most
    "words" are not actually words. Rejections never hit Vertex — saving
    quota and preventing silent zero-information embeddings in Firestore.
    """
    text = text.strip()
    # Too short to carry meaning.
    if len(text) < 50:
        return False
    # Exam-paper fill-in lines: long runs of underscores.
    if text.count("_") / len(text) > 0.3:
        return False
    words = text.split()
    if len(words) < 5:
        return False
    # Ratio of tokens that look like real words (>3 chars, mostly letters).
    # Handles English, Shona, Ndebele — all alphabetic scripts.
    real_words = [
        w for w in words
        if len(w) > 3 and sum(c.isalpha() for c in w) / len(w) > 0.7
    ]
    if len(real_words) / max(len(words), 1) < 0.4:
        return False
    return True


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Index syllabus PDFs into Firestore")
    parser.add_argument("--dry-run", action="store_true", help="Parse and chunk but don't store")
    parser.add_argument("--force", action="store_true", help="Re-index files even if already indexed")
    args = parser.parse_args()

    if not SYLLABUSES_DIR.exists():
        logger.error("Syllabuses directory not found: %s", SYLLABUSES_DIR)
        sys.exit(1)

    pdfs = sorted(SYLLABUSES_DIR.glob("*.pdf"))
    if not pdfs:
        logger.error("No PDF files found in %s", SYLLABUSES_DIR)
        sys.exit(1)

    logger.info("Found %d PDF files in %s", len(pdfs), SYLLABUSES_DIR)

    # Import after path setup
    from shared.vector_db import store_document
    from shared.firestore_client import query

    # Check which files are already indexed
    existing_files: set[str] = set()
    if not args.force:
        try:
            docs = query("rag_syllabuses", [])
            existing_files = {d.get("metadata", {}).get("source_file", "") for d in docs}
            if existing_files:
                logger.info("Already indexed: %d files — will skip", len(existing_files))
        except Exception:
            pass

    total_stored          = 0   # chunks where store_document returned True
    total_chunk_skipped   = 0   # chunks whose embedding failed or Firestore errored
    total_chunk_filtered  = 0   # chunks rejected by is_valid_chunk before embedding
    total_files_skipped   = 0   # files short-circuited because already indexed
    total_files_processed = 0

    for pdf_path in pdfs:
        filename = pdf_path.name

        if filename in existing_files and not args.force:
            logger.info("  SKIP %s (already indexed)", filename)
            total_files_skipped += 1
            continue

        # Parse metadata from filename
        meta = parse_filename(filename)
        logger.info("  FILE %s → subject=%s level=%s curriculum=%s",
                     filename, meta["subject"], meta["education_level"], meta["curriculum"])

        # Extract text
        try:
            import pdfplumber
            text = ""
            with pdfplumber.open(pdf_path) as pdf:
                for page in pdf.pages:
                    page_text = page.extract_text() or ""
                    text += page_text + "\n"
        except Exception as e:
            logger.error("    Failed to extract text: %s", e)
            continue

        if not text.strip():
            logger.warning("    Empty text — skipping")
            continue

        # Chunk
        chunk_chars = CHUNK_SIZE * CHARS_PER_TOKEN
        overlap_chars = CHUNK_OVERLAP * CHARS_PER_TOKEN
        chunks = chunk_text(text, chunk_chars, overlap_chars)
        logger.info("    Extracted %d chars → %d chunks", len(text), len(chunks))

        if args.dry_run:
            valid_count = sum(1 for c in chunks if is_valid_chunk(c))
            total_stored         += valid_count
            total_chunk_filtered += len(chunks) - valid_count
            total_files_processed += 1
            continue

        total_files_processed += 1
        file_stored   = 0
        file_skipped  = 0
        file_filtered = 0

        # Store each chunk
        for i, chunk in enumerate(chunks):
            doc_id = f"{hashlib.md5(filename.encode()).hexdigest()[:8]}-{i:04d}"
            chunk_meta = {
                **meta,
                "source_file": filename,
                "chunk_index": i,
            }

            # Pre-embedding garbage filter — saves quota and prevents
            # low-information chunks from polluting search results. Rejected
            # chunks DO NOT sleep because they never hit Vertex.
            if not is_valid_chunk(chunk):
                file_filtered += 1
                continue

            try:
                ok = store_document("syllabuses", doc_id, chunk, chunk_meta)
            except Exception as e:
                logger.error("    Chunk %d raised: %s", i, e)
                ok = False

            if ok:
                file_stored += 1
            else:
                file_skipped += 1

            # Rate-limit gemini-embedding-001 on Vertex — per-minute quota is
            # tighter than the previous text-embedding-005 allowance. 4s
            # between chunks ≈ 15 RPM, conservative for a low-quota project
            # (a 500-chunk run takes ~33 minutes; increase when quota raises).
            time.sleep(4)

        total_stored         += file_stored
        total_chunk_skipped  += file_skipped
        total_chunk_filtered += file_filtered

        msg = f"Stored {file_stored}/{len(chunks)} chunks for {filename}"
        notes = []
        if file_filtered:
            notes.append(f"{file_filtered} filtered")
        if file_skipped:
            notes.append(f"{file_skipped} skipped")
        if notes:
            msg += f" ({', '.join(notes)})"
        logger.info("    %s", msg)

    logger.info("")
    logger.info(
        "Done. %d chunks stored, %d chunks skipped (embedding failed), "
        "%d chunks filtered (garbage), %d files processed.",
        total_stored, total_chunk_skipped, total_chunk_filtered,
        total_files_processed,
    )
    if total_files_skipped:
        logger.info("(%d files skipped because already indexed — pass --force to re-embed)",
                    total_files_skipped)
    if args.dry_run:
        logger.info("(dry run — nothing was stored)")


if __name__ == "__main__":
    main()
