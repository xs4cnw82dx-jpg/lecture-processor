"""File validation and conversion helpers."""

import glob
import os
import re
import shutil
import subprocess
import zipfile


def allowed_file(filename, allowed_extensions):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in allowed_extensions


def get_saved_file_size(path):
    try:
        return os.path.getsize(path)
    except Exception:
        return -1


def file_has_pdf_signature(path):
    try:
        with open(path, 'rb') as handle:
            return handle.read(5) == b'%PDF-'
    except Exception:
        return False


def file_has_pptx_signature(path):
    try:
        with open(path, 'rb') as handle:
            if handle.read(4) != b'PK\x03\x04':
                return False
        with zipfile.ZipFile(path, 'r') as archive:
            members = set(archive.namelist())
        return '[Content_Types].xml' in members and 'ppt/presentation.xml' in members
    except Exception:
        return False


def get_ffmpeg_binary(*, which_func=shutil.which, imageio_ffmpeg_module=None):
    ffmpeg_bin = which_func('ffmpeg')
    if ffmpeg_bin:
        return ffmpeg_bin
    if imageio_ffmpeg_module:
        try:
            ffmpeg_bin = imageio_ffmpeg_module.get_ffmpeg_exe()
            if ffmpeg_bin and os.path.exists(ffmpeg_bin):
                return ffmpeg_bin
        except Exception:
            pass
    return ''


def get_ffprobe_binary(*, ffmpeg_binary_getter):
    ffprobe_bin = shutil.which('ffprobe')
    if ffprobe_bin:
        return ffprobe_bin
    ffmpeg_bin = ffmpeg_binary_getter()
    if not ffmpeg_bin:
        return ''
    candidate = os.path.join(os.path.dirname(ffmpeg_bin), 'ffprobe')
    if os.path.exists(candidate):
        return candidate
    return ''


def file_has_audio_signature(path):
    try:
        with open(path, 'rb') as handle:
            header = handle.read(16)
        if len(header) < 4:
            return False
        if header.startswith(b'ID3'):
            return True
        if header.startswith(b'RIFF') and header[8:12] == b'WAVE':
            return True
        if header.startswith(b'fLaC'):
            return True
        if header.startswith(b'OggS'):
            return True
        if header[4:8] == b'ftyp':
            return True
        if header[0] == 0xFF and (header[1] & 0xF0) == 0xF0:
            return True
        return False
    except Exception:
        return False


def file_looks_like_audio(path, *, ffprobe_binary_getter, subprocess_module=subprocess):
    if not path or not os.path.exists(path):
        return False
    if file_has_audio_signature(path):
        return True
    ffprobe_bin = ffprobe_binary_getter()
    if not ffprobe_bin:
        return False
    try:
        cmd = [
            ffprobe_bin,
            '-v', 'error',
            '-select_streams', 'a:0',
            '-show_entries', 'stream=codec_type',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            path,
        ]
        result = subprocess_module.run(cmd, check=False, capture_output=True, text=True, timeout=12)
        if result.returncode != 0:
            return False
        return any(line.strip().lower() == 'audio' for line in (result.stdout or '').splitlines())
    except Exception:
        return False


def get_soffice_binary(*, env_getter=os.getenv, which_func=shutil.which):
    preferred = str(env_getter('LIBREOFFICE_BIN', '') or '').strip()
    if preferred:
        candidate = which_func(preferred) if os.path.basename(preferred) == preferred else preferred
        if candidate and os.path.exists(candidate):
            return candidate
    for name in ('soffice', 'libreoffice'):
        candidate = which_func(name)
        if candidate:
            return candidate
    for fallback in ('/usr/bin/soffice', '/usr/local/bin/soffice'):
        if os.path.exists(fallback):
            return fallback
    return ''


