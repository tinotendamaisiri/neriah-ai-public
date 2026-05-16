"""
shared/student_matcher.py — resolve an inbound email submission to the
right student record (or create one).

Pipeline used by functions/email_poller.py:

  parse_subject(subject, body_fallback)  → SubjectFields | None
  match_student(fields, sender_email)    → MatchResult

A submission is deemed routable when we have all three of (school, class,
student_name) AND can fuzzy-match the school + class. Student name
matching is NOT required — when no student matches in the resolved
class, we auto-enrol the sender as a new Student in that class
(per product policy: "if a student submits to a class they're not in,
they get auto-added").

Matching is intentionally cheap and ordered:

  1. If a Student already exists with this email AND is in some class,
     short-circuit straight there. (Second + emails from the same
     address skip every fuzzy step entirely.)
  2. Exact (case-insensitive) school name match.
  3. Fuzzy school name match via difflib (cutoff 0.85, mirrors the
     existing whatsapp.py:_fuzzy_match_school threshold tuned for
     SADC school name typos like "St Marys" vs "St Mary's").
  4. Filter classes by school_id, then exact + fuzzy class name match.
  5. Filter students by class_id, then exact + fuzzy student name match.
  6. No student match → auto-enrol.

Returns a MatchResult tagged with `status` so the caller can branch:

  MATCHED         single confident student → grade against any answer key
                  in this class
  AUTO_ENROLLED   sender wasn't in the class, we created the Student
  AMBIGUOUS_*     two+ candidates within the cutoff band — caller should
                  send a format-error reply asking for more detail
  NOT_FOUND       school or class couldn't be resolved at all
"""

from __future__ import annotations

import difflib
import logging
import re
from dataclasses import dataclass
from enum import Enum
from typing import Optional

from shared.firestore_client import get_doc, query, query_single, upsert
from shared.models import Student

logger = logging.getLogger(__name__)


# ─── Subject parsing ──────────────────────────────────────────────────────────

# Order matters: we try the most specific format first, then more
# permissive fallbacks. The pipe-delimited form is what's printed on the
# class slip — students who follow it get zero ambiguity.
_PIPE_RE = re.compile(
    r"name\s*[:\-]\s*(?P<name>[^|]+?)\s*\|\s*"
    r"class\s*[:\-]\s*(?P<class_name>[^|]+?)\s*\|\s*"
    r"school\s*[:\-]\s*(?P<school>.+)",
    re.IGNORECASE,
)
# Hyphen / em-dash / comma fallback: "John Smith - Form 4A - St Mary's"
_HYPHEN_RE = re.compile(
    r"^\s*(?P<name>[^\-,–—]+?)\s*[\-,–—]\s*(?P<class_name>[^\-,–—]+?)\s*[\-,–—]\s*(?P<school>.+?)\s*$",
)
# Standalone homework code with explicit "Code:" prefix — pulled from
# subjects that already have other structured fields (e.g. the full
# Name|Class|School slip). Codes are 6 chars from the typo-resistant
# alphabet defined in shared.submission_codes.
_CODE_RE = re.compile(
    r"code\s*[:\-]\s*(?P<code>[A-Z0-9]{6})\b",
    re.IGNORECASE,
)
# Minimal "Name: Alice | Code: HW7K2P" form. School/class fields not
# required when a code is present — the code resolves the answer key
# directly which gives us class + school for free.
_NAME_CODE_RE = re.compile(
    r"name\s*[:\-]\s*(?P<name>[^|]+?)\s*\|\s*"
    r"code\s*[:\-]\s*(?P<code>[A-Z0-9]{6})\b",
    re.IGNORECASE,
)
# Bare 6-char token anywhere in the subject. Used by the lenient
# free-text path: a student typing "Tinotenda Maisiri QJXEPE" or
# "QJXEPE Tinotenda" or "tinotenda - qjxepe" should still route. The
# word boundary stops us from grabbing substrings of longer words.
_BARE_CODE_RE = re.compile(r"\b([A-Za-z0-9]{6})\b")
# Reply/forward prefixes we strip from the subject before extracting
# the name — common in email clients but never part of the student's
# intended name.
_PREFIX_RE = re.compile(
    r"^\s*(?:re|fw|fwd|aw|wg|tr|sv|vs|ang|encaminhado)\s*:\s*",
    re.IGNORECASE,
)
# Characters from the typo-resistant alphabet only. Filters bare-token
# matches: a 6-char English word like "STREET" would match the regex
# but fails this set check (E and T are present, but T is in the safe
# alphabet so STREET would also wrongly look like a code). We accept
# this minor risk — if a student's subject literally says "STREET
# Tinotenda", we'd treat "STREET" as a code, the matcher would
# NOT_FOUND_CODE, and the student gets a clear error telling them
# the code wasn't recognised.
_CODE_ALPHABET = set("ABCDEFGHJKMNPQRSTUVWXYZ23456789")


