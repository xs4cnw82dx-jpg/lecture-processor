"""Validation, localization, media parsing, and schema models for xPEDitie Pijn E-Learning."""
from __future__ import annotations

import csv
import io
import re
import secrets
from copy import deepcopy
from urllib.parse import parse_qs, urlparse
from xml.etree import ElementTree as ET

from lecture_processor.domains.shared import sanitize_csv_row

SCHEMA_VERSION = 1
SUPPORTED_LANGUAGES = ('nl', 'en', 'de')
VALID_DOMAINS = ('bio', 'psycho', 'social', 'general')
VALID_STATUSES = ('empty', 'draft', 'review', 'ready')
VALID_ROLES = ('owner', 'edit', 'translate')
VALID_THEMES = ('xped-warm-sand', 'xped-clean', 'high-contrast')
VALID_STEP_LAYOUTS = ('focused', 'scroll')
VALID_IMAGE_LAYOUTS = ('full', 'split-left', 'split-right', 'framed')
VALID_CALLOUT_TONES = ('bio', 'psycho', 'social', 'tip')
VALID_BLOCK_TYPES = (
    'richtext',
    'video',
    'image',
    'audio',
    'callout',
    'story',
    'sources',
    'mcq',
    'myth_fact',
    'scale',
    'reflection',
    'wordcloud',
    'ranking',
    'hotspot',
    'balance_scale',
    'bps_triad',
    'mini_plan',
    'custom_visual',
)

MAX_MODULES = 30
MAX_STEPS_PER_MODULE = 40
MAX_BLOCKS_PER_STEP = 25
MAX_OPTIONS = 20

_ID_RE = re.compile(r'^[a-zA-Z0-9_-]{2,80}$')
_YT_ID_RE = re.compile(r'^[a-zA-Z0-9_-]{11}$')
_VIMEO_ID_RE = re.compile(r'^\d{5,15}$')
_SAFE_XPED_ASSET_RE = re.compile(r'^/static/images/xped/[a-zA-Z0-9_.-]+\.(?:png|svg|webp|jpg)$')
_EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')


class ElearningError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def new_id(prefix: str = 'el') -> str:
    return f'{prefix}_{secrets.token_urlsafe(8).replace("-", "").replace("_", "")[:12]}'


def identifier(value: object, label: str = 'identifier') -> str:
    raw = str(value or '').strip()
    if not _ID_RE.fullmatch(raw):
        raise ElearningError(f'Invalid {label}.', 400)
    return raw


def safe_text(value: object, max_len: int = 4000) -> str:
    if value is None:
        return ''
    text = str(value).replace('\r\n', '\n').replace('\r', '\n')
    return text[:max_len]


def safe_email(value: object) -> str:
    raw = str(value or '').strip().lower()
    if not _EMAIL_RE.fullmatch(raw) or len(raw) > 254:
        raise ElearningError('Enter a valid email address.', 400)
    return raw


def normalize_lang(value: object, default: str = 'nl') -> str:
    raw = str(value or '').strip().lower()
    if raw in SUPPORTED_LANGUAGES:
        return raw
    for lang in SUPPORTED_LANGUAGES:
        if raw.startswith(lang + '-') or raw.startswith(lang + '_'):
            return lang
    return default


def normalize_localized(raw: object, max_len: int = 4000, default_lang: str = 'nl') -> dict:
    """Normalize a string or localized dict into {nl, en, de, _review}."""
    result: dict = {'nl': '', 'en': '', 'de': ''}
    review: dict[str, bool] = {}
    if isinstance(raw, str):
        result[normalize_lang(default_lang)] = safe_text(raw, max_len)
    elif isinstance(raw, dict):
        for lang in SUPPORTED_LANGUAGES:
            result[lang] = safe_text(raw.get(lang, ''), max_len)
        raw_review = raw.get('_review')
        if isinstance(raw_review, dict):
            for lang in SUPPORTED_LANGUAGES:
                if raw_review.get(lang):
                    review[lang] = True
    if review:
        result['_review'] = review
    return result


def parse_timestamp_seconds(raw: object) -> int | None:
    if raw is None or raw == '':
        return None
    if isinstance(raw, (int, float)):
        val = int(raw)
        return val if 0 <= val <= 86400 else None
    text = str(raw).strip().lower()
    if not text:
        return None
    if text.isdigit():
        val = int(text)
        return val if 0 <= val <= 86400 else None
    match = re.fullmatch(r'(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?', text)
    if match and any(match.groups()):
        h = int(match.group(1) or 0)
        m = int(match.group(2) or 0)
        s = int(match.group(3) or 0)
        total = h * 3600 + m * 60 + s
        return total if 0 <= total <= 86400 else None
    colon = re.fullmatch(r'(\d+):(\d{1,2})(?::(\d{1,2}))?', text)
    if colon:
        parts = [int(p) for p in colon.groups() if p is not None]
        total = parts[0] * 3600 + parts[1] * 60 + parts[2] if len(parts) == 3 else parts[0] * 60 + parts[1]
        return total if 0 <= total <= 86400 else None
    return None


