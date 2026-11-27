"""Personal course folders for the standalone Academy."""
from flask import Blueprint, jsonify, request
from google.api_core.exceptions import GoogleAPICallError

from lecture_processor.domains.account import lifecycle
from lecture_processor.domains.elearning import model
from lecture_processor.runtime.container import get_runtime
from lecture_processor.services import elearning_service as studio

academy_folders_bp = Blueprint('academy_folders', __name__, url_prefix='/api/academy')
REVIEW_FOLDER = 'account-review'


@academy_folders_bp.errorhandler(model.ElearningError)
def _declined(error):
    return jsonify(error=str(error)), error.status


@academy_folders_bp.errorhandler(GoogleAPICallError)
def _unavailable(_error):
    return jsonify(error='Cloud saving is temporarily unavailable. Please try again in a moment.'), 503


def _author(unit, runtime, user):
    studio._require_author(runtime, user, unit)
    uid = user['uid']
    profile = unit.get('users/' + uid) or {}
    deletion = unit.get(lifecycle.ACCOUNT_DELETIONS_COLLECTION + '/' + uid)
    if profile.get('account_status') in ('deleting', 'deleted') or (deletion and deletion.get('status') != 'cancelled'):
        raise model.ElearningError('This account is being removed.', 409)


def _name():
    name = studio.payload().get('name')
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > 80:
        raise model.ElearningError('Enter a folder name of 1 to 80 characters.', 400)
    if name.strip().casefold() == 'account review':
        raise model.ElearningError('Choose a different folder name. Account review is reserved.', 400)
    return name.strip()


@academy_folders_bp.post('/folders')
def create_folder():
    runtime = get_runtime()
    user = studio.identity(runtime, required=True)
    name = _name()
    folder_id = model.new_id('folder')
    path = f"academy_users/{user['uid']}/folders/{folder_id}"

    def create(unit):
        _author(unit, runtime, user)
        if unit.get(path):
            raise model.ElearningError('Please try creating this folder again.', 409)
        unit.put(path, {'name': name})

    studio._store(runtime).atomic(create)
    return jsonify(id=folder_id), 201


@academy_folders_bp.route('/folders/<folder_id>', methods=['PATCH', 'DELETE'])
def edit_folder(folder_id):
    runtime = get_runtime()
    user = studio.identity(runtime, required=True)
    folder_id = model.identifier(folder_id, 'folder')
    if folder_id == REVIEW_FOLDER:
        raise model.ElearningError('Account review is a reserved Studio folder.', 403)
    path = f"academy_users/{user['uid']}/folders/{folder_id}"
    remove = request.method == 'DELETE'
    name = None if remove else _name()
    db = studio._store(runtime)

    def change(unit):
        _author(unit, runtime, user)
        folder = unit.get(path)
        if not folder:
            raise model.ElearningError('This folder is unavailable.', 404)
        if not remove and folder.get('deleting'):
            raise model.ElearningError('This folder is being removed.', 409)
        unit.put(path, {**folder, **({'deleting': True} if remove else {'name': name})})

    db.atomic(change)
    if remove:
        # Closing the folder to incoming moves first makes cleanup resumable, even
        # for libraries larger than one Firestore write batch.
        def unfile(unit):
            current = unit.get(course_path)
            if current and current.get('owner_uid') == user['uid'] and current.get('folder_id') == folder_id:
                current.pop('folder_id')
                unit.put(course_path, current)

        for course in db.list('elearning_expeditions', 'folder_id', folder_id, limit=None, fields=['owner_uid']):
            if course.get('owner_uid') == user['uid']:
                course_path = studio._exp_path(course['_id'])
                db.atomic(unfile)
        db.delete(path)
    return jsonify(ok=True)


@academy_folders_bp.put('/expeditions/<expedition_id>/folder')
def move_course(expedition_id):
    runtime = get_runtime()
    user = studio.identity(runtime, required=True)
    folder_id = studio.payload().get('folderId')
    if not isinstance(folder_id, str):
        raise model.ElearningError('Choose a folder or Unfiled.', 400)
    if folder_id:
        folder_id = model.identifier(folder_id, 'folder')
    path = studio._exp_path(expedition_id)

    def move(unit):
        _author(unit, runtime, user)
        course = unit.get(path)
        if not course or course.get('owner_uid') != user['uid'] or course.get('deleted') or course.get('copying'):
            raise model.ElearningError('This expedition is unavailable.', 404)
        if folder_id:
            folder = unit.get(f"academy_users/{user['uid']}/folders/{folder_id}")
            if not folder or folder.get('deleting') or (
                folder_id == REVIEW_FOLDER and not studio._is_studio_admin(runtime, user)
            ):
                raise model.ElearningError('This folder is unavailable.', 404)
            course['folder_id'] = folder_id
        else:
            course.pop('folder_id', None)
        unit.put(path, course)

    studio._store(runtime).atomic(move)
    return jsonify(ok=True)
