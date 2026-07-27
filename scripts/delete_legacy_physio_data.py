#!/usr/bin/env python3
"""Delete one authenticated user's legacy Physio Firestore documents.

Dry-run is the default. This command never performs collection-wide deletion and
refuses ambiguous ownership unless an exact UID or email is supplied.
"""

from __future__ import annotations

import argparse
import json
import os
from collections import defaultdict
from typing import Any

import firebase_admin
from firebase_admin import auth, credentials, firestore


COLLECTIONS = ("physio_cases", "physio_case_sessions")


def init_clients():
    if os.path.exists("firebase-credentials.json"):
        cred = credentials.Certificate("firebase-credentials.json")
    else:
        raw = (os.getenv("FIREBASE_CREDENTIALS", "") or "").strip()
        if not raw:
            raise RuntimeError("Missing firebase-credentials.json and FIREBASE_CREDENTIALS env var.")
        cred = credentials.Certificate(json.loads(raw))
    if not firebase_admin._apps:
        firebase_admin.initialize_app(cred)
    return firestore.client(), auth


def _docs_for_uid(db: Any, collection_name: str, uid: str) -> list[Any]:
    return list(db.collection(collection_name).where("uid", "==", uid).stream())


def discover_active_owner(db: Any, auth_client: Any) -> tuple[str, int]:
    owner_counts: dict[str, int] = defaultdict(int)
    for collection_name in COLLECTIONS:
        for doc in db.collection(collection_name).stream():
            payload = doc.to_dict() or {}
            uid = str(payload.get("uid") or "").strip()
            if uid:
                owner_counts[uid] += 1

    active: list[str] = []
    orphan_groups = 0
    for uid in sorted(owner_counts):
        try:
            auth_client.get_user(uid)
        except Exception as exc:
            if exc.__class__.__name__ in {"UserNotFoundError", "UserNotFound"}:
                orphan_groups += 1
                continue
            raise
        active.append(uid)
    if len(active) != 1:
        raise RuntimeError(
            f"Expected exactly one active Physio owner, found {len(active)}. "
            "Provide --uid or --email to select an exact account."
        )
    return active[0], orphan_groups


def delete_for_uid(db: Any, uid: str, *, execute: bool) -> dict[str, Any]:
    if not uid or "/" in uid:
        raise ValueError("A non-empty exact Firebase UID is required.")
    matched = {name: _docs_for_uid(db, name, uid) for name in COLLECTIONS}
    if execute:
        for docs in matched.values():
            for start in range(0, len(docs), 450):
                batch = db.batch()
                for doc in docs[start : start + 450]:
                    batch.delete(doc.reference)
                batch.commit()
        remaining = {name: len(_docs_for_uid(db, name, uid)) for name in COLLECTIONS}
        if any(remaining.values()):
            raise RuntimeError(f"Deletion verification failed: {remaining}")
    return {
        "mode": "execute" if execute else "dry-run",
        "uid": uid,
        "documents": {name: len(docs) for name, docs in matched.items()},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    owner = parser.add_mutually_exclusive_group()
    owner.add_argument("--uid", help="Exact Firebase UID to remove")
    owner.add_argument("--email", help="Resolve an exact Firebase account by email")
    parser.add_argument("--execute", action="store_true", help="Permanently delete matched documents")
    args = parser.parse_args()
    db, auth_client = init_clients()
    orphan_groups = 0
    if args.email:
        uid = auth_client.get_user_by_email(args.email).uid
    elif args.uid:
        auth_client.get_user(args.uid)
        uid = args.uid
    else:
        uid, orphan_groups = discover_active_owner(db, auth_client)
    result = delete_for_uid(db, uid, execute=args.execute)
    result["orphan_owner_groups_ignored"] = orphan_groups
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