def convert_pptx_to_pdf(source_path, target_pdf_path, *, soffice_binary_getter, subprocess_module=subprocess):
    soffice_bin = soffice_binary_getter()
    if not soffice_bin:
        return '', 'PowerPoint conversion is unavailable on this server. Please upload a PDF instead.'
    output_dir = os.path.dirname(target_pdf_path) or '.'
    os.makedirs(output_dir, exist_ok=True)
    cmd = [
        soffice_bin,
        '--headless',
        '--nologo',
        '--nolockcheck',
        '--nodefault',
        '--convert-to', 'pdf',
        '--outdir', output_dir,
        source_path,
    ]
    try:
        result = subprocess_module.run(cmd, check=False, capture_output=True, text=True, timeout=180)
    except Exception as exc:
        return '', f'Could not convert PPTX to PDF ({str(exc)[:180]}).'
    if result.returncode != 0:
        stderr = (result.stderr or result.stdout or '').strip().splitlines()
        reason = stderr[-1] if stderr else 'conversion process failed'
        return '', f'Could not convert PPTX to PDF ({reason[:220]}).'
    expected_path = target_pdf_path
    if not os.path.exists(expected_path):
        basename = os.path.splitext(os.path.basename(source_path))[0]
        fallback_path = os.path.join(output_dir, f'{basename}.pdf')
        if os.path.exists(fallback_path):
            expected_path = fallback_path
    if not os.path.exists(expected_path):
        return '', 'PowerPoint conversion finished but no PDF output was found.'
    return expected_path, ''


def resolve_uploaded_slides_to_pdf(
    uploaded_file,
    job_id,
    *,
    upload_folder,
    allowed_slide_extensions,
    allowed_slide_mime_types,
    max_pdf_upload_bytes,
    cleanup_files_fn,
    secure_filename_fn,
    allowed_file_fn,
    file_has_pdf_signature_fn,
    file_has_pptx_signature_fn,
    convert_pptx_to_pdf_fn,
    get_saved_file_size_fn,
):
    if not uploaded_file or not uploaded_file.filename:
        return '', 'Slide file is required'
    if not allowed_file_fn(uploaded_file.filename, allowed_slide_extensions):
        return '', 'Invalid slide file. Please upload PDF or PPTX.'
    mime_type = str(uploaded_file.mimetype or '').lower()
    if mime_type not in allowed_slide_mime_types:
        return '', 'Invalid slide content type'

    safe_name = secure_filename_fn(uploaded_file.filename)
    source_path = os.path.join(upload_folder, f"{job_id}_{safe_name}")
    uploaded_file.save(source_path)

    source_size = get_saved_file_size_fn(source_path)
    if source_size <= 0 or source_size > max_pdf_upload_bytes:
        cleanup_files_fn([source_path], [])
        return '', 'Slide file exceeds server limit (max 50MB) or is empty.'

    extension = safe_name.rsplit('.', 1)[1].lower() if '.' in safe_name else ''
    if extension == 'pdf':
        if not file_has_pdf_signature_fn(source_path):
            cleanup_files_fn([source_path], [])
            return '', 'Uploaded PDF file is invalid.'
        return source_path, ''

    if extension != 'pptx' or not file_has_pptx_signature_fn(source_path):
        cleanup_files_fn([source_path], [])
        return '', 'Uploaded PPTX file is invalid.'

    converted_target = os.path.join(upload_folder, f"{job_id}_slides_converted.pdf")
    converted_pdf_path, conversion_error = convert_pptx_to_pdf_fn(source_path, converted_target)

    try:
        if os.path.exists(source_path):
            os.remove(source_path)
    except Exception:
        pass

    if conversion_error:
        cleanup_files_fn([converted_target], [])
        return '', conversion_error

    converted_size = get_saved_file_size_fn(converted_pdf_path)
    if converted_size <= 0 or converted_size > max_pdf_upload_bytes:
        cleanup_files_fn([converted_pdf_path], [])
        return '', 'Converted PDF exceeds server limit (max 50MB) or is empty.'
    if not file_has_pdf_signature_fn(converted_pdf_path):
        cleanup_files_fn([converted_pdf_path], [])
        return '', 'Converted PDF file is invalid.'
    return converted_pdf_path, ''


