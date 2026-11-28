"""Authenticated course and team views for the Academy."""
from flask import Blueprint, jsonify, render_template, request
from google.api_core.exceptions import GoogleAPICallError

from lecture_processor.domains.elearning import model
from lecture_processor.runtime.container import get_runtime
from lecture_processor.services import elearning_service as studio

collaboration = Blueprint('academy_collaboration', __name__, url_prefix='/api/academy')


@collaboration.errorhandler(model.ElearningError)
def rejected(error):
    return jsonify(error=str(error)), error.status


@collaboration.errorhandler(GoogleAPICallError)
def unavailable(_error):
    return jsonify(error='De gegevens zijn tijdelijk niet beschikbaar.'), 503


@collaboration.get('/courses/<expedition_id>/workspace')
def workspace(expedition_id):
    _, course, role, _, target = studio.access(get_runtime(), expedition_id, required='translate')
    language = target or ('nl' if course.get('defaultLanguage') == 'de' else 'de')
    rows = model.extract_translation_rows(course, course.get('defaultLanguage', 'nl'), language)
    return jsonify(
        course=studio._public_studio_view(course, role, target),
        coverage=model.compute_language_coverage(course), target=language, translations=rows,
        html=render_template('academy/course_controls.html', role=role, expedition_id=expedition_id),
    )


@collaboration.get('/team')
def team():
    runtime = get_runtime()
    admin = studio._require_studio_admin(runtime)
    db = studio._store(runtime)
    admin_email = studio._verified_member_email(admin)
    people = {admin_email: {'email': admin_email, 'author': True, 'admin': True, 'courses': []}}
    for invite in db.list('academy_authors', limit=None, fields=['email']):
        email = invite.get('email')
        if email and email != admin_email:
            people[email] = {'email': email, 'author': True, 'courses': []}
    courses = []
    for course in db.stream('elearning_expeditions', 'owner_uid', admin['uid'], limit=None,
                            fields=['id', 'title', 'members', 'deleted', 'copying']):
        if course.get('deleted') or course.get('copying'):
            continue
        item = {'id': course.get('id') or course['_id'], 'title': course.get('title', '')}
        courses.append(item)
        people[admin_email]['courses'].append({**item, 'role': 'owner'})
        for email, role in (course.get('members') or {}).items():
            if email == admin_email or role not in ('edit', 'translate'):
                continue
            person = people.setdefault(email, {'email': email, 'courses': []})
            person['courses'].append({**item, 'role': role})
    profiles = runtime.academy_team_profiles(list(people))
    for email, person in people.items():
        person.update((profiles or {}).get(email, {}))
    return jsonify(people=list(people.values()), courses=courses, profilesAvailable=profiles is not None, html=render_template('academy/team_controls.html'))


@collaboration.post('/team/invitations')
def invite():
    runtime = get_runtime()
    admin = studio._require_studio_admin(runtime)
    request.max_content_length = 12000
    data = studio.payload()
    email = model.safe_email(data.get('email'))
    role = data.get('role')
    if email == studio._verified_member_email(admin) or role not in ('author', 'edit', 'translate'):
        raise model.ElearningError('Kies een geldig e-mailadres en een rol.', 400)
    ids = data.get('courses', [])
    if not isinstance(ids, list) or len(ids) > 100 or (role != 'author' and not ids):
        raise model.ElearningError('Kies ten minste één en maximaal 100 expedities voor deze rol.', 400)
    course_ids = list(dict.fromkeys(model.identifier(value, 'expedition id') for value in ids))

    def apply(unit):
        # Firestore transactions read and validate every course before writing any invitation.
        selected = []
        for course_id in course_ids:
            _, course, _, _, _ = studio.access(runtime, course_id, required='owner', unit=unit)
            members = dict(course.get('members') or {})
            if len(members) >= 20 and email not in members:
                raise model.ElearningError('Een expeditie heeft al 20 teamleden.', 409)
            members[email] = 'translate' if role == 'translate' else 'edit'
            selected.append((course_id, course, members))
        studio._allow_invitation(runtime, unit, email)
        if role == 'author':
            unit.put(studio._author_key(email), {'email': email})
        for course_id, course, members in selected:
            course.update(members=members, member_emails=sorted(members), updated_at=studio.now())
            course.pop('_memberUndo', None)
            unit.put(studio._exp_path(course_id), course)
    studio._store(runtime).atomic(apply)
    return jsonify(ok=True), 201
