from __future__ import annotations

import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field, field_validator


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _uid() -> str:
    return str(uuid.uuid4())


# ─── Enumerations ─────────────────────────────────────────────────────────────

class EducationLevel(str, Enum):
    GRADE_1 = "Grade 1"
    GRADE_2 = "Grade 2"
    GRADE_3 = "Grade 3"
    GRADE_4 = "Grade 4"
    GRADE_5 = "Grade 5"
    GRADE_6 = "Grade 6"
    GRADE_7 = "Grade 7"
    FORM_1 = "Form 1"
    FORM_2 = "Form 2"
    FORM_3 = "Form 3"
    FORM_4 = "Form 4"
    FORM_5 = "Form 5 (A-Level)"
    FORM_6 = "Form 6 (A-Level)"
    COLLEGE = "College/University"


class MarkSource(str, Enum):
    TEACHER_SCAN = "teacher_scan"
    # Set when /api/mark received pre_graded_verdicts from a mobile teacher
    # who graded the submission offline on-device (LiteRT-LM E2B). Backend
    # skips the cloud grading call entirely and persists the teacher's
    # verdicts as the canonical record. Useful in analytics to distinguish
    # accuracy-tier sources.
    TEACHER_SCAN_OFFLINE = "teacher_scan_offline"
    STUDENT_SUBMISSION = "student_submission"
    # Student submitted homework via WhatsApp inbound. Distinguished from
    # STUDENT_SUBMISSION (in-app upload) so the approval dispatcher knows
    # to send the result back through WhatsApp once the teacher approves.
    STUDENT_WHATSAPP = "student_whatsapp"
    # Student emailed homework to mark@neriah.ai (Zoho IMAP poller). Same
    # downstream grading; approval dispatcher replies via Resend with the
    # annotated image attached.
    EMAIL_SUBMISSION = "email_submission"


class WhatsAppState(str, Enum):
    IDLE = "IDLE"
    CLASS_SETUP = "CLASS_SETUP"
    AWAITING_REGISTER = "AWAITING_REGISTER"
    AWAITING_ANSWER_KEY = "AWAITING_ANSWER_KEY"
    MARKING_ACTIVE = "MARKING_ACTIVE"
    ERROR = "ERROR"
    # Role-pick gate for unknown phones — no app actions until the user
    # has identified themselves as teacher or student.
    REGISTER_ROLE_PICK = "REGISTER_ROLE_PICK"
    # Teacher self-registration flow
    TEACHER_ONBOARDING_NAME = "TEACHER_ONBOARDING_NAME"
    TEACHER_ONBOARDING_SCHOOL = "TEACHER_ONBOARDING_SCHOOL"
    TEACHER_ONBOARDING_CONFIRM = "TEACHER_ONBOARDING_CONFIRM"
    # Student self-registration flow
    STUDENT_ONBOARDING_SCHOOL = "STUDENT_ONBOARDING_SCHOOL"
    STUDENT_ONBOARDING_CLASS = "STUDENT_ONBOARDING_CLASS"
    STUDENT_ONBOARDING_LEVEL = "STUDENT_ONBOARDING_LEVEL"
    STUDENT_ONBOARDING_NAME = "STUDENT_ONBOARDING_NAME"
    STUDENT_ONBOARDING_CONFIRM = "STUDENT_ONBOARDING_CONFIRM"


# ─── Domain models ────────────────────────────────────────────────────────────

class Teacher(BaseModel):
    id: str = Field(default_factory=_uid)
    phone: str
    name: str
    title: Optional[str] = None
    school_name: Optional[str] = None
    school_id: Optional[str] = None
    created_at: str = Field(default_factory=lambda: _now().isoformat())
    token_version: int = 0
    pin_hash: Optional[str] = None
    pin_attempts: int = 0
    pin_locked: bool = False
    role: str = "teacher"
    # Consent for training data collection (default on, opt-out available in Settings)
    training_data_consent: bool = True


class Student(BaseModel):
    id: str = Field(default_factory=_uid)
    class_id: str
    class_ids: list[str] = []
    first_name: str
    surname: str
    register_number: Optional[str] = None
    phone: Optional[str] = None
    # Sender address from email-channel submissions. Used so the second
    # email from the same student short-circuits the fuzzy name match and
    # routes straight to this record. Populated on auto-enroll from the
    # email poller; can also be set manually by a teacher.
    email: Optional[str] = None
    created_at: str = Field(default_factory=lambda: _now().isoformat())
    role: str = "student"
    token_version: int = 0


