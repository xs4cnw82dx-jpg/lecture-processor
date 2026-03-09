#!/usr/bin/env python3
import argparse
import json
import os

import firebase_admin
from firebase_admin import credentials, firestore

from lecture_processor.domains.admin import metrics as admin_metrics


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


def backfill_admin_visible(db, *, apply_changes, limit):
    scanned = 0
    changed = 0
    skipped = 0

    for doc in db.collection('job_logs').limit(limit).stream():
        scanned += 1
        payload = doc.to_dict() or {}
        expected = admin_metrics.add_admin_visibility_flag(payload).get('admin_visible')
        if payload.get('admin_visible') is expected:
            skipped += 1
            continue
        if apply_changes:
            doc.reference.set({'admin_visible': bool(expected)}, merge=True)
        changed += 1

    return {
        'mode': 'APPLY' if apply_changes else 'DRY-RUN',
        'scanned': scanned,
        'changed': changed,
        'skipped': skipped,
    }


def main():
    parser = argparse.ArgumentParser(description="Backfill admin_visible on historical job_logs documents.")
    parser.add_argument('--apply', action='store_true', help='Write changes. Without this flag the script only reports the number of rows to update.')
    parser.add_argument('--limit', type=int, default=5000, help='Maximum number of job_logs documents to scan.')
    args = parser.parse_args()

    db = init_firestore()
    summary = backfill_admin_visible(
        db,
        apply_changes=bool(args.apply),
        limit=max(1, int(args.limit or 1)),
    )
    print("[{mode}] scanned={scanned} changed={changed} skipped={skipped}".format(**summary))
    if not args.apply:
        print("No changes were written. Re-run with --apply to persist admin_visible.")


if __name__ == '__main__':
    main()
