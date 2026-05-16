"""
shared/orientation.py — make sure a homework page is upright before any
grading or annotation step touches it.

Two-phase normalization:

  1. EXIF transpose. iPhone / Android cameras shoot portrait photos as
     landscape pixels with an EXIF Orientation tag asking the viewer
     to rotate. Pillow's plain Image.open ignores it. Without baking
     the rotation into the pixels the annotator draws at "right margin"
     in raw landscape space, then Gmail rotates the JPEG on display
     and the tick ends up in the bottom margin. Free, universal,
     handles 95% of real-world cases.

  2. Vision-based fallback. EXIF is a hint, not a guarantee — students
     screenshot photos (no EXIF), older Androids strip it, and a page
     can simply be rotated within an otherwise-correctly-oriented
     frame. After the EXIF transpose we ask Gemma "what rotation is
     needed to make this page readable top-to-bottom" and apply that
     too. Costs one cheap vision call per page; pays for itself by
     keeping every annotation on the actual page area regardless of
     how the student held the phone.

  Public API:

      normalize_to_upright(image_bytes) -> bytes

  Returns JPEG bytes in display orientation (orientation tag reset to 1,
  pixels physically rotated). Always returns a result — never raises;
  on internal failure returns the EXIF-transposed bytes (or original
  bytes if even that step fails) so the grading pipeline can proceed.

  Pages should be normalized BEFORE both grading and annotation so that:
    - Gemma grades a readable image (better OCR / answer extraction)
    - The annotator's qx/qy coordinates match what the recipient sees
    - The same JPEG bytes flow through both paths consistently
"""

from __future__ import annotations

import io
import logging

from PIL import Image, ImageOps

logger = logging.getLogger(__name__)

# Save quality matches the rest of the pipeline (mark.py, pdf_pages.py).
# Quality 88 keeps OCR readability without bloating the bytes.
_JPEG_QUALITY = 88


def _exif_transpose_bytes(image_bytes: bytes) -> bytes:
    """Apply EXIF rotation to the pixels. Returns JPEG bytes with
    orientation tag reset to 1. Falls back to the original bytes on
    any failure."""
    try:
        img = Image.open(io.BytesIO(image_bytes))
        rotated = ImageOps.exif_transpose(img).convert("RGB")
        if rotated is None:
            return image_bytes
        buf = io.BytesIO()
        rotated.save(buf, format="JPEG", quality=_JPEG_QUALITY, optimize=True)
        return buf.getvalue()
    except Exception:
        logger.exception("orientation: EXIF transpose failed; using original bytes")
        return image_bytes


def _rotate_bytes(image_bytes: bytes, degrees: int) -> bytes:
    """Rotate JPEG bytes counter-clockwise by `degrees` (must be a
    multiple of 90). Returns JPEG bytes."""
    if degrees % 360 == 0:
        return image_bytes
    try:
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        # Pillow's rotate() rotates counter-clockwise by default.
        rotated = img.rotate(-degrees, expand=True)
        buf = io.BytesIO()
        rotated.save(buf, format="JPEG", quality=_JPEG_QUALITY, optimize=True)
        return buf.getvalue()
    except Exception:
        logger.exception("orientation: rotate by %d failed; returning input bytes", degrees)
        return image_bytes


def _detect_rotation_via_vision(image_bytes: bytes) -> int:
    """Ask Gemma what clockwise rotation makes the page readable.

    Returns one of {0, 90, 180, 270}. Defaults to 0 on any failure
    (parse error, network blip, unset Vertex creds in local dev) so
    the caller never sees an exception — orientation detection is a
    quality-of-result feature, not a correctness gate.
    """
    # Local import — orientation.py is imported by the annotator which
    # runs in lightweight contexts where pulling the full Vertex stack
    # at module load adds startup latency for no reason. Lazy-load.
    try:
        from shared.gemma_client import _generate, _parse_json
    except ImportError:
        logger.warning("orientation: gemma_client unavailable — skipping vision check")
        return 0

    prompt = (
        "You are looking at a photograph of a single page of student "
        "homework. Determine the smallest clockwise rotation in degrees "
        "(0, 90, 180, or 270) that would make the page upright — i.e. "
        "with text reading naturally from top to bottom and left to "
        "right. Return ONLY valid JSON: "
        '{"rotation": 0|90|180|270}. No other commentary, no markdown.'
    )
    try:
        raw = _generate(prompt, image_bytes=image_bytes)
        parsed = _parse_json(raw, {"rotation": 0})
        rot = int(parsed.get("rotation", 0)) % 360
        if rot not in (0, 90, 180, 270):
            return 0
        return rot
    except Exception:
        logger.exception("orientation: vision rotation detection failed")
        return 0


def normalize_to_upright(image_bytes: bytes, *, use_vision: bool = True) -> bytes:
    """Public API. Returns JPEG bytes in upright display orientation.

    Pass `use_vision=False` to skip the Gemma call (e.g. unit tests,
    paths where you trust EXIF, or batch reprocessing where the
    per-page Vertex cost matters more than absolute orientation
    correctness).
    """
    if not image_bytes:
        return image_bytes

    transposed = _exif_transpose_bytes(image_bytes)

    if not use_vision:
        return transposed

    rotation = _detect_rotation_via_vision(transposed)
    if rotation == 0:
        return transposed
    logger.info("orientation: vision detected %d° rotation, applying", rotation)
    return _rotate_bytes(transposed, rotation)
