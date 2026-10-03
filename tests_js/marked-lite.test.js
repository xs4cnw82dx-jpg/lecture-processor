const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const window = {};
vm.runInNewContext(fs.readFileSync('static/js/marked-lite.js', 'utf8'), { window });
test('markdown tables preserve inline formatting and safe cell contents', () => {
  const html = window.marked.parse('Intro\n\n| Topic | Meaning |\n| --- | --- |\n| **Recall** | <script>alert(1)</script> |\n| A \\| B | `a|b` |\n\nAfter');
  assert.match(html, /<th scope="col">Topic<\/th>/);
  assert.match(html, /<td><strong>Recall<\/strong><\/td>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /<td>A \| B<\/td><td><code>a\|b<\/code><\/td>/);
  assert.match(html, /<p>After<\/p>/);
});
test('paragraph followed immediately by table and mismatched separators terminate', () => {
  assert.match(window.marked.parse('Intro\nName | Value\n--- | ---\nOne | Two'), /<p>Intro<\/p>\n<table>/);
  assert.doesNotMatch(window.marked.parse('A | B\n---\nC | D'), /<table>/);
});
