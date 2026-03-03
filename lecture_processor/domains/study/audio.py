import os
import re
import shutil

from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def _study_audio_relative_dir(runtime):
    resolved_runtime = _resolve_runtime(runtime)
    return str(getattr(resolved_runtime, 'STUDY_AUDIO_RELATIVE_DIR', 'study_audio') or 'study_audio')


def _study_audio_root(runtime):
    resolved_runtime = _resolve_runtime(runtime)
    configured = getattr(resolved_runtime, 'STUDY_AUDIO_ROOT', '')
    if configured:
        return os.path.abspath(configured)
    upload_folder = str(getattr(resolved_runtime, 'UPLOAD_FOLDER', 'uploads') or 'uploads')
    return os.path.abspath(os.path.join(upload_folder, _study_audio_relative_dir(resolved_runtime)))


def parse_audio_markers_from_notes(notes_markdown, runtime=None):
    _ = runtime
    if not notes_markdown:
        return []
    pattern = re.compile('#{1,3}\\s+(.+?)\\s*\\n\\s*<!--\\s*audio:(\\d+)-(\\d+)\\s*-->', re.MULTILINE)
    notes_audio_map = []
    section_index = 0
    for match in pattern.finditer(notes_markdown):
        try:
            start_ms = int(match.group(2))
            end_ms = int(match.group(3))
        except Exception:
            continue
        notes_audio_map.append(
            {
                'section_index': section_index,
                'section_title': match.group(1).strip(),
                'start_ms': max(0, start_ms),
                'end_ms': max(start_ms, end_ms),
            }
        )
        section_index += 1
    return notes_audio_map


def format_transcript_with_timestamps(segments, runtime=None):
    _ = runtime
    if not isinstance(segments, list):
        return ''
    lines = []
    for seg in segments:
        if not isinstance(seg, dict):
            continue
        text = str(seg.get('text', '') or '').strip()
        if not text:
            continue
        start_ms = int(seg.get('start_ms', 0) or 0)
        end_ms = int(seg.get('end_ms', start_ms) or start_ms)
        lines.append(f'[{start_ms}-{end_ms}] {text}')
    return '\n'.join(lines)


def ensure_study_audio_root(runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    os.makedirs(_study_audio_root(resolved_runtime), exist_ok=True)


def normalize_audio_storage_key(raw_key, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    key = str(raw_key or '').strip().replace('\\', '/')
    if not key:
        return ''
    key = os.path.normpath(key).replace('\\', '/')
    while key.startswith('./'):
        key = key[2:]
    if key.startswith('/'):
        return ''
    if key == '.' or key.startswith('../') or '/..' in key:
        return ''
    relative_dir = _study_audio_relative_dir(resolved_runtime)
    if not key.startswith(f'{relative_dir}/'):
        return ''
    return key


def resolve_audio_storage_path_from_key(raw_key, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    key = normalize_audio_storage_key(raw_key, runtime=resolved_runtime)
    if not key:
        return ''
    ensure_study_audio_root(runtime=resolved_runtime)
    relative_dir = _study_audio_relative_dir(resolved_runtime)
    root = _study_audio_root(resolved_runtime)
    relative_path = key[len(f'{relative_dir}/') :]
    absolute_path = os.path.abspath(os.path.join(root, relative_path))
    if not absolute_path.startswith(root + os.sep):
        return ''
    return absolute_path


def infer_audio_storage_key_from_path(raw_path, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    path = str(raw_path or '').strip()
    if not path:
        return ''
    absolute_path = os.path.abspath(path)
    ensure_study_audio_root(runtime=resolved_runtime)
    root = _study_audio_root(resolved_runtime)
    if not absolute_path.startswith(root + os.sep):
        return ''
    relative = os.path.relpath(absolute_path, root).replace('\\', '/')
    if relative == '.' or relative.startswith('../'):
        return ''
    return normalize_audio_storage_key(f"{_study_audio_relative_dir(resolved_runtime)}/{relative}", runtime=resolved_runtime)


def get_audio_storage_key_from_pack(pack, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    if not isinstance(pack, dict):
        return ''
    key = normalize_audio_storage_key(pack.get('audio_storage_key', ''), runtime=resolved_runtime)
    if key:
        return key
    return infer_audio_storage_key_from_path(pack.get('audio_storage_path', ''), runtime=resolved_runtime)


def get_audio_storage_path_from_pack(pack, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    key = get_audio_storage_key_from_pack(pack, runtime=resolved_runtime)
    if key:
        return resolve_audio_storage_path_from_key(key, runtime=resolved_runtime)
    return ''


def ensure_pack_audio_storage_key(pack_ref, pack, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    key = get_audio_storage_key_from_pack(pack, runtime=resolved_runtime)
    if key and (not normalize_audio_storage_key(pack.get('audio_storage_key', ''), runtime=resolved_runtime)):
        try:
            pack_ref.set(
                {
                    'audio_storage_key': key,
                    'has_audio_playback': True,
                    'updated_at': resolved_runtime.time.time(),
                },
                merge=True,
            )
        except Exception:
            pass
    return key


def remove_pack_audio_file(pack, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    target_path = get_audio_storage_path_from_pack(pack, runtime=resolved_runtime)
    if not target_path:
        return False
    try:
        if os.path.exists(target_path):
            os.remove(target_path)
            return True
    except Exception:
        return False
    return False


def persist_audio_for_study_pack(job_id, audio_source_path, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    if not audio_source_path or not os.path.exists(audio_source_path):
        return ''
    ext = os.path.splitext(audio_source_path)[1].lower() or '.mp3'
    ensure_study_audio_root(runtime=resolved_runtime)
    target_key = normalize_audio_storage_key(
        f"{_study_audio_relative_dir(resolved_runtime)}/{job_id}{ext}",
        runtime=resolved_runtime,
    )
    target_path = resolve_audio_storage_path_from_key(target_key, runtime=resolved_runtime)
    if not target_path:
        return ''
    try:
        shutil.copy2(audio_source_path, target_path)
        return target_key
    except Exception as error:
        resolved_runtime.logger.warning('⚠️ Could not persist audio for study pack %s: %s', job_id, error)
        return ''
