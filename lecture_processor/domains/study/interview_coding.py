"""Interview coding helpers for transcript offsets, AI drafts, and exports."""

import hashlib
import json
import re

from lecture_processor.domains.ai import study_generation
from lecture_processor.domains.study import export as study_export


CODING_PALETTE = (
    {'key': 'yellow', 'label': 'Yellow', 'hex': '#FEF3C7'},
    {'key': 'green', 'label': 'Green', 'hex': '#DCFCE7'},
    {'key': 'blue', 'label': 'Blue', 'hex': '#DBEAFE'},
    {'key': 'pink', 'label': 'Pink', 'hex': '#FCE7F3'},
    {'key': 'teal', 'label': 'Teal', 'hex': '#CCFBF1'},
    {'key': 'purple', 'label': 'Purple', 'hex': '#EDE9FE'},
    {'key': 'orange', 'label': 'Orange', 'hex': '#FFEDD5'},
    {'key': 'rose', 'label': 'Rose', 'hex': '#FFE4E6'},
    {'key': 'cyan', 'label': 'Cyan', 'hex': '#CFFAFE'},
    {'key': 'lime', 'label': 'Lime', 'hex': '#ECFCCB'},
    {'key': 'amber', 'label': 'Amber', 'hex': '#FDE68A'},
    {'key': 'slate', 'label': 'Slate', 'hex': '#E2E8F0'},
)
CODING_COLOR_KEYS = {item['key'] for item in CODING_PALETTE}
CODING_COLOR_HEX = {item['key']: item['hex'] for item in CODING_PALETTE}


def sanitize_code_color(raw_color):
    color = str(raw_color or '').strip().lower()
    return color if color in CODING_COLOR_KEYS else 'teal'


def transcript_base_key(pack_id, transcript):
    safe_pack_id = str(pack_id or '').strip()
    text = str(transcript or '')
    digest = hashlib.sha256(text.encode('utf-8')).hexdigest()[:12]
    return f'{safe_pack_id}:{len(text)}:{digest}'


_SPEAKER_LINE_RE = re.compile(
    r'^\s*(?:timecode\s*)?\(?([0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?)\)?\s*[-–]\s*([^-\n:]{1,80}?)\s*[-:]\s*(.+?)\s*$',
    re.IGNORECASE,
)


def parse_transcript_segments(transcript):
    text = str(transcript or '')
    segments = []
    offset = 0
    for raw_line in text.splitlines(keepends=True):
        line = raw_line.rstrip('\r\n')
        line_start = offset
        offset += len(raw_line)
        if not line.strip():
            continue
        match = _SPEAKER_LINE_RE.match(line)
        if match:
            caption = match.group(3).strip()
            caption_start = line_start + match.start(3)
            caption_end = line_start + match.end(3)
            timestamp = match.group(1).strip()
            speaker = match.group(2).strip()
        else:
            caption = line.strip()
            leading = len(line) - len(line.lstrip())
            caption_start = line_start + leading
            caption_end = caption_start + len(caption)
            timestamp = ''
            speaker = ''
        segments.append({
            'segment_id': f'seg-{len(segments) + 1}',
            'timestamp': timestamp,
            'speaker': speaker,
            'text': caption,
            'start_offset': caption_start,
            'end_offset': caption_end,
        })
    if not segments and text.strip():
        stripped = text.strip()
        leading = len(text) - len(text.lstrip())
        segments.append({
            'segment_id': 'seg-1',
            'timestamp': '',
            'speaker': '',
            'text': stripped,
            'start_offset': leading,
            'end_offset': leading + len(stripped),
        })
    return segments


def _safe_text(value, max_chars):
    return str(value or '').strip()[:max_chars]


def sanitize_code_payload(payload, *, default_color='teal'):
    item = payload if isinstance(payload, dict) else {}
    name = _safe_text(item.get('name', ''), 80)
    if not name:
        return None
    return {
        'name': name,
        'description': _safe_text(item.get('description', ''), 500),
        'color': sanitize_code_color(item.get('color', default_color)),
        'parent_code_id': _safe_text(item.get('parent_code_id', ''), 120),
    }


