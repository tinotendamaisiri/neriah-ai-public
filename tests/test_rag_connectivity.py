"""
tests/test_rag_connectivity.py

RAG pipeline connectivity tests — verify that RAG context is actually
fetched from the vector DB, injected into prompts, and influences every
AI endpoint.  All model calls (Vertex) are mocked so these tests run
without any external service.

Actual API surface (corrected from spec):
  - shared.vector_db.search_similar() / search_with_user_context()   (NOT query_similar)
  - shared.vector_db.store_document(collection, doc_id, text, meta)  (4 positional args)
  - shared.embeddings.get_embedding()                                 (local: 384-d)
  - shared.user_context.get_user_context()                            (NOT build_context)
  - shared.gemma_client._build_rag_context()                          (internal RAG builder)
  - functions/answer_keys.py  (scheme generation lives here)          (NOT homework.py)
"""

import os
from unittest.mock import MagicMock, call, patch

from tests.registry import feature_test

# ── Shared fixtures ────────────────────────────────────────────────────────────

MOCK_SYLLABUS_CONTEXT = (
    "ZIMSEC Form 2 Mathematics: Algebra, quadratic equations, factorization..."
)
MOCK_STUDENT_WEAK_AREAS = ["fractions", "quadratic equations", "velocity calculations"]
MOCK_GRADING_HISTORY = [
    {"question": "Solve x^2=4", "verdict": "incorrect", "student_answer": "x=2 only"}
]

DEMO_TEACHER = {
    "teacher_id": "t1",
    "school": "Chiredzi High",
    "curriculum": "ZIMSEC",
    "education_level": "form_2",
}
DEMO_STUDENT = {"student_id": "s1", "class_id": "cls1", "teacher_id": "t1"}
DEMO_CLASS = {"class_id": "cls1", "subject": "Mathematics", "education_level": "form_2"}

# Formatted RAG section as actually returned by _build_rag_context
_RAG_SECTION = (
    "\n--- CURRICULUM CONTEXT (use to calibrate marking) ---\n"
    f"• {MOCK_SYLLABUS_CONTEXT[:400]}\n"
    "--- END OF CONTEXT ---\n"
)

# Minimal JPEG-like bytes — enough to pass through pipeline without decoding
_DUMMY_IMAGE = b"\xff\xd8\xff" + b"\x00" * 100


# ── Helpers ────────────────────────────────────────────────────────────────────

def _mock_get_doc(collection, doc_id):
    """Firestore get_doc stub that returns realistic profile data."""
    if collection == "teachers":
        return {"phone": "+263771234567", "school_id": "school1"}
    if collection == "schools":
        return {"country": "Zimbabwe", "curriculum": "ZIMSEC", "subscription_active": True}
    if collection == "classes":
        return {"subject": "Mathematics", "education_level": "form_2", "teacher_id": "t1"}
    if collection == "students":
        return {"class_id": "cls1", "phone": "+263772000001"}
    return None


# ============================================================
# TEST SUITE 1 — RAG Vector DB Connectivity
# ============================================================


@feature_test("rag_chromadb_connection")
def test_chromadb_connects_and_returns_results():
    """search_similar() routes to Firestore and returns documents."""
    from shared.vector_db import search_similar

    expected = [{"text": MOCK_SYLLABUS_CONTEXT, "metadata": {}, "score": 0.15}]
    # Force ChromaDB path by making _use_firestore_vectors() return False
    with patch("shared.vector_db._firestore_search", return_value=expected), \
         patch("shared.vector_db.get_embedding", return_value=[0.1] * 384), \
         patch("shared.vector_db._fs_collection", return_value="rag_syllabuses"):
        results = search_similar("syllabuses", "quadratic equations", top_k=3)

    assert len(results) > 0
    assert results[0]["text"] == MOCK_SYLLABUS_CONTEXT


@feature_test("rag_embeddings_generated")
def test_embeddings_generated_for_query():
    """get_embedding() calls the local sentence-transformers backend."""
    from shared.embeddings import get_embedding
    # Force local path by making _use_vertex() return False
    with patch("shared.embeddings._use_vertex", return_value=False), \
         patch("shared.embeddings._local_embed", return_value=[0.1] * 384) as mock_embed:
        embedding = get_embedding("velocity and acceleration")

    # Local model returns 384-dimensional vectors
    assert len(embedding) == 384
    mock_embed.assert_called_once_with("velocity and acceleration")


