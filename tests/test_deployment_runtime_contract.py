from pathlib import Path


def test_production_web_server_keeps_request_capacity_while_jobs_run():
    dockerfile = Path('Dockerfile').read_text(encoding='utf-8')
    render_config = Path('render.yaml').read_text(encoding='utf-8')

    # Render builds the Dockerfile (render.yaml env: docker); it is the only start command.
    assert '--worker-class gthread' in dockerfile
    assert '--threads ${WEB_THREADS:-4}' in dockerfile
    assert not Path('Procfile').exists()
    assert 'key: WEB_THREADS\n        value: "4"' in render_config
