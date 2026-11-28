"""Academy reporting over consented response rows and the current course outline."""
from collections import Counter
import csv
from datetime import date, datetime, time, timedelta, timezone
import io
import json
import math
import re

from werkzeug.utils import secure_filename
from lecture_processor.domains.shared import sanitize_csv_row


MAX_STEP_SECONDS = 4 * 60 * 60
MAX_REVISION_WEEKS = 52


def period_bounds(args, now):
    def midnight(key):
        try:
            day = date.fromisoformat(args.get(key, ''))
            if key == 'to':
                day += timedelta(days=1)
            return datetime.combine(day, time.min, tzinfo=timezone.utc).timestamp()
        except (ValueError, OverflowError, OSError):
            return None

    start, end = midnight('from'), midnight('to')
    if start is None and end is None and args.get('days') in ('7', '30', '90'):
        start = now - int(args['days']) * 86400
    return start, end


def filter_responses(rows, args, now):
    cohorts = set(filter(None, args.getlist('cohort')))
    language = (args.get('language') or '').lower()
    start, end = period_bounds(args, now)
    def matches(row):
        stamp = row.get('started_at') or row.get('updated_at') or 0
        return ((not cohorts or (row.get('cohort') or 'default') in cohorts)
                and (not language or row.get('language') == language)
                and (start is None or stamp >= start)
                and (end is None or stamp < end))
    return [row for row in rows if matches(row)]


def merge_seconds(stored, reported, steps):
    merged = {sid: min(value, MAX_STEP_SECONDS) for sid, value in (stored or {}).items()
              if sid in steps and type(value) is int and value > 0}
    if isinstance(reported, dict):
        for sid, value in reported.items():
            if sid not in steps or type(value) not in (int, float) or value < 1:
                continue
            if type(value) is float and not math.isfinite(value):
                continue
            merged[sid] = max(merged.get(sid, 0), int(min(value, MAX_STEP_SECONDS)))
    return merged


def measured_seconds(row):
    if row.get('activeTimeDisclosure') != 1:
        return {}
    return {sid: min(seconds, MAX_STEP_SECONDS) for sid, seconds in (row.get('stepSeconds') or {}).items()
            if type(seconds) is int and seconds > 0}


def quartiles(values):
    ordered = sorted(v for v in values if v > 0)
    if not ordered:
        return None

    def at(fraction):
        position = (len(ordered) - 1) * fraction
        low, high = math.floor(position), math.ceil(position)
        return round(ordered[low] + (ordered[high] - ordered[low]) * (position - low))

    return {'median': at(.5), 'p25': at(.25), 'p75': at(.75), 'count': len(ordered)}


def _monday(ts):
    day = datetime.fromtimestamp(ts, tz=timezone.utc).date()
    return day - timedelta(days=day.weekday())


def record_public_revision(course, ts):
    """Keep a bounded, non-personal marker for the last public revision of each UTC week."""
    if not (course.get('share') or {}).get('enabled'):
        return
    week = _monday(ts).isoformat()
    markers = {entry['week']: entry for entry in course.get('publicRevisionWeeks', [])}
    markers[week] = {'week': week, 'revision': course.get('revision', 1), 'at': int(ts)}
    course['publicRevisionWeeks'] = [markers[key] for key in sorted(markers)[-MAX_REVISION_WEEKS:]]


def weekly_activity(rows, markers, now, since, until):
    started, completed = Counter(), Counter()
    for row in rows:
        stamp = row.get('started_at') or row.get('updated_at')
        if stamp:
            week = _monday(stamp)
            started[week] += 1
            if row.get('completed'):
                completed[week] += 1
    if not started:
        return []
    end = _monday(min(now, until - 1) if until is not None else now)
    first = max(_monday(since) if since else min(started), end - timedelta(weeks=25))
    marks = {entry['week']: entry for entry in markers if (not since or entry['at'] >= since) and (not until or entry['at'] < until)}
    result = []
    while first <= end:
        key = first.isoformat()
        result.append({'week': key, 'started': started[first], 'completed': completed[first], 'revision': marks.get(key)})
        first += timedelta(weeks=1)
    return result


def _grade(block, answer):
    data = block.get('data') or {}
    if block['type'] == 'myth_fact':
        return answer == data.get('correctAnswer', 'myth')
    if block['type'] == 'mcq' and data.get('graded'):
        correct = {opt['id'] for opt in data.get('options', []) if opt.get('isCorrect')}
        selected = set(answer if isinstance(answer, list) else [answer])
        return selected == correct if correct else None
    return None


