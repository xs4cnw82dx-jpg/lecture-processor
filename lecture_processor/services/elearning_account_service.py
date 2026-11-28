"""Include authored expeditions in account exports and deletion."""
from lecture_processor.domains.elearning import reporting
from lecture_processor.repositories.elearning_repo import ElearningStore
from lecture_processor.services import elearning_storage


def collect(runtime, uid):
    db = ElearningStore(runtime.db)
    courses = []
    for doc in db.list('elearning_expeditions', 'owner_uid', uid, limit=None):
        if doc.get('deleted'):
            continue
        eid = doc['id']
        course = {k: v for k, v in doc.items() if k not in ('_id', 'lease', 'member_emails', 'asset_bytes', 'share', '_statisticsReset')}
        course['share'] = {k: v for k, v in doc.get('share', {}).items() if k != 'token'}
        course['assets'] = [{k: asset[k] for k in ('id', 'kind', 'size', 'content_type') if k in asset}
                            for asset in db.list('elearning_assets', 'expedition_id', eid, limit=None)
                            if asset.get('ready', True)]
        course['responses'] = [{k: v for k, v in row.items() if k not in ('_id', 'share_token', 'statisticsScope')}
                               for row in db.list('elearning_responses', *reporting.response_scope(doc), limit=None)]
        courses.append(course)
    return courses


def add_bundle_assets(runtime, archive, courses):
    if not courses:
        return
    db = ElearningStore(runtime.db)
    for course in courses:
        for asset in course['assets']:
            meta = db.get('elearning_assets/' + asset['id'])
            if meta and meta.get('expedition_id') == course['id']:
                archive.writestr('elearning/' + course['id'] + '/assets/' + asset['id'],
                                 elearning_storage.read_asset(db, meta))


def delete_owned(runtime, uid, email):
    db = ElearningStore(runtime.db)
    erased = 0
    while owned := db.list('elearning_expeditions', 'owner_uid', uid, limit=25):
        for row in owned:
            elearning_storage.delete_expedition(db, row['id'], uid)
            erased += 1
    email = (email or '').strip().lower()
    if email:
        def remove_member(tx, eid):
            path = 'elearning_expeditions/' + eid
            current = tx.get(path)
            if not current:
                return
            members = current.get('members') or {}
            members.pop(email, None)
            current.update(members=members, member_emails=sorted(members))
            if (current.get('lease') or {}).get('user_id') == uid:
                current['lease'] = {}
            tx.put(path, current)

        while shared := db.list('elearning_expeditions', 'member_emails', email, 'array_contains', limit=25):
            for row in shared:
                db.atomic(lambda tx, eid=row['id']: remove_member(tx, eid))
    # Media belongs to its expedition. Erasing a co-author removes the attribution
    # without breaking another owner's course.
    def clear_uploader(tx, aid):
        path = 'elearning_assets/' + aid
        asset = tx.get(path)
        if asset and asset.get('uploaded_by') == uid:
            asset.pop('uploaded_by')
            tx.put(path, asset)

    while assets := db.list('elearning_assets', 'uploaded_by', uid, limit=100):
        for asset in assets:
            db.atomic(lambda tx, aid=asset['id']: clear_uploader(tx, aid))
    return erased
