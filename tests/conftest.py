"""
Pytest configuration for the Neriah GCP project.

Sets required environment variables before any module is imported.
Non-GCP vars (WhatsApp tokens, JWT secret) are set to safe test values.
GCP vars (GCP_PROJECT_ID) must be set in the environment or a .env file
before running the live smoke tests.
"""

import os
from pathlib import Path

from dotenv import load_dotenv

# ── Load .env from project root so GCP_PROJECT_ID is visible to pytestmark ───
load_dotenv(Path(__file__).parent.parent / ".env")

# ── Provide fallback values for non-GCP required settings ────────────────────
# These allow the Settings() object to instantiate without crashing.
# Real GCP credentials come from the environment / Application Default Credentials.
_DEFAULTS = {
    "GCS_BUCKET_SCANS":         "neriah-test-scans",
    "GCS_BUCKET_MARKED":        "neriah-test-marked",
    "GCS_BUCKET_SUBMISSIONS":   "neriah-test-submissions",
    "WHATSAPP_VERIFY_TOKEN":    "test-verify-token",
    "WHATSAPP_ACCESS_TOKEN":    "test-access-token",
    "WHATSAPP_PHONE_NUMBER_ID": "test-phone-id",
    "APP_JWT_SECRET":           "test-jwt-secret-at-least-32-chars-ok",
}

for key, value in _DEFAULTS.items():
    os.environ.setdefault(key, value)

# GCP_PROJECT_ID must be set for live tests; skip gracefully if not.


# ── Autouse fixture: no-op the role-invariant guards by default ──────────────
# shared.role_invariants.assert_is_student / assert_is_teacher each do a
# Firestore get_doc to verify the ID lands in the right collection. Most
# unit tests build minimal fixtures that don't bother creating real student
# / teacher docs, so without this fixture every Mark or AnswerKey
# construction site that now calls these helpers would 400. Tests that
# WANT to verify the invariants (tests/test_role_invariants.py) bypass this
# fixture by patching shared.role_invariants.get_doc themselves.
import pytest  # noqa: E402

@pytest.fixture(autouse=True)
def _disable_role_invariants(request):
    # Skip when the test module explicitly targets the invariants.
    if "test_role_invariants" in (request.node.module.__name__ or ""):
        yield
        return
    from unittest.mock import patch
    with patch("shared.role_invariants.assert_is_student"), \
         patch("shared.role_invariants.assert_is_teacher"):
        yield