def course_metrics(course, rows, funnel, block_stats):
    """Reach, progression and drop-off use sets of the same sessions, even when steps were skipped."""
    modules = course.get('modules', [])
    order = [step for module in modules for step in module.get('steps', [])]
    positions = {step['id']: n for n, step in enumerate(order)}
    visitors = {sid: set() for sid in positions}
    continued = {sid: set() for sid in positions}
    comments, scores, graded = Counter(), Counter(), Counter()
    times = [measured_seconds(row) for row in rows]
    correct_by_block, answered_by_block = Counter(), Counter()
    questions = {block['id']: (step['id'], block) for step in order for block in step.get('blocks', [])
                 if block['type'] in ('myth_fact', 'mcq')}
    for ordinal, row in enumerate(rows):
        visited = set(positions).intersection(row.get('visitedStepIds') or [])
        furthest = max((positions[sid] for sid in visited), default=-1)
        for sid in visited:
            visitors[sid].add(ordinal)
            if row.get('completed') or positions[sid] < furthest:
                continued[sid].add(ordinal)
        for note in row.get('stepComments') or []:
            if note.get('comment'):
                comments[note.get('stepId')] += 1
        for bid, answer in (row.get('answers') or {}).items():
            if bid in questions:
                sid, block = questions[bid]
                correct = _grade(block, answer)
                if correct is not None:
                    scores[sid] += int(correct)
                    graded[sid] += 1
                    correct_by_block[bid] += int(correct)
                    answered_by_block[bid] += 1
    for bid, count in answered_by_block.items():
        block_stats[bid]['gradedAnswers'] = count
        block_stats[bid]['correctAnswers'] = correct_by_block[bid]
    previous = None
    for line in funnel:
        sid = line['stepId']
        line.update(continued=len(continued[sid]), previousReached=len(previous) if previous is not None else None,
                    lostFromPrevious=len(previous - visitors[sid]) if previous is not None else None,
                    comments=comments[sid], correctAnswers=scores[sid], gradedAnswers=graded[sid],
                    time=quartiles(value.get(sid, 0) for value in times))
        previous = visitors[sid]
    stations = []
    for module in modules:
        ids = [step['id'] for step in module.get('steps', [])]
        reached = set().union(*(visitors[sid] for sid in ids))
        advanced = continued[ids[-1]] if ids else set()
        totals = [sum(value.get(sid, 0) for sid in ids) for value in times]
        stations.append(dict(activeSecondsTotal=sum(totals), moduleId=module['id'], moduleTitle=module.get('title', {}), reached=len(reached),
                             continued=len(advanced), lost=len(reached - advanced),
                             comments=sum(comments[sid] for sid in ids), correctAnswers=sum(scores[sid] for sid in ids),
                             gradedAnswers=sum(graded[sid] for sid in ids), estimatedMinutes=module.get('estimatedMinutes'),
                             time=quartiles(totals)))
    active = quartiles(sum(value.get(sid, 0) for sid in positions) for value in times)
    return {'activeSeconds': active, 'timedSessions': active['count'] if active else 0}, stations


def _export_rows(course, rows):
    modules = [(module['id'], [s['id'] for s in module.get('steps', [])]) for module in course.get('modules', [])]
    step_ids = [sid for _, ids in modules for sid in ids]
    block_ids = [b['id'] for m in course.get('modules', []) for s in m.get('steps', []) for b in s.get('blocks', [])
                 if b['type'] in ('mcq','myth_fact','scale','reflection','wordcloud','ranking','balance_scale','mini_plan','hotspot')]
    yield (['session_id','cohort','language','completed','clarity','engagement','pilot_comment','active_seconds']
           + ['station_seconds_' + mid for mid, _ in modules] + ['seconds_' + sid for sid in step_ids] + block_ids)
    for row in rows:
        pf, answers = row.get('pilotFeedback') or {}, row.get('answers') or {}
        seconds = measured_seconds(row)
        active = sum(seconds.get(sid, 0) for sid in step_ids)
        data = [row.get('session_id',''),row.get('cohort','default'),row.get('language','nl'),
                'yes' if row.get('completed') else 'no',pf.get('clarity',''),pf.get('engagement',''),pf.get('comment',''),active or '']
        data.extend(sum(seconds.get(sid, 0) for sid in ids) or '' for _, ids in modules)
        data.extend(seconds.get(sid,'') for sid in step_ids)
        for bid in block_ids:
            answer = answers.get(bid, '')
            data.append(json.dumps(answer, ensure_ascii=False) if isinstance(answer, (list, dict)) else answer)
        yield data


def export_file(course, rows, extension, now):
    title = secure_filename(course.get('title') or '') or 'expeditie'
    basename = re.sub(r'[^a-z0-9]+', '-', title.lower()).strip('-') or 'expeditie'
    day = datetime.fromtimestamp(now, timezone.utc).date().isoformat()
    data = _export_rows(course, rows)
    if extension == 'xlsx':
        from openpyxl import Workbook
        from openpyxl.cell import WriteOnlyCell
        from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE

        book = Workbook(write_only=True)
        sheet = book.create_sheet('Resultaten')
        sheet.freeze_panes = 'D2'
        for row in data:
            cells = []
            for value in row:
                if isinstance(value, str):
                    cell = WriteOnlyCell(sheet, value=ILLEGAL_CHARACTERS_RE.sub('', value))
                    cell.data_type = 's'
                    cells.append(cell)
                else:
                    cells.append(value)
            sheet.append(cells)
        payload = io.BytesIO()
        book.save(payload)
        payload.seek(0)
        media = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    else:
        text = io.StringIO(newline='')
        writer = csv.writer(text, delimiter=';')
        for row in data:
            writer.writerow(sanitize_csv_row(row))
        payload = io.BytesIO(text.getvalue().encode('utf-8-sig'))
        media = 'text/csv; charset=utf-8'
    return payload, media, f'{basename}_resultaten_{day}.{extension}'
