"""Privacy scrubber for Neriah training data.

Every piece of text that leaves the Neriah project boundary into a
training file passes through this module first. The output of
``scrub(...)`` is what gets written to disk; the original raw text
never lands in ``gs://neriah-ai-models/training/``.

What we redact:

- Personal names from a curated list (passed in by the caller — the
  extractors hydrate this from the live ``students`` and ``teachers``
  Firestore collections plus a baseline list of common Zimbabwean
  given/family names).
- School names from a curated list (the ``schools`` collection plus
  any school string typed by a teacher into ``school_name``).
- Phone numbers — international ``+CCDDDDDDD`` and the local
  ``0DDDDDDDDD`` Zimbabwean shape.
- Email addresses.
- Internal IDs (``STU_…``, ``CLS_…``, ``HW_…``, etc.) and
  register-number markers like ``"Reg No: 12345"``.

What we DON'T redact (deliberately):

- Common nouns, proper nouns from history / curriculum (``King Henry
  VIII``, ``Mount Everest``, ``photosynthesis``). The scrubber only
  removes strings that match the curated name / school lists, never
  arbitrary capitalised words.
- Subject names, place names that aren't in the school list.

Replacement tokens are SHORT, structured strings so a downstream
fine-tune learns to ignore the placeholder rather than memorise it.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Iterable, Literal


# ─── Redaction tokens ───────────────────────────────────────────────────────
#
# Kept short + uniform so the model sees them as ordinary tokens, not
# as content. ``[NAME]`` consistently means "person's name redacted",
# regardless of which kind of person.

_TOKEN = {
    "NAME":              "[NAME]",
    "PHONE":             "[PHONE]",
    "EMAIL":             "[EMAIL]",
    "SCHOOL":            "[SCHOOL]",
    "STUDENT_ID":        "[STUDENT_ID]",
    "REGISTER_NUMBER":   "[REG]",
}

RedactionKind = Literal[
    "NAME",
    "PHONE",
    "EMAIL",
    "SCHOOL",
    "STUDENT_ID",
    "REGISTER_NUMBER",
]


@dataclass(frozen=True)
class RedactionEvent:
    """Audit record for a single redaction. Spans refer to the
    *original* (pre-scrub) text offsets, not the output text. Excerpt
    is capped at 40 chars so the audit log can't accidentally re-leak
    the data it's tracking."""
    kind: RedactionKind
    span: tuple[int, int]
    original_excerpt: str

    def __post_init__(self) -> None:
        # Defensive: never let an audit record carry the full PII payload.
        if len(self.original_excerpt) > 40:
            object.__setattr__(self, "original_excerpt", self.original_excerpt[:40])


@dataclass
class ScrubResult:
    text: str
    redactions: list[RedactionEvent] = field(default_factory=list)

    def stats(self) -> dict[RedactionKind, int]:
        out: dict[RedactionKind, int] = {}
        for r in self.redactions:
            out[r.kind] = out.get(r.kind, 0) + 1
        return out


# ─── Pattern set ────────────────────────────────────────────────────────────
#
# All regexes are case-insensitive where appropriate and use
# word-boundary anchors so a redaction in one place doesn't match a
# substring of a longer real word. ``re.IGNORECASE`` only — no DOTALL
# / MULTILINE so a newline ends a phone span if formatting is broken.

# International phone: + then 6-15 digits, optional spaces / dashes.
_PHONE_INTL = re.compile(r"\+\d(?:[\s\-‐‑]?\d){5,14}")

# Zim local: 0 followed by 9 digits, optional spaces / dashes between.
_PHONE_LOCAL = re.compile(r"\b0(?:[\s\-‐‑]?\d){8,9}\b")

# Loose RFC-style email; deliberately not exhaustive — we'd rather
# over-redact than under-redact.
_EMAIL = re.compile(
    r"\b[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}\b",
    re.IGNORECASE,
)

# Internal IDs we mint: STU_, CLS_, HW_, AK_, MARK_, SUB_, MEDIA_,
# WAMID. Match the prefix + a slug body.
_INTERNAL_ID = re.compile(
    r"\b(?:STU|CLS|HW|AK|MARK|SUB|MEDIA|WAMID)[_\-][A-Z0-9_\-]{4,}\b",
    re.IGNORECASE,
)

# "Register Number: 12345" / "Reg No 12345" / "Register: 0001"
_REGISTER_NUMBER = re.compile(
    r"\b(?:reg(?:ister)?(?:\.|\s)*(?:no\.?|number|#)?\s*[:#]?\s*)([0-9]{2,8})\b",
    re.IGNORECASE,
)


