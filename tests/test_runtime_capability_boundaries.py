from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DIRECT_REPOSITORY_ATTRIBUTES = (
    ".admin_credit_grants_repo",
    ".admin_repo",
    ".batch_repo",
    ".planner_repo",
    ".purchases_repo",
    ".runtime_jobs_repo",
    ".study_repo",
    ".users_repo",
)


def test_services_use_explicit_repository_capability():
    offenders = []
    for path in (ROOT / "lecture_processor/services").glob("*.py"):
        text = path.read_text(encoding="utf-8")
        if any(attribute in text for attribute in DIRECT_REPOSITORY_ATTRIBUTES):
            offenders.append(path.name)
    assert offenders == []


def test_large_frontend_entrypoints_do_not_absorb_new_mode_configuration():
    index_app = (ROOT / "static/js/index-app.js").read_text(encoding="utf-8")
    mode_config = (ROOT / "static/js/index-mode-config.js").read_text(encoding="utf-8")
    assert "const modeConfig = window.LectureProcessorIndexModeConfig || {};" in index_app
    assert "titleLabel: 'Interview Title / Name'" not in index_app
    assert "missingTitleMessage" in mode_config
