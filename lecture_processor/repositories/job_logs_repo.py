"""Firestore accessors for job logs."""


def set_job_log(db, job_id, payload):
    return db.collection('job_logs').document(job_id).set(payload)
