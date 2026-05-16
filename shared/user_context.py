"""
User context builder — derives RAG filter context from profile data.

Reads teacher/student → school → class documents from Firestore and assembles
a context dict used to narrow vector DB searches to the user's curriculum,
country, subject, and education level automatically.

The user never selects anything.  They register once with their school.
Everything else flows from the data already stored at registration.

Usage:
    from shared.user_context import get_user_context

    ctx = get_user_context(teacher_id, "teacher", class_id=class_id)
    # {"country": "Zimbabwe", "curriculum": "ZIMSEC",
    #  "subject": "Mathematics", "education_level": "form_2"}

    ctx = get_user_context(student_id, "student")
    # same shape — resolved via student → class → school traversal

All functions are synchronous and never raise.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

# ── Country detection ─────────────────────────────────────────────────────────

_COUNTRY_CODES: dict[str, str] = {
    "+263": "Zimbabwe",
    "+260": "Zambia",
    "+265": "Malawi",
    "+255": "Tanzania",
    "+27":  "South Africa",
    "+267": "Botswana",
    "+264": "Namibia",
    "+258": "Mozambique",
    "+243": "DRC",
    "+254": "Kenya",
    "+234": "Nigeria",
    "+233": "Ghana",
    "+256": "Uganda",
    "+250": "Rwanda",
    "+251": "Ethiopia",
    "+212": "Morocco",
    "+216": "Tunisia",
    "+20":  "Egypt",
    "+1":   "US/Canada",
    "+44":  "UK",
}


def detect_country_from_phone(phone: str) -> str:
    """
    Return the country name for *phone* based on its international dialling code.

    Matches longest prefix first so +263 beats +26.
    Returns "Unknown" when no code matches.
    """
    if not phone:
        return "Unknown"
    # Sort by length descending so longer codes (e.g. +263) match before shorter ones (+2)
    for code in sorted(_COUNTRY_CODES, key=len, reverse=True):
        if phone.startswith(code):
            return _COUNTRY_CODES[code]
    return "Unknown"


# ── Default curriculum per country ────────────────────────────────────────────

_DEFAULT_CURRICULUM: dict[str, str] = {
    "Zimbabwe":     "ZIMSEC",
    "Kenya":        "KNEC",
    "Nigeria":      "WAEC",
    "Ghana":        "WAEC",
    "South Africa": "CAPS",
    "Uganda":       "UNEB",
    "Tanzania":     "NECTA",
    "Zambia":       "ECZ",
    "Malawi":       "MANEB",
    "Botswana":     "BEC",
    "Namibia":      "NIED",
    "Rwanda":       "REB",
    "DRC":          "MEPSP",
}


def _default_curriculum(country: str) -> str:
    return _DEFAULT_CURRICULUM.get(country, "ZIMSEC")


# ── Context builder ───────────────────────────────────────────────────────────

def get_user_context(
    user_id: str,
    role: str,                      # "teacher" | "student"
    class_id: str | None = None,    # teacher can pass the active class_id explicitly
) -> dict:
    """
    Build a RAG filter context dict from the user's stored profile.

    Returns a dict with any subset of:
        country, curriculum, subject, education_level

    Keys are omitted when the value cannot be determined, so the caller can
    always do ``filters = {k: v for k, v in ctx.items() if v}`` safely.

    Never raises — returns {} on any error.
    """
    try:
        from shared.firestore_client import get_doc  # noqa: PLC0415

        if role == "teacher":
            ctx = _teacher_context(user_id, class_id, get_doc)
        elif role == "student":
            ctx = _student_context(user_id, get_doc)
        else:
            return {}

        logger.info(
            "[user_context] built for %s/%s class=%s → country=%s curriculum=%s "
            "subject=%s level=%s weaknesses=%d",
            role, user_id, class_id or "-",
            ctx.get("country", "-"),
            ctx.get("curriculum", "-"),
            ctx.get("subject", "-"),
            ctx.get("education_level", "-"),
            len(ctx.get("weakness_topics") or []),
        )
        return ctx
    except Exception:
        logger.exception("[user_context] get_user_context failed for %s/%s", role, user_id)
        return {}


def _teacher_context(
    teacher_id: str,
    class_id: str | None,
    get_doc,
) -> dict:
    ctx: dict = {}
    teacher = get_doc("teachers", teacher_id)
    if not teacher:
        return ctx

    # Country — school document is authoritative; fall back to phone number
    school_id = teacher.get("school_id") or ""
    school = get_doc("schools", school_id) if school_id else None

    country = (school or {}).get("country") or detect_country_from_phone(
        teacher.get("phone", "")
    )
    if country and country != "Unknown":
        ctx["country"] = country

    # Curriculum — from school document, then country-based default
    curriculum = (school or {}).get("curriculum") or _default_curriculum(country)
    if curriculum:
        ctx["curriculum"] = curriculum

    # Subject + education_level — from the active class
    if class_id:
        cls = get_doc("classes", class_id)
        if cls:
            if subj := cls.get("subject"):
                ctx["subject"] = subj
            if level := cls.get("education_level"):
                ctx["education_level"] = level

    return ctx


def _student_context(student_id: str, get_doc) -> dict:
    ctx: dict = {}
    student = get_doc("students", student_id)
    if not student:
        return ctx

    # Class → subject + education_level
    class_id = student.get("class_id") or ""
    cls = get_doc("classes", class_id) if class_id else None

    if cls:
        if subj := cls.get("subject"):
            ctx["subject"] = subj
        if level := cls.get("education_level"):
            ctx["education_level"] = level

    # School → country + curriculum
    school_id = student.get("school_id") or (cls or {}).get("school_id") or ""
    school = get_doc("schools", school_id) if school_id else None

    country = (school or {}).get("country") or detect_country_from_phone(
        student.get("phone", "")
    )
    if country and country != "Unknown":
        ctx["country"] = country

    curriculum = (school or {}).get("curriculum") or _default_curriculum(country)
    if curriculum:
        ctx["curriculum"] = curriculum

    # Weakness topics — up to 5 most recent incorrect/partial verdicts, newest first.
    # Persisted by weakness_tracker.py after each approved submission.
    raw_weaknesses: list[dict] = student.get("weaknesses") or []
    weak_topics = [
        w["topic"] for w in raw_weaknesses[:5]
        if w.get("topic")
    ]
    if weak_topics:
        ctx["weakness_topics"] = weak_topics

    return ctx
