from __future__ import annotations

import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr

from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def send_batch_completion_email(recipient_email, subject, body_text, runtime=None):
    """Send one batch-completion email through SMTP.

    Returns a tuple: (status, error_message)
    status is one of: sent, skipped, failed
    """
    resolved_runtime = _resolve_runtime(runtime)

    recipient = str(recipient_email or '').strip()
    if not recipient:
        return 'skipped', 'Missing recipient email.'

    if not bool(getattr(resolved_runtime, 'BATCH_EMAIL_NOTIFICATIONS_ENABLED', True)):
        return 'skipped', 'Batch email notifications are disabled.'

    host = str(getattr(resolved_runtime, 'SMTP_HOST', '') or '').strip()
    from_email = str(getattr(resolved_runtime, 'SMTP_FROM_EMAIL', '') or '').strip()
    if not host or not from_email:
        return 'skipped', 'SMTP is not configured.'

    port = int(getattr(resolved_runtime, 'SMTP_PORT', 587) or 587)
    username = str(getattr(resolved_runtime, 'SMTP_USERNAME', '') or '').strip()
    password = str(getattr(resolved_runtime, 'SMTP_PASSWORD', '') or '').strip()
    use_tls = bool(getattr(resolved_runtime, 'SMTP_USE_TLS', True))
    use_ssl = bool(getattr(resolved_runtime, 'SMTP_USE_SSL', False))
    timeout_seconds = int(getattr(resolved_runtime, 'SMTP_TIMEOUT_SECONDS', 12) or 12)
    from_name = str(getattr(resolved_runtime, 'SMTP_FROM_NAME', 'Lecture Processor') or 'Lecture Processor').strip()
    reply_to = str(getattr(resolved_runtime, 'SMTP_REPLY_TO', '') or '').strip()

    if use_ssl and use_tls:
        use_tls = False

    message = EmailMessage()
    message['Subject'] = str(subject or 'Batch update').strip()[:220]
    message['From'] = formataddr((from_name, from_email)) if from_name else from_email
    message['To'] = recipient
    if reply_to:
        message['Reply-To'] = reply_to
    message.set_content(str(body_text or '').strip() + '\n')

    last_error = ''
    for attempt in range(1, 3):
        try:
            if use_ssl:
                smtp = smtplib.SMTP_SSL(host=host, port=port, timeout=timeout_seconds, context=ssl.create_default_context())
            else:
                smtp = smtplib.SMTP(host=host, port=port, timeout=timeout_seconds)
            with smtp:
                smtp.ehlo()
                if use_tls:
                    smtp.starttls(context=ssl.create_default_context())
                    smtp.ehlo()
                if username:
                    smtp.login(username, password)
                smtp.send_message(message)
            return 'sent', ''
        except Exception as error:
            last_error = str(error)[:600]
            if attempt < 2:
                try:
                    resolved_runtime.time.sleep(0.6)
                except Exception:
                    pass

    return 'failed', (last_error or 'SMTP send failed.')