def parse_video_url(raw_url: object) -> dict:
    """Parse a YouTube or Vimeo URL into a safe embed descriptor."""
    url = safe_text(raw_url, 500).strip()
    if not url:
        return {'provider': '', 'videoId': '', 'embedUrl': '', 'startSeconds': None}
    parsed = urlparse(url)
    if parsed.scheme not in ('http', 'https'):
        raise ElearningError('Video URL must start with https:// (YouTube or Vimeo).', 400)
    host = (parsed.hostname or '').lower()
    qs = parse_qs(parsed.query)
    start_hint = parse_timestamp_seconds((qs.get('t') or qs.get('start') or [None])[0])

    video_id = ''
    provider = ''
    if host in ('youtu.be', 'www.youtu.be'):
        candidate = parsed.path.strip('/').split('/')[0]
        if _YT_ID_RE.fullmatch(candidate):
            provider, video_id = 'youtube', candidate
    elif host in ('youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'):
        if parsed.path.startswith('/watch'):
            candidate = (qs.get('v') or [''])[0]
        elif parsed.path.startswith(('/embed/', '/shorts/', '/live/')):
            candidate = parsed.path.strip('/').split('/')[1] if len(parsed.path.strip('/').split('/')) > 1 else ''
        else:
            candidate = ''
        if _YT_ID_RE.fullmatch(candidate):
            provider, video_id = 'youtube', candidate
    elif host in ('vimeo.com', 'www.vimeo.com', 'player.vimeo.com'):
        segments = [seg for seg in parsed.path.strip('/').split('/') if seg]
        candidate = segments[-1] if segments else ''
        if _VIMEO_ID_RE.fullmatch(candidate):
            provider, video_id = 'vimeo', candidate

    if not provider or not video_id:
        raise ElearningError('Unsupported video URL. Paste a valid YouTube or Vimeo link.', 400)

    if provider == 'youtube':
        embed_url = f'https://www.youtube-nocookie.com/embed/{video_id}'
    else:
        embed_url = f'https://player.vimeo.com/video/{video_id}'
    return {'provider': provider, 'videoId': video_id, 'embedUrl': embed_url, 'startSeconds': start_hint}


_SVG_NS = '{http://www.w3.org/2000/svg}'
_SVG_TAGS = set(
    'svg g path circle ellipse rect line polyline polygon text tspan defs linearGradient '
    'radialGradient stop clipPath mask title desc animate animateTransform'.split()
)
_SVG_ATTRS = set(
    'id viewBox preserveAspectRatio x y x1 y1 x2 y2 cx cy r rx ry d points width height '
    'fill fill-opacity fill-rule stroke stroke-width stroke-linejoin stroke-linecap '
    'stroke-dasharray stroke-dashoffset stroke-opacity opacity transform clip-path mask '
    'offset stop-color stop-opacity gradientUnits gradientTransform fx fy '
    'font-size font-weight text-anchor dominant-baseline'.split()
)
_ANIM_ATTRS = {'attributeName', 'type', 'from', 'to', 'values', 'dur', 'repeatCount', 'keyTimes'}
_ANIM_TARGETS = {'opacity', 'fill-opacity', 'stroke-opacity', 'transform', 'r', 'rx', 'ry', 'cx', 'cy', 'x', 'y'}


def sanitize_svg_markup(raw: object) -> str:
    """Rebuild standalone drawing elements and numeric animation tracks."""
    text = safe_text(raw, 45000).strip()
    if not text or '<!' in text:
        return ''
    try:
        source = ET.fromstring(text)
    except (ET.ParseError, ValueError):
        return ''
    if source.tag.removeprefix(_SVG_NS) != 'svg':
        return ''

    def drawing(node, depth):
        tag = node.tag.removeprefix(_SVG_NS)
        if depth > 32 or tag not in _SVG_TAGS:
            return None
        if tag in ('animate', 'animateTransform'):
            if node.get('attributeName') not in _ANIM_TARGETS:
                return None
            allowed = _ANIM_ATTRS
        else:
            allowed = _SVG_ATTRS
        clean = ET.Element(tag)
        for name, value in node.attrib.items():
            if name not in allowed:
                continue
            # Paint servers are confined to fragment references in this drawing.
            if any(c in value for c in '()') and name in ('fill', 'stroke', 'clip-path', 'mask'):
                if not re.fullmatch(r'(?:url\(#[a-zA-Z_][\w.-]*\)|rgba?\([\d .,/%]+\))', value):
                    continue
            clean.set(name, value)
        clean.text = node.text
        for child in node:
            safe_child = drawing(child, depth + 1)
            if safe_child is not None:
                safe_child.tail = child.tail
                clean.append(safe_child)
        return clean

    root = drawing(source, 0)
    root.set('xmlns', _SVG_NS[1:-1])
    return ET.tostring(root, encoding='unicode')


