"""
tests/test_runner.py

Auto-discovers all @feature_test-decorated functions and runs them via pytest.

Usage:
    python tests/test_runner.py
    python -m pytest tests/ -v          # standard pytest also works
"""

from __future__ import annotations

import sys

import pytest

# Import every test module so their @feature_test decorators fire and populate
# the registry before we print the summary.
import tests.test_homework_creation_flow  # noqa: F401

from tests.registry import FEATURE_TESTS


def run_all() -> None:
    """Print registered features then run the full test suite."""
    print(f"\n{'=' * 60}")
    print(f"NERIAH TEST SUITE — {len(FEATURE_TESTS)} features registered")
    print(f"{'=' * 60}")
    for feature, test_func in FEATURE_TESTS.items():
        print(f"  \u2713 {feature}: {test_func.__name__}")
    print(f"{'=' * 60}\n")

    sys.exit(pytest.main([__file__, "-v", "--tb=short"]))


if __name__ == "__main__":
    run_all()
