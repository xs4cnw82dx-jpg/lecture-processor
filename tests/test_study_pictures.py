"""Private study pictures: permissions, resumable writes and durable card references."""
from types import SimpleNamespace

import pytest
from flask import Flask

from lecture_processor.domains.books.model import BookError
from lecture_processor.services import access_service, study_api_support
from lecture_processor.services import study_picture_service as service


def test_upload_retry_reserves_once_and_preserves_original(study_pictures):
    runtime, db, files, data = study_pictures
    image = service.save_image(runtime, 'owner', 'pack', data, 'muscle.png')
    reserved = db.data['book_usage/storage']['bytes']
    assert len(files) == 2
    assert service.save_image(runtime, 'owner', 'pack', data, 'muscle.png') == image
    assert db.data['book_usage/storage']['bytes'] == reserved
    assert files[db.data['study_images/' + image['id']]['path']] == data


def test_partial_upload_resumes_with_no_extra_reservation(study_pictures, monkeypatch):
    runtime, db, files, data = study_pictures
    original = service.book_storage.request
    attempts = []
    def fail_preview(method, path, *args):
        if method == 'POST' and path.endswith('preview.webp') and not attempts:
            attempts.append(True)
            raise BookError('Storage unavailable', 503)
        return original(method, path, *args)
    monkeypatch.setattr(service.book_storage, 'request', fail_preview)
    with pytest.raises(BookError):
        service.save_image(runtime, 'owner', 'pack', data, 'muscle.png')
    reserved = db.data['book_usage/storage']['bytes']
    image = service.save_image(runtime, 'owner', 'pack', data, 'muscle.png')
    assert db.data['study_images/' + image['id']]['ready']
    assert db.data['book_usage/storage']['bytes'] == reserved
    assert len(files) == 2


@pytest.mark.parametrize('mutation', ['disabled', 'foreign', 'deleting', 'full'])
def test_upload_guards_prevent_storage_writes(study_pictures, monkeypatch, mutation):
    runtime, db, files, data = study_pictures
    if mutation == 'disabled': db.data['users/owner']['study_pictures_enabled'] = False
    if mutation == 'foreign': db.data['study_packs/pack']['uid'] = 'someone-else'
    if mutation == 'deleting': db.data['users/owner']['account_status'] = 'deleting'
    if mutation == 'full': monkeypatch.setattr(service.book_storage, 'GLOBAL_BYTES', 1)
    with pytest.raises(BookError):
        service.save_image(runtime, 'owner', 'pack', data, 'muscle.png')
    assert not files
    assert 'book_usage/storage' not in db.data


def test_card_edits_preserve_references_and_reject_foreign_pictures(study_pictures):
    runtime, db, _, data = study_pictures
    image = service.save_image(runtime, 'owner', 'pack', data, 'muscle.png')
    cards = [{'front': ' Edited front ', 'back': 'Edited back', 'image_ids': [image['id'], image['id']]}]
    cleaned = service.sanitize_cards(runtime, 'owner', 'pack', cards)
    assert cleaned == [{'front': 'Edited front', 'back': 'Edited back', 'image_ids': [image['id']]}]
    with pytest.raises(BookError): service.sanitize_cards(runtime, 'owner', 'another-pack', cards)
    db.data['study_images/' + image['id']]['ready'] = False
    with pytest.raises(BookError): service.sanitize_cards(runtime, 'owner', 'pack', cards)
    assert service.sanitize_cards(runtime, 'owner', 'pack', [{'front': 'a', 'back': 'b'}]) == [{'front': 'a', 'back': 'b'}]


def test_many_picture_cards_validate_in_two_projected_batches_and_deduplicate_references(study_pictures):
    runtime, db, _, _ = study_pictures
    cards = []
    for index in range(165):
        aid = f'{index:064x}'
        db.data['study_images/' + aid] = {'uid': 'owner', 'pack_id': 'pack', 'ready': True, 'private_storage_path': 'not needed'}
        cards.append({'front': f'Card {index}', 'back': 'Answer', 'image_ids': [aid, aid]})

    cleaned = service.sanitize_cards(runtime, 'owner', 'pack', cards)

    assert [len(batch) for batch in db.metadata_batches] == [100, 65]
    assert len(cleaned) == 165
    assert cleaned[164]['image_ids'] == [f'{164:064x}']


