"""
Tests for Phase-2 guardrails: country-aware system prompts and the
confidence-hedge postprocess.
"""

from __future__ import annotations

import pytest

from shared.country_profile import (
    CountryProfile,
    country_profile,
    supported_countries,
)
from shared.guardrails import apply_confidence_hedge, build_system_addendum


# ── country_profile ───────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "country,expected_currency,expected_curriculum",
    [
        ("Zimbabwe",      "USD/ZWL", "ZIMSEC"),
        ("South Africa",  "ZAR",     "CAPS"),
        ("Kenya",         "KES",     "KNEC (CBC)"),
        ("Nigeria",       "NGN",     "WAEC (NERDC)"),
        ("Ghana",         "GHS",     "WAEC (NaCCA)"),
        ("Uganda",        "UGX",     "UNEB"),
        ("Tanzania",      "TZS",     "NECTA"),
        ("Zambia",        "ZMW",     "ECZ"),
    ],
)
def test_country_profile_known(country, expected_currency, expected_curriculum):
    p = country_profile(country)
    assert p.country == country
    assert p.currency == expected_currency
    assert p.curriculum == expected_curriculum
    # Sanity: every profile field is non-empty
    assert p.level_system
    assert p.mobile_money
    assert p.transport
    assert p.food
    assert p.agriculture


def test_country_profile_unknown_falls_back_to_pan_african():
    p = country_profile("Atlantis")
    assert p.country == "Pan-African"
    assert "EcoCash" in p.mobile_money or "M-Pesa" in p.mobile_money


def test_country_profile_none_or_empty_returns_default():
    assert country_profile(None).country == "Pan-African"
    assert country_profile("").country == "Pan-African"


def test_supported_countries_lists_real_countries():
    countries = supported_countries()
    # Expect at least the SADC core
    assert "Zimbabwe" in countries
    assert "South Africa" in countries
    assert "Kenya" in countries
    assert "Pan-African" not in countries  # default isn't in the list


# ── build_system_addendum with country ────────────────────────────────────────

def test_addendum_zimbabwe_includes_zw_specifics():
    out = build_system_addendum(
        "student", education_level="form_4", country="Zimbabwe",
    )
    assert "Zimbabwe" in out
    assert "ZIMSEC" in out
    assert "EcoCash" in out
    assert "kombi" in out
    assert "sadza" in out


def test_addendum_kenya_includes_ke_specifics():
    out = build_system_addendum(
        "student", education_level="form_2", country="Kenya",
    )
    assert "Kenya" in out
    assert "KNEC" in out
    assert "M-Pesa" in out
    assert "matatu" in out
    assert "ugali" in out
    # Make sure ZW examples DON'T leak into a KE prompt
    assert "EcoCash" not in out
    assert "sadza" not in out


def test_addendum_nigeria_includes_ng_specifics():
    out = build_system_addendum(
        "teacher", country="Nigeria",
    )
    assert "Nigeria" in out
    assert "WAEC" in out
    assert "NGN" in out
    assert "danfo" in out or "okada" in out
    assert "jollof" in out


def test_addendum_unknown_country_uses_pan_african_default():
    out = build_system_addendum(
        "student", education_level="form_3", country="Wakanda",
    )
    assert "Pan-African" in out
    # The default mentions multiple options
    assert "EcoCash" in out or "M-Pesa" in out


def test_addendum_no_country_uses_default():
    out = build_system_addendum("student", education_level="form_3")
    assert "Pan-African" in out


# ── apply_confidence_hedge ────────────────────────────────────────────────────

def test_hedge_appended_when_specific_facts_no_hedge():
    text = "World War 2 ended in 1945."
    out = apply_confidence_hedge(text, role="student")
    assert "double-check" in out
    assert text in out  # original preserved


def test_hedge_appended_for_percentage_claim():
    text = "About 73% of Zimbabweans live in rural areas."
    out = apply_confidence_hedge(text, role="student")
    assert "double-check" in out


def test_hedge_appended_for_large_number():
    text = "Harare has a population of 1500000 people."
    out = apply_confidence_hedge(text, role="student")
    assert "double-check" in out


def test_hedge_skipped_when_already_hedged():
    text = "I think the war ended in 1945, but please double-check with your teacher."
    out = apply_confidence_hedge(text, role="student")
    assert out == text  # untouched


def test_hedge_skipped_when_self_hedged_with_other_phrase():
    text = "World War 2 ended in 1945, but verify with your textbook to be sure."
    out = apply_confidence_hedge(text, role="student")
    assert out == text


def test_hedge_skipped_when_no_specific_facts():
    text = "Photosynthesis is the process by which plants make food from sunlight."
    out = apply_confidence_hedge(text, role="student")
    assert out == text  # nothing specific to hedge


def test_hedge_idempotent():
    text = "WWII ended in 1945."
    once = apply_confidence_hedge(text, role="student")
    twice = apply_confidence_hedge(once, role="student")
    assert once == twice


def test_hedge_skipped_for_teacher_role():
    text = "World War 2 ended in 1945."
    assert apply_confidence_hedge(text, role="teacher") == text


def test_hedge_skipped_for_empty_text():
    assert apply_confidence_hedge("", role="student") == ""
    assert apply_confidence_hedge(None, role="student") is None  # type: ignore[arg-type]
