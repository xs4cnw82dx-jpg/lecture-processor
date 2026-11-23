"""The Study stylesheets are linked in cascade order and every one is served."""
import re

import pytest

# study.css carries the small-screen overrides for every Study area, so it must load last.
STUDY_SHEETS = ['study-library', 'study-learn', 'study-builder', 'study-coding', 'study']


def _study_sheet_urls(html):
    hrefs = re.findall(r'<link rel="stylesheet" href="([^"]+)"', html)
    pattern = r'/static/css/(%s)\.css' % '|'.join(STUDY_SHEETS)
    return [href for href in hrefs if re.search(pattern + r'(\?|$)', href)]


@pytest.mark.parametrize('path', ['/study', '/shared/demo-token'])
def test_study_pages_link_the_study_sheets_in_cascade_order(client, path):
    response = client.get(path)
    assert response.status_code == 200

    urls = _study_sheet_urls(response.get_data(as_text=True))
    names = [re.search(r'/static/css/([a-z-]+)\.css', url).group(1) for url in urls]
    assert names == STUDY_SHEETS

    for url in urls:
        served = client.get(url)
        assert served.status_code == 200, url
        assert served.get_data(as_text=True).strip(), url
        served.close()
