"""
shared/submission_codes.py — generator for the short homework codes
printed on the slip students copy into their email subject line.

Code format: 6 chars from a typo-resistant alphabet. We drop the four
visually ambiguous characters (0/O, 1/I/L) so a code copied off a paper
slip survives even sloppy handwriting or low-quality phone cameras
focused on the wrong tier of the page.

Collision handling: brute-force retry against the answer_keys
collection. With a 28^6 ≈ 480 M alphabet and v1 scale (≪ 100 K active
homeworks at any time), the birthday-style collision rate is
negligible, but we still loop a handful of times to be safe.
"""

from __future__ import annotations

import logging
import secrets

from shared.firestore_client import query_single

logger = logging.getLogger(__name__)

# Alphabet excludes 0 O 1 I L — common typo offenders both for handwritten
# slips and for OCR running over a printed code. Keeps every character
# unambiguous in any sans-serif font.
_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
CODE_LENGTH = 6
_MAX_ATTEMPTS = 16


def _random_code() -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(CODE_LENGTH))


def generate_unique_submission_code() -> str:
    """Return a code that doesn't collide with any existing answer_key.

    Falls back to returning a fresh random code after _MAX_ATTEMPTS
    (vanishingly unlikely to land on a duplicate even then) and logs a
    warning so we notice if the alphabet ever needs to grow.
    """
    for _ in range(_MAX_ATTEMPTS):
        code = _random_code()
        existing = query_single("answer_keys", [("submission_code", "==", code)])
        if not existing:
            return code
    fallback = _random_code()
    logger.warning(
        "generate_unique_submission_code: %d attempts exhausted, returning %s without collision check",
        _MAX_ATTEMPTS, fallback,
    )
    return fallback
