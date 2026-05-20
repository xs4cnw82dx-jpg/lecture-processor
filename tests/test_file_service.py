import json
import socket
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from lecture_processor.services import file_service, ytdlp_network_guard
from lecture_processor.services.url_security import ValidatedFetchTarget


class _UploadedFile:
    def __init__(self, filename, mimetype, data):
        self.filename = filename
        self.mimetype = mimetype
        self._data = data

    def save(self, path):
        Path(path).write_bytes(self._data)


def _resolve_uploaded_slides_to_pdf(uploaded_file, tmp_path, cleanup_files_fn):
    return file_service.resolve_uploaded_slides_to_pdf(
        uploaded_file,
        "job",
        upload_folder=str(tmp_path),
        allowed_slide_extensions={"pdf", "pptx"},
        allowed_slide_mime_types={
            "application/pdf",
            "application/x-pdf",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "application/vnd.ms-powerpoint",
        },
        max_pdf_upload_bytes=50 * 1024 * 1024,
        cleanup_files_fn=cleanup_files_fn,
        secure_filename_fn=lambda filename: filename,
        allowed_file_fn=file_service.allowed_file,
        file_has_pdf_signature_fn=file_service.file_has_pdf_signature,
        file_has_pptx_signature_fn=file_service.file_has_pptx_signature,
        convert_pptx_to_pdf_fn=lambda _source_path, _target_path: ("", "unexpected conversion"),
        get_saved_file_size_fn=file_service.get_saved_file_size,
    )


@pytest.mark.parametrize("mime_type", ["", "application/octet-stream"])
def test_resolve_uploaded_slides_allows_generic_mime_after_pdf_signature(tmp_path, mime_type):
    cleaned_paths = []
    uploaded = _UploadedFile("slides.pdf", mime_type, b"%PDF-1.4\n")

    path, error = _resolve_uploaded_slides_to_pdf(
        uploaded,
        tmp_path,
        lambda paths, _dirs: cleaned_paths.extend(paths),
    )

    assert error == ""
    assert Path(path).read_bytes().startswith(b"%PDF-")
    assert cleaned_paths == []


def test_resolve_uploaded_slides_rejects_generic_mime_without_pdf_signature(tmp_path):
    cleaned_paths = []

    def cleanup_files(paths, _dirs):
        cleaned_paths.extend(paths)
        for path in paths:
            Path(path).unlink(missing_ok=True)

    path, error = _resolve_uploaded_slides_to_pdf(
        _UploadedFile("slides.pdf", "application/octet-stream", b"not-a-pdf"),
        tmp_path,
        cleanup_files,
    )

    expected_path = tmp_path / "job_slides.pdf"
    assert path == ""
    assert error == "Uploaded PDF file is invalid."
    assert cleaned_paths == [str(expected_path)]
    assert not expected_path.exists()


def test_download_audio_from_video_url_rejects_overlong_media_before_download(tmp_path):
    calls = []

    class _FakeSubprocess:
        def run(self, cmd, **_kwargs):
            calls.append(list(cmd))
            return SimpleNamespace(returncode=0, stdout=json.dumps({"duration": 25_000}), stderr="")

    with pytest.raises(RuntimeError, match="too long to fit within the server limit"):
        file_service.download_audio_from_video_url(
            "https://example.com/video",
            "lecture-audio",
            upload_folder=str(tmp_path),
            max_audio_upload_bytes=500 * 1024 * 1024,
            ffmpeg_binary_getter=lambda: "/usr/bin/ffmpeg",
            file_looks_like_audio_fn=lambda _path: True,
            get_saved_file_size_fn=lambda _path: 0,
            which_func=lambda name: "/usr/bin/yt-dlp" if name == "yt-dlp" else "",
            subprocess_module=_FakeSubprocess(),
        )

    assert len(calls) == 1
    assert "--dump-single-json" in calls[0]


