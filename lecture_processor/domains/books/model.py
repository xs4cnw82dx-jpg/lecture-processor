"""Bounded, versioned, renderer-independent book documents (coordinates in mm)."""
from __future__ import annotations

import json
import math
import re
import uuid

WIDTH = 148.5
HEIGHT = 210
MAX_PAGES = 100
FONTS = {'Andika', 'Playpen Sans', 'Nunito', 'Comic Neue', 'Fraunces'}
TYPES = {'text', 'image', 'shape', 'arrow', 'table', 'flow', 'drawing'}


class BookError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def identifier(value):
    value = str(value or '')
    if not re.fullmatch(r'[a-zA-Z0-9_-]{1,100}', value):
        raise BookError('This book or page address is invalid.')
    return value


def new_id():
    return uuid.uuid4().hex


def text(value, limit=200):
    return str(value or '')[:limit]


def number(value, low, high, default=0):
    try:
        value = float(value)
    except (TypeError, ValueError):
        value = default
    return min(high, max(low, value)) if math.isfinite(value) else default


def color(value, default='#263343'):
    return value if isinstance(value, str) and re.fullmatch(r'#[a-fA-F0-9]{6}', value) else default


def array(value, limit, label='list'):
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > limit:
        raise BookError('This ' + label + ' is too large or could not be read.')
    return value


def style(raw):
    raw = raw if isinstance(raw, dict) else {}
    font = raw.get('font', 'Nunito')
    return {
        'font': font if isinstance(font, str) and font in FONTS else 'Nunito',
        'size': number(raw.get('size', 18), 6, 160, 18),
        'weight': number(raw.get('weight', 400), 100, 1000, 400),
        'color': color(raw.get('color')),
        'italic': bool(raw.get('italic')), 'underline': bool(raw.get('underline')),
        'align': raw.get('align') if raw.get('align') in ('left', 'center', 'right') else 'left',
        'lineHeight': number(raw.get('lineHeight', 1.4), 0.8, 3, 1.4),
        'letterSpacing': number(raw.get('letterSpacing', 0), -2, 10),
        'outline': number(raw.get('outline', 0), 0, 4),
        'highlight': color(raw.get('highlight'), '#ffffff'),
        'highlightOn': bool(raw.get('highlightOn')),
    }


def item(raw):
    if not isinstance(raw, dict) or not isinstance(raw.get('type'), str) or raw.get('type') not in TYPES:
        raise BookError('One of the objects could not be read.')
    result = {
        'id': identifier(raw.get('id')), 'type': raw['type'],
        'x': number(raw.get('x'), -WIDTH, WIDTH * 2),
        'y': number(raw.get('y'), -HEIGHT, HEIGHT * 2),
        'w': number(raw.get('w'), 0.2, WIDTH * 2, 50),
        'h': number(raw.get('h'), 0.2, HEIGHT * 2, 30),
        'rotation': number(raw.get('rotation'), -360, 360),
        'opacity': number(raw.get('opacity', 1), 0, 1, 1),
        'locked': bool(raw.get('locked')), 'hidden': bool(raw.get('hidden')),
        'group': text(raw.get('group'), 100), 'name': text(raw.get('name'), 100),
        'fill': color(raw.get('fill'), '#c9def0'),
        'stroke': color(raw.get('stroke'), '#4f46e5'),
        'strokeWidth': number(raw.get('strokeWidth', 1), 0, 12, 1),
        'shape': raw.get('shape') if raw.get('shape') in ('rounded', 'circle', 'triangle', 'pentagon', 'square', 'diamond', 'pill', 'parallelogram', 'arrow-right') else 'rounded',
        'style': style(raw.get('style')),
        'text': text(raw.get('text'), 12000),
        'runs': [], 'points': [],
        'tableHeader': raw.get('tableHeader') is not False,
        'tableStriped': raw.get('tableStriped') is not False,
        'tableRounded': raw.get('tableRounded') is not False,
        'flowDirection': 'vertical' if raw.get('flowDirection') == 'vertical' else 'horizontal',
        'flowShape': raw.get('flowShape') if raw.get('flowShape') in ('rounded', 'pill', 'square') else 'rounded',
        'arrowHead': raw.get('arrowHead') if raw.get('arrowHead') in ('none', 'end', 'both') else 'end',
        'arrowLine': 'dashed' if raw.get('arrowLine') == 'dashed' else 'solid',

        'assetId': identifier(raw['assetId']) if raw.get('assetId') else '',
        'originalAssetId': identifier(raw['originalAssetId']) if raw.get('originalAssetId') else '',
        'aspectLock': raw.get('aspectLock') is not False,
        'fit': 'cover' if raw.get('fit') == 'cover' else 'contain',
        'cropX': number(raw.get('cropX', 50), 0, 100, 50),
        'cropY': number(raw.get('cropY', 50), 0, 100, 50),
        'mask': raw.get('mask') if raw.get('mask') in ('none', 'circle', 'rounded') else 'none',
        'feather': number(raw.get('feather'), 0, 20),
        'spanId': text(raw.get('spanId'), 100), 'spanSide': text(raw.get('spanSide'), 10),
        'brush': raw.get('brush') if raw.get('brush') in ('pen', 'pencil', 'highlighter') else 'pen',
        'styleName': raw.get('styleName') if raw.get('styleName') in ('heading', 'body', 'caption') else '',
    }
    for run in array(raw.get('runs'), 500, 'text'):
        if isinstance(run, dict):
            result['runs'].append({'text': text(run.get('text'), 12000), 'style': style(run.get('style'))})
    if sum(len(run['text']) for run in result['runs']) > 12000:
        raise BookError('This text box is too long. Split it into smaller text boxes.')
    for point in array(raw.get('points'), 3000, 'drawing'):
        if isinstance(point, list) and len(point) >= 2:
            result['points'].append([number(point[0], 0, WIDTH * 2), number(point[1], 0, HEIGHT * 2), number(point[2] if len(point) > 2 else .5, .05, 1, .5)])
    result['cells'] = [[text(cell, 2000) for cell in row[:8]] for row in array(raw.get('cells'), 8, 'table') if isinstance(row, list)]
    result['steps'] = [text(step, 400) for step in array(raw.get('steps'), 8, 'diagram')]
    return result


