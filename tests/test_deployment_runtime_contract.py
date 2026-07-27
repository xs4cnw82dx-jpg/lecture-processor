from pathlib import Path


def test_production_web_server_keeps_request_capacity_while_jobs_run():
    dockerfile = Path('Dockerfile').read_text(encoding='utf-8')
    procfile = Path('Procfile').read_text(encoding='utf-8')
    render_config = Path('render.yaml').read_text(encoding='utf-8')

    for command in (dockerfile, procfile):
        assert '--worker-class gthread' in command
        assert '--threads ${WEB_THREADS:-4}' in command
    assert 'key: WEB_THREADS\n        value: "4"' in render_config
