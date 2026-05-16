"""
Tests for the country-driven curriculum + level picker:

- shared.country_profile.picker_options / levels_for_curriculum
- GET /api/curriculum/options endpoint (with monkeypatched Firestore)

Verifies that a teacher's country (resolved from phone or school doc) drives
which curricula and levels appear in the mobile picker.
"""

from __future__ import annotations

import pytest

from shared.country_profile import (
    levels_for_curriculum,
    picker_options,
    supported_countries,
)


# ── picker_options shape ──────────────────────────────────────────────────────

def test_picker_options_zimbabwe_has_zimsec_default():
    out = picker_options("Zimbabwe")
    assert out["country"] == "Zimbabwe"
    assert out["default_curriculum"] == "ZIMSEC"
    assert out["curriculum_options"][0] == "ZIMSEC"
    assert "Cambridge" in out["curriculum_options"]
    assert "IB" in out["curriculum_options"]
    assert "ZIMSEC" in out["level_options"]
    # ZIMSEC levels include the canonical Form 5 (A-Level) entry
    assert any("Form 5" in lvl for lvl in out["level_options"]["ZIMSEC"])
    # Each curriculum has its own level list — they don't share entries
    assert out["level_options"]["ZIMSEC"] != out["level_options"]["Cambridge"]


def test_picker_options_kenya_uses_knec():
    out = picker_options("Kenya")
    assert out["default_curriculum"] == "KNEC (CBC)"
    assert "KNEC (CBC)" in out["level_options"]
    # KNEC CBC has Grade 1-12 structure
    levels = out["level_options"]["KNEC (CBC)"]
    assert "Grade 12" in levels


def test_picker_options_nigeria_uses_waec_and_jss_sss():
    out = picker_options("Nigeria")
    assert "WAEC (NERDC)" in out["curriculum_options"]
    levels = out["level_options"]["WAEC (NERDC)"]
    assert any("JSS" in lvl for lvl in levels)
    assert any("SSS" in lvl for lvl in levels)


def test_picker_options_unknown_country_falls_back():
    out = picker_options("Atlantis")
    assert out["country"] == "Pan-African"
    # The default profile still offers Cambridge / IB as alternatives
    assert "Cambridge" in out["curriculum_options"]
    assert "IB" in out["curriculum_options"]


def test_picker_options_none_falls_back():
    assert picker_options(None)["country"] == "Pan-African"


# ── Cross-country level isolation ─────────────────────────────────────────────

def test_zimbabwe_native_levels_dont_leak_to_kenya():
    zw = picker_options("Zimbabwe")["level_options"]["ZIMSEC"]
    ke = picker_options("Kenya")["level_options"]["KNEC (CBC)"]
    # Form 5 (A-Level) is a Zim-native concept
    assert any("Form 5" in lvl for lvl in zw)
    assert not any("Form 5" in lvl for lvl in ke)


def test_cambridge_levels_universal():
    """Cambridge IGCSE / A-Level structure is the same regardless of country."""
    zw = levels_for_curriculum("Zimbabwe", "Cambridge")
    ke = levels_for_curriculum("Kenya", "Cambridge")
    assert zw == ke
    assert any("IGCSE" in lvl for lvl in zw)
    assert any("A-Level" in lvl for lvl in zw)


def test_ib_levels_universal():
    zw = levels_for_curriculum("Zimbabwe", "IB")
    ng = levels_for_curriculum("Nigeria", "IB")
    assert zw == ng
    assert "Diploma Programme (DP)" in zw


# ── Every supported country has a picker config ───────────────────────────────

def test_every_supported_country_has_picker_options():
    for country in supported_countries():
        out = picker_options(country)
        assert out["country"] == country
        assert out["curriculum_options"], f"{country} has empty curriculum_options"
        assert out["default_curriculum"] in out["curriculum_options"]
        for curriculum in out["curriculum_options"]:
            levels = out["level_options"].get(curriculum)
            assert levels, f"{country}/{curriculum} has empty level list"
            assert levels[0] == "All Levels"


# ── HTTP endpoint ─────────────────────────────────────────────────────────────

@pytest.fixture
def app_client(monkeypatch):
    """Build a Flask test client with stubbed Firestore + auth."""
    from flask import Flask
    from functions.curriculum import curriculum_bp

    app = Flask(__name__)
    app.register_blueprint(curriculum_bp, url_prefix="/api")
    return app.test_client()


def _patch_doc(monkeypatch, teacher_phone: str, school_country: str | None):
    """Stub get_doc to return a teacher with the given phone + school country."""
    def fake_get_doc(collection: str, doc_id: str):
        if collection == "teachers":
            return {"id": doc_id, "phone": teacher_phone, "school_id": "school1"}
        if collection == "schools":
            return {"id": "school1", "country": school_country} if school_country else None
        return None
    monkeypatch.setattr("functions.curriculum.get_doc", fake_get_doc)


def _patch_role(monkeypatch, teacher_id: str = "tch1"):
    """Stub require_role to authorise as the given teacher."""
    monkeypatch.setattr(
        "functions.curriculum.require_role",
        lambda req, role: (teacher_id, None),
    )


def test_endpoint_zw_teacher_phone(app_client, monkeypatch):
    _patch_role(monkeypatch)
    # School has no country set → fall back to phone country (+263 = Zimbabwe)
    _patch_doc(monkeypatch, teacher_phone="+263771234567", school_country=None)
    res = app_client.get("/api/curriculum/options")
    assert res.status_code == 200
    body = res.get_json()
    assert body["country"] == "Zimbabwe"
    assert body["default_curriculum"] == "ZIMSEC"


def test_endpoint_ke_teacher_phone(app_client, monkeypatch):
    _patch_role(monkeypatch)
    _patch_doc(monkeypatch, teacher_phone="+254712345678", school_country=None)
    res = app_client.get("/api/curriculum/options")
    body = res.get_json()
    assert body["country"] == "Kenya"
    assert body["default_curriculum"] == "KNEC (CBC)"


def test_endpoint_school_country_overrides_phone(app_client, monkeypatch):
    """A South African school set explicitly should win over a +263 ZW phone."""
    _patch_role(monkeypatch)
    _patch_doc(monkeypatch, teacher_phone="+263771234567", school_country="South Africa")
    res = app_client.get("/api/curriculum/options")
    body = res.get_json()
    assert body["country"] == "South Africa"
    assert body["default_curriculum"] == "CAPS"


def test_endpoint_unknown_phone_falls_back(app_client, monkeypatch):
    _patch_role(monkeypatch)
    _patch_doc(monkeypatch, teacher_phone="+9999999", school_country=None)
    res = app_client.get("/api/curriculum/options")
    body = res.get_json()
    assert body["country"] == "Pan-African"


def test_endpoint_unauthorised_returns_401(app_client, monkeypatch):
    monkeypatch.setattr(
        "functions.curriculum.require_role",
        lambda req, role: (None, "missing token"),
    )
    res = app_client.get("/api/curriculum/options")
    assert res.status_code == 401