class Class(BaseModel):
    id: str = Field(default_factory=_uid)
    teacher_id: str
    name: str
    education_level: str
    curriculum: str = "zimsec"
    school_id: Optional[str] = None
    join_code: str = Field(default_factory=lambda: str(uuid.uuid4())[:6].upper())
    student_count: int = 0
    created_at: str = Field(default_factory=lambda: _now().isoformat())


class AnswerKeyQuestion(BaseModel):
    question_number: int
    question_text: str
    answer: str
    marks: float
    marking_notes: Optional[str] = None


class AnswerKey(BaseModel):
    id: str = Field(default_factory=_uid)
    class_id: str
    teacher_id: str
    title: str
    education_level: str = ""
    subject: Optional[str] = None
    questions: list[AnswerKeyQuestion] = []
    total_marks: float = 0.0
    open_for_submission: bool = False
    generated: bool = False
    status: Optional[str] = None  # None = ready, "draft" = awaiting teacher review, "pending_setup" = unlabeled
    question_paper_text: Optional[str] = None  # stored for server-side regeneration
    due_date: Optional[str] = None
    # Short, easy-to-share code printed on the slip teachers hand out so
    # students can email submissions to mark@neriah.ai with a subject of
    # "Name: Alice | Code: HW7K2P". Code uniquely identifies the homework,
    # which gives the email poller class + school + answer key in one
    # Firestore lookup — no fuzzy school/class matching needed when the
    # student copies the code correctly. Generated on create with retry
    # on collision; intentionally NOT given a default_factory here so a
    # legacy AnswerKey reloaded from Firestore without this field stays
    # empty (the poller falls back to the fuzzy path) instead of getting
    # a fresh code on every load that wouldn't match anything.
    submission_code: Optional[str] = None
    created_at: str = Field(default_factory=lambda: _now().isoformat())


class GradingVerdict(BaseModel):
    question_number: int
    student_answer: str
    expected_answer: str
    verdict: str  # "correct" | "incorrect" | "partial"
    awarded_marks: float
    max_marks: float
    feedback: Optional[str] = None


class Mark(BaseModel):
    id: str = Field(default_factory=_uid)
    student_id: str
    class_id: str
    answer_key_id: str
    teacher_id: str
    score: float
    max_score: float
    percentage: float
    verdicts: list[GradingVerdict] = []
    marked_image_url: Optional[str] = None  # legacy singular — == annotated_urls[0]
    source: str = MarkSource.TEACHER_SCAN
    approved: bool = True
    timestamp: str = Field(default_factory=lambda: _now().isoformat())
    # Multi-page fields (2026-04-22). Single-page submissions still work:
    # page_count=1 and both arrays have one element.
    page_count: int = 1
    page_urls: list[str] = []        # signed URLs to originals, one per page
    annotated_urls: list[str] = []   # signed URLs to annotated pages, same order


class Session(BaseModel):
    """WhatsApp conversation state."""
    id: str  # == phone
    phone: str
    state: str = WhatsAppState.IDLE
    context: dict = {}
    updated_at: str = Field(default_factory=lambda: _now().isoformat())


class OTPVerification(BaseModel):
    id: str  # == phone
    phone: str
    otp_hash: str  # SHA-256 hex
    attempts: int = 0
    created_at: str = Field(default_factory=lambda: _now().isoformat())


# ─── Tertiary models ──────────────────────────────────────────────────────────

class RubricCriterion(BaseModel):
    id: str
    name: str
    description: str
    marks: float
    levels: dict[str, str] = {}  # {"Distinction": "...", "Merit": "...", ...}


class Rubric(BaseModel):
    id: str = Field(default_factory=_uid)
    class_id: str
    teacher_id: str
    title: str
    education_level: str
    total_marks: float = 100.0
    criteria: list[RubricCriterion] = []
    created_at: str = Field(default_factory=lambda: _now().isoformat())


