from types import SimpleNamespace

from lecture_processor.domains.account import lifecycle
from lecture_processor.domains.rate_limit import limiter, quotas
from lecture_processor.domains.upload import import_audio
from lecture_processor.services import media_admission


def make_downloads(client, core, monkeypatch, tmp_path):
    state = SimpleNamespace(client=client, core=core, queued=[], media=[], released=[], reserved=[], paths=[], deleting=False)
    monkeypatch.setattr(core, 'UPLOAD_FOLDER', str(tmp_path))
    monkeypatch.setattr(core, 'db', None)
    monkeypatch.setattr(core, 'verify_firebase_token', lambda req: {'uid': req.headers.get('X-Test-Uid', 'owner'), 'email': 'user@example.test'} if req.headers.get('X-Test-Uid', 'owner') else None)
    monkeypatch.setattr(core, 'is_email_allowed', lambda _email: True)
    monkeypatch.setattr(lifecycle, 'ensure_account_allows_writes', lambda *_args, **_kwargs: (not state.deleting, 'Account unavailable'))
    monkeypatch.setattr(limiter, 'check_rate_limit', lambda **_kwargs: (True, 0))
    monkeypatch.setattr(import_audio, 'validate_video_import_fetch_target', lambda *_args, **_kwargs: ('https://media.example.test/file?secret=signed', ''))
    monkeypatch.setattr(quotas, 'has_sufficient_upload_disk_space', lambda *_args, **_kwargs: (True, 10**12, 0))
    monkeypatch.setattr(quotas, 'reserve_daily_upload_bytes', lambda uid, size, **_kwargs: state.reserved.append((uid, size)) or (True, 0))
    monkeypatch.setattr(quotas, 'release_daily_upload_bytes', lambda uid, size, **_kwargs: state.released.append((uid, size)) or True)
    monkeypatch.setattr(core, 'submit_background_job', lambda target, *args, **kwargs: state.queued.append((target, args, kwargs)))

    def download(target, prefix):
        state.media.append(target)
        path = tmp_path / f'{prefix}_audio.mp3'
        path.write_bytes(b'ID3 synthetic lecture')
        state.paths.append(path)
        return str(path), path.name, path.stat().st_size

    monkeypatch.setattr(core, 'download_audio_from_video_url', download)
    def post(**kwargs):
        headers = {'Accept': 'application/json', **kwargs.pop('headers', {})}
        return client.post('/api/tools/lecture-download', json={'url': 'https://media.example.test/file?secret=signed', 'format': 'audio'}, headers=headers, **kwargs)

    state.post = post
    yield state
    # Tests that deliberately withhold the worker still release process admission.
    for target, args, kwargs in state.queued:
        for value in (*args, *kwargs.values()):
            if isinstance(value, media_admission._MediaLease):
                value.release()
