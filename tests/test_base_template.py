"""Pages built on templates/_base.html render a complete, well-ordered document."""
import re

import pytest

BASE_PAGES = {
    '/': 'Lecture Processor', '/privacy': 'Privacy Policy', '/terms': 'Terms of Service', '/FAQ': 'FAQ',
    '/helpcenter': 'Help Center', '/features': 'Features', '/definitely-missing-page': '404',
}


@pytest.mark.parametrize(('path', 'title_text'), BASE_PAGES.items())
def test_base_pages_render_charset_first_one_title_and_theme_before_page_styles(client, path, title_text):
    response = client.get(path, follow_redirects=True)
    html = response.get_data(as_text=True)
    head = html[html.index('<head>'):html.index('</head>')]

    assert html.lstrip().startswith('<!DOCTYPE html>')
    assert '<html lang="en">' in html
    # The charset declaration comes before any resource the browser has to fetch.
    assert head.index('<meta charset="UTF-8">') < min(head.index(tag) for tag in ('<link', '<script'))
    assert re.search(r'<meta name="viewport" content="width=device-width, initial-scale=1.0">', head)
    titles = re.findall(r'<title>(.*?)</title>', head, re.S)
    assert len(titles) == 1 and title_text in titles[0], titles
    # Theme tokens load before the shared and page stylesheets that use them.
    sheets = re.findall(r'<link rel="stylesheet" href="/static/css/([a-z-]+)\.css', head)
    assert sheets[0] == 'theme' and 'shared-ui' in sheets, sheets
    assert html.count('<body>') == 1 and 'class="skip-link"' in html