def _find_quote_offsets(segment, quote, transcript):
    quote_text = str(quote or '').strip()
    if not quote_text:
        return None
    segment_text = str(segment.get('text', '') or '')
    index = segment_text.find(quote_text)
    if index >= 0:
        start = int(segment.get('start_offset', 0) or 0) + index
        return (start, start + len(quote_text))
    global_index = str(transcript or '').find(quote_text)
    if global_index >= 0:
        return (global_index, global_index + len(quote_text))
    collapsed_quote = re.sub(r'\s+', ' ', quote_text).strip()
    collapsed_segment = re.sub(r'\s+', ' ', segment_text).strip()
    if collapsed_quote and collapsed_quote in collapsed_segment:
        return (int(segment.get('start_offset', 0) or 0), int(segment.get('end_offset', 0) or 0))
    return None


def sanitize_quotation_payload(payload, transcript, allowed_code_ids, *, pack_id='', transcript_key=''):
    item = payload if isinstance(payload, dict) else {}
    text = str(transcript or '')
    code_ids = []
    for raw_code_id in item.get('code_ids', []):
        code_id = str(raw_code_id or '').strip()
        if code_id and code_id in allowed_code_ids and code_id not in code_ids:
            code_ids.append(code_id)
    if not code_ids:
        return None
    try:
        start_offset = max(0, int(item.get('start_offset', 0) or 0))
        end_offset = max(0, int(item.get('end_offset', 0) or 0))
    except Exception:
        return None
    if end_offset <= start_offset or end_offset > len(text):
        return None
    quote_text = str(item.get('text', '') or '').strip()
    actual_text = text[start_offset:end_offset].strip()
    if not quote_text or quote_text != actual_text:
        quote_text = actual_text
    if not quote_text:
        return None
    segment = find_segment_for_offsets(parse_transcript_segments(text), start_offset, end_offset)
    return {
        'pack_id': str(pack_id or '').strip(),
        'transcript_base_key': str(transcript_key or '').strip(),
        'start_offset': start_offset,
        'end_offset': end_offset,
        'text': quote_text[:4000],
        'speaker': str(segment.get('speaker', '') if segment else '')[:80],
        'timestamp': str(segment.get('timestamp', '') if segment else '')[:32],
        'code_ids': code_ids,
        'comment': _safe_text(item.get('comment', ''), 1000),
        'source': _safe_text(item.get('source', 'manual'), 40) or 'manual',
    }


def find_segment_for_offsets(segments, start_offset, end_offset):
    for segment in segments or []:
        if int(segment.get('start_offset', 0) or 0) <= start_offset and int(segment.get('end_offset', 0) or 0) >= end_offset:
            return segment
    for segment in segments or []:
        if int(segment.get('start_offset', 0) or 0) <= start_offset <= int(segment.get('end_offset', 0) or 0):
            return segment
    return None


def build_ai_prompt(template, transcript_segments, existing_codes):
    compact_segments = []
    for segment in transcript_segments or []:
        compact_segments.append({
            'segment_id': segment.get('segment_id', ''),
            'timestamp': segment.get('timestamp', ''),
            'speaker': segment.get('speaker', ''),
            'text': segment.get('text', ''),
        })
    compact_codes = []
    for code in existing_codes or []:
        compact_codes.append({
            'code_id': code.get('code_id', ''),
            'name': code.get('name', ''),
            'description': code.get('description', ''),
            'parent_code_id': code.get('parent_code_id', ''),
        })
    return template.format(
        existing_codes_json=json.dumps(compact_codes, ensure_ascii=False),
        segments_json=json.dumps(compact_segments, ensure_ascii=False),
    )