def safe_external_url(raw: object) -> str:
    url = safe_text(raw, 600).strip()
    if not url:
        return ''
    parsed = urlparse(url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname:
        return ''
    return url


def safe_media_ref(raw: object) -> dict:
    """Validate an image/audio reference: uploaded assetId, built-in xPED static path, or empty."""
    if not isinstance(raw, dict):
        return {'kind': 'none', 'assetId': '', 'staticPath': ''}
    kind = str(raw.get('kind') or 'none').strip()
    if kind == 'asset':
        aid = str(raw.get('assetId') or '').strip()
        if aid and _ID_RE.fullmatch(aid):
            return {'kind': 'asset', 'assetId': aid, 'staticPath': ''}
    elif kind == 'xped':
        sp = str(raw.get('staticPath') or '').strip()
        if _SAFE_XPED_ASSET_RE.fullmatch(sp):
            return {'kind': 'xped', 'assetId': '', 'staticPath': sp}
    return {'kind': 'none', 'assetId': '', 'staticPath': ''}


def _normalize_media_overrides(raw: object, kind: str = 'image') -> dict:
    overrides: dict = {}
    if not isinstance(raw, dict):
        return overrides
    for lang in SUPPORTED_LANGUAGES:
        val = raw.get(lang)
        if not val:
            continue
        if kind == 'video' and isinstance(val, str) and val.strip():
            parsed = parse_video_url(val)
            overrides[lang] = {'url': val.strip(), **parsed}
        elif kind == 'video' and isinstance(val, dict) and str(val.get('url') or '').strip():
            parsed = parse_video_url(val.get('url'))
            overrides[lang] = {'url': str(val.get('url')).strip(), **parsed}
        elif kind in ('image', 'audio') and isinstance(val, dict):
            ref = safe_media_ref(val)
            if ref['kind'] != 'none':
                overrides[lang] = ref
    return overrides


def _normalize_option_list(raw: object, default_lang: str, max_items: int = MAX_OPTIONS) -> list[dict]:
    items = raw if isinstance(raw, list) else []
    result = []
    seen = set()
    for entry in items[:max_items]:
        if not isinstance(entry, dict):
            continue
        oid = str(entry.get('id') or '').strip()
        if not _ID_RE.fullmatch(oid) or oid in seen:
            oid = new_id('opt')
        seen.add(oid)
        item = {
            'id': oid,
            'label': normalize_localized(entry.get('label'), 400, default_lang),
        }
        if 'isCorrect' in entry:
            item['isCorrect'] = bool(entry.get('isCorrect'))
        if 'feedback' in entry:
            item['feedback'] = normalize_localized(entry.get('feedback'), 1200, default_lang)
        if 'category' in entry:
            cat = str(entry.get('category') or '').strip()
            if cat in ('load', 'resource', 'bio', 'psycho', 'social'):
                item['category'] = cat
        if 'x' in entry and 'y' in entry:
            try:
                item['x'] = round(min(100.0, max(0.0, float(entry['x']))), 2)
                item['y'] = round(min(100.0, max(0.0, float(entry['y']))), 2)
            except (TypeError, ValueError):
                item['x'], item['y'] = 50.0, 50.0
        if 'detail' in entry:
            item['detail'] = normalize_localized(entry.get('detail'), 1500, default_lang)
        result.append(item)
    return result


def normalize_block(raw: object, default_lang: str = 'nl') -> dict:
    if not isinstance(raw, dict):
        raise ElearningError('Each block must be an object.', 400)
    btype = str(raw.get('type') or '').strip()
    if btype not in VALID_BLOCK_TYPES:
        raise ElearningError(f'Unsupported block type: {btype}', 400)
    bid = str(raw.get('id') or '').strip()
    if not _ID_RE.fullmatch(bid):
        bid = new_id('blk')
    data = raw.get('data') if isinstance(raw.get('data'), dict) else {}
    settings = raw.get('settings') if isinstance(raw.get('settings'), dict) else {}

    norm_settings = {
        'required': bool(settings.get('required', False)),
        'showPeerResults': bool(settings.get('showPeerResults', False)),
        'allowMultiple': bool(settings.get('allowMultiple', False)),
        'saveToSummary': bool(settings.get('saveToSummary', btype in ('reflection', 'balance_scale', 'mini_plan'))),
        'revealAfterAnswer': bool(settings.get('revealAfterAnswer', False)),
    }

    norm_data: dict = {}
    if btype == 'richtext':
        norm_data = {
            'heading': normalize_localized(data.get('heading'), 300, default_lang),
            'body': normalize_localized(data.get('body'), 8000, default_lang),
        }
    elif btype == 'video':
        url = safe_text(data.get('url', ''), 500).strip()
        parsed = parse_video_url(url) if url else {'provider': '', 'videoId': '', 'embedUrl': '', 'startSeconds': None}
        start_s = parse_timestamp_seconds(data.get('startSeconds'))
        if start_s is None:
            start_s = parsed['startSeconds']
        end_s = parse_timestamp_seconds(data.get('endSeconds'))
        if start_s is not None and end_s is not None and end_s <= start_s:
            end_s = None
        norm_data = {
            'title': normalize_localized(data.get('title'), 300, default_lang),
            'url': url,
            'provider': parsed['provider'],
            'videoId': parsed['videoId'],
            'embedUrl': parsed['embedUrl'],
            'startSeconds': start_s,
            'endSeconds': end_s,
            'caption': normalize_localized(data.get('caption'), 600, default_lang),
            'transcript': normalize_localized(data.get('transcript'), 6000, default_lang),
            'mediaOverrides': _normalize_media_overrides(data.get('mediaOverrides'), 'video'),
        }
    elif btype == 'image':
        layout = str(data.get('layout') or 'full').strip()
        if layout not in VALID_IMAGE_LAYOUTS:
            layout = 'full'
        norm_data = {
            'media': safe_media_ref(data.get('media')),
            'layout': layout,
            'alt': normalize_localized(data.get('alt'), 400, default_lang),
            'caption': normalize_localized(data.get('caption'), 600, default_lang),
            'sideHeading': normalize_localized(data.get('sideHeading'), 300, default_lang),
            'sideBody': normalize_localized(data.get('sideBody'), 3000, default_lang),
            'mediaOverrides': _normalize_media_overrides(data.get('mediaOverrides'), 'image'),
        }
    elif btype == 'audio':
        norm_data = {
            'title': normalize_localized(data.get('title'), 300, default_lang),
            'description': normalize_localized(data.get('description'), 1000, default_lang),
            'media': safe_media_ref(data.get('media')),
            'transcript': normalize_localized(data.get('transcript'), 6000, default_lang),
            'mediaOverrides': _normalize_media_overrides(data.get('mediaOverrides'), 'audio'),
        }
    elif btype == 'callout':
        tone = str(data.get('tone') or 'tip').strip()
        if tone not in VALID_CALLOUT_TONES:
            tone = 'tip'
        norm_data = {
            'tone': tone,
            'title': normalize_localized(data.get('title'), 300, default_lang),
            'body': normalize_localized(data.get('body'), 3000, default_lang),
        }
    elif btype == 'story':
        norm_data = {
            'speakerName': safe_text(data.get('speakerName', ''), 120),
            'speakerRole': normalize_localized(data.get('speakerRole'), 200, default_lang),
            'quote': normalize_localized(data.get('quote'), 2500, default_lang),
            'media': safe_media_ref(data.get('media')),
        }
    elif btype == 'sources':
        raw_items = data.get('items') if isinstance(data.get('items'), list) else []
        items = []
        for entry in raw_items[:20]:
            if not isinstance(entry, dict):
                continue
            sid = str(entry.get('id') or '').strip()
            if not _ID_RE.fullmatch(sid):
                sid = new_id('src')
            items.append({
                'id': sid,
                'citation': normalize_localized(entry.get('citation'), 800, default_lang),
                'url': safe_external_url(entry.get('url', '')),
            })
        norm_data = {
            'title': normalize_localized(data.get('title'), 200, default_lang),
            'items': items,
        }
    elif btype == 'mcq':
        norm_data = {
            'question': normalize_localized(data.get('question'), 600, default_lang),
            'subtitle': normalize_localized(data.get('subtitle'), 600, default_lang),
            'options': _normalize_option_list(data.get('options'), default_lang, MAX_OPTIONS),
            'explanation': normalize_localized(data.get('explanation'), 2000, default_lang),
        }
    elif btype == 'myth_fact':
        answer = 'fact' if str(data.get('correctAnswer') or 'myth').strip().lower() == 'fact' else 'myth'
        norm_data = {
            'statement': normalize_localized(data.get('statement'), 600, default_lang),
            'correctAnswer': answer,
            'explanation': normalize_localized(data.get('explanation'), 2500, default_lang),
            'sourceUrl': safe_external_url(data.get('sourceUrl', '')),
            'sourceLabel': normalize_localized(data.get('sourceLabel'), 200, default_lang),
        }
    elif btype == 'scale':
        try:
            min_v = int(data.get('min', 0))
            max_v = int(data.get('max', 10))
        except (TypeError, ValueError):
            min_v, max_v = 0, 10
        min_v = max(0, min(min_v, 99))
        max_v = max(min_v + 1, min(max_v, 100))
        norm_data = {
            'question': normalize_localized(data.get('question'), 600, default_lang),
            'min': min_v,
            'max': max_v,
            'minLabel': normalize_localized(data.get('minLabel'), 200, default_lang),
            'maxLabel': normalize_localized(data.get('maxLabel'), 200, default_lang),
            'feedback': normalize_localized(data.get('feedback'), 1500, default_lang),
        }
    elif btype == 'reflection':
        norm_data = {
            'prompt': normalize_localized(data.get('prompt'), 800, default_lang),
            'placeholder': normalize_localized(data.get('placeholder'), 300, default_lang),
            'helperNote': normalize_localized(data.get('helperNote'), 600, default_lang),
        }
    elif btype == 'wordcloud':
        try:
            max_words = max(1, min(5, int(data.get('maxWords', 3))))
        except (TypeError, ValueError):
            max_words = 3
        norm_data = {
            'question': normalize_localized(data.get('question'), 600, default_lang),
            'placeholder': normalize_localized(data.get('placeholder'), 200, default_lang),
            'maxWords': max_words,
        }
    elif btype == 'ranking':
        norm_data = {
            'question': normalize_localized(data.get('question'), 600, default_lang),
            'items': _normalize_option_list(data.get('items'), default_lang, 12),
        }
    elif btype == 'hotspot':
        mode = 'quiz' if str(data.get('mode') or 'explore').strip() == 'quiz' else 'explore'
        norm_data = {
            'title': normalize_localized(data.get('title'), 400, default_lang),
            'instruction': normalize_localized(data.get('instruction'), 600, default_lang),
            'mode': mode,
            'media': safe_media_ref(data.get('media')),
            'alt': normalize_localized(data.get('alt'), 400, default_lang),
            'pins': _normalize_option_list(data.get('pins'), default_lang, 12),
        }
    elif btype == 'balance_scale':
        norm_data = {
            'title': normalize_localized(data.get('title'), 400, default_lang),
            'intro': normalize_localized(data.get('intro'), 1000, default_lang),
            'loadLabel': normalize_localized(data.get('loadLabel'), 150, default_lang),
            'resourceLabel': normalize_localized(data.get('resourceLabel'), 150, default_lang),
            'factors': _normalize_option_list(data.get('factors'), default_lang, 12),
            'overloadTip': normalize_localized(data.get('overloadTip'), 1200, default_lang),
            'balancedTip': normalize_localized(data.get('balancedTip'), 1200, default_lang),
        }
    elif btype == 'bps_triad':
        norm_data = {
            'title': normalize_localized(data.get('title'), 400, default_lang),
            'intro': normalize_localized(data.get('intro'), 1000, default_lang),
            'bioTitle': normalize_localized(data.get('bioTitle'), 150, default_lang),
            'bioBody': normalize_localized(data.get('bioBody'), 2000, default_lang),
            'psychoTitle': normalize_localized(data.get('psychoTitle'), 150, default_lang),
            'psychoBody': normalize_localized(data.get('psychoBody'), 2000, default_lang),
            'socialTitle': normalize_localized(data.get('socialTitle'), 150, default_lang),
            'socialBody': normalize_localized(data.get('socialBody'), 2000, default_lang),
        }
    elif btype == 'mini_plan':
        try:
            max_select = max(1, min(5, int(data.get('maxSelect', 3))))
        except (TypeError, ValueError):
            max_select = 3
        norm_data = {
            'title': normalize_localized(data.get('title'), 400, default_lang),
            'intro': normalize_localized(data.get('intro'), 1000, default_lang),
            'suggestions': _normalize_option_list(data.get('suggestions'), default_lang, 15),
            'allowCustom': bool(data.get('allowCustom', True)),
            'maxSelect': max_select,
        }
    elif btype == 'custom_visual':
        height_mode = str(data.get('height') or 'medium').strip()
        if height_mode not in ('compact', 'medium', 'tall'):
            height_mode = 'medium'
        preset_anim = str(data.get('preset') or 'placeholder').strip()
        if preset_anim not in ('placeholder', 'alarm-dial', 'breathing-circle', 'custom-svg'):
            preset_anim = 'placeholder'
        norm_data = {
            'title': normalize_localized(data.get('title'), 300, default_lang),
            'caption': normalize_localized(data.get('caption'), 600, default_lang),
            'alt': normalize_localized(data.get('alt'), 400, default_lang),
            'agentBrief': safe_text(data.get('agentBrief', ''), 2500),
            'slotId': safe_text(data.get('slotId', ''), 80),
            'height': height_mode,
            'preset': preset_anim,
            'svgMarkup': sanitize_svg_markup(data.get('svgMarkup', '')),
        }

    return {'id': bid, 'type': btype, 'data': norm_data, 'settings': norm_settings}


def normalize_step(raw: object, default_lang: str = 'nl') -> dict:
    if not isinstance(raw, dict):
        raise ElearningError('Each step must be an object.', 400)
    sid = str(raw.get('id') or '').strip()
    if not _ID_RE.fullmatch(sid):
        sid = new_id('stp')
    layout = str(raw.get('layout') or 'focused').strip()
    if layout not in VALID_STEP_LAYOUTS:
        layout = 'focused'
    status = str(raw.get('status') or 'draft').strip()
    if status not in VALID_STATUSES:
        status = 'draft'
    raw_blocks = raw.get('blocks') if isinstance(raw.get('blocks'), list) else []
    if len(raw_blocks) > MAX_BLOCKS_PER_STEP:
        raise ElearningError(f'A step can hold at most {MAX_BLOCKS_PER_STEP} blocks.', 400)
    blocks = [normalize_block(b, default_lang) for b in raw_blocks]

    raw_branching = raw.get('branching') if isinstance(raw.get('branching'), list) else []
    branching = []
    for rule in raw_branching[:10]:
        if not isinstance(rule, dict):
            continue
        block_id = str(rule.get('blockId') or '').strip()
        target_step_id = str(rule.get('targetStepId') or '').strip()
        operator = str(rule.get('operator') or 'equals').strip()
        if operator not in ('equals', 'lte', 'gte'):
            operator = 'equals'
        if _ID_RE.fullmatch(block_id) and _ID_RE.fullmatch(target_step_id):
            branching.append({
                'blockId': block_id,
                'operator': operator,
                'value': safe_text(rule.get('value', ''), 120),
                'targetStepId': target_step_id,
            })

    return {
        'id': sid,
        'title': normalize_localized(raw.get('title'), 300, default_lang),
        'layout': layout,
        'status': status,
        'authorNotes': safe_text(raw.get('authorNotes', ''), 4000),
        'blocks': blocks,
        'branching': branching,
    }


def normalize_module(raw: object, default_lang: str = 'nl') -> dict:
    if not isinstance(raw, dict):
        raise ElearningError('Each module must be an object.', 400)
    mid = str(raw.get('id') or '').strip()
    if not _ID_RE.fullmatch(mid):
        mid = new_id('mod')
    domain = str(raw.get('domain') or 'general').strip()
    if domain not in VALID_DOMAINS:
        domain = 'general'
    status = str(raw.get('status') or 'empty').strip()
    if status not in VALID_STATUSES:
        status = 'empty'
    try:
        minutes = max(1, min(120, int(raw.get('estimatedMinutes', 5))))
    except (TypeError, ValueError):
        minutes = 5
    raw_steps = raw.get('steps') if isinstance(raw.get('steps'), list) else []
    if len(raw_steps) > MAX_STEPS_PER_MODULE:
        raise ElearningError(f'A module can hold at most {MAX_STEPS_PER_MODULE} steps.', 400)
    steps = [normalize_step(s, default_lang) for s in raw_steps]
    return {
        'id': mid,
        'title': normalize_localized(raw.get('title'), 300, default_lang),
        'subtitle': normalize_localized(raw.get('subtitle'), 500, default_lang),
        'domain': domain,
        'estimatedMinutes': minutes,
        'status': status,
        'visibleToLearners': bool(raw.get('visibleToLearners', True)),
        'milestoneMessage': normalize_localized(raw.get('milestoneMessage'), 600, default_lang),
        'steps': steps,
    }


def normalize_expedition_payload(raw: object) -> dict:
    if not isinstance(raw, dict):
        raise ElearningError('Expedition payload must be a JSON object.', 400)
    default_lang = normalize_lang(raw.get('defaultLanguage', 'nl'))
    raw_enabled = raw.get('enabledLanguages')
    if isinstance(raw_enabled, list):
        enabled = []
        for lang in raw_enabled:
            norm = normalize_lang(lang, '')
            if norm and norm not in enabled:
                enabled.append(norm)
        if default_lang not in enabled:
            enabled.insert(0, default_lang)
    else:
        enabled = ['nl', 'en', 'de']

    raw_theme = raw.get('theme') if isinstance(raw.get('theme'), dict) else {}
    preset = str(raw_theme.get('preset') or 'xped-warm-sand').strip()
    if preset not in VALID_THEMES:
        preset = 'xped-warm-sand'
    theme = {
        'preset': preset,
        'showRouteMap': bool(raw_theme.get('showRouteMap', True)),
    }

    raw_start = raw.get('startPage') if isinstance(raw.get('startPage'), dict) else {}
    raw_highlights = raw_start.get('highlights') if isinstance(raw_start.get('highlights'), list) else []
    highlights = []
    for entry in raw_highlights[:8]:
        if isinstance(entry, dict) and ('text' in entry or 'id' in entry):
            hid = str(entry.get('id') or '').strip()
            if not _ID_RE.fullmatch(hid):
                hid = new_id('hl')
            highlights.append({'id': hid, 'text': normalize_localized(entry.get('text'), 300, default_lang)})
        else:
            highlights.append({'id': new_id('hl'), 'text': normalize_localized(entry, 300, default_lang)})

    hero_video_url = safe_text(raw_start.get('heroVideoUrl', ''), 500).strip()
    hero_video = parse_video_url(hero_video_url) if hero_video_url else {'provider': '', 'videoId': '', 'embedUrl': '', 'startSeconds': None}

    start_page = {
        'eyebrow': normalize_localized(raw_start.get('eyebrow'), 120, default_lang),
        'title': normalize_localized(raw_start.get('title'), 300, default_lang),
        'subtitle': normalize_localized(raw_start.get('subtitle'), 1000, default_lang),
        'heroMedia': safe_media_ref(raw_start.get('heroMedia')),
        'heroMediaOverrides': _normalize_media_overrides(raw_start.get('heroMediaOverrides'), 'image'),
        'heroVideoUrl': hero_video_url,
        'heroVideoEmbedUrl': hero_video['embedUrl'],
        'highlights': highlights,
        'ctaLabel': normalize_localized(raw_start.get('ctaLabel'), 120, default_lang),
    }

    raw_modules = raw.get('modules') if isinstance(raw.get('modules'), list) else []
    if len(raw_modules) > MAX_MODULES:
        raise ElearningError(f'An expedition can contain at most {MAX_MODULES} modules.', 400)
    modules = [normalize_module(m, default_lang) for m in raw_modules]

    title_raw = raw.get('title')
    if isinstance(title_raw, dict):
        title_loc = normalize_localized(title_raw, 200, default_lang)
        plain_title = title_loc.get(default_lang) or title_loc.get('nl') or title_loc.get('en') or 'Untitled Expedition'
    else:
        plain_title = safe_text(title_raw, 200).strip() or 'Untitled Expedition'
        title_loc = normalize_localized({default_lang: plain_title}, 200, default_lang)

    raw_glossary = raw.get('glossary') if isinstance(raw.get('glossary'), list) else []
    glossary = []
    for entry in raw_glossary[:30]:
        if not isinstance(entry, dict):
            continue
        gid = str(entry.get('id') or '').strip()
        if not _ID_RE.fullmatch(gid):
            gid = new_id('gls')
        nl_t = safe_text(entry.get('nl', ''), 120).strip()
        en_t = safe_text(entry.get('en', ''), 120).strip()
        de_t = safe_text(entry.get('de', ''), 120).strip()
        if nl_t or en_t or de_t:
            glossary.append({'id': gid, 'nl': nl_t, 'en': en_t, 'de': de_t})

    return {
        'schemaVersion': SCHEMA_VERSION,
        'title': plain_title,
        'localizedTitle': title_loc,
        'defaultLanguage': default_lang,
        'enabledLanguages': enabled,
        'theme': theme,
        'startPage': start_page,
        'modules': modules,
        'glossary': glossary,
    }


def build_default_expedition(title: str = 'xPEDitie Pijn — Nieuw ontwerp', default_lang: str = 'nl') -> dict:
    """Create a clean, blank-first expedition with 1 starter station ready for content."""
    safe_title = safe_text(title, 200).strip() or 'xPEDitie Pijn — Nieuw ontwerp'
    return normalize_expedition_payload({
        'title': safe_title,
        'defaultLanguage': default_lang,
        'enabledLanguages': ['nl', 'en', 'de'],
        'theme': {'preset': 'xped-warm-sand', 'showRouteMap': True},
        'startPage': {
            'eyebrow': {'nl': 'XPEDITIE PIJN', 'en': 'XPEDITION PAIN', 'de': 'XPEDITION SCHMERZ'},
            'title': {'nl': safe_title, 'en': '', 'de': ''},
            'subtitle': {
                'nl': 'Welkom op jouw expeditie. Voeg hier een warme, heldere introductie toe zodra de inhoud klaar is.',
                'en': '',
                'de': '',
            },
            'heroMedia': {'kind': 'xped', 'staticPath': '/static/images/xped/xped-wandelaar-met-kaart.png'},
            'highlights': [],
            'ctaLabel': {'nl': 'Start de expeditie', 'en': 'Start the expedition', 'de': 'Expedition starten'},
        },
        'modules': [
            {
                'id': new_id('mod'),
                'title': {'nl': 'Station 1', 'en': 'Station 1', 'de': ''},
                'subtitle': {'nl': '', 'en': '', 'de': ''},
                'domain': 'bio',
                'estimatedMinutes': 5,
                'status': 'empty',
                'visibleToLearners': True,
                'steps': [
                    {
                        'id': new_id('stp'),
                        'title': {'nl': 'Stap 1', 'en': 'Step 1', 'de': ''},
                        'layout': 'focused',
                        'status': 'empty',
                        'authorNotes': '',
                        'blocks': [],
                        'branching': [],
                    }
                ],
            }
        ],
    })


def _walk_localized_fields(expedition: dict):
    """Yield (field_key, location_label, localized_dict) for every translatable text field."""
    yield ('startPage.eyebrow', 'Start Page · Eyebrow', expedition['startPage']['eyebrow'])
    yield ('startPage.title', 'Start Page · Title', expedition['startPage']['title'])
    yield ('startPage.subtitle', 'Start Page · Subtitle', expedition['startPage']['subtitle'])
    yield ('startPage.ctaLabel', 'Start Page · Button', expedition['startPage']['ctaLabel'])
    for idx, hl in enumerate(expedition['startPage'].get('highlights', [])):
        yield (f"startPage.highlights.{hl['id']}", f'Start Page · Highlight {idx + 1}', hl['text'])

    for m_idx, mod in enumerate(expedition.get('modules', [])):
        m_prefix = f"mod.{mod['id']}"
        m_label = f'Station {m_idx + 1}'
        yield (f'{m_prefix}.title', f'{m_label} · Title', mod['title'])
        yield (f'{m_prefix}.subtitle', f'{m_label} · Subtitle', mod['subtitle'])
        yield (f'{m_prefix}.milestoneMessage', f'{m_label} · Milestone', mod['milestoneMessage'])
        for s_idx, step in enumerate(mod.get('steps', [])):
            s_prefix = f"{m_prefix}.stp.{step['id']}"
            s_label = f'{m_label} · Step {s_idx + 1}'
            yield (f'{s_prefix}.title', f'{s_label} · Title', step['title'])
            for b_idx, blk in enumerate(step.get('blocks', [])):
                b_prefix = f"{s_prefix}.blk.{blk['id']}"
                b_label = f"{s_label} · {blk['type']} #{b_idx + 1}"
                data = blk.get('data') or {}
                for key, value in data.items():
                    if isinstance(value, dict) and all(lang in value for lang in SUPPORTED_LANGUAGES):
                        yield (f'{b_prefix}.{key}', f'{b_label} · {key}', value)
                    elif isinstance(value, list):
                        for item_idx, item in enumerate(value):
                            if not isinstance(item, dict) or not item.get('id'):
                                continue
                            for subkey, subval in item.items():
                                if isinstance(subval, dict) and all(lang in subval for lang in SUPPORTED_LANGUAGES):
                                    yield (
                                        f"{b_prefix}.{key}.{item['id']}.{subkey}",
                                        f'{b_label} · {key} #{item_idx + 1} · {subkey}',
                                        subval,
                                    )


def mark_translations_for_review(previous_exp: dict, next_exp: dict, edited_lang: str) -> dict:
    """When source text changes in edited_lang, flag existing other-language translations for review."""
    prev_map = {k: deepcopy(v) for k, _, v in _walk_localized_fields(previous_exp)}
    safe_lang = normalize_lang(edited_lang)
    for key, _, loc in _walk_localized_fields(next_exp):
        old_loc = prev_map.get(key)
        if not old_loc:
            continue
        if old_loc.get(safe_lang, '') != loc.get(safe_lang, ''):
            review = dict(loc.get('_review') or {})
            for other in SUPPORTED_LANGUAGES:
                if other != safe_lang and loc.get(other, '').strip():
                    review[other] = True
            if review:
                loc['_review'] = review
    return next_exp


def extract_translation_rows(expedition: dict, source_lang: str = 'nl', target_lang: str = 'de') -> list[dict]:
    src = normalize_lang(source_lang, 'nl')
    tgt = normalize_lang(target_lang, 'de')
    rows = []
    for key, location, loc in _walk_localized_fields(expedition):
        src_text = loc.get(src, '')
        en_text = loc.get('en', '')
        nl_text = loc.get('nl', '')
        tgt_text = loc.get(tgt, '')
        needs_review = bool((loc.get('_review') or {}).get(tgt))
        if not src_text.strip() and not tgt_text.strip() and not nl_text.strip() and not en_text.strip():
            continue
        status = 'needs_review' if needs_review else ('translated' if tgt_text.strip() else 'untranslated')
        rows.append({
            'key': key,
            'location': location,
            'source': src_text,
            'nl': nl_text,
            'en': en_text,
            'target': tgt_text,
            'status': status,
        })
    return rows


def apply_translation_patch(
    expedition: dict,
    target_lang: str,
    text_updates: dict[str, str],
    media_updates: dict[str, object] | None = None,
) -> dict:
    """Apply localized-only updates for target_lang without mutating structure or other languages."""
    tgt = normalize_lang(target_lang, '')
    if not tgt:
        raise ElearningError('Choose a valid target language (nl, en, or de).', 400)
    updated = deepcopy(expedition)
    if tgt not in updated.get('enabledLanguages', []):
        updated.setdefault('enabledLanguages', ['nl']).append(tgt)

    field_index = {key: loc for key, _, loc in _walk_localized_fields(updated)}
    for key, raw_value in (text_updates or {}).items():
        if key not in field_index:
            raise ElearningError(f'Unknown translation field: {key}', 400)
        loc = field_index[key]
        loc[tgt] = safe_text(raw_value, 8000)
        if isinstance(loc.get('_review'), dict) and tgt in loc['_review']:
            loc['_review'].pop(tgt, None)
            if not loc['_review']:
                loc.pop('_review', None)

    if media_updates:
        block_index = {}
        for mod in updated.get('modules', []):
            for step in mod.get('steps', []):
                for blk in step.get('blocks', []):
                    block_index[blk['id']] = blk
        for target_id, raw_media in media_updates.items():
            if target_id == 'startPage.heroMedia':
                overrides = dict(updated['startPage'].get('heroMediaOverrides') or {})
                if not raw_media:
                    overrides.pop(tgt, None)
                else:
                    ref = safe_media_ref(raw_media)
                    if ref['kind'] == 'none':
                        overrides.pop(tgt, None)
                    else:
                        overrides[tgt] = ref
                updated['startPage']['heroMediaOverrides'] = overrides
                continue
            blk = block_index.get(target_id)
            if not blk or blk['type'] not in ('video', 'image', 'audio'):
                raise ElearningError(f'Unknown media override target: {target_id}', 400)
            overrides = dict(blk['data'].get('mediaOverrides') or {})
            if not raw_media:
                overrides.pop(tgt, None)
            elif blk['type'] == 'video':
                url = raw_media if isinstance(raw_media, str) else str((raw_media or {}).get('url') or '')
                if not url.strip():
                    overrides.pop(tgt, None)
                else:
                    overrides[tgt] = {'url': url.strip(), **parse_video_url(url)}
            else:
                ref = safe_media_ref(raw_media)
                if ref['kind'] == 'none':
                    overrides.pop(tgt, None)
                else:
                    overrides[tgt] = ref
            blk['data']['mediaOverrides'] = overrides

    return updated


def translation_rows_to_csv(rows: list[dict], target_lang: str) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(['field_key', 'location', 'nl', 'en', f'target_{target_lang}', 'status'])
    for row in rows:
        writer.writerow(sanitize_csv_row([
            row['key'],
            row['location'],
            row.get('nl', ''),
            row.get('en', ''),
            row.get('target', ''),
            row.get('status', ''),
        ]))
    return buf.getvalue()


def csv_to_translation_updates(csv_text: str, target_lang: str) -> dict[str, str]:
    tgt = normalize_lang(target_lang, '')
    if not tgt:
        raise ElearningError('Invalid target language.', 400)
    reader = csv.DictReader(io.StringIO(csv_text.lstrip('\ufeff')))
    target_col = f'target_{tgt}'
    updates: dict[str, str] = {}
    for row in reader:
        key = str(row.get('field_key') or '').strip()
        if not key:
            continue
        if target_col in row and row[target_col] is not None:
            updates[key] = str(row[target_col])
        elif tgt in row and row[tgt] is not None:
            updates[key] = str(row[tgt])
    return updates


def sanitize_public_expedition(expedition: dict) -> dict:
    """Strip internal metadata, author notes, and hidden modules before serving to learners."""
    clean_modules = []
    for mod in expedition.get('modules', []):
        if not mod.get('visibleToLearners', True):
            continue
        clean_steps = []
        for step in mod.get('steps', []):
            blocks = []
            for block in step.get('blocks', []):
                if block.get('type') == 'custom_visual':
                    data = block.get('data') or {}
                    if data.get('preset', 'placeholder') == 'placeholder':
                        continue
                    block = {**block, 'data': {k: v for k, v in data.items() if k not in ('agentBrief', 'slotId')}}
                blocks.append(deepcopy(block))
            clean_steps.append({
                'id': step['id'],
                'title': deepcopy(step.get('title', {})),
                'layout': step.get('layout', 'focused'),
                'blocks': blocks,
                'branching': deepcopy(step.get('branching', [])),
            })
        clean_modules.append({
            'id': mod['id'],
            'title': deepcopy(mod.get('title', {})),
            'subtitle': deepcopy(mod.get('subtitle', {})),
            'domain': mod.get('domain', 'general'),
            'estimatedMinutes': mod.get('estimatedMinutes', 5),
            'milestoneMessage': deepcopy(mod.get('milestoneMessage', {})),
            'steps': clean_steps,
        })
    share = expedition.get('share') or {}
    return {
        'id': expedition['id'],
        'schemaVersion': expedition.get('schemaVersion', SCHEMA_VERSION),
        'title': expedition.get('title', ''),
        'defaultLanguage': expedition.get('defaultLanguage', 'nl'),
        'enabledLanguages': list(expedition.get('enabledLanguages', ['nl'])),
        'theme': deepcopy(expedition.get('theme', {'preset': 'xped-warm-sand', 'showRouteMap': True})),
        'startPage': deepcopy(expedition.get('startPage', {})),
        'modules': clean_modules,
        'shareOptions': {
            'showPeerResults': bool(share.get('showPeerResults', True)),
            'collectPilotFeedback': bool(share.get('collectPilotFeedback', True)),
            'allowStepComments': bool(share.get('allowStepComments', False)),
        },
    }


def media_refs(expedition):
    start = expedition.get('startPage', {})
    yield start.get('heroMedia')
    yield from (start.get('heroMediaOverrides') or {}).values()
    for module in expedition.get('modules', []):
        for step in module.get('steps', []):
            for block in step.get('blocks', []):
                data = block.get('data') or {}
                yield data.get('media')
                yield from (data.get('mediaOverrides') or {}).values()


def media_ids(expedition):
    return {ref['assetId'] for ref in media_refs(expedition)
            if isinstance(ref, dict) and ref.get('kind') == 'asset' and ref.get('assetId')}
