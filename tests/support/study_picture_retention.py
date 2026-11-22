import logging
from copy import deepcopy
from types import SimpleNamespace

from flask import Flask, jsonify

from lecture_processor.services import access_service
from lecture_processor.services import study_library_service as library
from lecture_processor.services import study_picture_service as pictures


class PackRef:
    def __init__(self, db, path):
        self.db = db
        self.path = path
        self.id = path.rsplit('/', 1)[-1]

    def get(self, **_kwargs):
        data = deepcopy(self.db.data.get(self.path))
        return SimpleNamespace(
            exists=data is not None, reference=self, id=self.id,
            to_dict=lambda: deepcopy(data),
        )

    def update(self, fields):
        self.db.data[self.path].update(deepcopy(fields))

    def delete(self):
        self.db.data.pop(self.path, None)


def make_retention(study_pictures, monkeypatch):
    runtime, db, files, data = study_pictures
    state = SimpleNamespace(runtime=runtime, db=db, files=files, data=data, fail_commit=False)
    runtime.jsonify = jsonify
    runtime.logger = logging.getLogger('synthetic-picture-retention')
    runtime.time = SimpleNamespace(time=lambda: 1000.0)
    runtime.FEATURE_AUDIO_SECTION_SYNC = False
    runtime.repositories = SimpleNamespace(study=SimpleNamespace(
        study_pack_doc_ref=lambda _db, pack_id: PackRef(db, 'study_packs/' + pack_id),
        get_study_pack_doc=lambda _db, pack_id: PackRef(db, 'study_packs/' + pack_id).get(),
        study_pack_source_doc_ref=lambda _db, pack_id: PackRef(db, 'study_pack_sources/' + pack_id),
        list_study_shares_by_owner_and_entity=lambda *_args, **_kwargs: [],
        list_interview_ai_coding_runs_by_uid_and_pack=lambda *_args, **_kwargs: [],
        list_interview_quotations_by_uid_and_pack=lambda *_args, **_kwargs: [],
    ))
    runtime.get_study_card_state_doc = lambda uid, pack_id: PackRef(db, f'study_card_states/{uid}__{pack_id}')
    monkeypatch.setattr(access_service, 'require_allowed_user', lambda *_args, **_kwargs: ({'uid': 'owner'}, None, 0))
    monkeypatch.setattr(access_service, 'account_write_guard', lambda *_args: None)
    monkeypatch.setattr(library.study_audio, 'ensure_pack_audio_storage_key', lambda *_args, **_kwargs: '')
    monkeypatch.setattr(library.study_audio, 'audio_storage_key_has_file', lambda *_args, **_kwargs: False)
    monkeypatch.setattr(library.study_audio, 'remove_pack_audio_file', lambda *_args, **_kwargs: None)

    def commit(_runtime, _uid, _pack_id, refs):
        if state.fail_commit:
            raise RuntimeError('Synthetic pack commit failure')
        for ref in refs:
            ref.delete()

    monkeypatch.setattr(library.study_progress_service, 'delete_pack_and_progress', commit)
    image = pictures.save_image(runtime, 'owner', 'pack', data, 'synthetic.png')
    state.image_id = image['id']
    state.asset_path = 'study_images/' + image['id']
    state.asset = deepcopy(db.data[state.asset_path])
    db.data['study_packs/pack']['flashcards'] = [{'front': 'Question', 'back': 'Answer', 'image_ids': [image['id']]}]
    with Flask(__name__).app_context():
        yield state


def response_status(result):
    return result[1] if isinstance(result, tuple) else result.status_code


def update_cards(state, cards):
    request = SimpleNamespace(get_json=lambda **_kwargs: {'flashcards': cards})
    return library.update_study_pack(state.runtime, request, 'pack')
