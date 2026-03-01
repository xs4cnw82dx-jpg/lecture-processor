#!/usr/bin/env python3
import argparse
import json
import os
from typing import Tuple

import firebase_admin
from firebase_admin import credentials, firestore


def init_firestore():
    if os.path.exists("firebase-credentials.json"):
        cred = credentials.Certificate("firebase-credentials.json")
    else:
        raw = (os.getenv("FIREBASE_CREDENTIALS", "") or "").strip()
        if not raw:
            raise RuntimeError("Missing firebase-credentials.json and FIREBASE_CREDENTIALS env var.")
        cred = credentials.Certificate(json.loads(raw))
    if not firebase_admin._apps:
        firebase_admin.initialize_app(cred)
    return firestore.client()


def cleanup_study_pack_emails(db, apply_changes: bool) -> Tuple[int, int]:
    scanned = 0
    updated = 0
    for doc in db.collection("study_packs").stream():
        scanned += 1
        data = doc.to_dict() or {}
        if "email" not in data:
            continue
        updated += 1
        if apply_changes:
            doc.reference.update({"email": firestore.DELETE_FIELD})
    return scanned, updated


def main():
    parser = argparse.ArgumentParser(description="Remove legacy email field from study_packs documents.")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Apply changes. Without this flag, the script runs in dry-run mode.",
    )
    args = parser.parse_args()

    db = init_firestore()
    scanned, matched = cleanup_study_pack_emails(db, apply_changes=args.apply)
    mode = "APPLY" if args.apply else "DRY-RUN"
    print(f"[{mode}] scanned={scanned} study_packs, docs_with_email={matched}")
    if not args.apply:
        print("No changes were written. Re-run with --apply to persist.")


if __name__ == "__main__":
    main()
