#!/usr/bin/env python3
"""
Create Firestore vector indexes for RAG collections.

Tries the Admin API first; falls back to printing gcloud commands.

Usage:
    python scripts/create_vector_indexes.py

Env vars:
    GCP_PROJECT_ID  — Google Cloud project ID (required)
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")
logger = logging.getLogger(__name__)

PROJECT = os.environ.get("GCP_PROJECT_ID", "")
DATABASE = os.environ.get("FIRESTORE_DATABASE", "(default)")

COLLECTIONS = [
    ("rag_syllabuses", 768),
    ("rag_grading_examples", 768),
]


def create_via_gcloud(collection: str, dimension: int) -> bool:
    """Try creating via gcloud CLI. Returns True on success."""
    cmd = [
        "gcloud", "firestore", "indexes", "composite", "create",
        f"--project={PROJECT}",
        f"--database={DATABASE}",
        f"--collection-group={collection}",
        "--query-scope=COLLECTION",
        f'--field-config=field-path=embedding,vector-config={{"dimension":{dimension},"flat":{{}}}}',
    ]
    logger.info("Running: %s", " ".join(cmd))
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if result.returncode == 0:
            logger.info("  Index created for %s", collection)
            return True
        if "already exists" in result.stderr.lower():
            logger.info("  Index already exists for %s", collection)
            return True
        logger.warning("  gcloud failed (rc=%d): %s", result.returncode, result.stderr.strip())
        return False
    except FileNotFoundError:
        logger.warning("  gcloud CLI not found")
        return False
    except Exception as e:
        logger.warning("  gcloud failed: %s", e)
        return False


def main():
    if not PROJECT:
        logger.error("GCP_PROJECT_ID env var is required")
        sys.exit(1)

    logger.info("Project: %s | Database: %s", PROJECT, DATABASE)
    logger.info("")

    failed: list[str] = []

    for collection, dimension in COLLECTIONS:
        logger.info("Creating vector index: %s (dimension=%d)", collection, dimension)
        if not create_via_gcloud(collection, dimension):
            failed.append(collection)

    if failed:
        logger.info("")
        logger.info("Some indexes could not be created automatically.")
        logger.info("Run these commands manually in your terminal:")
        logger.info("")
        for collection, dimension in COLLECTIONS:
            if collection in failed:
                print(f"""gcloud firestore indexes composite create \\
  --project={PROJECT} \\
  --database={DATABASE} \\
  --collection-group={collection} \\
  --query-scope=COLLECTION \\
  --field-config='field-path=embedding,vector-config={{"dimension":{dimension},"flat":{{}}}}'
""")
    else:
        logger.info("")
        logger.info("All vector indexes created successfully.")
        logger.info("Note: indexes take a few minutes to build. Check status:")
        logger.info("  gcloud firestore indexes composite list --project=%s", PROJECT)


if __name__ == "__main__":
    main()
