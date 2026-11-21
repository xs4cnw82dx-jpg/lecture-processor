"""Firestore accessors for analytics and rate-limit logs."""


def add_event(db, payload):
    return db.collection('analytics_events').add(payload)


def new_event_ref(db):
    """A new auto-id event document, as add() would create, for use in a write batch."""
    return db.collection('analytics_events').document()


def add_rate_limit_log(db, payload):
    return db.collection('rate_limit_logs').add(payload)
