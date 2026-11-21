const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Load markdown-utils on its own (no html-utils), with a fake parser that
// returns dangerous HTML, so the fallback sanitizer path is exercised.
function load(globals) {
  const sandbox = { ...globals };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync('static/js/markdown-utils.js', 'utf8'), sandbox);
  return sandbox.LectureProcessorMarkdown;
}
const dangerous = { parse: () => '<p>Hi</p><img src=x onerror="alert(1)">', setOptions() {} };

test('markdown fails closed: without a sanitizer the parsed HTML is escaped, not rendered', () => {
  const html = load({ marked: dangerous }).parseMarkdownToSafeHtml('# Hi');
  assert.ok(!/<img/i.test(html), html);
  assert.ok(html.includes('&lt;img'), html);
});

test('markdown uses DOMPurify with the allowed tags when it is available', () => {
  const calls = [];
  const DOMPurify = { sanitize: (html, options) => { calls.push(options); return '<p>clean</p>'; } };
  const html = load({ marked: dangerous, DOMPurify }).parseMarkdownToSafeHtml('# Hi');
  assert.equal(html, '<p>clean</p>');
  assert.equal(calls.length, 1);
  assert.ok(Array.isArray(calls[0].ALLOWED_TAGS) && calls[0].ALLOWED_TAGS.length > 0);
});

test('without a markdown parser the source is escaped with line breaks', () => {
  const html = load({}).parseMarkdownToSafeHtml('<b>x</b>\nnext');
  assert.equal(html, '&lt;b&gt;x&lt;/b&gt;<br>next');
});
