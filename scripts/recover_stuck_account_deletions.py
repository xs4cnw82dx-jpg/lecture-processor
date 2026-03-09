#!/usr/bin/env python3
import argparse
import json
import os
import time

import firebase_admin
from firebase_admin import credentials, firestore

from lecture_processor.domains.account import lifecycle as account_lifecycle


ACTIVE_JOB_STATUSES = ['queued', 'starting', 'processing']


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


def has_active_jobs(db, uid):
    runtime_jobs = (
        db.collection('runtime_jobs')
        .where('user_id', '==', uid)
        .where('status', 'in', ACTIVE_JOB_STATUSES)
        .limit(1)
        .stream()
    )
    if any(True for _ in runtime_jobs):
        return True
    batch_jobs = (
        db.collection('batch_jobs')
        .where('uid', '==', uid)
        .where('status', 'in', ACTIVE_JOB_STATUSES)
        .limit(1)
        .stream()
    )
    return any(True for _ in batch_jobs)


def recover_stuck_accounts(db, *, stale_minutes, apply_changes, limit):
    now_ts = time.time()
    stale_after_seconds = max(60, int(stale_minutes * 60))
    scanned = 0
    recovered = 0
    skipped_active_jobs = 0
    candidates = 0

    query = db.collection('users').where('account_status', '==', 'deleting').limit(limit)
    for doc in query.stream():
        scanned += 1
        state = doc.to_dict() or {}
        if not account_lifecycle.is_stuck_deletion_candidate(
            state,
            now_ts=now_ts,
            stale_after_seconds=stale_after_seconds,
        ):
            continue
        candidates += 1
        uid = str(state.get('uid', '') or doc.id or '').strip()
        if not uid:
            continue
        if has_active_jobs(db, uid):
            skipped_active_jobs += 1
            continue
        if apply_changes:
            payload = dict(state)
            payload.update({
                'uid': uid,
                'email': str(state.get('email', '') or '').strip(),
                'account_status': 'active',
                'delete_requested_at': 0,
                'delete_started_at': 0,
                'last_delete_failure_at': now_ts,
                'last_delete_failure_reason': 'Recovered automatically from stuck deletion state.',
                'updated_at': now_ts,
            })
            doc.reference.set(payload, merge=False)
        recovered += 1

    return {
        'scanned': scanned,
        'candidates': candidates,
        'recovered': recovered,
        'skipped_active_jobs': skipped_active_jobs,
        'mode': 'APPLY' if apply_changes else 'DRY-RUN',
    }


def main():
    parser = argparse.ArgumentParser(description="Recover users stuck in account_status=deleting after failed account deletion.")
    parser.add_argument('--apply', action='store_true', help='Write changes. Without this flag the script only reports candidates.')
    parser.add_argument('--stale-minutes', type=int, default=60, help='Minimum age for a deleting state before it can be recovered.')
    parser.add_argument('--limit', type=int, default=500, help='Maximum number of deleting users to scan.')
    args = parser.parse_args()

    db = init_firestore()
    summary = recover_stuck_accounts(
        db,
        stale_minutes=max(1, args.stale_minutes),
        apply_changes=bool(args.apply),
        limit=max(1, args.limit),
    )
    print(
        "[{mode}] scanned={scanned} candidates={candidates} recovered={recovered} skipped_active_jobs={skipped_active_jobs}".format(
            **summary
        )
    )
    if not args.apply:
        print("No changes were written. Re-run with --apply to persist recovery.")


if __name__ == '__main__':
    main()
