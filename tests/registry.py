"""
tests/registry.py

Central registry for feature-level tests.  Every test function decorated with
@feature_test(...) is recorded here so test_runner.py can discover and report
all registered features without scanning the filesystem.
"""

from __future__ import annotations

from typing import Callable

FEATURE_TESTS: dict[str, Callable] = {}


def register_test(feature_name: str, test_func: Callable) -> Callable:
    """Register a test function under a feature name and return it unchanged."""
    FEATURE_TESTS[feature_name] = test_func
    return test_func


def feature_test(feature_name: str) -> Callable:
    """Decorator — registers the decorated function in FEATURE_TESTS."""
    def decorator(func: Callable) -> Callable:
        return register_test(feature_name, func)
    return decorator
