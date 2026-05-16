"""
Module-level constants that don't belong to the Pydantic Settings object.

Use `settings` (from shared.config) for anything reading from the environment.
Use this module for compile-time constants that change only when the codebase
is redeployed.
"""

from __future__ import annotations

# ── Legal / Terms ─────────────────────────────────────────────────────────────
# Terms of Service version. Bump when neriah.ai/legal content changes; mobile
# sends the version it presented to the user, backend records both the user's
# accepted version and the current server version for drift detection.
TERMS_VERSION = "1.0"
TERMS_URL = "https://neriah.ai/legal"