def test_download_audio_from_video_url_redacts_urls_from_tool_errors(tmp_path):
    class _FakeSubprocess:
        def run(self, cmd, **_kwargs):
            if "--dump-single-json" in cmd:
                return SimpleNamespace(returncode=0, stdout=json.dumps({"duration": 60}), stderr="")
            return SimpleNamespace(
                returncode=1,
                stdout="",
                stderr="ERROR: unable to download https://example.com/private/video.m3u8?token=secret",
            )

    with pytest.raises(RuntimeError) as exc_info:
        file_service.download_audio_from_video_url(
            "https://example.com/private/video.m3u8?token=secret",
            "lecture-audio",
            upload_folder=str(tmp_path),
            max_audio_upload_bytes=500 * 1024 * 1024,
            ffmpeg_binary_getter=lambda: "/usr/bin/ffmpeg",
            file_looks_like_audio_fn=lambda _path: True,
            get_saved_file_size_fn=lambda _path: 0,
            which_func=lambda name: "/usr/bin/yt-dlp" if name == "yt-dlp" else "",
            subprocess_module=_FakeSubprocess(),
        )

    message = str(exc_info.value)
    assert "token=secret" not in message
    assert "/private/video.m3u8" not in message
    assert "https://example.com/[redacted]" in message


def test_guarded_ytdlp_command_uses_pinned_fetch_target_and_strips_proxies(monkeypatch):
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.local:8080")
    target = ValidatedFetchTarget(
        url="https://video.example.com/watch",
        scheme="https",
        host="video.example.com",
        port=443,
        resolved_ips=("93.184.216.34",),
    )

    command, env = file_service._guarded_ytdlp_command(
        ["/usr/bin/yt-dlp", "--dump-single-json", "--", "https://video.example.com/watch"],
        target,
    )

    assert command[:3] == [sys.executable, "-m", "lecture_processor.services.ytdlp_network_guard"]
    assert "--proxy" in command
    assert "HTTPS_PROXY" not in env
    guard_config = json.loads(env["LECTURE_PROCESSOR_YTDLP_GUARD"])
    assert guard_config == {"host": "video.example.com", "port": 443, "resolved_ips": ["93.184.216.34"]}


def test_ytdlp_network_guard_rejects_restricted_dns_results():
    def _restricted_getaddrinfo(*_args, **_kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("127.0.0.1", 443))]

    guarded = ytdlp_network_guard._guard_getaddrinfo(
        _restricted_getaddrinfo,
        "video.example.com",
        443,
        ("93.184.216.34",),
    )

    pinned = guarded("video.example.com", 443)
    assert pinned[0][4][0] == "93.184.216.34"
    with pytest.raises(socket.gaierror):
        guarded("cdn.example.com", 443)


def test_download_audio_from_video_url_cleans_up_partial_files_on_timeout(tmp_path):
    upload_folder = Path(tmp_path)

    class _FakeSubprocess:
        def run(self, cmd, **kwargs):
            if "--dump-single-json" in cmd:
                return SimpleNamespace(returncode=0, stdout=json.dumps({"duration": 60}), stderr="")
            output_template = cmd[cmd.index("--output") + 1]
            partial_path = Path(output_template.replace("%(ext)s", "part"))
            partial_path.write_bytes(b"partial download")
            raise subprocess.TimeoutExpired(cmd=cmd, timeout=kwargs.get("timeout"))

    with pytest.raises(RuntimeError, match="download timed out"):
        file_service.download_audio_from_video_url(
            "https://example.com/video",
            "timed-out-audio",
            upload_folder=str(upload_folder),
            max_audio_upload_bytes=500 * 1024 * 1024,
            ffmpeg_binary_getter=lambda: "/usr/bin/ffmpeg",
            file_looks_like_audio_fn=lambda _path: True,
            get_saved_file_size_fn=lambda _path: 0,
            which_func=lambda name: "/usr/bin/yt-dlp" if name == "yt-dlp" else "",
            subprocess_module=_FakeSubprocess(),
        )

    imported_dir = upload_folder / "imported_audio"
    assert sorted(imported_dir.glob("timed-out-audio.*")) == []


