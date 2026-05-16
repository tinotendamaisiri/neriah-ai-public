"""Tests for tools/dataset/scrub.py.

The scrubber is the privacy gate every training example passes
through before it lands in ``gs://neriah-ai-models/training/``. The
test suite below is intentionally adversarial — it exists to make a
PII leak loud, not to make the implementation look good.

If any of these tests start failing, the dataset pipeline must STOP
and the regression must be fixed before any new training data is
emitted.
"""

from __future__ import annotations

import pytest

from tools.dataset.scrub import scrub


# ─── Fixtures ────────────────────────────────────────────────────────────────


_NAMES = [
    # Common Zimbabwean given names + family names. Real curated list
    # at runtime hydrates from the live students/teachers collections;
    # this minimal set keeps the test fixture deterministic.
    "Tinotenda",
    "Tatenda",
    "Kundai",
    "Chipo",
    "Nyasha",
    "Tendai",
    "Maisiri",
    "Moyo",
    "Mukamuri",
    "Sibanda",
    "Ndlovu",
    "Chigumira",
]

_SCHOOLS = [
    "Chiredzi High School",
    "Prince Edward School",
    "Christian Brothers College",
    # Single-word school name to test boundary behaviour.
    "Borrowdale",
    "Chiredzi",  # parent name to test "longest first" preference
]


# ─── Phone numbers ──────────────────────────────────────────────────────────


class TestPhones:
    def test_redacts_e164(self):
        out = scrub("Call me on +263771234567.")
        assert out.text == "Call me on [PHONE]."
        assert out.stats() == {"PHONE": 1}

    def test_redacts_e164_with_spaces(self):
        out = scrub("My number is +263 77 123 4567 today.")
        assert "[PHONE]" in out.text
        assert "771234567" not in out.text

    def test_redacts_local_zim_format(self):
        out = scrub("Local: 0771234567 — call after 5.")
        assert "[PHONE]" in out.text
        assert "0771234567" not in out.text

    def test_does_not_redact_inline_year_or_quantity(self):
        # 2024 is not a phone; "0123" alone is below the local 0NNNNNNNN cap.
        out = scrub("In 2024 we scored 50/60.")
        assert out.text == "In 2024 we scored 50/60."
        assert out.stats() == {}


# ─── Emails ─────────────────────────────────────────────────────────────────


class TestEmails:
    def test_redacts_simple_email(self):
        out = scrub("Email me at student@example.org for the answer key.")
        assert out.text == "Email me at [EMAIL] for the answer key."

    def test_redacts_email_with_dots_and_plus(self):
        out = scrub("alice.b+tag@neriah.ai")
        assert out.text == "[EMAIL]"

    def test_does_not_match_lone_at_sign(self):
        out = scrub("@everyone please review.")
        assert out.text == "@everyone please review."


# ─── Names ──────────────────────────────────────────────────────────────────


class TestNames:
    def test_redacts_known_name(self):
        out = scrub("Tinotenda submitted homework today.", names=_NAMES)
        assert out.text == "[NAME] submitted homework today."

    def test_redacts_multiple_names_in_one_string(self):
        out = scrub(
            "Kundai and Chipo studied with Tendai.",
            names=_NAMES,
        )
        assert out.text == "[NAME] and [NAME] studied with [NAME]."
        assert out.stats() == {"NAME": 3}

    def test_does_not_redact_curriculum_names(self):
        """King Henry VIII is curriculum, not Neriah PII."""
        out = scrub(
            "Discuss the impact of King Henry VIII on the Reformation.",
            names=_NAMES,
        )
        assert out.text == "Discuss the impact of King Henry VIII on the Reformation."
        assert out.stats() == {}

    def test_partial_substring_does_not_match(self):
        """'Moyo' must not match inside 'Moyola' — \\b anchors guard
        against substring leakage."""
        out = scrub("Moyola Reservoir is in Spain.", names=_NAMES)
        assert "Moyo" in out.text  # the substring stays
        assert out.text == "Moyola Reservoir is in Spain."

    def test_case_insensitive(self):
        out = scrub("MAISIRI was the headteacher.", names=_NAMES)
        assert "[NAME]" in out.text
        assert "MAISIRI" not in out.text


# ─── Schools ────────────────────────────────────────────────────────────────


class TestSchools:
    def test_redacts_full_school_name(self):
        out = scrub("She studies at Chiredzi High School.", schools=_SCHOOLS)
        assert out.text == "She studies at [SCHOOL]."

    def test_longest_school_match_wins(self):
        """When 'Chiredzi' AND 'Chiredzi High School' are both in the
        list, the multi-word phrase should win for the same span."""
        out = scrub(
            "Welcome to Chiredzi High School in Chiredzi town.",
            schools=_SCHOOLS,
        )
        # First occurrence is the multi-word school. Second is the
        # bare town name (also in the list, so also redacted to keep
        # the scrubber strict).
        assert out.text.count("[SCHOOL]") == 2
        assert "Chiredzi High School" not in out.text

    def test_school_not_in_list_is_kept(self):
        out = scrub("Welcome to Mavhuradonha High.", schools=_SCHOOLS)
        # School name not in our list survives — that's by design;
        # the live extractor hydrates the list from Firestore so
        # this only happens in tests with a small fixture.
        assert out.text == "Welcome to Mavhuradonha High."


