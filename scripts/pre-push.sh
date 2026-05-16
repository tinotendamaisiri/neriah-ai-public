#!/bin/bash
# scripts/pre-push.sh
# Runs the Neriah test suite before every git push.
# Installed as .git/hooks/pre-push by: cp scripts/pre-push.sh .git/hooks/pre-push
#
# Tests that drive live Gemma (Vertex) are excluded because Vertex refuses to
# transcribe synthetic blank JPEGs. See CLAUDE.md § 9.10 for the proper fix.

set -euo pipefail

echo "Running Neriah test suite before push..."
cd "$(git rev-parse --show-toplevel)"

# test_integration.py is wholesale excluded — every test in it depends on
# mark_response, which hits live Gemma. The two other names cover a
# grade-submission test and a scheme-generation suite with the same issue.
SKIP_EXPR="-k 'not (test_integration or test_grade_submission_non_empty or TestSchemeGeneration)'"

eval python3 -m pytest tests/ -v --tb=short $SKIP_EXPR

if [ $? -ne 0 ]; then
    echo ""
    echo "Tests failed. Push aborted."
    exit 1
fi

echo ""
echo "All tests passed. Pushing..."
