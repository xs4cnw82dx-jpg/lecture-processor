const test = require('node:test');
const assert = require('node:assert/strict');

const { markdownToHtml, highlightTerms } = require('../static/js/physio-local.js');

test('Physio Markdown renders GFM-style tables instead of pipe paragraphs', () => {
  const html = markdownToHtml('| Veld | Waarde |\n| --- | --- |\n| Regio | Knie |');

  assert.match(html, /<table>/);
  assert.match(html, /<th[^>]*>Veld<\/th>/);
  assert.match(html, /<td[^>]*>Knie<\/td>/);
  assert.doesNotMatch(html, /<p>\| Veld/);
});

test('Physio Markdown only renders manifest-mapped Craft images', () => {
  const markdown = '![Test](Notitie.assets/Image.png)';
  const mapped = markdownToHtml(markdown, { 'Notitie.assets/Image.png': 'src-image' });
  const unmapped = markdownToHtml(markdown, {});

  assert.match(mapped, /sources-manager\/src-image\/preview/);
  assert.match(unmapped, /Afbeelding niet gekoppeld/);
});

test('search highlight terms omit short Dutch stop words', () => {
  assert.deepEqual(highlightTerms('Wat komt er na transductie en conductie?'), ['transductie', 'conductie', 'komt']);
});
