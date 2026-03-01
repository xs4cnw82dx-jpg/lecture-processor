"""Authentication utility helpers."""


def verify_firebase_token(request, auth_module, logger):
    """Return decoded Firebase token dict, or None when invalid/missing."""
    auth_header = request.headers.get('Authorization', '')
    if not auth_header.startswith('Bearer '):
        return None
    token = auth_header.split('Bearer ', 1)[1]
    try:
        return auth_module.verify_id_token(token)
    except Exception as exc:
        if logger is not None:
            logger.info(f"Token verification failed: {exc}")
        return None
