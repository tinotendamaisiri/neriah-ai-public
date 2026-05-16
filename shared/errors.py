"""
Typed error contract for Neriah backend.

Each NeriahError carries a stable error_code that the mobile app maps to
a user-facing message, plus a technical_detail for debugging logs.
Used in grading-critical paths only — non-blocking calls (tutor, etc) keep
their existing graceful-degrade behavior.
"""

from __future__ import annotations
import logging
from typing import Any

logger = logging.getLogger(__name__)


class NeriahError(Exception):
    http_status: int = 500
    error_code: str = "UNKNOWN_ERROR"
    user_message: str = "Something went wrong. Please try again."
    retryable: bool = True
    retry_after_seconds: int | None = None

    def __init__(self, technical_detail: str | None = None, **extra: Any):
        self.technical_detail = technical_detail or self.user_message
        self.extra = extra
        super().__init__(self.technical_detail)

    def to_response(self) -> dict:
        body: dict = {
            "error": self.user_message,
            "error_code": self.error_code,
            "retryable": self.retryable,
        }
        if self.retry_after_seconds is not None:
            body["retry_after"] = self.retry_after_seconds
        if self.technical_detail and self.technical_detail != self.user_message:
            body["technical"] = self.technical_detail[:500]
        if self.extra:
            body["detail"] = self.extra
        return body


# ─── Vertex AI errors ─────────────────────────────────────────────────────────

class VertexAITimeoutError(NeriahError):
    http_status = 504
    error_code = "VERTEX_AI_TIMEOUT"
    user_message = "The AI is warming up — this can take 30 seconds for the first grading. Please try again."
    retry_after_seconds = 30


class VertexAIQuotaError(NeriahError):
    http_status = 429
    error_code = "VERTEX_AI_QUOTA"
    user_message = "Grading service is at capacity. Please try again in a few minutes."
    retry_after_seconds = 300


class VertexAIAuthError(NeriahError):
    http_status = 500
    error_code = "VERTEX_AI_AUTH"
    user_message = "Grading service is misconfigured. Our team has been notified."
    retryable = False


class VertexAIUnavailableError(NeriahError):
    http_status = 503
    error_code = "VERTEX_AI_UNAVAILABLE"
    user_message = "Grading service is temporarily unavailable. Please try again in a moment."
    retry_after_seconds = 60


# ─── Storage errors ───────────────────────────────────────────────────────────

class StorageBucketMissingError(NeriahError):
    http_status = 500
    error_code = "STORAGE_BUCKET_MISSING"
    user_message = "Cannot save the marked image — storage is misconfigured. Our team has been notified."
    retryable = False


class StorageUploadError(NeriahError):
    http_status = 502
    error_code = "STORAGE_UPLOAD_FAILED"
    user_message = "Saved your grading but couldn't store the marked image. Please try again."
    retry_after_seconds = 10


# ─── Image errors ─────────────────────────────────────────────────────────────

class ImageTooLargeError(NeriahError):
    http_status = 413
    error_code = "IMAGE_TOO_LARGE"
    user_message = "That photo is too large. Retake the photo at lower resolution or crop to just the page."
    retryable = False


class ImageQualityRejectedError(NeriahError):
    http_status = 422
    error_code = "IMAGE_QUALITY_REJECTED"
    user_message = "The photo didn't pass the quality check."  # overridden per reason
    retryable = False


# ─── Grading errors ───────────────────────────────────────────────────────────

class GradingParseError(NeriahError):
    http_status = 502
    error_code = "GRADING_PARSE_FAILED"
    user_message = "The AI returned an unexpected response. Please try grading again — this usually works the second time."
    retry_after_seconds = 5


class GradingEmptyError(NeriahError):
    http_status = 422
    error_code = "GRADING_EMPTY"
    user_message = "The AI couldn't find any answers in this photo. Make sure the student's handwritten answers are clearly visible."
    retryable = False


class MarkingSchemeError(NeriahError):
    http_status = 400
    error_code = "NO_MARKING_SCHEME"
    user_message = "This homework doesn't have a marking scheme yet. Generate one first."
    retryable = False


class RateLimitError(NeriahError):
    http_status = 429
    error_code = "RATE_LIMIT"
    user_message = "You've reached today's marking limit. Please try again tomorrow."
    retry_after_seconds = 3600


class DuplicateSubmissionError(NeriahError):
    http_status = 409
    error_code = "DUPLICATE_SUBMISSION"
    user_message = "This student already has a graded submission for this homework. Do you want to replace it?"
    retryable = False


# ─── Classification helper for unknown exceptions ─────────────────────────────

def classify_vertex_exception(exc: Exception) -> NeriahError:
    """Map raw Vertex/HTTP exceptions to typed NeriahErrors."""
    import requests as _requests
    from google.api_core import exceptions as gcp_exc  # type: ignore

    tech = f"{type(exc).__name__}: {exc}"

    # google-api-core wrappers
    if isinstance(exc, gcp_exc.ResourceExhausted):
        return VertexAIQuotaError(tech)
    if isinstance(exc, gcp_exc.DeadlineExceeded):
        return VertexAITimeoutError(tech)
    if isinstance(exc, (gcp_exc.PermissionDenied, gcp_exc.Unauthenticated)):
        return VertexAIAuthError(tech)
    if isinstance(exc, (gcp_exc.ServiceUnavailable, gcp_exc.InternalServerError)):
        return VertexAIUnavailableError(tech)
    if isinstance(exc, gcp_exc.NotFound):
        # Storage 404 — bucket missing
        if "bucket" in str(exc).lower():
            return StorageBucketMissingError(tech)
        return VertexAIUnavailableError(tech)

    # raw requests exceptions (older Vertex client paths)
    if isinstance(exc, _requests.exceptions.Timeout):
        return VertexAITimeoutError(tech)
    if isinstance(exc, _requests.exceptions.HTTPError):
        status = getattr(exc.response, "status_code", None) if exc.response is not None else None
        if status == 429:
            return VertexAIQuotaError(tech)
        if status in (401, 403):
            return VertexAIAuthError(tech)
        if status == 413:
            return ImageTooLargeError(tech)
        if status and 500 <= status < 600:
            return VertexAIUnavailableError(tech)
    if isinstance(exc, _requests.exceptions.ConnectionError):
        return VertexAIUnavailableError(tech)

    # Catchall — preserves the actual exception class name
    err = NeriahError(tech)
    err.error_code = f"UNEXPECTED_{type(exc).__name__.upper()}"
    err.user_message = "Grading failed unexpectedly. Please try again, and let us know if it keeps happening."
    return err
