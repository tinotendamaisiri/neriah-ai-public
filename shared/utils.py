"""
Small request/HTTP helpers shared across function handlers.
"""

from __future__ import annotations


def get_client_ip(request) -> str:
    """Extract the client IP from a Flask request.

    Cloud Functions / GCP load balancers put the real client IP in
    X-Forwarded-For as `"<client>, <proxy1>, <proxy2>"` — the first entry
    is the original caller. Falls back to `request.remote_addr` for local
    test runs that don't set XFF, then "unknown" as a last resort.
    """
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.remote_addr or "unknown"