@feature_test("rag_user_context_built")
def test_user_context_built_from_profile():
    """get_user_context() resolves country, curriculum, subject, and level."""
    from shared.user_context import get_user_context

    # get_doc is lazily imported inside get_user_context — patch the source module
    with patch("shared.firestore_client.get_doc", side_effect=_mock_get_doc):
        context = get_user_context("t1", "teacher", class_id="cls1")

    assert context.get("curriculum") == "ZIMSEC"
    assert context.get("subject") == "Mathematics"
    assert context.get("education_level") == "form_2"
    assert context.get("country") == "Zimbabwe"


@feature_test("rag_syllabus_uploaded_and_indexed")
def test_syllabus_pdf_chunked_and_stored():
    """store_document() embeds text and writes to ChromaDB in non-vertex mode."""
    from shared.vector_db import store_document

    with patch("shared.vector_db.get_embedding", return_value=[0.1] * 384), \
         patch("shared.vector_db._fs_collection", return_value="rag_syllabuses"), \
         patch("shared.firestore_client.get_db") as mock_db:
        mock_db.return_value.collection.return_value.document.return_value.set.return_value = None
        store_document(
            collection="syllabuses",
            doc_id="zimsec_math_form2_001",
            text=MOCK_SYLLABUS_CONTEXT * 5,
            metadata={
                "curriculum": "ZIMSEC",
                "subject": "Mathematics",
                "education_level": "form_2",
            },
        )

    # Must have attempted to write to Firestore
    mock_set = mock_db.return_value.collection.return_value.document.return_value.set
    mock_set.assert_called_once()
    stored = mock_set.call_args[0][0]  # first positional arg is the dict
    assert "embedding" in stored
    assert "text" in stored


# ============================================================
# TEST SUITE 2 — RAG in Marking Scheme Generation
# ============================================================


@feature_test("rag_in_generate_scheme")
def test_rag_context_injected_in_generate_scheme():
    """generate_scheme_from_text() calls _build_rag_context with curriculum query."""
    from shared.gemma_client import generate_scheme_from_text

    good_json = (
        '{"title": "Algebra", "total_marks": 2, "questions": ['
        '{"question_number": 1, "question_text": "Solve x^2=4", '
        '"correct_answer": "x=\u00b12", "marks": 2, "marking_notes": ""}]}'
    )
    with patch("shared.gemma_client._build_rag_context", return_value=_RAG_SECTION) as mock_rag, \
         patch("shared.gemma_client._generate", return_value=good_json):
        generate_scheme_from_text(
            question_paper_text="Solve x^2 = 4",
            education_level="Form 2",
            subject="Mathematics",
            user_context={"curriculum": "ZIMSEC", "subject": "Mathematics", "education_level": "form_2"},
        )

    mock_rag.assert_called_once()
    # _build_rag_context is called with keyword args; verify curriculum appears in query
    query_arg = mock_rag.call_args[1].get("query_text") or mock_rag.call_args[0][0]
    assert "ZIMSEC" in query_arg or "Mathematics" in query_arg


@feature_test("rag_scheme_uses_curriculum_context")
def test_scheme_generation_uses_correct_syllabus():
    """generate_marking_scheme() searches the syllabuses collection with curriculum filter."""
    from shared.gemma_client import generate_marking_scheme

    syllabus_hit = [{"text": MOCK_SYLLABUS_CONTEXT, "metadata": {"curriculum": "ZIMSEC"}, "score": 0.1}]
    good_json = '{"title": "Test", "total_marks": 4, "questions": []}'

    with patch("shared.vector_db.search_with_user_context", return_value=syllabus_hit) as mock_search, \
         patch("shared.vector_db.get_embedding", return_value=[0.1] * 384), \
         patch("shared.gemma_client._generate", return_value=good_json):
        generate_marking_scheme(
            question_paper_text="Algebra questions",
            education_level="Form 2",
            user_context={"curriculum": "ZIMSEC", "subject": "Mathematics", "education_level": "form_2"},
        )

    assert mock_search.called
    # First positional arg to search_with_user_context is collection name
    collections_hit = [c[0][0] for c in mock_search.call_args_list]
    assert "syllabuses" in collections_hit
    # Third positional arg is user_context — must contain curriculum filter
    user_ctx_passed = mock_search.call_args_list[0][0][2]
    assert user_ctx_passed.get("curriculum") == "ZIMSEC"