def _looks_like_a_code(token: str) -> bool:
    if len(token) != 6:
        return False
    return all(c in _CODE_ALPHABET for c in token.upper())


@dataclass
class SubjectFields:
    student_name: str
    # class_name + school_name are optional — populated from the legacy
    # three-field subject. When the student uses the code-based form
    # they're empty, and the matcher resolves school + class from the
    # code's answer_key instead.
    class_name: str = ""
    school_name: str = ""
    submission_code: str = ""

    @property
    def has_code(self) -> bool:
        return bool(self.submission_code)


def _extract_code(text: str) -> str:
    m = _CODE_RE.search(text)
    return m.group("code").upper() if m else ""


def parse_subject(subject: str, body_fallback: str = "") -> Optional[SubjectFields]:
    """Parse the subject (or first 500 chars of body) into matcher fields.

    Three valid shapes, in order of specificity:
      A. Structured code:  "Name: Alice | Code: HW7K2P"
      B. Three-field:      "Name: Alice | Class: Form 4A | School: St Marys"
      C. Free-text:        "Alice Mukamuri QJXEPE", "QJXEPE - alice",
                           "Tinotenda. QJXEPE" — anything containing a
                           name and a 6-char code-shaped token. Strips
                           reply prefixes (Re:, Fwd:, etc.) from the
                           name. This is the lenient path for students
                           typing on a phone with no patience for
                           keyword:value formatting.

    Returns None when none of the three yields a name AND a code/class
    + school pair.
    """
    for source in (subject, body_fallback[:500]):
        if not source:
            continue

        # A. Structured "Name: X | Code: Y".
        m = _NAME_CODE_RE.search(source)
        if m:
            return SubjectFields(
                student_name=m.group("name").strip(),
                submission_code=m.group("code").upper(),
            )

        # B. Three-field. Pull a code opportunistically if one happens
        # to be present so a student who copies the full slip
        # ("Name | Class | School | Code") still gets the fast path.
        m = _PIPE_RE.search(source)
        if not m:
            m = _HYPHEN_RE.match(source)
        if m:
            return SubjectFields(
                student_name=m.group("name").strip(),
                class_name=m.group("class_name").strip(),
                school_name=m.group("school").strip().rstrip(".,;"),
                submission_code=_extract_code(source),
            )

        # C. Free-text. Find any 6-char token from the typo-resistant
        # code alphabet; treat the rest of the subject (sans reply
        # prefixes) as the student's name.
        free = _extract_free_text(source)
        if free:
            return free

    return None


def _extract_free_text(text: str) -> Optional[SubjectFields]:
    """Find a code-shaped token anywhere in the text and treat the rest
    as the student's name. Returns None if no valid code is present, or
    if stripping the code leaves no name behind.
    """
    # Strip leading reply/forward prefixes so they don't end up in the
    # name (e.g. "Re: Tinotenda QJXEPE" → name "Tinotenda").
    cleaned = text
    for _ in range(3):  # allow a few stacked prefixes ("Re: Fwd: …")
        new = _PREFIX_RE.sub("", cleaned)
        if new == cleaned:
            break
        cleaned = new

    for m in _BARE_CODE_RE.finditer(cleaned):
        token = m.group(1)
        if not _looks_like_a_code(token):
            continue
        code = token.upper()
        # Everything in the cleaned text except the code itself is the
        # name. Collapse whitespace and strip surrounding punctuation
        # ("Tinotenda. QJXEPE" → "Tinotenda").
        name_raw = cleaned[: m.start()] + cleaned[m.end() :]
        name = re.sub(r"\s+", " ", name_raw).strip(" .,;:-_|/\\")
        if not name:
            return None
        return SubjectFields(student_name=name, submission_code=code)
    return None