def test_download_audio_from_video_url_uses_max_filesize_for_audio_only_sources(tmp_path):
    commands = []

    class _FakeSubprocess:
        def run(self, cmd, **_kwargs):
            commands.append(list(cmd))
            if "--dump-single-json" in cmd:
                return SimpleNamespace(
                    returncode=0,
                    stdout=json.dumps({"duration": 120, "filesize": 1024, "vcodec": "none"}),
                    stderr="",
                )
            output_template = cmd[cmd.index("--output") + 1]
            output_path = Path(output_template.replace("%(ext)s", "mp3"))
            output_path.write_bytes(b"ID3\x03\x00\x00\x00")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

    output_path, output_name, size_bytes = file_service.download_audio_from_video_url(
        "https://example.com/audio-only",
        "audio-only",
        upload_folder=str(tmp_path),
        max_audio_upload_bytes=500 * 1024 * 1024,
        ffmpeg_binary_getter=lambda: "/usr/bin/ffmpeg",
        file_looks_like_audio_fn=lambda _path: True,
        get_saved_file_size_fn=lambda _path: 2048,
        which_func=lambda name: "/usr/bin/yt-dlp" if name == "yt-dlp" else "",
        subprocess_module=_FakeSubprocess(),
    )

    assert output_name == "audio-only.mp3"
    assert size_bytes == 2048
    assert output_path.endswith("audio-only.mp3")
    assert any("--max-filesize" in command for command in commands if "--extract-audio" in command)


def test_download_audio_from_video_url_uses_max_filesize_without_source_size(tmp_path):
    commands = []

    class _FakeSubprocess:
        def run(self, cmd, **_kwargs):
            commands.append(list(cmd))
            if "--dump-single-json" in cmd:
                return SimpleNamespace(
                    returncode=0,
                    stdout=json.dumps({"duration": 120}),
                    stderr="",
                )
            output_template = cmd[cmd.index("--output") + 1]
            output_path = Path(output_template.replace("%(ext)s", "mp3"))
            output_path.write_bytes(b"ID3\x03\x00\x00\x00")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

    output_path, output_name, size_bytes = file_service.download_audio_from_video_url(
        "https://example.com/video-without-size",
        "video-without-size",
        upload_folder=str(tmp_path),
        max_audio_upload_bytes=500 * 1024 * 1024,
        ffmpeg_binary_getter=lambda: "/usr/bin/ffmpeg",
        file_looks_like_audio_fn=lambda _path: True,
        get_saved_file_size_fn=lambda _path: 2048,
        which_func=lambda name: "/usr/bin/yt-dlp" if name == "yt-dlp" else "",
        subprocess_module=_FakeSubprocess(),
    )

    assert output_name == "video-without-size.mp3"
    assert size_bytes == 2048
    assert output_path.endswith("video-without-size.mp3")
    extract_commands = [command for command in commands if "--extract-audio" in command]
    assert len(extract_commands) == 1
    assert "--max-filesize" in extract_commands[0]
    assert str(500 * 1024 * 1024) in extract_commands[0]


def test_download_video_from_video_url_returns_mp4_when_download_succeeds(tmp_path):
    commands = []

    class _FakeSubprocess:
        def run(self, cmd, **_kwargs):
            commands.append(list(cmd))
            if "--dump-single-json" in cmd:
                return SimpleNamespace(
                    returncode=0,
                    stdout=json.dumps({"filesize": 1024}),
                    stderr="",
                )
            output_template = cmd[cmd.index("--output") + 1]
            output_path = Path(output_template.replace("%(ext)s", "mp4"))
            output_path.write_bytes(b"video-bytes")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

    output_path, output_name, size_bytes = file_service.download_video_from_video_url(
        "https://example.com/video",
        "lecture-video",
        upload_folder=str(tmp_path),
        max_download_bytes=500 * 1024 * 1024,
        ffmpeg_binary_getter=lambda: "/usr/bin/ffmpeg",
        get_saved_file_size_fn=lambda _path: 4096,
        which_func=lambda name: "/usr/bin/yt-dlp" if name == "yt-dlp" else "",
        subprocess_module=_FakeSubprocess(),
    )

    assert output_name == "lecture-video.mp4"
    assert size_bytes == 4096
    assert output_path.endswith("lecture-video.mp4")
    video_command = next(command for command in commands if "--dump-single-json" not in command)
    assert "--remux-video" in video_command
    assert "--recode-video" not in video_command
    assert "mp4" in video_command


