from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from lecture_processor.domains.study import audio
from lecture_processor.domains.study import export
from lecture_processor.domains.study import progress


def test_progress_summary_counts_due_cards_and_streak():
    progress_data = {
        'daily_goal': 25,
        'timezone': 'UTC',
        'streak_data': {
            'last_study_date': '2026-01-02',
            'current_streak': 4,
            'daily_progress_date': '2026-01-02',
            'daily_progress_count': 6,
        },
    }
    card_state_maps = [
        {
            'fc_1': {
                'seen': 1,
                'correct': 1,
                'wrong': 0,
                'interval_days': 2,
                'next_review_date': '2026-01-01',
                'last_review_date': '2026-01-01',
                'difficulty': 'easy',
            },
            'q_1': {
                'seen': 1,
                'correct': 1,
                'wrong': 0,
                'interval_days': 2,
                'next_review_date': '2026-01-01',
                'last_review_date': '2026-01-01',
                'difficulty': 'easy',
            },
        }
    ]

    summary = progress.compute_study_progress_summary(
        progress_data,
        card_state_maps,
        base_now=datetime(2026, 1, 2, 12, 0, tzinfo=timezone.utc),
        runtime=SimpleNamespace(),
    )

    assert summary == {
        'daily_goal': 25,
        'current_streak': 4,
        'today_progress': 6,
        'due_today': 1,
    }


def test_audio_storage_round_trip_and_persist(tmp_path):
    root = tmp_path / 'uploads' / 'study_audio'
    runtime = SimpleNamespace(
        STUDY_AUDIO_RELATIVE_DIR='study_audio',
        STUDY_AUDIO_ROOT=str(root),
        UPLOAD_FOLDER=str(tmp_path / 'uploads'),
        time=SimpleNamespace(time=lambda: 123.0),
        logger=SimpleNamespace(warning=lambda *args, **kwargs: None),
    )

    assert audio.normalize_audio_storage_key('../etc/passwd', runtime=runtime) == ''

    source_path = tmp_path / 'input.mp3'
    source_path.write_bytes(b'abc123')

    key = audio.persist_audio_for_study_pack('job-1', str(source_path), runtime=runtime)
    assert key == 'study_audio/job-1.mp3'

    saved_path = audio.resolve_audio_storage_path_from_key(key, runtime=runtime)
    assert saved_path
    assert (root / 'job-1.mp3').exists()
    assert audio.infer_audio_storage_key_from_path(saved_path, runtime=runtime) == key


def test_export_helpers_handle_dates_markdown_and_html():
    assert export.normalize_exam_date('2026-12-31') == '2026-12-31'
    with pytest.raises(ValueError):
        export.normalize_exam_date('31-12-2026')

    html_value = export.markdown_inline_to_pdf_html('**Bold** *Italic* <x>')
    assert '<b>Bold</b>' in html_value
    assert '<i>Italic</i>' in html_value
    assert '&lt;x&gt;' in html_value

    doc = export.markdown_to_docx('# Title\n\n- Item one')
    assert len(doc.paragraphs) >= 2


def test_annotated_notes_html_exports_to_pdf():
    pdf_buffer = export.build_annotated_notes_pdf(
        'Neurology Notes',
        '<h1>Overview</h1><p><mark data-hl="yellow">Migraine</mark> overview paragraph.</p><ul><li>Primary symptom</li><li><mark data-hl="blue">Secondary</mark> detail</li></ul>',
    )

    pdf_bytes = pdf_buffer.getvalue()

    assert pdf_bytes.startswith(b'%PDF-')
    assert len(pdf_bytes) > 800