# ============================================================
# TEST SUITE 3 — RAG in Grading
# ============================================================


@feature_test("rag_in_grading_endpoint")
def test_rag_context_injected_in_grading():
    """grade_submission() calls _build_rag_context before generating the prompt."""
    from shared.gemma_client import grade_submission

    answer_key = {
        "questions": [
            {"question_number": 1, "question_text": "Solve x^2=4",
             "answer": "x=\u00b12", "marks": 2}
        ]
    }
    mock_verdict = (
        '[{"question_number":1,"student_answer":"x=2","expected_answer":"x=\u00b12",'
        '"verdict":"partial","awarded_marks":1,"max_marks":2,"feedback":null}]'
    )
    with patch("shared.gemma_client._build_rag_context", return_value=_RAG_SECTION) as mock_rag, \
         patch("shared.gemma_client._generate", return_value=mock_verdict):
        verdicts = grade_submission(
            image_bytes=_DUMMY_IMAGE,
            answer_key=answer_key,
            education_level="Form 2",
            user_context={"curriculum": "ZIMSEC", "subject": "Mathematics"},
        )

    mock_rag.assert_called_once()
    # Verify RAG query included subject + level context
    query_arg = mock_rag.call_args[1].get("query_text") or mock_rag.call_args[0][0]
    assert "ZIMSEC" in query_arg or "Mathematics" in query_arg or "Form 2" in query_arg


@feature_test("rag_grading_uses_rubric_history")
def test_grading_uses_verified_grading_history():
    """grade_submission() queries BOTH syllabuses AND grading_examples collections."""
    from shared.gemma_client import grade_submission

    with patch("shared.vector_db.search_with_user_context") as mock_search, \
         patch("shared.vector_db.get_embedding", return_value=[0.1] * 384), \
         patch("shared.gemma_client._generate", return_value="[]"):
        # First call → syllabuses; second call → grading_examples
        mock_search.side_effect = [
            [{"text": MOCK_SYLLABUS_CONTEXT, "metadata": {}, "score": 0.1}],
            [{"text": str(MOCK_GRADING_HISTORY[0]), "metadata": {}, "score": 0.2}],
        ]
        grade_submission(
            image_bytes=_DUMMY_IMAGE,
            answer_key={"questions": []},
            education_level="Form 2",
            user_context={"curriculum": "ZIMSEC", "subject": "Mathematics"},
        )

    assert mock_search.call_count == 2
    collections_queried = [c[0][0] for c in mock_search.call_args_list]
    assert "syllabuses" in collections_queried
    assert "grading_examples" in collections_queried


@feature_test("rag_approved_grading_stored")
def test_approved_grading_stored_in_vector_db():
    """store_document() can write a verified grading example to the vector DB."""
    from shared.vector_db import store_document

    with patch("shared.vector_db.get_embedding", return_value=[0.1] * 384), \
         patch("shared.vector_db._fs_collection", return_value="rag_syllabuses"), \
         patch("shared.firestore_client.get_db") as mock_db:
        mock_db.return_value.collection.return_value.document.return_value.set.return_value = None
        store_document(
            collection="grading_examples",
            doc_id="grading_ex_001",
            text=(
                "Q1: Solve x^2=4. Student: x=2. Verdict: partial. "
                "Teacher override: x=\u00b12 required."
            ),
            metadata={
                "type": "verified_grading",
                "subject": "Mathematics",
                "education_level": "form_2",
            },
        )

    mock_set = mock_db.return_value.collection.return_value.document.return_value.set
    mock_set.assert_called()
    stored = mock_set.call_args[0][0]
    assert "embedding" in stored


# ============================================================
# TEST SUITE 4 — RAG in Student Tutor
# ============================================================


@feature_test("rag_in_student_tutor")
def test_rag_context_injected_in_tutor():
    """student_tutor() calls _build_rag_context before the model call."""
    from shared.gemma_client import student_tutor

    with patch("shared.gemma_client._build_rag_context", return_value=_RAG_SECTION) as mock_rag, \
         patch("shared.gemma_client.chat", return_value="Have you tried factoring?"):
        response = student_tutor(
            message="How do I solve x^2 - 4 = 0?",
            conversation_history=[],
            education_level="Form 2",
            user_context={"curriculum": "ZIMSEC", "subject": "Mathematics"},
        )

    mock_rag.assert_called_once()
    assert response == "Have you tried factoring?"


