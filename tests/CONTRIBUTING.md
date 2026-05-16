# Adding Tests for New Features

When you add a new feature to Neriah, add a test function in the appropriate test file and decorate it:

```python
from tests.registry import feature_test

@feature_test("your_feature_name")
def test_your_feature(self, client, auth_headers):
    # 1. Set up mock data
    # 2. Call the endpoint or function
    # 3. Assert expected behavior
    # 4. Assert nothing else broke
    pass
```

## Rules

- Every new backend endpoint needs at least one test
- Every new mobile screen interaction needs at least one test
- Test must be independent — no shared state between tests
- Mock all external services: Firestore, GCS, Gemma, Vertex AI
- Run `python -m pytest tests/ -v` before every git push

## Feature name conventions

Use `snake_case` with the format `<domain>_<behaviour>`:

| Feature | Recommended name |
|---|---|
| Homework creation from image | `homework_creation_image` |
| Homework creation from PDF | `homework_creation_pdf` |
| Marking scheme due date stored | `marking_scheme_due_date` |
| Auto-close after due date | `marking_scheme_auto_close` |
| Answer key PUT endpoint | `answer_key_update` |

## Discovering registered tests

```bash
python tests/test_runner.py
```

This prints every registered feature name and its backing function, then runs the full suite.

## Patch targets

All Firestore and Gemma patches go on the module that *imports* the symbol, not on the module that defines it.

| Symbol | Patch target |
|---|---|
| `get_doc` inside answer_keys handler | `functions.answer_keys.get_doc` |
| `upsert` inside answer_keys handler | `functions.answer_keys.upsert` |
| `get_user_context` | `functions.answer_keys.get_user_context` |
| Gemma image call | `functions.answer_keys.generate_marking_scheme_from_image` |
| Gemma text call | `functions.answer_keys.generate_scheme_from_text` |
| Token version check (auth bypass) | `shared.firestore_client.get_doc` |

## Running a single suite

```bash
python -m pytest tests/test_homework_creation_flow.py::TestDueDateAndAutoClose -v
```
