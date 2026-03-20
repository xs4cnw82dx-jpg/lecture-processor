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
