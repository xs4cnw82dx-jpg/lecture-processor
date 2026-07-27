from pathlib import Path
import importlib.util
import sys


ROOT = Path(__file__).parents[1]


def _load(name):
    path = ROOT / f"scripts/{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    assert spec.loader
    spec.loader.exec_module(module)
    return module


def test_launch_agent_is_loopback_runner_and_never_cloud_server(tmp_path):
    module = _load("install_physio_companion")
    repo = tmp_path / "repo"
    payload = module.launch_agent_payload(repo, Path("/usr/bin/python3"), tmp_path / "support")

    assert payload["RunAtLoad"] is True
    assert payload["ProgramArguments"][1] == str(repo / "scripts/run_physio_companion.py")
    assert payload["ProgramArguments"][-1] == "--no-browser"
    assert "gunicorn" not in " ".join(payload["ProgramArguments"])
    assert "/opt/homebrew/bin" in payload["EnvironmentVariables"]["PATH"]


def test_runner_rejects_non_loopback_host():
    text = (ROOT / "scripts/run_physio_companion.py").read_text(encoding="utf-8")
    assert 'choices=("127.0.0.1", "localhost")' in text
    assert 'owner_token=_stable_secret(app_support, "owner-token")' in text
    assert '#owner_token={config.owner_token}' in text


def test_installer_preserves_virtualenv_executable():
    text = (ROOT / "scripts/install_physio_companion.py").read_text(encoding="utf-8")
    assert "Path(sys.executable).absolute()" in text
    assert "Path(sys.executable).resolve()" not in text


def test_installer_owner_token_is_stable_and_private(tmp_path):
    module = _load("install_physio_companion")

    first = module.ensure_owner_token(tmp_path)
    second = module.ensure_owner_token(tmp_path)

    assert first == second
    assert len(first) >= 32
    assert (tmp_path / "owner-token").stat().st_mode & 0o077 == 0
