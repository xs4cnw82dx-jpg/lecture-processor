from pathlib import Path


def test_hosted_physio_api_is_permanently_retired(client):
    response = client.get("/api/physio/cases")

    assert response.status_code == 410
    assert response.get_json()["code"] == "physio_local_companion_required"


def test_hosted_physio_implementation_is_not_shipped():
    retired_paths = [
        "lecture_processor/services/physio_api_service.py",
        "lecture_processor/repositories/physio_repo.py",
        "lecture_processor/domains/physio",
        "templates/physio.html",
        "static/js/physio.js",
        "static/css/physio.css",
        "scripts/build_physio_library.py",
    ]
    assert all(not Path(path).exists() for path in retired_paths)

    blueprint = Path("lecture_processor/blueprints/physio.py").read_text(encoding="utf-8")
    assert "ENABLE_LEGACY_PHYSIO_API" not in blueprint
    assert "physio_api_service" not in blueprint
