"""Load each blueprint only when its application requests it."""
from importlib import import_module

__all__ = ['auth_bp', 'account_bp', 'study_bp', 'upload_bp', 'admin_bp', 'payments_bp', 'physio_bp']


def __getattr__(name):
    if name in __all__:
        return getattr(import_module(f'.{name.removesuffix("_bp")}', __name__), name)
    raise AttributeError(name)
