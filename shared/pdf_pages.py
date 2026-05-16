"""
shared/pdf_pages.py — render PDF attachment pages to JPEG bytes.

Used by functions/email_poller.py to turn a multi-page PDF submission
into the same `pages_bytes: list[bytes]` shape that `functions/mark.py`
expects for app scans, so the rest of the grading pipeline doesn't
care which channel the submission came in through.

Why pdf2image (and not pdfplumber): students photograph a printed page
and email a scan; the PDF is image-bearing. pdfplumber.extract_text()
returns "" for those, so we have to rasterize the page first and OCR
via the existing image grading path.

System dep: pdf2image wraps poppler. The Cloud Function runtime image
already includes poppler (it's pulled in by pymupdf via apt during the
buildpack stage); local dev needs `brew install poppler` once.
"""

from __future__ import annotations

import io
import logging
from typing import Iterable

logger = logging.getLogger(__name__)

# Cap rendered pages so a 200-page PDF can't run away with cost. v1
# students should be sending single-page or short-multi-page scans;
# anything longer is almost certainly the wrong attachment.
MAX_PAGES = 10
DEFAULT_DPI = 200  # readable handwriting + reasonable bytes


def pdf_to_jpegs(
    pdf_bytes: bytes,
    *,
    dpi: int = DEFAULT_DPI,
    max_pages: int = MAX_PAGES,
) -> list[bytes]:
    """Render up to `max_pages` of `pdf_bytes` as JPEG bytes, one per page.

    Returns an empty list (and logs) on render failure — callers should
    treat that the same as "no usable attachment" and trigger the
    format-error reply path rather than crash.
    """
    if not pdf_bytes:
        return []
    try:
        from pdf2image import convert_from_bytes  # type: ignore
    except ImportError:
        logger.exception("pdf_to_jpegs: pdf2image not installed")
        return []

    try:
        images = convert_from_bytes(
            pdf_bytes,
            dpi=dpi,
            fmt="jpeg",
            # First-page-first; cap with last_page so we don't render
            # the whole thing just to throw most away.
            first_page=1,
            last_page=max_pages,
        )
    except Exception:
        logger.exception("pdf_to_jpegs: convert_from_bytes failed (poppler missing or PDF malformed)")
        return []

    out: list[bytes] = []
    for img in images:
        buf = io.BytesIO()
        # Quality 88 is the sweet spot between OCR readability and
        # network cost; matches what the app uses for scan uploads.
        img.save(buf, format="JPEG", quality=88, optimize=True)
        out.append(buf.getvalue())
    return out


def attachments_to_pages(
    attachments: Iterable[tuple[str, bytes, str]],
) -> list[bytes]:
    """Flatten a mixed list of (filename, bytes, content_type) tuples
    into the per-page list[bytes] the grader consumes.

    - PDFs are rendered via pdf_to_jpegs (each page → one JPEG).
    - Images are passed through as-is (one page each).
    - Anything else is dropped (parser already filtered, but defensive).

    Order is preserved so a teacher with multi-attachment submissions
    sees pages in the order the student attached them.
    """
    pages: list[bytes] = []
    for _filename, payload, content_type in attachments:
        if content_type == "application/pdf":
            pages.extend(pdf_to_jpegs(payload))
        elif content_type.startswith("image/"):
            pages.append(payload)
    return pages
