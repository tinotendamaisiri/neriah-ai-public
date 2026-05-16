"""
Shared helper for decoding chat-attached files (image / PDF / Word).

Used by both the teacher assistant and the student tutor so file-handling
behaviour stays consistent: the same MIME types are accepted, the same
extraction libraries are used, and failures degrade the same way.
"""

from __future__ import annotations

import base64
import io
import logging

logger = logging.getLogger(__name__)


def extract_file_text(file_data: str, media_type: str) -> tuple[bytes | None, str]:
    """
    Decode a base64-encoded file attachment.

    Returns ``(image_bytes, extracted_text)``:
    - For images: ``(bytes, "")`` — caller passes bytes to multimodal model.
    - For PDF / Word: ``(None, text)`` — caller appends text to the prompt.
    - On any decode/extraction error: ``(None, "")``.

    The function never raises — extraction failures are logged and degrade
    silently so the chat turn can still proceed without the attachment.
    """
    try:
        raw = base64.b64decode(file_data)
    except Exception:
        logger.warning("file_attachments: could not base64-decode file_data")
        return None, ""

    if media_type == "image":
        return raw, ""

    if media_type == "pdf":
        try:
            import pdfplumber  # noqa: PLC0415
            with pdfplumber.open(io.BytesIO(raw)) as pdf:
                pages = [p.extract_text() or "" for p in pdf.pages[:20]]
            return None, "\n\n".join(p for p in pages if p).strip()
        except Exception:
            logger.warning("file_attachments: PDF text extraction failed")
            return None, ""

    if media_type == "word":
        try:
            import docx  # noqa: PLC0415
            doc = docx.Document(io.BytesIO(raw))
            text = "\n".join(p.text for p in doc.paragraphs if p.text.strip())
            return None, text.strip()
        except Exception:
            logger.warning("file_attachments: Word text extraction failed")
            return None, ""

    return None, ""