class Submission(BaseModel):
    id: str = Field(default_factory=_uid)
    student_id: str
    class_id: str
    teacher_id: str
    rubric_id: str
    file_url: str
    extracted_text: Optional[str] = None
    verdicts: list[dict] = []
    score: float = 0.0
    max_score: float = 100.0
    approved: bool = False
    submitted_at: str = Field(default_factory=lambda: _now().isoformat())


# ─── Response helpers ─────────────────────────────────────────────────────────

class ImageQualityResult(BaseModel):
    pass_check: bool = Field(alias="pass")
    reason: str
    suggestion: str

    model_config = {"populate_by_name": True}


# ─── Neriah Play models ───────────────────────────────────────────────────────

class PlayQuestion(BaseModel):
    """A single multiple-choice question used by the Play arcade modes.

    Constraints (validated below):
      - prompt:  ≤ 80 characters (longer prompts overflow the in-game cards
                 across all four formats: lane runner, stacker, blaster, snake).
      - options: exactly 4 entries, each ≤ 25 characters.
      - correct: integer index in [0, 3] pointing into ``options``.
    """

    prompt: str
    options: list[str]
    correct: int

    @field_validator("prompt")
    @classmethod
    def _prompt_under_80(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError("prompt must not be empty")
        if len(v) > 80:
            raise ValueError(f"prompt must be ≤ 80 characters, got {len(v)}")
        return v

    @field_validator("options")
    @classmethod
    def _exactly_four_options(cls, v: list[str]) -> list[str]:
        if not isinstance(v, list) or len(v) != 4:
            raise ValueError("options must be a list of exactly 4 strings")
        cleaned: list[str] = []
        for i, opt in enumerate(v):
            opt = (opt or "").strip()
            if not opt:
                raise ValueError(f"options[{i}] must not be empty")
            if len(opt) > 25:
                raise ValueError(
                    f"options[{i}] must be ≤ 25 characters, got {len(opt)}"
                )
            cleaned.append(opt)
        return cleaned

    @field_validator("correct")
    @classmethod
    def _correct_index(cls, v: int) -> int:
        if not isinstance(v, int) or v < 0 or v > 3:
            raise ValueError("correct must be an integer in [0, 3]")
        return v


class PlayLesson(BaseModel):
    """A bank of MCQs generated from teacher- or student-supplied source
    content. Owned by a student; can be optionally shared with their class.

    Every saved lesson has exactly 100 questions — the generator runs in a
    single pass with same-domain auto-expansion until the target is hit.
    There is no draft state.
    """

    id: str = Field(default_factory=_uid)
    title: str
    subject: Optional[str] = None
    grade: Optional[str] = None
    owner_id: str
    owner_role: str = "student"
    source_content: str
    questions: list[PlayQuestion] = []
    question_count: int
    # Lifecycle: 'generating' (worker still building the bank), 'ready' (full
    # 100 questions saved), 'failed' (worker raised — payload includes
    # error_message). Default 'ready' so legacy rows stay valid.
    status: str = "ready"
    error_message: Optional[str] = None
    was_expanded: bool = False  # generator auto-augmented broader-topic content
    recommended: bool = False  # weakness-driven "Recommended for me" lesson
    created_at: str = Field(default_factory=lambda: _now().isoformat())
    shared_with_class: bool = False
    allow_copying: bool = False
    class_id: Optional[str] = None


class PlaySession(BaseModel):
    """Outcome of a single Play attempt by a student against a lesson.

    ``game_format`` is the arcade mode the student chose. ``end_reason``
    distinguishes a natural loss from completing the bank or quitting early
    so leaderboards / completion analytics stay clean.
    """

    id: str = Field(default_factory=_uid)
    lesson_id: str
    player_id: str
    game_format: str
    started_at: str
    ended_at: str
    duration_seconds: int
    final_score: int
    questions_attempted: int
    questions_correct: int
    end_reason: str

    @field_validator("game_format")
    @classmethod
    def _valid_format(cls, v: str) -> str:
        allowed = {"lane_runner", "stacker", "blaster", "snake"}
        if v not in allowed:
            raise ValueError(f"game_format must be one of {sorted(allowed)}")
        return v

    @field_validator("end_reason")
    @classmethod
    def _valid_end_reason(cls, v: str) -> str:
        allowed = {"loss_condition", "completed", "quit"}
        if v not in allowed:
            raise ValueError(f"end_reason must be one of {sorted(allowed)}")
        return v
