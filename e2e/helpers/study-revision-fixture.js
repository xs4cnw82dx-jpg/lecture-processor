const { createHash } = require('node:crypto');

function contentRevision(pack) {
  return createHash('sha256').update(JSON.stringify([
    pack.notes_markdown || '', pack.flashcards || [], pack.test_questions || [],
  ])).digest('hex');
}

function withContentRevision(pack) {
  return { ...pack, content_revision: contentRevision(pack) };
}

module.exports = { contentRevision, withContentRevision };
