from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from lecture_processor.domains.study import audio
from lecture_processor.domains.study import export
from lecture_processor.domains.study import interview_coding
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


def test_progress_helpers_count_viewed_cards_as_familiar_and_due():
    cleaned = progress.sanitize_card_state_entry(
        {
            'flip_count': 1,
            'last_action': 'retry',
            'difficulty': 'hard',
            'max_interval_days': 21,
        },
        runtime=SimpleNamespace(),
    )

    assert cleaned == {
        'seen': 0,
        'correct': 0,
        'wrong': 0,
        'level': 'familiar',
        'interval_days': 0,
        'max_interval_days': 21,
        'next_review_date': '',
        'last_review_date': '',
        'difficulty': 'hard',
        'last_action': 'retry',
        'flip_count': 1,
        'write_count': 0,
    }

    summary = progress.compute_study_progress_summary(
        {'daily_goal': 10, 'timezone': 'UTC', 'streak_data': {}},
        [{'fc_1': cleaned}],
        base_now=datetime(2026, 3, 22, 12, 0, tzinfo=timezone.utc),
        runtime=SimpleNamespace(),
    )

    assert summary['due_today'] == 1


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
    assert audio.audio_storage_key_has_file(key, runtime=runtime) is True
    assert audio.pack_audio_file_exists({'audio_storage_key': key}, runtime=runtime) is True

    (root / 'job-1.mp3').unlink()
    assert audio.audio_storage_key_has_file(key, runtime=runtime) is False
    assert audio.pack_audio_file_exists({'audio_storage_key': key}, runtime=runtime) is False


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


def test_interview_coding_parses_segments_and_ai_payload():
    transcript = "00:01 - Speaker A - We need better follow-up care.\n00:12 - Speaker B - Follow-up is hard at home."
    segments = interview_coding.parse_transcript_segments(transcript)

    assert segments[0]["segment_id"] == "seg-1"
    assert segments[0]["speaker"] == "Speaker A"
    assert transcript[segments[0]["start_offset"]:segments[0]["end_offset"]] == "We need better follow-up care."

    payload = interview_coding.sanitize_ai_coding_payload(
        """
        {
          "codes": [{"temp_id": "c1", "name": "Follow-up care", "description": "Care after the appointment", "color": "teal"}],
          "quotations": [{"segment_id": "seg-1", "quote": "better follow-up care", "code_refs": ["c1"], "comment": "important barrier"}]
        }
        """,
        transcript,
        segments,
    )

    assert payload["error"] is None
    assert payload["codes"][0]["name"] == "Follow-up care"
    assert payload["quotations"][0]["text"] == "better follow-up care"
    assert payload["quotations"][0]["code_refs"] == ["c1"]


def test_interview_coding_validates_multiple_code_quotation_and_pdf():
    transcript = "00:01 - Speaker A - Patients want clear guidance."
    code_ids = {"code-1", "code-2"}
    start = transcript.index("Patients")
    end = len(transcript)
    payload = interview_coding.sanitize_quotation_payload(
        {
            "start_offset": start,
            "end_offset": end,
            "code_ids": ["code-1", "code-2"],
            "comment": "two concepts",
        },
        transcript,
        code_ids,
        pack_id="pack-1",
        transcript_key="pack-1:key",
    )

    assert payload["code_ids"] == ["code-1", "code-2"]
    assert payload["text"] == "Patients want clear guidance."

    pdf_buffer = interview_coding.build_interview_coding_pdf(
        "Interview",
        transcript,
        [
            {"code_id": "code-1", "name": "Patient needs", "description": "", "color": "teal"},
            {"code_id": "code-2", "name": "Guidance", "description": "", "color": "amber"},
        ],
        [{**payload, "quotation_id": "q1"}],
    )
    assert pdf_buffer.getvalue().startswith(b"%PDF-")