# ─── Match results ────────────────────────────────────────────────────────────

class MatchStatus(str, Enum):
    MATCHED = "matched"
    AUTO_ENROLLED = "auto_enrolled"
    AMBIGUOUS_SCHOOL = "ambiguous_school"
    AMBIGUOUS_CLASS = "ambiguous_class"
    NOT_FOUND_SCHOOL = "not_found_school"
    NOT_FOUND_CLASS = "not_found_class"
    # Code-path failures: the student typed a code we don't recognise.
    NOT_FOUND_CODE = "not_found_code"


@dataclass
class MatchResult:
    status: MatchStatus
    student: Optional[dict] = None
    class_doc: Optional[dict] = None
    school: Optional[dict] = None
    # Set when the match took the code path so the poller can grade
    # against this exact answer_key and skip the "most recent in class"
    # heuristic. None on the legacy fuzzy path.
    answer_key: Optional[dict] = None
    # Human-readable detail for format-error reply emails (e.g. "no
    # school named 'St Marys' was found; closest matches: …").
    reason: str = ""


# ─── Fuzzy helpers ────────────────────────────────────────────────────────────

_SCHOOL_FUZZY_CUTOFF = 0.85
_CLASS_FUZZY_CUTOFF = 0.80
_STUDENT_FUZZY_CUTOFF = 0.85


# NOTE: _maybe_update_name was removed. It used to overwrite the
# student's stored first_name/surname with whatever name appeared in
# the latest email subject — intended to fix a debug-time
# "Test Student" record but in production it silently corrupted real
# user identities (a legitimate student who emailed once with a typo
# in their subject would have their registered name overwritten).
# The student's name is now whatever they registered with, full stop.
# Email subjects are used to *match* the student, never to *rename*.


def _fuzzy_pick(needle: str, haystack: list[dict], key: str, cutoff: float) -> list[dict]:
    """Return docs whose `key` field fuzzy-matches `needle` above cutoff.
    Combines exact case-insensitive containment + difflib ratio.
    """
    if not needle or not haystack:
        return []
    needle_l = needle.lower().strip()
    names = [(d.get(key, "") or "").strip() for d in haystack]
    # Exact case-insensitive match wins outright.
    exact = [d for d, n in zip(haystack, names) if n.lower() == needle_l]
    if exact:
        return exact
    # Substring match (e.g. "St Mary" inside "St Mary's High School").
    contains = [d for d, n in zip(haystack, names) if needle_l in n.lower()]
    if contains:
        return contains
    # Fall back to difflib ratio.
    close_names = set(difflib.get_close_matches(needle, names, n=5, cutoff=cutoff))
    return [d for d, n in zip(haystack, names) if n in close_names]


# ─── Matching ─────────────────────────────────────────────────────────────────