def sanitize_ai_coding_payload(raw_text, transcript, transcript_segments, existing_code_ids=None, max_items=300):
    parsed = study_generation.extract_json_payload(raw_text)
    if not isinstance(parsed, dict):
        return {'codes': [], 'quotations': [], 'error': 'AI coding JSON parsing failed.'}
    existing_ids = {str(value or '').strip() for value in (existing_code_ids or []) if str(value or '').strip()}
    codes = []
    temp_ids = set()
    for index, item in enumerate(parsed.get('codes', []) if isinstance(parsed.get('codes', []), list) else []):
        if not isinstance(item, dict):
            continue
        name = _safe_text(item.get('name', ''), 80)
        if not name:
            continue
        temp_id = _safe_text(item.get('temp_id', ''), 80) or f'c{index + 1}'
        if temp_id in temp_ids:
            temp_id = f'{temp_id}-{index + 1}'
        temp_ids.add(temp_id)
        existing_code_id = _safe_text(item.get('existing_code_id', ''), 120)
        codes.append({
            'temp_id': temp_id,
            'name': name,
            'description': _safe_text(item.get('description', ''), 500),
            'color': sanitize_code_color(item.get('color', 'teal')),
            'parent_temp_id': _safe_text(item.get('parent_temp_id', ''), 80),
            'existing_code_id': existing_code_id if existing_code_id in existing_ids else '',
        })
        if len(codes) >= max_items:
            break

    code_refs = set(temp_ids) | existing_ids
    segment_by_id = {segment.get('segment_id'): segment for segment in transcript_segments or []}
    quotations = []
    seen = set()
    for item in parsed.get('quotations', []) if isinstance(parsed.get('quotations', []), list) else []:
        if not isinstance(item, dict):
            continue
        segment = segment_by_id.get(str(item.get('segment_id', '') or '').strip())
        if not segment:
            continue
        quote = _safe_text(item.get('quote', ''), 4000)
        offsets = _find_quote_offsets(segment, quote, transcript)
        if offsets is None:
            continue
        refs = []
        for raw_ref in item.get('code_refs', []) if isinstance(item.get('code_refs', []), list) else []:
            ref = str(raw_ref or '').strip()
            if ref and ref in code_refs and ref not in refs:
                refs.append(ref)
        if not refs:
            continue
        start_offset, end_offset = offsets
        exact_text = str(transcript or '')[start_offset:end_offset].strip() or quote
        key = (start_offset, end_offset, tuple(sorted(refs)))
        if key in seen:
            continue
        seen.add(key)
        quotations.append({
            'segment_id': segment.get('segment_id', ''),
            'start_offset': start_offset,
            'end_offset': end_offset,
            'text': exact_text[:4000],
            'speaker': segment.get('speaker', ''),
            'timestamp': segment.get('timestamp', ''),
            'code_refs': refs,
            'comment': _safe_text(item.get('comment', ''), 1000),
        })
        if len(quotations) >= max_items:
            break
    if not codes and not quotations:
        return {'codes': [], 'quotations': [], 'error': 'AI coding returned no usable codes or quotations.'}
    return {'codes': codes, 'quotations': quotations, 'error': None}


def split_segments_for_ai(transcript_segments, max_chars=120000):
    chunks = []
    current = []
    current_chars = 0
    for segment in transcript_segments or []:
        segment_chars = len(str(segment.get('text', '') or '')) + 80
        if current and current_chars + segment_chars > max_chars:
            chunks.append(current)
            current = []
            current_chars = 0
        current.append(segment)
        current_chars += segment_chars
    if current:
        chunks.append(current)
    return chunks or [[]]


