"""Firestore accessors for analytics and rate-limit logs."""


def add_event(db, payload):
    return db.collection('analytics_events').add(payload)


def add_rate_limit_log(db, payload):
    return db.collection('rate_limit_logs').add(payload)