def match_student(fields: SubjectFields, sender_email: str) -> MatchResult:
    """Resolve a SubjectFields + sender to a (student, class, school).

    Two paths:
      - Code-based (when fields.has_code): exact answer_key lookup,
        class + school derived from it, student matched/auto-enrolled
        in that class. No fuzzy matching — fastest and least
        ambiguous, this is the path students using the printed slip
        should hit.
      - Fuzzy (legacy): school name → class name → student name, with
        difflib at each step. Falls through when there's no code.
    """
    sender_email_norm = (sender_email or "").strip().lower()

    # 0. Code path — resolve from the homework code.
    if fields.has_code:
        return _match_by_code(fields, sender_email_norm)

    # 1. Email shortcut. If we've seen this address before, the matched
    #    Student is canonical — skip everything else. The caller still
    #    has to resolve the *class* though, since a student may be in
    #    multiple classes; we use the SubjectFields.class_name to pick
    #    which one the submission is for, and only fall back to the
    #    student's primary class_id when the subject class doesn't
    #    match any of theirs.
    if sender_email_norm:
        existing = query_single("students", [("email", "==", sender_email_norm)])
        if existing:
            class_doc = _resolve_class_for_returning_student(existing, fields.class_name)
            if class_doc:
                school = get_doc("schools", class_doc.get("school_id", "")) if class_doc.get("school_id") else None
                # Match found via email shortcut — return the existing
                # record as-is. We don't rename based on the subject;
                # the registered name is canonical. See the deleted
                # _maybe_update_name docstring above for why.
                return MatchResult(
                    status=MatchStatus.MATCHED,
                    student=existing,
                    class_doc=class_doc,
                    school=school,
                )
            # Email known but the class name in this submission doesn't
            # match any of theirs — fall through to the full resolve so
            # we can auto-enrol them in the new class too.

    # 2 + 3. School resolve.
    schools = query("schools", []) or []
    school_matches = _fuzzy_pick(fields.school_name, schools, "name", _SCHOOL_FUZZY_CUTOFF)
    if not school_matches:
        return MatchResult(
            status=MatchStatus.NOT_FOUND_SCHOOL,
            reason=f"We couldn't find a school called '{fields.school_name}' in our records.",
        )
    if len(school_matches) > 1:
        names = ", ".join(s.get("name", "") for s in school_matches[:3])
        return MatchResult(
            status=MatchStatus.AMBIGUOUS_SCHOOL,
            reason=f"Multiple schools matched '{fields.school_name}': {names}. Please use the exact school name.",
        )
    school = school_matches[0]

    # 4. Class resolve, scoped to that school.
    classes = query("classes", [("school_id", "==", school["id"])]) or []
    class_matches = _fuzzy_pick(fields.class_name, classes, "name", _CLASS_FUZZY_CUTOFF)
    if not class_matches:
        return MatchResult(
            status=MatchStatus.NOT_FOUND_CLASS,
            school=school,
            reason=f"We couldn't find a class called '{fields.class_name}' at {school.get('name','')}.",
        )
    if len(class_matches) > 1:
        names = ", ".join(c.get("name", "") for c in class_matches[:3])
        return MatchResult(
            status=MatchStatus.AMBIGUOUS_CLASS,
            school=school,
            reason=f"Multiple classes matched '{fields.class_name}' at {school.get('name','')}: {names}.",
        )
    class_doc = class_matches[0]

    # 5. Student name resolve, scoped to that class.
    students = query("students", [("class_id", "==", class_doc["id"])]) or []
    # Match against either first_name+surname or full name string.
    name_haystack: list[dict] = []
    for s in students:
        full = f"{s.get('first_name','')} {s.get('surname','')}".strip()
        name_haystack.append({**s, "_full": full})
    student_matches = _fuzzy_pick(fields.student_name, name_haystack, "_full", _STUDENT_FUZZY_CUTOFF)
    if len(student_matches) == 1:
        student = student_matches[0]
        # Backfill email on first match-by-name from this address so
        # the next submission takes the email shortcut.
        if sender_email_norm and not student.get("email"):
            student = {**student, "email": sender_email_norm}
            student.pop("_full", None)
            upsert("students", student["id"], student)
        return MatchResult(
            status=MatchStatus.MATCHED,
            student={k: v for k, v in student.items() if k != "_full"},
            class_doc=class_doc,
            school=school,
        )

    # 6. No (or ambiguous) student match → auto-enrol the sender. We
    #    intentionally do this even on AMBIGUOUS to honour the policy
    #    "if a student submits to a class they're not in, they get
    #    auto-added"; the teacher resolves any duplicate later from
    #    the roster.
    new_student = _auto_enrol(fields.student_name, sender_email_norm, class_doc)
    return MatchResult(
        status=MatchStatus.AUTO_ENROLLED,
        student=new_student,
        class_doc=class_doc,
        school=school,
    )