@pytest.mark.parametrize('mutation', ['missing', 'foreign-user', 'foreign-pack', 'not-ready'])
def test_batched_picture_validation_keeps_every_authorization_check(study_pictures, mutation):
    runtime, db, _, _ = study_pictures
    aid = 'a' * 64
    asset = {'uid': 'owner', 'pack_id': 'pack', 'ready': True}
    if mutation == 'foreign-user': asset['uid'] = 'other'
    if mutation == 'foreign-pack': asset['pack_id'] = 'other'
    if mutation == 'not-ready': asset['ready'] = False
    if mutation != 'missing': db.data['study_images/' + aid] = asset

    with pytest.raises(BookError, match='does not belong'):
        service.sanitize_cards(runtime, 'owner', 'pack', [{'front': 'Card', 'back': 'Answer', 'image_ids': [aid]}])

    assert db.metadata_batches == [[aid]]


def test_cards_without_pictures_do_not_read_image_metadata(study_pictures):
    runtime, db, _, _ = study_pictures
    assert service.sanitize_cards(runtime, 'owner', 'pack', [{'front': 'Text', 'back': 'Only'}]) == [{'front': 'Text', 'back': 'Only'}]
    assert db.metadata_batches == []


def test_private_read_and_account_cleanup(study_pictures, monkeypatch):
    runtime, db, files, data = study_pictures
    image = service.save_image(runtime, 'owner', 'pack', data, 'muscle.png')
    monkeypatch.setattr(service, 'require_access', lambda *args, **kwargs: ('owner', None))
    with Flask(__name__).test_request_context('/?original=1') as context:
        response = service.get_image(runtime, context.request, 'pack', image['id'])
        response.direct_passthrough = False
        assert response.get_data() == data
        assert response.headers['Cache-Control'] == 'private, max-age=31536000, immutable'
        assert response.headers['X-Content-Type-Options'] == 'nosniff'
        with pytest.raises(BookError): service.get_image(runtime, context.request, 'other', image['id'])
    assert service.delete_owned(runtime, 'owner') == 1
    assert not files
    assert db.data['book_usage/storage']['bytes'] == 0


def test_nonpilot_and_unsigned_requests_are_rejected_before_pack_lookup(study_pictures, monkeypatch):
    runtime, _, _, _ = study_pictures
    monkeypatch.setattr(access_service, 'require_allowed_user', lambda *args, **_kwargs: (None, {'error': 'Unauthorized'}, 401))
    assert service.require_access(runtime, None, 'pack')[1][1] == 401
    monkeypatch.setattr(access_service, 'require_allowed_user', lambda *args, **_kwargs: ({'uid': 'owner'}, None, 0))
    monkeypatch.setattr(service, 'enabled', lambda *args: False)
    with Flask(__name__).app_context():
        assert service.require_access(runtime, None, 'pack')[1][1] == 403


@pytest.mark.parametrize('owner,expected', [('owner', None), ('someone-else', 403), (None, 404)])
def test_picture_access_checks_ownership_with_a_projected_owner_read(study_pictures, monkeypatch, owner, expected):
    runtime, db, _, _ = study_pictures
    monkeypatch.setattr(access_service, 'require_allowed_user', lambda *args, **_kwargs: ({'uid': 'owner'}, None, 0))
    monkeypatch.setattr(service, 'enabled', lambda *args: True)
    monkeypatch.setattr(study_api_support, 'get_owned_study_pack',
                        lambda *args: pytest.fail('Picture access must not read the whole study pack'))
    reads = []

    def owner_docs(_db, ids, transaction=None):
        reads.append(list(ids))
        payload = {'uid': owner} if owner else None
        return [SimpleNamespace(id=pack_id, exists=payload is not None, to_dict=lambda: dict(payload or {})) for pack_id in ids]

    monkeypatch.setattr(service.study_repo, 'get_study_pack_owner_docs', owner_docs)
    with Flask(__name__).app_context():
        uid, error = service.require_access(runtime, None, 'pack')
    assert reads == [['pack']]
    if expected is None:
        assert uid == 'owner' and error is None
    else:
        assert uid is None and error[1] == expected
        assert error[0].get_json()['error'] == ('Forbidden' if expected == 403 else 'Study pack not found')
