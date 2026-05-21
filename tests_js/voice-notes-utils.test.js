const assert = require('node:assert/strict');
const test = require('node:test');

global.window = global;
require('../static/js/voice-notes-utils.js');

const utils = global.LectureProcessorVoiceNotes;

test('parseTags trims, dedupes, and caps tags', () => {
  assert.deepEqual(utils.parseTags(' biology, Exam Prep,biology,  week 1  '), [
    'biology',
    'Exam Prep',
    'week 1',
  ]);
});

test('filterVoiceNotes searches transcript notes and tags while hiding archived by default', () => {
  const notes = [
    { id: '1', title: 'Cell lecture', transcript: 'mitochondria ATP', tags: ['biology'], created_at: 2 },
    { id: '2', title: 'Archived', notes_markdown: 'hidden mitochondria', archived: true, created_at: 4 },
    { id: '3', title: 'Pinned', pinned: true, tags: ['exam'], created_at: 1 },
  ];

  assert.deepEqual(utils.filterVoiceNotes(notes, { query: 'mitochondria', filter: 'all' }).map((note) => note.id), ['1']);
  assert.deepEqual(utils.filterVoiceNotes(notes, { filter: 'pinned' }).map((note) => note.id), ['3']);
  assert.deepEqual(utils.filterVoiceNotes(notes, { filter: 'archived' }).map((note) => note.id), ['2']);
});

test('normalizePackPayload keeps study tools and mobile metadata', () => {
  const normalized = utils.normalizePackPayload({
    study_pack_id: 'pack-1',
    title: 'Voice',
    notes_markdown: '# Notes',
    source_transcript: 'Transcript',
    flashcards: [{ front: 'Q?', back: 'A' }],
    test_questions: [{ question: 'Q', options: ['A', 'B', 'C', 'D'], answer: 'A' }],
    tags: ['exam'],
    pinned: true,
  });

  assert.equal(normalized.study_pack_id, 'pack-1');
  assert.equal(normalized.status, 'synced');
  assert.equal(normalized.flashcards.length, 1);
  assert.equal(normalized.test_questions.length, 1);
  assert.deepEqual(normalized.tags, ['exam']);
  assert.equal(normalized.pinned, true);
});