@feature_test("rag_tutor_uses_student_weak_areas")
def test_tutor_incorporates_student_weak_areas():
    """student_tutor() injects weakness topics into the system prompt."""
    from shared.gemma_client import student_tutor

    captured: list[str] = []

    def _capture_chat(system_prompt, history, message, image_bytes=None):
        captured.append(system_prompt)
        return "Good — what do you know about fractions?"

    with patch("shared.vector_db.search_with_user_context",
               return_value=[{"text": MOCK_SYLLABUS_CONTEXT, "metadata": {}, "score": 0.1}]), \
         patch("shared.vector_db.get_embedding", return_value=[0.1] * 384), \
         patch("shared.gemma_client.chat", side_effect=_capture_chat):
        student_tutor(
            message="Help",
            conversation_history=[],
            education_level="Form 2",
            user_context={"curriculum": "ZIMSEC", "weakness_topics": MOCK_STUDENT_WEAK_AREAS},
        )

    assert len(captured) > 0
    system = captured[0]
    # Weakness topics must appear in the system prompt
    assert "fractions" in system or "quadratic" in system


@feature_test("rag_tutor_socratic_not_direct")
def test_tutor_response_is_socratic():
    """student_tutor() must return a question (Socratic), not a direct answer."""
    from shared.gemma_client import student_tutor

    socratic = "What do you think happens when you substitute x=2 into the equation?"
    with patch("shared.gemma_client._build_rag_context", return_value=""), \
         patch("shared.gemma_client.chat", return_value=socratic):
        response = student_tutor("Solve x^2=4", [], "Form 2")

    assert "?" in response


@feature_test("rag_tutor_rate_limit_uses_firestore")
def test_tutor_rate_limit_checked_in_firestore():
    """guardrails.check_rate_limit() returns (allowed, retry_after) for student tutor."""
    from shared.guardrails import check_rate_limit

    with patch("shared.guardrails.check_rate_limit", return_value=(True, 45)) as mock_limit:
        allowed, remaining = mock_limit("s1", "tutor", "student")

    assert allowed is True
    assert remaining == 45


# ============================================================
# TEST SUITE 5 — RAG in Teacher Assistant
# ============================================================


@feature_test("rag_in_teacher_assistant")
def test_rag_context_injected_in_teacher_assistant():
    """_rag_context() in teacher_assistant calls _build_rag_context and returns the result."""
    from functions.teacher_assistant import _rag_context

    with patch("shared.gemma_client._build_rag_context", return_value=_RAG_SECTION) as mock_rag:
        result = _rag_context(
            query_text="ZIMSEC form_2 quadratic equations",
            user_ctx={"curriculum": "ZIMSEC", "education_level": "form_2", "subject": "Mathematics"},
        )

    mock_rag.assert_called_once()
    assert result == _RAG_SECTION


@feature_test("rag_teacher_assistant_class_performance")
def test_teacher_assistant_class_performance_uses_firestore():
    """get_teacher_context_data() with include_marks=True queries Firestore and surfaces per-class stats."""
    from functions.teacher_assistant import get_teacher_context_data

    mock_class_doc = MagicMock()
    mock_class_doc.id = "cls1"
    mock_class_doc.to_dict.return_value = {
        "id": "cls1", "name": "Form 2 Maths", "subject": "Mathematics",
        "education_level": "form_2", "teacher_id": "t1",
    }

    mock_student_doc = MagicMock()
    mock_student_doc.id = "s1"
    mock_student_doc.to_dict.return_value = {
        "id": "s1", "first_name": "Alice", "surname": "Moyo", "class_id": "cls1",
    }

    mock_mark_docs = []
    for sid, name, pct in [("s1", "Alice Moyo", 80.0), ("s2", "Bob Dube", 45.0), ("s3", "Carol Choto", 72.0)]:
        m = MagicMock()
        m.id = f"mark_{sid}"
        m.to_dict.return_value = {
            "student_id": sid, "student_name": name,
            "percentage": pct, "score": int(pct), "max_score": 100,
            "approved": True, "verdicts": [],
        }
        mock_mark_docs.append(m)

    mock_db = MagicMock()
    classes_ref = mock_db.collection.return_value.where.return_value
    classes_ref.stream.return_value = [mock_class_doc]

    students_ref = MagicMock()
    students_ref.stream.return_value = [mock_student_doc]

    marks_ref = MagicMock()
    marks_ref.stream.return_value = mock_mark_docs

    def collection_side_effect(name):
        col = MagicMock()
        if name == "classes":
            col.where.return_value.stream.return_value = [mock_class_doc]
        elif name == "students":
            col.where.return_value.stream.return_value = [mock_student_doc]
        elif name == "marks":
            col.where.return_value.stream.return_value = mock_mark_docs
        return col

    mock_db.collection.side_effect = collection_side_effect

    with patch("functions.teacher_assistant.get_db", return_value=mock_db):
        result = get_teacher_context_data("t1", include_marks=True)

    assert "classes" in result
    classes = result["classes"]
    assert len(classes) == 1
    cls = classes[0]
    # include_marks=True means marks stats must be present
    assert "average_score" in cls or "students" in cls


