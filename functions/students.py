"""Student management endpoints."""

from __future__ import annotations

import csv
import io
import json
import logging

from flask import Blueprint, jsonify, request

from shared.auth import require_role
from shared.firestore_client import delete_doc, get_doc, query, upsert
from shared.gemma_client import _generate, _parse_json
from shared.models import Student
from shared.observability import instrument_route

logger = logging.getLogger(__name__)
students_bp = Blueprint("students", __name__)


def _teacher_owns_class(teacher_id: str, class_id: str) -> bool:
    from shared.firestore_client import get_doc as _get
    cls = _get("classes", class_id)
    return bool(cls and cls.get("teacher_id") == teacher_id)


@students_bp.get("/students")
@instrument_route("students.list", "students")
def list_students():
    teacher_id, err = require_role(request, "teacher")
    if err:
        return jsonify({"error": err}), 401

    class_id = request.args.get("class_id", "").strip()
    if not class_id:
        return jsonify({"error": "class_id query param is required"}), 400

    if not _teacher_owns_class(teacher_id, class_id):
        return jsonify({"error": "forbidden"}), 403

    results = query("students", [("class_id", "==", class_id)], order_by="created_at")
    return jsonify(results), 200


@students_bp.post("/students")
@instrument_route("students.create", "students")
def create_student():
    teacher_id, err = require_role(request, "teacher")
    if err:
        return jsonify({"error": err}), 401

    body = request.get_json(silent=True) or {}
    class_id = (body.get("class_id") or "").strip()
    first_name = (body.get("first_name") or "").strip()
    surname = (body.get("surname") or "").strip()

    if not class_id or not first_name or not surname:
        return jsonify({"error": "class_id, first_name, and surname are required"}), 400

    if not _teacher_owns_class(teacher_id, class_id):
        return jsonify({"error": "forbidden"}), 403

    student = Student(
        class_id=class_id,
        first_name=first_name,
        surname=surname,
        register_number=body.get("register_number"),
        phone=body.get("phone"),
    )
    upsert("students", student.id, student.model_dump())

    # Increment class student count
    cls = get_doc("classes", class_id)
    if cls:
        upsert("classes", class_id, {"student_count": cls.get("student_count", 0) + 1})

    return jsonify(student.model_dump()), 201


@students_bp.post("/students/batch")
@instrument_route("students.batch", "students")
def create_students_batch():
    teacher_id, err = require_role(request, "teacher")
    if err:
        return jsonify({"error": err}), 401

    body = request.get_json(silent=True) or {}
    class_id = (body.get("class_id") or "").strip()

    if not class_id:
        return jsonify({"error": "class_id is required"}), 400

    if not _teacher_owns_class(teacher_id, class_id):
        return jsonify({"error": "forbidden"}), 403

    created = []

    # Rich format: students=[{first_name, surname, register_number, phone}, ...]
    if "students" in body:
        for row in body["students"]:
            first = (row.get("first_name") or "").strip()
            if not first:
                continue
            sur = (row.get("surname") or "").strip()
            reg = (row.get("register_number") or "").strip() or None
            phone = (row.get("phone") or "").strip() or None
            student = Student(class_id=class_id, first_name=first, surname=sur,
                              register_number=reg, phone=phone)
            upsert("students", student.id, student.model_dump())
            created.append(student.model_dump())
    # Legacy format: names=["First Surname", ...]
    elif "names" in body:
        for raw_name in body["names"]:
            parts = str(raw_name).strip().split(None, 1)
            first = parts[0] if parts else str(raw_name).strip()
            sur = parts[1] if len(parts) > 1 else first  # single name → use as both
            if not first:
                continue
            student = Student(class_id=class_id, first_name=first, surname=sur)
            upsert("students", student.id, student.model_dump())
            created.append(student.model_dump())
    else:
        return jsonify({"error": "students or names array is required"}), 400

    if created:
        cls = get_doc("classes", class_id)
        if cls:
            upsert("classes", class_id, {"student_count": cls.get("student_count", 0) + len(created)})

    return jsonify({"created": len(created), "students": created}), 201


@students_bp.put("/students/<student_id>")
@instrument_route("students.update", "students")
def update_student(student_id: str):
    teacher_id, err = require_role(request, "teacher")
    if err:
        return jsonify({"error": err}), 401

    student = get_doc("students", student_id)
    if not student:
        return jsonify({"error": "Student not found"}), 404
    if not _teacher_owns_class(teacher_id, student["class_id"]):
        return jsonify({"error": "forbidden"}), 403

    body = request.get_json(silent=True) or {}
    allowed = {"first_name", "surname", "register_number", "phone"}
    updates = {k: v for k, v in body.items() if k in allowed}
    if not updates:
        return jsonify({"error": "No updatable fields"}), 400

    upsert("students", student_id, updates)
    return jsonify({**student, **updates}), 200


@students_bp.delete("/students/<student_id>")
@instrument_route("students.delete", "students")
def delete_student(student_id: str):
    teacher_id, err = require_role(request, "teacher")
    if err:
        return jsonify({"error": err}), 401

    student = get_doc("students", student_id)
    if not student:
        return jsonify({"error": "Student not found"}), 404
    if not _teacher_owns_class(teacher_id, student["class_id"]):
        return jsonify({"error": "forbidden"}), 403

    delete_doc("students", student_id)

    cls = get_doc("classes", student["class_id"])
    if cls and cls.get("student_count", 0) > 0:
        upsert("classes", student["class_id"], {"student_count": cls["student_count"] - 1})

    return jsonify({"message": "deleted"}), 200


