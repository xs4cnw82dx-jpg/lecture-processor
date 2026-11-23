"""Firestore transaction failures handled at billing boundaries."""

from google.api_core.exceptions import GoogleAPIError
from google.auth.exceptions import GoogleAuthError
from grpc import RpcError

# Firestore raises ValueError when its transaction retry budget is exhausted.
# Local repository adapters also report failed reads or writes with RuntimeError.
STORAGE_ERRORS = (GoogleAPIError, GoogleAuthError, RpcError, OSError, ValueError, RuntimeError)
