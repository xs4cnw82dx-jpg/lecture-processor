"""Recovery removes only proven-unused synthetic persisted audio."""

from pathlib import Path

import pytest

from lecture_processor.domains.runtime_jobs import recovery
from lecture_processor.services import upload_runtime_service
from tests.test_failed_job_audio_cleanup import MemoryDatabase
from tests.test_runtime_job_recovery import add_job, recovery_state as recovery_state


@pytest.fixture
def audio_recovery(recovery_state, tmp_path):
    state = recovery_state
    runtime = state['runtime']
    database = MemoryDatabase()
    database.transaction = runtime.db.transaction
    runtime.db = database
    runtime.UPLOAD_FOLDER = str(tmp_path)
    runtime.STUDY_AUDIO_ROOT = str(tmp_path / 'study_audio')
    root = Path(runtime.STUDY_AUDIO_ROOT)
    root.mkdir()
    path = root / 'job.mp3'
    path.write_bytes(b'Synthetic persisted audio')
    other = root / 'other.mp3'
    other.write_bytes(b'Unrelated synthetic audio')
    state.update(audio=path, other=other, database=database)
    add_job(state, audio_storage_key='study_audio/job.mp3', job_scope='lecture-notes')
    # A restart has discarded the in-memory snapshot.
    state['memory'].clear()
    return state


def recover(state, entry):
    runtime = state['runtime']
    if entry == 'startup':
        recovery.run_startup_recovery_once(runtime=runtime)
    elif entry == 'periodic':
        assert recovery.run_periodic_recovery(runtime=runtime) == 1
    else:
        result = upload_runtime_service.get_status(runtime, object(), 'job')
        assert result['status'] == 'error'


@pytest.mark.parametrize('entry', ['startup', 'periodic', 'status'])
@pytest.mark.parametrize('mode', ['lecture-notes', 'interview', 'voice-notes'])
def test_restart_recovery_removes_unreferenced_audio_and_refunds_once(audio_recovery, entry, mode):
    state = audio_recovery
    state['durable']['job']['mode'] = mode

    recover(state, entry)

    assert state['durable']['job']['status'] == 'error'
    assert state['durable']['job']['credit_refunded'] is True
    assert state['audio'].exists() is False
    assert state['other'].read_bytes() == b'Unrelated synthetic audio'
    assert len(state['logs']) == 1
    assert len(state['refunds']) == 2
    assert recovery.recover_runtime_job_if_stale('job', runtime=state['runtime']) is False
    assert len(state['refunds']) == 2


@pytest.mark.parametrize('reference', ['source_job', 'storage_key', 'append_session', 'legacy_path'])
def test_recovery_preserves_audio_after_a_pack_save_committed(audio_recovery, reference):
    state = audio_recovery
    pack = {'uid': 'owner'}
    if reference == 'source_job':
        pack['source_job_id'] = 'job'
    elif reference == 'storage_key':
        pack['audio_storage_key'] = 'study_audio/job.mp3'
    else:
        state['durable']['job']['voice_note_append_to_pack_id'] = 'saved-pack'
        pack['audio_sessions'] = [{'session_id': 'job'}] if reference == 'append_session' else [
            {'audio_storage_path': str(state['audio'])}]
    state['database'].documents[('study_packs', 'saved-pack')] = pack

    recover(state, 'periodic')

    assert state['audio'].read_bytes() == b'Synthetic persisted audio'
    assert state['other'].exists()
    assert state['durable']['job']['status'] == 'error'
    assert len(state['refunds']) == 2


@pytest.mark.parametrize('protected', ['local_worker', 'fresh_heartbeat', 'successful_job'])
def test_recovery_keeps_audio_for_jobs_it_cannot_claim(audio_recovery, protected):
    state = audio_recovery
    if protected == 'local_worker':
        state['active'].add('job')
    elif protected == 'fresh_heartbeat':
        state['durable']['job']['last_heartbeat_at'] = state['now']
    else:
        state['durable']['job']['status'] = 'complete'

    assert recovery.recover_stale_runtime_jobs(runtime=state['runtime']) == 0
    assert state['audio'].exists()
    assert state['other'].exists()
    assert state['refunds'] == []


@pytest.mark.parametrize('key', ['', 'study_audio/other.mp3', '../job.mp3'])
def test_recovery_does_not_expand_a_missing_or_unrelated_audio_key(audio_recovery, key):
    state = audio_recovery
    state['durable']['job']['audio_storage_key'] = key

    recover(state, 'periodic')

    assert state['audio'].exists()
    assert state['other'].exists()


def test_unavailable_reference_lookup_preserves_audio_and_completed_refund(audio_recovery):
    state = audio_recovery

    def unavailable():
        raise OSError('Synthetic reference lookup unavailable')

    state['database'].before_read = unavailable
    recover(state, 'periodic')

    assert state['audio'].exists()
    assert state['durable']['job']['status'] == 'error'
    assert state['durable']['job']['credit_refunded'] is True
    assert len(state['refunds']) == 2