# ── Roster extraction helpers ─────────────────────────────────────────────────

_EXTRACT_PROMPT = (
    "Extract all student names from this class register. "
    "Return ONLY a JSON array with no markdown fences:\n"
    '[{"first_name": "...", "surname": "...", "register_number": "..." or null, "phone": "..." or null}]\n'
    "Use null for any field that is not present. Return raw JSON only."
)


def _gemma_extract_students(text: str | None = None, image_bytes: bytes | None = None) -> list[dict]:
    """Call Gemma 4 to extract student rows. Returns list of dicts, never raises."""
    try:
        raw = _generate(_EXTRACT_PROMPT, image_bytes=image_bytes, complexity="complex")
        parsed = _parse_json(raw, [])
        if not isinstance(parsed, list):
            return []
        out = []
        for item in parsed:
            if not isinstance(item, dict):
                continue
            fn = (item.get("first_name") or "").strip()
            if not fn:
                continue
            out.append({
                "first_name": fn,
                "surname": (item.get("surname") or "").strip(),
                "register_number": (item.get("register_number") or None),
                "phone": (item.get("phone") or None),
            })
        return out
    except Exception:
        logger.exception("_gemma_extract_students failed")
        return []


def _read_spreadsheet_rows(file_bytes: bytes, filename: str) -> list[dict]:
    """Parse xlsx or csv bytes into student dicts. Returns list, never raises."""
    try:
        ext = filename.rsplit(".", 1)[-1].lower()
        rows: list[dict] = []

        if ext == "csv":
            text = file_bytes.decode("utf-8-sig", errors="replace")
            reader = csv.DictReader(io.StringIO(text))
            for raw_row in reader:
                # Normalise keys to lowercase with underscores
                row = {k.strip().lower().replace(" ", "_"): (v or "").strip() for k, v in raw_row.items()}
                fn = row.get("first_name") or row.get("firstname") or row.get("name") or ""
                if not fn:
                    continue
                rows.append({
                    "first_name": fn,
                    "surname": row.get("surname") or row.get("last_name") or "",
                    "register_number": row.get("register_number") or row.get("reg_no") or row.get("reg") or None,
                    "phone": row.get("phone") or row.get("phone_number") or None,
                })

        elif ext in ("xlsx", "xls"):
            import openpyxl  # optional dep
            wb = openpyxl.load_workbook(io.BytesIO(file_bytes), read_only=True, data_only=True)
            ws = wb.active
            headers: list[str] = []
            for i, raw_row in enumerate(ws.iter_rows(values_only=True)):
                if i == 0:
                    headers = [str(c or "").strip().lower().replace(" ", "_") for c in raw_row]
                    continue
                row = dict(zip(headers, [str(c or "").strip() for c in raw_row]))
                fn = row.get("first_name") or row.get("firstname") or row.get("name") or ""
                if not fn:
                    continue
                rows.append({
                    "first_name": fn,
                    "surname": row.get("surname") or row.get("last_name") or "",
                    "register_number": row.get("register_number") or row.get("reg_no") or row.get("reg") or None,
                    "phone": row.get("phone") or row.get("phone_number") or None,
                })

        return rows
    except Exception:
        logger.exception("_read_spreadsheet_rows failed")
        return []


def _extract_text_from_file(file_bytes: bytes, filename: str) -> str:
    """Extract plain text from PDF or DOCX. Returns empty string on failure."""
    try:
        ext = filename.rsplit(".", 1)[-1].lower()
        if ext == "pdf":
            import pdfplumber
            with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
                return "\n".join(page.extract_text() or "" for page in pdf.pages)
        elif ext in ("docx", "doc"):
            from docx import Document
            doc = Document(io.BytesIO(file_bytes))
            return "\n".join(p.text for p in doc.paragraphs)
    except Exception:
        logger.exception("_extract_text_from_file failed")
    return ""


# ── Extraction endpoints ──────────────────────────────────────────────────────

@students_bp.post("/students/extract-from-image")
@instrument_route("students.extract_from_image", "students")
def extract_students_from_image():
    """Extract student roster from a class register photo using Gemma 4."""
    _, err = require_role(request, "teacher")
    if err:
        return jsonify({"error": err}), 401

    if "image" not in request.files:
        return jsonify({"error": "image file is required"}), 400

    file = request.files["image"]
    image_bytes = file.read()
    if not image_bytes:
        return jsonify({"error": "Empty file"}), 400

    students = _gemma_extract_students(image_bytes=image_bytes)
    return jsonify({"students": students, "count": len(students)}), 200


@students_bp.post("/students/extract-from-file")
@instrument_route("students.extract_from_file", "students")
def extract_students_from_file():
    """Extract student roster from xlsx, csv, pdf, or docx."""
    _, err = require_role(request, "teacher")
    if err:
        return jsonify({"error": err}), 401

    if "file" not in request.files:
        return jsonify({"error": "file is required"}), 400

    file = request.files["file"]
    filename = (file.filename or "upload.bin").lower()
    file_bytes = file.read()
    if not file_bytes:
        return jsonify({"error": "Empty file"}), 400

    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""

    if ext in ("xlsx", "xls", "csv"):
        students = _read_spreadsheet_rows(file_bytes, filename)
    elif ext in ("pdf", "docx", "doc"):
        text = _extract_text_from_file(file_bytes, filename)
        # Fall back to Gemma for unstructured text docs
        students = _gemma_extract_students(text=text)
    else:
        return jsonify({"error": f"Unsupported file type: .{ext}"}), 400

    return jsonify({"students": students, "count": len(students)}), 200
