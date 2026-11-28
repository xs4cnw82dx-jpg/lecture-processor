"""Period comparisons for expeditions the signed-in Academy member may open."""
from collections import Counter
from datetime import date, datetime, time, timedelta
from heapq import nlargest
from statistics import median
from zoneinfo import ZoneInfo

from lecture_processor.domains.elearning import model, reporting
from lecture_processor.services import elearning_service as studio

ZONE = ZoneInfo('Europe/Amsterdam')
FIELDS = ['started_at', 'updated_at', 'completed', 'cohort', 'visitedStepIds', 'stepSeconds',
          'activeTimeDisclosure', 'pilotFeedback', 'stepComments']


def _midnight(day):
    return datetime.combine(day, time.min, ZONE).timestamp()


def _period(args, today):
    try:
        if args.get('from') or args.get('to'):
            start, end = (date.fromisoformat(args[key]) for key in ('from', 'to'))
            if not 0 <= (end - start).days < 365 or end > today:
                raise ValueError
        else:
            days = int(args.get('days', 30))
            if days not in (7, 30, 90):
                raise ValueError
            end, start = today, today - timedelta(days=days - 1)
    except (KeyError, TypeError, ValueError):
        raise model.ElearningError('Choose a valid dashboard period.', 400) from None
    return start, end


class PeriodStatistics:
    """Retain numeric observations needed for an exact median, without retaining learner records."""
    def __init__(self):
        self.total = 0
        self.completed = 0
        self.active = set()
        self.times = []

    def add(self, eid, row):
        self.total += 1
        self.active.add(eid)
        self.completed += bool(row.get('completed'))
        measurements = reporting.measured_seconds(row)
        if measurements:
            self.times.append(sum(measurements.values()))

    def summary(self):
        return dict(sessions=self.total, completed=self.completed,
                    completion=round(100 * self.completed / self.total, 1) if self.total else None,
                    medianSeconds=round(median(self.times)) if self.times else None,
                    measured=len(self.times), active=len(self.active))


def _stations(exp):
    return [dict(title=m.get('title') or {}, steps=len(m.get('steps') or [])) for m in exp.get('modules') or []]


def _drop(exp, transitions):
    best, change = None, 0
    for station in exp.get('modules') or []:
        if not station.get('visibleToLearners', True):
            continue
        for step in station.get('steps') or []:
            reached, left = transitions[step['id']]
            decline = left / reached if reached else 0
            if decline > change:
                change, best = decline, dict(title=step.get('title') or {}, percent=round(decline * 100, 1))
    return best


def _feedback(eid, title, row):
    pilot = row.get('pilotFeedback') or {}
    if pilot.get('comment'):
        yield dict(id=eid, title=title, comment=pilot['comment'], at=row.get('updated_at') or row['started_at'])
    for sc in row.get('stepComments') or []:
        if sc.get('comment'):
            yield dict(id=eid, title=title, comment=sc['comment'], step=sc.get('stepTitle') or '',
                       at=sc.get('createdAt') or row['started_at'])


def navigation(runtime):
    user, db, can_create, courses = studio.accessible_expeditions(runtime)
    admin = studio._is_studio_admin(runtime, user)
    items, people = [], set()
    for eid, exp, role in courses:
        if exp.get('deleted'):
            continue
        items.append(dict(type='course', course=eid, title=exp.get('title', ''), role=role))
        if role == 'owner':
            people.update(exp.get('members') or {})
        for station in exp.get('modules') or []:
            steps = station.get('steps') or []
            for kind, item, sid in [('station', station, steps[0]['id'] if steps else ''),
                                    *(('step', step, step['id']) for step in steps)]:
                titles = {k: v for k, v in (item.get('title') or {}).items() if k in ('nl', 'de') and v}
                if titles:
                    items.append(dict(type=kind, course=eid, parent=exp.get('title', ''), labels=titles,
                                      role=role, station=station['id'], step=sid))
    if admin:
        people.update(row['email'] for row in db.list('academy_authors', limit=None, fields=['email']) if row.get('email'))
    return dict(canCreate=can_create, studioAdmin=admin, items=items, people=sorted(people) if admin else [])


def dashboard(runtime, args):
    user, db, can_create, courses = studio.accessible_expeditions(runtime)
    start, end = _period(args, datetime.fromtimestamp(studio.now(), ZONE).date())
    days = (end - start).days + 1
    begin, stop, previous = _midnight(start), _midnight(end + timedelta(days=1)), _midnight(start - timedelta(days=days))
    cohort = args.get('cohort', '')
    current, prior = PeriodStatistics(), PeriodStatistics()
    feedback, entries, options = [], [], set()
    for eid, exp, role in courses:
        if exp.get('deleted'):
            continue
        entry = studio._summary_card(exp, role)
        entry.pop('shareToken', None)
        entry['stations'] = _stations(exp)
        entry['estimate'] = sum(m.get('estimatedMinutes') or 0 for m in exp.get('modules') or [] if m.get('visibleToLearners', True))
        entry['owner'] = exp.get('owner_email', '') if role == 'owner' else ''
        entries.append(entry)
        if role == 'translate':
            continue
        sessions = db.dashboard_sessions(eid, previous, stop, FIELDS)
        group = PeriodStatistics()
        ids = [step['id'] for station in exp.get('modules') or [] if station.get('visibleToLearners', True)
               for step in station.get('steps') or []]
        incoming, lost = Counter(), Counter()
        for row in sessions:
            name = row.get('cohort') or 'default'
            options.add(name)
            if cohort and cohort != name:
                continue
            if row['started_at'] < begin:
                prior.add(eid, row)
                continue
            group.add(eid, row)
            current.add(eid, row)
            visited = set(row.get('visitedStepIds') or [])
            # Compare the same sessions at both ends of each transition.
            for idx, sid in enumerate(ids):
                if idx == 0 or ids[idx - 1] in visited:
                    incoming[sid] += 1
                    lost[sid] += sid not in visited
            comments = list(_feedback(eid, entry['title'], row))
            if comments:
                feedback = nlargest(6, (*feedback, *comments), key=lambda item: item['at'])
        entry['metrics'] = group.summary()
        entry['drop'] = _drop(exp, {sid: (incoming[sid], lost[sid]) for sid in ids})

    return dict(canCreate=can_create, studioAdmin=studio._is_studio_admin(runtime, user),
                courses=sorted(entries, key=lambda c: c['updatedAt'], reverse=True),
                period={'from': start.isoformat(), 'to': end.isoformat()}, cohorts=sorted(options),
                current=current.summary(), previous=prior.summary(), feedback=feedback)