def page(raw):
    if not isinstance(raw, dict):
        raise BookError('This page could not be read.')
    objects = raw.get('items') or []
    if not isinstance(objects, list) or len(objects) > 300:
        raise BookError('A page can contain up to 300 objects.')
    result = {
        'id': identifier(raw.get('id')), 'title': text(raw.get('title'), 100),
        'role': raw.get('role') if raw.get('role') in ('front', 'back', 'page') else 'page',
        'background': color(raw.get('background'), '#fffdf7'),
        'texture': raw.get('texture') if raw.get('texture') in ('plain', 'grain', 'lined', 'dots', 'grid') else 'plain',
        'items': [item(obj) for obj in objects],
    }
    if len({obj['id'] for obj in result['items']}) != len(objects):
        raise BookError('Objects must have unique identifiers.')
    if len(json.dumps(result).encode()) > 600_000:
        raise BookError('This page is too detailed to save. Split the drawing across pages.')
    return result


def metadata(raw):
    raw = raw if isinstance(raw, dict) else {}
    styles = raw.get('styles') if isinstance(raw.get('styles'), dict) else {}
    illustration = raw.get('illustration') if isinstance(raw.get('illustration'), dict) else {}
    return {
        'title': text(raw.get('title'), 150).strip() or 'Untitled book',
        'folder': text(raw.get('folder'), 80),
        'tags': [text(tag, 40) for tag in array(raw.get('tags'), 12, 'tag list')],
        'favorite': bool(raw.get('favorite')),
        'palette': [color(c) for c in array(raw.get('palette') or ['#4f46e5', '#c9def0', '#f6d6a8', '#263343'], 12, 'palette')],
        'styles': {key: style(styles.get(key)) for key in ('heading', 'body', 'caption')},
        'illustration': {
            'style': text(illustration.get('style', 'soft pencil and watercolor'), 200),
            'characters': text(illustration.get('characters'), 2000),
            'space': text(illustration.get('space', 'upper third'), 100),
            'blend': illustration.get('blend') is not False,
            'transparent': illustration.get('transparent') is not False,
        },
    }


def validate_order(ids):
    if not isinstance(ids, list) or not 4 <= len(ids) <= MAX_PAGES:
        raise BookError('A book needs a cover, at least two inside pages and a back cover (up to 100 pages).')
    result = [identifier(pid) for pid in ids]
    if len(set(result)) != len(result):
        raise BookError('Each page must appear only once in the book.')
    return result


def validate_spans(pages):
    spans = {}
    for index, page in enumerate(pages):
        for obj in page['items']:
            if obj.get('spanId'):
                spans.setdefault(obj['spanId'], []).append((index, obj.get('spanSide')))
    for halves in spans.values():
        if len(halves) != 2 or halves[0][0] % 2 != 1 or halves != [(halves[0][0], 'left'), (halves[0][0] + 1, 'right')]:
            raise BookError('Keep both halves of a spread illustration together, or split the illustration first.')


def sheets(pages, arrangement='cut'):
    """Return logical page indices for each landscape sheet side. None is blank."""
    n = len(pages)
    if arrangement == 'fold':
        order = list(range(n - 1))
        while (len(order) + 1) % 4:
            order.append(None)
        order.append(n - 1)
        total = len(order)
        pairs = []
        for offset in range(total // 4):
            pairs.extend([(order[total - 1 - offset * 2], order[offset * 2]),
                          (order[offset * 2 + 1], order[total - 2 - offset * 2])])
        return pairs
    pairs = [(None, 0)]
    inside = list(range(1, n - 1))
    for offset in range(0, len(inside), 2):
        pairs.append((inside[offset], inside[offset + 1] if offset + 1 < len(inside) else None))
    pairs.append((n - 1, None))
    return pairs