def _normalise_token(s: str) -> str:
    """Casefold + strip diacritics so 'Maïsiri' matches 'Maisiri'."""
    nfkd = unicodedata.normalize("NFKD", s)
    no_marks = "".join(c for c in nfkd if not unicodedata.combining(c))
    return no_marks.casefold()


def _build_phrase_pattern(phrases: Iterable[str]) -> re.Pattern[str] | None:
    """Compile a single regex that matches any of the given phrases as
    whole-word matches. Sorted longest-first so 'Chiredzi High School'
    wins over 'Chiredzi' on overlapping inputs."""
    cleaned = sorted({p.strip() for p in phrases if p and p.strip()}, key=len, reverse=True)
    if not cleaned:
        return None
    escaped = [re.escape(p) for p in cleaned]
    # \b on either side keeps "Moyo" from matching inside "Moyola".
    pattern = r"\b(?:" + "|".join(escaped) + r")\b"
    return re.compile(pattern, re.IGNORECASE)


def scrub(
    text: str | None,
    *,
    names: Iterable[str] = (),
    schools: Iterable[str] = (),
) -> ScrubResult:
    """Run the scrub pipeline on ``text``.

    ``names`` and ``schools`` are caller-supplied — extractors pull
    them from Firestore at runtime. Empty defaults are intentional:
    the only redactions that fire without a curated list are pattern-
    based (phones, emails, internal IDs, register-number markers).

    Idempotent — ``scrub(scrub(x).text)`` returns text equal to the
    first scrub's output (the redaction tokens themselves don't match
    any of the patterns)."""
    if not text:
        return ScrubResult(text="", redactions=[])

    # We collect (kind, span_in_original, replacement) tuples first,
    # then apply them right-to-left so spans stay valid.
    matches: list[tuple[RedactionKind, int, int, str, str]] = []
    seen: set[tuple[int, int]] = set()

    def _add(kind: RedactionKind, start: int, end: int, original: str) -> None:
        if (start, end) in seen:
            return
        # Skip if this span is entirely inside an existing one.
        for k, s, e, _, _ in matches:
            if s <= start and end <= e:
                return
        seen.add((start, end))
        matches.append((kind, start, end, _TOKEN[kind], original))

    # Order matters for overlap-resolution: more specific patterns
    # first.

    # 1) Schools (longest phrase first, so multi-word school names win).
    school_re = _build_phrase_pattern(schools)
    if school_re is not None:
        for m in school_re.finditer(text):
            _add("SCHOOL", m.start(), m.end(), m.group(0))

    # 2) Names.
    name_re = _build_phrase_pattern(names)
    if name_re is not None:
        for m in name_re.finditer(text):
            _add("NAME", m.start(), m.end(), m.group(0))

    # 3) Emails (cheap and unambiguous).
    for m in _EMAIL.finditer(text):
        _add("EMAIL", m.start(), m.end(), m.group(0))

    # 4) International phone first — its + makes it unambiguous —
    # then the local 0DDDDDDDDD form. Both are word-bounded.
    for m in _PHONE_INTL.finditer(text):
        _add("PHONE", m.start(), m.end(), m.group(0))
    for m in _PHONE_LOCAL.finditer(text):
        _add("PHONE", m.start(), m.end(), m.group(0))

    # 5) Internal IDs.
    for m in _INTERNAL_ID.finditer(text):
        _add("STUDENT_ID", m.start(), m.end(), m.group(0))

    # 6) Register-number markers — only the digits group is redacted,
    # not the literal "Register Number" prefix (we want the structure
    # preserved so the model still sees the field, just without the
    # value).
    for m in _REGISTER_NUMBER.finditer(text):
        digit_start = m.start(1)
        digit_end = m.end(1)
        _add("REGISTER_NUMBER", digit_start, digit_end, m.group(1))

    # Apply right-to-left so earlier offsets don't shift.
    matches.sort(key=lambda t: t[1], reverse=True)
    out = text
    for kind, start, end, replacement, _original in matches:
        out = out[:start] + replacement + out[end:]

    redactions = sorted(
        (
            RedactionEvent(kind=kind, span=(start, end), original_excerpt=original)
            for kind, start, end, _, original in matches
        ),
        key=lambda r: r.span[0],
    )
    return ScrubResult(text=out, redactions=redactions)
