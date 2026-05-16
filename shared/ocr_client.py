"""
Document AI OCR — used ONLY for tertiary PDF/DOCX text extraction.

Handwriting on exercise-book photos is read directly by Gemma 4 in
gemma_client.grade_submission() — this module is NOT part of that pipeline.
"""

from __future__ import annotations

import logging

from google.cloud import documentai

from shared.config import settings

logger = logging.getLogger(__name__)


def extract_text(file_bytes: bytes, mime_type: str = "application/pdf") -> str:
    """
    Extracts plain text from a PDF or DOCX via Document AI.
    Returns empty string on error or if no processor is configured.
    """
    if not settings.DOCAI_PROCESSOR_ID:
        logger.warning("DOCAI_PROCESSOR_ID not set — skipping OCR")
        return ""

    try:
        client = documentai.DocumentProcessorServiceClient()
        name = client.processor_path(
            settings.GCP_PROJECT_ID,
            settings.DOCAI_PROCESSOR_LOCATION,
            settings.DOCAI_PROCESSOR_ID,
        )
        raw_doc = documentai.RawDocument(content=file_bytes, mime_type=mime_type)
        request = documentai.ProcessRequest(name=name, raw_document=raw_doc)
        result = client.process_document(request=request)
        return result.document.text
    except Exception:
        logger.exception("Document AI extract_text failed")
        return ""


def extract_text_with_boxes(file_bytes: bytes, mime_type: str = "image/jpeg") -> tuple[str, list[dict]]:
    """
    Extracts text + word-level bounding boxes from an image via Document AI.
    Used when pixel-accurate annotation is needed alongside Gemma grading.
    Returns (full_text, bounding_boxes) where bounding_boxes is a list of page dicts.
    """
    if not settings.DOCAI_PROCESSOR_ID:
        return "", []

    try:
        client = documentai.DocumentProcessorServiceClient()
        name = client.processor_path(
            settings.GCP_PROJECT_ID,
            settings.DOCAI_PROCESSOR_LOCATION,
            settings.DOCAI_PROCESSOR_ID,
        )
        raw_doc = documentai.RawDocument(content=file_bytes, mime_type=mime_type)
        request = documentai.ProcessRequest(name=name, raw_document=raw_doc)
        result = client.process_document(request=request)
        doc = result.document

        full_text = doc.text
        bounding_boxes: list[dict] = []

        for page in doc.pages:
            page_data: dict = {"page": page.page_number, "words": []}
            for token in page.tokens:
                verts = token.layout.bounding_poly.normalized_vertices
                segments = token.layout.text_anchor.text_segments
                token_text = "".join(
                    doc.text[int(s.start_index): int(s.end_index)]
                    for s in segments
                )
                if verts and token_text.strip():
                    page_data["words"].append({
                        "text": token_text.strip(),
                        "x": verts[0].x,
                        "y": verts[0].y,
                        "width": abs(verts[1].x - verts[0].x) if len(verts) > 1 else 0.0,
                        "height": abs(verts[2].y - verts[0].y) if len(verts) > 2 else 0.0,
                    })
            bounding_boxes.append(page_data)

        return full_text, bounding_boxes

    except Exception:
        logger.exception("Document AI extract_text_with_boxes failed")
        return "", []
