"""Tests for shared/role_invariants.py — the runtime helpers that
enforce "Mark.student_id must be in students" and "AnswerKey.teacher_id
must be in teachers". Firestore can't enforce foreign keys, so this is
the application-level guard.
"""
from __future__ import annotations

import os
from unittest.mock import patch

import pytest

os.environ.setdefault("APP_JWT_SECRET", "test-jwt-secret-at-least-32-chars-ok")
os.environ.setdefault("GCS_BUCKET_SCANS", "neriah-test-scans")
os.environ.setdefault("GCS_BUCKET_MARKED", "neriah-test-marked")
os.environ.setdefault("GCS_BUCKET_SUBMISSIONS", "neriah-test-submissions")
os.environ.setdefault("WHATSAPP_VERIFY_TOKEN", "test-verify-token")
os.environ.setdefault("WHATSAPP_ACCESS_TOKEN", "test-access-token")
os.environ.setdefault("WHATSAPP_PHONE_NUMBER_ID", "test-phone-id")
os.environ.setdefault("NERIAH_ENV", "demo")


def _patch_get_doc(student_ids: set[str], teacher_ids: set[str]):
    """Build a get_doc patcher that returns truthy values for IDs in the
    given collections and None otherwise."""
    def fake(coll, doc_id):
        if coll == "students" and doc_id in student_ids:
            return {"id": doc_id, "first_name": "X", "surname": "Y"}
        if coll == "teachers" and doc_id in teacher_ids:
            return {"id": doc_id, "name": "X Y"}
        return None
    return patch("shared.role_invariants.get_doc", side_effect=fake)


# ─── assert_is_student ───────────────────────────────────────────────────────

def test_assert_is_student_passes_when_id_is_in_students():
    from shared.role_invariants import assert_is_student
    with _patch_get_doc({"stu-1"}, set()):
        assert_is_student("stu-1")  # no raise


def test_assert_is_student_raises_when_id_is_a_teacher():
    """The cross-role failure mode: someone passed a teacher's user_id
    where a student_id was expected. Must reject with a clear cause."""
    from shared.role_invariants import assert_is_student, RoleInvariantError
    with _patch_get_doc(set(), {"teach-1"}):
        with pytest.raises(RoleInvariantError) as ei:
            assert_is_student("teach-1")
    assert ei.value.expected == "student"
    assert ei.value.actual == "teacher"
    assert "teacher" in str(ei.value).lower()


def test_assert_is_student_raises_when_id_unknown():
    from shared.role_invariants import assert_is_student, RoleInvariantError
    with _patch_get_doc(set(), set()):
        with pytest.raises(RoleInvariantError) as ei:
            assert_is_student("missing")
    assert ei.value.expected == "student"
    assert ei.value.actual is None


def test_assert_is_student_raises_on_empty_id():
    from shared.role_invariants import assert_is_student, RoleInvariantError
    with pytest.raises(RoleInvariantError):
        assert_is_student("")


# ─── assert_is_teacher ───────────────────────────────────────────────────────

def test_assert_is_teacher_passes_when_id_is_in_teachers():
    from shared.role_invariants import assert_is_teacher
    with _patch_get_doc(set(), {"teach-1"}):
        assert_is_teacher("teach-1")  # no raise


def test_assert_is_teacher_raises_when_id_is_a_student():
    """The cross-role failure mode: someone passed a student_id where
    a teacher_id was expected — would let students 'create' homework
    or have AnswerKeys credited to them. Must reject."""
    from shared.role_invariants import assert_is_teacher, RoleInvariantError
    with _patch_get_doc({"stu-1"}, set()):
        with pytest.raises(RoleInvariantError) as ei:
            assert_is_teacher("stu-1")
    assert ei.value.expected == "teacher"
    assert ei.value.actual == "student"
    assert "student" in str(ei.value).lower()


def test_assert_is_teacher_raises_when_id_unknown():
    from shared.role_invariants import assert_is_teacher, RoleInvariantError
    with _patch_get_doc(set(), set()):
        with pytest.raises(RoleInvariantError) as ei:
            assert_is_teacher("missing")
    assert ei.value.expected == "teacher"
    assert ei.value.actual is None


def test_assert_is_teacher_raises_on_empty_id():
    from shared.role_invariants import assert_is_teacher, RoleInvariantError
    with pytest.raises(RoleInvariantError):
        assert_is_teacher("")