# ─── Internal IDs ───────────────────────────────────────────────────────────


class TestInternalIds:
    def test_redacts_student_id_prefix(self):
        out = scrub("submission stu_abc123 graded.")
        assert "[STUDENT_ID]" in out.text
        assert "stu_abc123" not in out.text.lower()

    def test_redacts_register_number_value_only(self):
        out = scrub("Register Number: 12345 — Form 4.")
        # Field label preserved, value redacted.
        assert "Register Number" in out.text
        assert "[REG]" in out.text
        assert "12345" not in out.text

    def test_register_number_handles_variants(self):
        for s in ("Reg No 4321", "Reg #4321", "register: 4321", "Reg. No: 4321"):
            out = scrub(s)
            assert "[REG]" in out.text, f"failed on: {s!r}"
            assert "4321" not in out.text, f"failed on: {s!r}"


# ─── Idempotency + audit ────────────────────────────────────────────────────


class TestIdempotency:
    def test_double_scrub_is_stable(self):
        """Running scrub on already-scrubbed text yields the same output."""
        first = scrub(
            "Tinotenda at Chiredzi High School, +263779929952, stu@neriah.ai.",
            names=_NAMES,
            schools=_SCHOOLS,
        )
        second = scrub(first.text, names=_NAMES, schools=_SCHOOLS)
        assert first.text == second.text
        # Replacement tokens in the cleaned text should NOT count as
        # new redactions on the second pass.
        assert second.stats() == {}

    def test_audit_excerpt_capped_at_40_chars(self):
        # Build a long fake "phone-shaped" string that would fit the
        # phone regex but with maximum digits.
        out = scrub("+263" + "1" * 14)
        assert len(out.redactions) == 1
        assert len(out.redactions[0].original_excerpt) <= 40

    def test_empty_input(self):
        out = scrub("")
        assert out.text == ""
        assert out.redactions == []

    def test_none_input(self):
        out = scrub(None)
        assert out.text == ""
        assert out.redactions == []


# ─── Compound red-team ─────────────────────────────────────────────────────


class TestRedTeamFixtures:
    """Hand-written tricky inputs the early extractors are likely to
    hit. Adding one to this class is the right reaction every time
    we find a real-world miss."""

    def test_full_homework_blob(self):
        raw = (
            "Tinotenda Maisiri (+263779929952, alice@example.com) at "
            "Chiredzi High School submitted Form 4 Maths. "
            "Register Number: 12345. Student id stu_abc-456-xyz."
        )
        out = scrub(raw, names=_NAMES, schools=_SCHOOLS)
        # Every PII vector is gone.
        assert "Tinotenda" not in out.text
        assert "Maisiri" not in out.text
        assert "+263" not in out.text
        assert "alice@example.com" not in out.text
        assert "Chiredzi High School" not in out.text
        assert "12345" not in out.text
        assert "stu_abc" not in out.text.lower()
        # Counts: 2 names + 1 phone + 1 email + 1 school + 1 reg + 1 student id = 7.
        assert sum(out.stats().values()) == 7

    def test_curriculum_text_passes_through_clean(self):
        """A photosynthesis question with no PII must come through
        byte-identical."""
        raw = (
            "Q1: Explain the role of chlorophyll in photosynthesis. "
            "[3 marks] Q2: Compare aerobic and anaerobic respiration."
        )
        out = scrub(raw, names=_NAMES, schools=_SCHOOLS)
        assert out.text == raw
        assert out.redactions == []

    def test_diacritic_normalisation_friendly(self):
        # The scrubber does not currently fold diacritics into name
        # matching (that's a future enhancement). Lock the current
        # behaviour explicitly so a future change is a deliberate
        # choice, not an accident.
        out = scrub("Maïsiri", names=_NAMES)
        # With current behaviour: the bare ASCII "Maisiri" doesn't
        # match "Maïsiri" because regex word-boundary + diacritic
        # treats them as different tokens. This test documents the
        # known gap rather than a fix — the live extractor will
        # always pass a runtime-built name list that includes the
        # diacritic variant directly.
        assert "[NAME]" not in out.text
        assert "Maïsiri" == out.text

    def test_all_caps_phone_email(self):
        out = scrub("CONTACT: ALICE@EXAMPLE.ORG OR +263779929952.")
        assert "ALICE@EXAMPLE.ORG" not in out.text
        assert "+263779929952" not in out.text
        assert out.text.count("[EMAIL]") == 1
        assert out.text.count("[PHONE]") == 1