def download_audio_from_video_url(
    source_url,
    file_prefix,
    *,
    upload_folder,
    max_audio_upload_bytes,
    ffmpeg_binary_getter,
    file_looks_like_audio_fn,
    get_saved_file_size_fn,
    which_func=shutil.which,
    subprocess_module=subprocess,
):
    ytdlp_bin = which_func('yt-dlp')
    ffmpeg_bin = ffmpeg_binary_getter()
    if not ytdlp_bin:
        raise RuntimeError('yt-dlp is not installed on the server.')
    if not ffmpeg_bin:
        raise RuntimeError('ffmpeg is not installed on the server.')

    import_dir = os.path.join(upload_folder, 'imported_audio')
    os.makedirs(import_dir, exist_ok=True)
    safe_prefix = re.sub(r'[^a-zA-Z0-9_-]+', '_', str(file_prefix or 'import')).strip('_') or 'import'
    base = os.path.join(import_dir, safe_prefix)
    output_template = f"{base}.%(ext)s"

    cmd = [
        ytdlp_bin,
        '--no-playlist',
        '--extract-audio',
        '--audio-format', 'mp3',
        '--audio-quality', '5',
        '--no-progress',
        '--restrict-filenames',
        '--ffmpeg-location', ffmpeg_bin,
        '--output', output_template,
        '--',
        source_url,
    ]
    result = subprocess_module.run(cmd, check=False, capture_output=True, text=True, timeout=15 * 60)
    if result.returncode != 0:
        stderr = (result.stderr or result.stdout or '').strip().splitlines()
        reason = stderr[-1] if stderr else 'unknown import error'
        raise RuntimeError(f'Could not fetch audio from the provided URL ({reason[:220]}).')

    candidates = sorted(glob.glob(f"{base}.*"))
    if not candidates:
        raise RuntimeError('Audio import finished but no output file was generated.')
    preferred = [path for path in candidates if path.lower().endswith('.mp3')]
    output_path = preferred[0] if preferred else candidates[0]

    size_bytes = get_saved_file_size_fn(output_path)
    if size_bytes <= 0 or size_bytes > max_audio_upload_bytes:
        try:
            if os.path.exists(output_path):
                os.remove(output_path)
        except Exception:
            pass
        raise RuntimeError('Imported audio exceeds server limit (max 500MB) or is empty.')
    if not file_looks_like_audio_fn(output_path):
        try:
            if os.path.exists(output_path):
                os.remove(output_path)
        except Exception:
            pass
        raise RuntimeError('Imported audio is invalid or unsupported.')
    return output_path, os.path.basename(output_path), size_bytes


def convert_audio_to_mp3_with_ytdlp(
    local_audio_path,
    *,
    ffmpeg_binary_getter,
    logger,
    which_func=shutil.which,
    subprocess_module=subprocess,
):
    if not local_audio_path or local_audio_path.lower().endswith('.mp3'):
        return local_audio_path, False

    ytdlp_bin = which_func('yt-dlp')
    ffmpeg_bin = ffmpeg_binary_getter()
    base_no_ext = os.path.splitext(local_audio_path)[0]
    output_path = f"{base_no_ext}_converted.mp3"

    if ytdlp_bin:
        try:
            source = f"file://{os.path.abspath(local_audio_path)}"
            command = [
                ytdlp_bin,
                '--no-playlist',
                '--extract-audio',
                '--audio-format', 'mp3',
                '--audio-quality', '5',
                '--output', f"{base_no_ext}_converted.%(ext)s",
                source,
            ]
            if ffmpeg_bin:
                command.extend(['--ffmpeg-location', ffmpeg_bin])
            result = subprocess_module.run(command, check=False, capture_output=True, text=True, timeout=300)
            if result.returncode == 0 and os.path.exists(output_path):
                return output_path, True
            if logger is not None:
                logger.info(f"⚠️ yt-dlp conversion failed: {(result.stderr or '').strip()[:300]}")
        except Exception as exc:
            if logger is not None:
                logger.info(f"⚠️ yt-dlp conversion exception: {exc}")
    else:
        if logger is not None:
            logger.info('⚠️ yt-dlp not found, skipping yt-dlp conversion.')

    if not ffmpeg_bin:
        return local_audio_path, False
    try:
        command = [
            ffmpeg_bin,
            '-y',
            '-i', local_audio_path,
            '-vn',
            '-codec:a', 'libmp3lame',
            '-q:a', '5',
            output_path,
        ]
        result = subprocess_module.run(command, check=False, capture_output=True, text=True, timeout=300)
        if result.returncode == 0 and os.path.exists(output_path):
            return output_path, True
        if logger is not None:
            logger.info(f"⚠️ ffmpeg conversion failed: {(result.stderr or '').strip()[:300]}")
    except Exception as exc:
        if logger is not None:
            logger.info(f"⚠️ ffmpeg conversion exception: {exc}")
    return local_audio_path, False


def get_mime_type(filename):
    parts = filename.rsplit('.', 1)
    ext = parts[1].lower() if len(parts) > 1 else ''
    mime_types = {
        'pdf': 'application/pdf',
        'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'mp3': 'audio/mpeg',
        'm4a': 'audio/mp4',
        'wav': 'audio/wav',
        'aac': 'audio/aac',
        'ogg': 'audio/ogg',
        'flac': 'audio/flac',
    }
    return mime_types.get(ext, 'application/octet-stream')
