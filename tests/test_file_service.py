import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from lecture_processor.services import file_service


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