def test_download_video_from_video_url_falls_back_to_recode_when_remux_fails(tmp_path):
    commands = []

    class _FakeSubprocess:
        def run(self, cmd, **_kwargs):
            commands.append(list(cmd))
            if "--dump-single-json" in cmd:
                return SimpleNamespace(returncode=0, stdout=json.dumps({"filesize": 1024}), stderr="")
            if "--remux-video" in cmd:
                return SimpleNamespace(returncode=1, stdout="", stderr="remux failed")
            output_template = cmd[cmd.index("--output") + 1]
            output_path = Path(output_template.replace("%(ext)s", "mp4"))
            output_path.write_bytes(b"video-bytes")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

    output_path, output_name, size_bytes = file_service.download_video_from_video_url(
        "https://example.com/video",
        "lecture-video",
        upload_folder=str(tmp_path),
        max_download_bytes=500 * 1024 * 1024,
        ffmpeg_binary_getter=lambda: "/usr/bin/ffmpeg",
        get_saved_file_size_fn=lambda _path: 4096,
        which_func=lambda name: "/usr/bin/yt-dlp" if name == "yt-dlp" else "",
        subprocess_module=_FakeSubprocess(),
    )

    assert output_name == "lecture-video.mp4"
    assert size_bytes == 4096
    assert output_path.endswith("lecture-video.mp4")
    video_commands = [command for command in commands if "--dump-single-json" not in command]
    assert len(video_commands) == 2
    assert "--remux-video" in video_commands[0]
    assert "--recode-video" in video_commands[1]


def test_download_video_from_video_url_rejects_known_oversize_file(tmp_path):
    class _FakeSubprocess:
        def run(self, cmd, **_kwargs):
            return SimpleNamespace(
                returncode=0,
                stdout=json.dumps({"filesize": 900 * 1024 * 1024}),
                stderr="",
            )

    with pytest.raises(RuntimeError, match="exceeds server limit"):
        file_service.download_video_from_video_url(
            "https://example.com/video",
            "lecture-video",
            upload_folder=str(tmp_path),
            max_download_bytes=500 * 1024 * 1024,
            ffmpeg_binary_getter=lambda: "/usr/bin/ffmpeg",
            get_saved_file_size_fn=lambda _path: 0,
            which_func=lambda name: "/usr/bin/yt-dlp" if name == "yt-dlp" else "",
            subprocess_module=_FakeSubprocess(),
        )


def test_convert_audio_to_mp3_with_ytdlp_prefers_ffmpeg_for_local_files(tmp_path):
    source_path = Path(tmp_path) / "lecture.wav"
    source_path.write_bytes(b"RIFF0000WAVEfmt ")
    commands = []

    class _FakeSubprocess:
        def run(self, cmd, **_kwargs):
            commands.append(list(cmd))
            assert cmd[0] == "/usr/bin/ffmpeg"
            output_path = Path(cmd[-1])
            output_path.write_bytes(b"ID3\x03\x00\x00\x00")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

    output_path, converted = file_service.convert_audio_to_mp3_with_ytdlp(
        str(source_path),
        ffmpeg_binary_getter=lambda: "/usr/bin/ffmpeg",
        logger=None,
        which_func=lambda name: "/usr/bin/yt-dlp" if name == "yt-dlp" else "",
        subprocess_module=_FakeSubprocess(),
    )

    assert converted is True
    assert output_path.endswith("_converted.mp3")
    assert len(commands) == 1
    assert commands[0][0] == "/usr/bin/ffmpeg"


def test_convert_audio_to_mp3_with_ytdlp_falls_back_to_ytdlp_when_ffmpeg_fails(tmp_path):
    source_path = Path(tmp_path) / "lecture.wav"
    source_path.write_bytes(b"RIFF0000WAVEfmt ")
    commands = []

    class _FakeSubprocess:
        def run(self, cmd, **_kwargs):
            commands.append(list(cmd))
            if cmd[0] == "/usr/bin/ffmpeg":
                return SimpleNamespace(returncode=1, stdout="", stderr="ffmpeg failed")
            output_template = cmd[cmd.index("--output") + 1]
            output_path = Path(output_template.replace("%(ext)s", "mp3"))
            output_path.write_bytes(b"ID3\x03\x00\x00\x00")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

    output_path, converted = file_service.convert_audio_to_mp3_with_ytdlp(
        str(source_path),
        ffmpeg_binary_getter=lambda: "/usr/bin/ffmpeg",
        logger=None,
        which_func=lambda name: "/usr/bin/yt-dlp" if name == "yt-dlp" else "",
        subprocess_module=_FakeSubprocess(),
    )

    assert converted is True
    assert output_path.endswith("_converted.mp3")
    assert len(commands) == 2
    assert commands[0][0] == "/usr/bin/ffmpeg"
    assert commands[1][0] == "/usr/bin/yt-dlp"
