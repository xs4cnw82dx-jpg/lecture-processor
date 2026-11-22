import io
import json
from types import SimpleNamespace

from lecture_processor.domains.auth import policy as auth_policy
from tests.credit_test_support import make_credit_runtime

UID = 'unified-route-user'


HEADERS = {'Authorization': 'Bearer synthetic-route-token'}


def make_processing(client, core, monkeypatch, tmp_path):
    user = {
        'uid': UID, 'email': 'student@example.test', 'account_status': 'active',
        'credits_version': 2, 'credits': 100, 'total_processed': 0,
        'lecture_credits_standard': 0, 'lecture_credits_extended': 0, 'slides_credits': 0,
        'interview_credits_short': 0, 'interview_credits_medium': 0, 'interview_credits_long': 0,
        'unlimited_credits': {'lecture': False, 'slides': False, 'interview': False},
    }
    billing_runtime, store = make_credit_runtime(
        users={UID: user},
        documents={('study_packs', 'owned-pack'): {'uid': UID, 'mode': 'voice-note', 'title': 'Synthetic notes', 'notes_markdown': 'Synthetic source'}},
    )
    monkeypatch.setattr(core, 'db', billing_runtime.db)
    monkeypatch.setattr(core.firestore, 'transactional', billing_runtime.firestore.transactional)
    monkeypatch.setattr(core.firestore, 'Increment', billing_runtime.firestore.Increment)
    monkeypatch.setattr(core, 'UNIFIED_CREDITS_ENABLED', True)
    monkeypatch.setattr(core, 'ADMIN_UIDS', set())
    monkeypatch.setattr(core, 'ADMIN_EMAILS', set())
    monkeypatch.setattr(core, 'UPLOAD_FOLDER', str(tmp_path))
    monkeypatch.setattr(core, 'client', object())
    monkeypatch.setattr(core, 'verify_firebase_token', lambda _request: {'uid': UID, 'email': user['email'], 'email_verified': True})
    monkeypatch.setattr(auth_policy, 'is_email_allowed', lambda *_args, **_kwargs: True)
    # Audio codecs are outside these admission tests; bytes are confined to tmp_path.
    monkeypatch.setattr(core, 'file_looks_like_audio', lambda _path: True)
    queued = []
    monkeypatch.setattr(core, 'submit_background_job', lambda target, *args, **kwargs: queued.append((target, args, kwargs)))
    monkeypatch.setattr(core, 'submit_batch_background_job', lambda target, *args, **kwargs: queued.append((target, args, kwargs)))
    return SimpleNamespace(client=client, core=core, store=store, queued=queued, tmp_path=tmp_path)


def pdf():
    return io.BytesIO(b'%PDF-1.4\nSynthetic isolated slides'), 'slides.pdf', 'application/pdf'


def audio():
    return io.BytesIO(b'ID3\x03\x00\x00Synthetic isolated audio'), 'audio.mp3', 'audio/mpeg'


def post_action(processing, action):
    if action == 'regenerate':
        return processing.client.post('/api/voice-notes/owned-pack/study-tools', json={'study_features': 'both'}, headers=HEADERS)
    data = {}
    if action in {'lecture', 'slides', 'interview', 'interview-extras'}:
        path = '/upload'
        data = {'mode': {'lecture': 'lecture-notes', 'slides': 'slides-only'}.get(action, 'interview'), 'study_pack_title': 'Synthetic route test'}
        if action in {'lecture', 'slides'}:
            data['pdf'] = pdf()
        if action != 'slides':
            data['audio'] = audio()
        if action == 'interview-extras':
            data['interview_features'] = 'both'
    elif action == 'extract':
        path, data = '/api/tools/extract', {'source_type': 'pdf', 'file': pdf()}
    elif action == 'transcribe':
        path, data = '/api/tools/transcribe', {'audio': audio()}
    elif action == 'voice':
        path, data = '/api/voice-notes', {'audio': audio(), 'title': 'Synthetic voice note'}
    else:
        raise AssertionError(action)
    return processing.client.post(path, data=data, content_type='multipart/form-data', headers=HEADERS)


def post_batch(processing, mode, *, instant, extras=0):
    data = {'mode': mode, 'batch_title': 'Synthetic three-row batch'}
    rows = []
    for index in range(1, 4):
        row = {'row_id': f'row-{index}'}
        if mode in {'lecture-notes', 'slides-only'}:
            data[f'row_{index}_slides'] = pdf()
        if mode in {'lecture-notes', 'interview', 'audio-transcription'}:
            data[f'row_{index}_audio'] = audio()
        if mode == 'text-combine':
            data[f'row_{index}_slide_text'] = (io.BytesIO(b'Synthetic slide text'), f'slides-{index}.txt', 'text/plain')
        if mode == 'interview':
            row['interview_features'] = ['summary', 'sections'][:extras]
        rows.append(row)
    data['rows'] = json.dumps(rows)
    path = '/api/instant-batch/jobs' if instant else '/api/batch/jobs'
    return processing.client.post(path, data=data, content_type='multipart/form-data', headers=HEADERS)
