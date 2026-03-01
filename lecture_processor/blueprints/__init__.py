from .auth import auth_bp
from .account import account_bp
from .study import study_bp
from .upload import upload_bp
from .admin import admin_bp
from .payments import payments_bp

__all__ = ['auth_bp', 'account_bp', 'study_bp', 'upload_bp', 'admin_bp', 'payments_bp']