def _match_by_code(fields: SubjectFields, sender_email_norm: str) -> MatchResult:
    """Code path: subject contained "Code: HW7K2P". One Firestore lookup
    (answer_keys by submission_code) gives us the answer_key, which
    chains to class → school. Student is then matched within the class
    roster, or auto-enrolled if missing — same policy as the fuzzy path.
    """
    code = fields.submission_code
    answer_key = query_single("answer_keys", [("submission_code", "==", code)])
    if not answer_key:
        return MatchResult(
            status=MatchStatus.NOT_FOUND_CODE,
            reason=(
                f"We couldn't find a homework with code '{code}'. "
                "Please check the code your teacher gave you and try again."
            ),
        )

    class_doc = get_doc("classes", answer_key.get("class_id", ""))
    if not class_doc:
        # Code is valid but the class went missing — almost certainly a
        # data-integrity bug, not a student-fixable problem. Treat it as
        # a transient route failure and surface a generic reply.
        logger.error(
            "_match_by_code: answer_key %s has missing class_id %s",
            answer_key.get("id"), answer_key.get("class_id"),
        )
        return MatchResult(
            status=MatchStatus.NOT_FOUND_CLASS,
            answer_key=answer_key,
            reason="That homework's class record couldn't be loaded. Please ask your teacher to check.",
        )

    school = None
    if class_doc.get("school_id"):
        school = get_doc("schools", class_doc["school_id"])

    # Email shortcut still applies on the code path so a student who's
    # already enrolled doesn't get auto-enrolled a second time when they
    # email a new homework code from the same address.
    if sender_email_norm:
        existing = query_single("students", [("email", "==", sender_email_norm)])
        if existing and class_doc["id"] in (
            existing.get("class_ids") or [existing.get("class_id")]
        ):
            # Match found via email shortcut — return the existing
            # record as-is. The registered name is canonical; we never
            # rename based on email-subject contents.
            return MatchResult(
                status=MatchStatus.MATCHED,
                student=existing,
                class_doc=class_doc,
                school=school,
                answer_key=answer_key,
            )

    # Match by name within the class roster.
    students = query("students", [("class_id", "==", class_doc["id"])]) or []
    name_haystack = [
        {**s, "_full": f"{s.get('first_name','')} {s.get('surname','')}".strip()}
        for s in students
    ]
    student_matches = _fuzzy_pick(fields.student_name, name_haystack, "_full", _STUDENT_FUZZY_CUTOFF)
    if len(student_matches) == 1:
        student = {k: v for k, v in student_matches[0].items() if k != "_full"}
        if sender_email_norm and not student.get("email"):
            student["email"] = sender_email_norm
            upsert("students", student["id"], student)
        return MatchResult(
            status=MatchStatus.MATCHED,
            student=student,
            class_doc=class_doc,
            school=school,
            answer_key=answer_key,
        )

    # Zero or multiple matches → auto-enrol. The product policy is
    # "submitting to a class adds you to it", and the same applies on
    # the code path — if a teacher hands the slip to a new student,
    # their first email is the enrolment.
    student = _auto_enrol(fields.student_name, sender_email_norm, class_doc)
    return MatchResult(
        status=MatchStatus.AUTO_ENROLLED,
        student=student,
        class_doc=class_doc,
        school=school,
        answer_key=answer_key,
    )


def _resolve_class_for_returning_student(student: dict, requested_class_name: str) -> Optional[dict]:
    """For a known-by-email student, pick the class their submission
    targets. Prefers an exact class-name match against any of their
    enrolments; falls back to their primary class_id."""
    class_ids = student.get("class_ids") or []
    if student.get("class_id") and student["class_id"] not in class_ids:
        class_ids = [student["class_id"], *class_ids]

    candidates: list[dict] = []
    for cid in class_ids:
        c = get_doc("classes", cid)
        if c:
            candidates.append(c)

    if not candidates:
        return None

    matches = _fuzzy_pick(requested_class_name, candidates, "name", _CLASS_FUZZY_CUTOFF)
    if matches:
        return matches[0]
    # Class name in subject doesn't match any of their enrolments.
    return None


def _auto_enrol(student_name: str, sender_email: str, class_doc: dict) -> dict:
    """Create a new Student in `class_doc` and return the dict."""
    parts = student_name.strip().split(None, 1)
    first_name = parts[0] if parts else "Student"
    surname = parts[1] if len(parts) > 1 else ""
    student = Student(
        class_id=class_doc["id"],
        class_ids=[class_doc["id"]],
        first_name=first_name,
        surname=surname,
        email=sender_email or None,
    )
    doc = student.model_dump()
    upsert("students", student.id, doc)
    logger.info(
        "student_matcher: auto-enrolled %s %s into class %s (%s)",
        first_name, surname, class_doc.get("name", ""), class_doc["id"],
    )
    return doc