def build_interview_coding_pdf(pack_title, transcript, codes, quotations):
    if not study_export.REPORTLAB_AVAILABLE:
        raise RuntimeError('PDF export is currently unavailable')
    io = study_export.io
    colors = study_export.colors
    mm = study_export.mm
    SimpleDocTemplate = study_export.SimpleDocTemplate
    Paragraph = study_export.Paragraph
    ParagraphStyle = study_export.ParagraphStyle
    Spacer = study_export.Spacer
    Table = study_export.Table
    TableStyle = study_export.TableStyle
    getSampleStyleSheet = study_export.getSampleStyleSheet

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=study_export.A4, leftMargin=14 * mm, rightMargin=14 * mm, topMargin=14 * mm, bottomMargin=14 * mm)
    base_styles = getSampleStyleSheet()
    styles = {
        'title': ParagraphStyle('CodingTitle', parent=base_styles['Heading1'], fontName='Helvetica-Bold', fontSize=18, leading=22, textColor=colors.HexColor('#0F172A'), spaceAfter=6),
        'section': ParagraphStyle('CodingSection', parent=base_styles['Heading2'], fontName='Helvetica-Bold', fontSize=13, leading=17, textColor=colors.HexColor('#111827'), spaceBefore=10, spaceAfter=6),
        'body': ParagraphStyle('CodingBody', parent=base_styles['BodyText'], fontName='Helvetica', fontSize=9.5, leading=13, textColor=colors.HexColor('#111827'), spaceAfter=5),
        'small': ParagraphStyle('CodingSmall', parent=base_styles['BodyText'], fontName='Helvetica', fontSize=8.5, leading=11, textColor=colors.HexColor('#475569'), spaceAfter=3),
    }
    code_by_id = {str(code.get('code_id', '') or ''): code for code in codes or []}
    quote_counts = {}
    for quotation in quotations or []:
        for code_id in quotation.get('code_ids', []) or []:
            quote_counts[code_id] = quote_counts.get(code_id, 0) + 1
    story = [
        Paragraph(study_export.markdown_inline_to_pdf_html(pack_title or 'Interview Coding'), styles['title']),
        Paragraph(f'{len(codes or [])} codes · {len(quotations or [])} quotations', styles['small']),
        Spacer(1, 4),
        Paragraph('Codebook', styles['section']),
    ]
    if codes:
        rows = [[Paragraph('<b>Code</b>', styles['small']), Paragraph('<b>Description</b>', styles['small']), Paragraph('<b>Quotes</b>', styles['small'])]]
        for code in sorted(codes, key=lambda item: str(item.get('name', '') or '').lower()):
            name = study_export.markdown_inline_to_pdf_html(str(code.get('name', '') or 'Untitled code'))
            desc = study_export.markdown_inline_to_pdf_html(str(code.get('description', '') or ''))
            rows.append([Paragraph(name, styles['body']), Paragraph(desc or ' ', styles['body']), Paragraph(str(quote_counts.get(code.get('code_id'), 0)), styles['body'])])
        table = Table(rows, colWidths=[45 * mm, 105 * mm, 22 * mm], repeatRows=1, hAlign='LEFT')
        table.setStyle(TableStyle([
            ('GRID', (0, 0), (-1, -1), 0.3, colors.HexColor('#CBD5E1')),
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#F8FAFC')),
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ]))
        story.append(table)
    else:
        story.append(Paragraph('No codes available.', styles['body']))

    story.append(Paragraph('Quotations', styles['section']))
    if quotations:
        for quotation in sorted(quotations, key=lambda item: int(item.get('start_offset', 0) or 0)):
            names = []
            for code_id in quotation.get('code_ids', []) or []:
                code = code_by_id.get(code_id)
                if code:
                    names.append(str(code.get('name', '') or 'Untitled code'))
            meta = ' · '.join(part for part in [quotation.get('timestamp', ''), quotation.get('speaker', ''), ', '.join(names)] if part)
            if meta:
                story.append(Paragraph(study_export.markdown_inline_to_pdf_html(meta), styles['small']))
            story.append(Paragraph(study_export.markdown_inline_to_pdf_html('"' + str(quotation.get('text', '') or '') + '"'), styles['body']))
            comment = str(quotation.get('comment', '') or '').strip()
            if comment:
                story.append(Paragraph(study_export.markdown_inline_to_pdf_html('Memo: ' + comment), styles['small']))
    else:
        story.append(Paragraph('No coded quotations available.', styles['body']))

    story.append(Paragraph('Transcript', styles['section']))
    transcript_text = str(transcript or '').strip()
    if transcript_text:
        for line in transcript_text.splitlines()[:600]:
            if line.strip():
                story.append(Paragraph(study_export.markdown_inline_to_pdf_html(line[:1200]), styles['body']))
    else:
        story.append(Paragraph('No transcript available.', styles['body']))

    doc.build(story)
    buffer.seek(0)
    return buffer