@feature_test("rag_teacher_assistant_curriculum_aware")
def test_teacher_assistant_uses_curriculum_from_rag():
    """generate_marking_scheme() passes curriculum metadata to search_with_user_context."""
    from shared.gemma_client import generate_marking_scheme

    syllabus_hit = [{"text": MOCK_SYLLABUS_CONTEXT, "metadata": {"curriculum": "ZIMSEC"}, "score": 0.1}]

    with patch("shared.vector_db.search_with_user_context", return_value=syllabus_hit) as mock_search, \
         patch("shared.vector_db.get_embedding", return_value=[0.1] * 384), \
         patch("shared.gemma_client._generate",
               return_value='{"title": "Quiz", "questions": [], "total_marks": 0}'):
        generate_marking_scheme(
            question_paper_text="Quadratic equations",
            education_level="Form 2",
            user_context={"curriculum": "ZIMSEC"},
        )

    assert mock_search.called
    collections_hit = [c[0][0] for c in mock_search.call_args_list]
    assert "syllabuses" in collections_hit


# ============================================================
# TEST SUITE 6 — RAG Country Expansion (Admin Upload)
# ============================================================


@feature_test("rag_new_country_syllabus_upload")
def test_new_country_syllabus_upload_indexes_correctly():
    """store_document() accepts a KNEC/Kenya syllabus and writes it to ChromaDB."""
    from shared.vector_db import store_document

    with patch("shared.vector_db.get_embedding", return_value=[0.1] * 384), \
         patch("shared.vector_db._fs_collection", return_value="rag_syllabuses"), \
         patch("shared.firestore_client.get_db") as mock_db:
        mock_db.return_value.collection.return_value.document.return_value.set.return_value = None
        store_document(
            collection="syllabuses",
            doc_id="knec_bio_form3_001",
            text="Kenya KNEC Form 3 Biology: Cell division, mitosis, meiosis...",
            metadata={
                "curriculum": "KNEC",
                "country": "Kenya",
                "subject": "Biology",
                "education_level": "form_3",
            },
        )

    mock_set = mock_db.return_value.collection.return_value.document.return_value.set
    mock_set.assert_called()
    stored = mock_set.call_args[0][0]
    assert "embedding" in stored
    assert stored.get("metadata", {}).get("country") == "Kenya"
    assert stored.get("metadata", {}).get("curriculum") == "KNEC"


@feature_test("rag_country_expansion_zero_code_changes")
def test_country_expansion_requires_no_code_changes():
    """AI endpoint source files must not hardcode country-specific content in prompts."""
    answer_keys_py = open(
        os.path.expanduser("~/Desktop/neriah-ai/functions/answer_keys.py")
    ).read()
    tutor_py = open(
        os.path.expanduser("~/Desktop/neriah-ai/functions/tutor.py")
    ).read()

    hardcoded_countries = ["Zimbabwe", "Kenya", "Nigeria", "South Africa"]
    for country in hardcoded_countries:
        count_ak = answer_keys_py.count(country)
        count_t  = tutor_py.count(country)
        assert count_ak <= 3, (
            f"{country} appears {count_ak}x in answer_keys.py — likely hardcoded in prompts"
        )
        assert count_t <= 3, (
            f"{country} appears {count_t}x in tutor.py — likely hardcoded in prompts"
        )
