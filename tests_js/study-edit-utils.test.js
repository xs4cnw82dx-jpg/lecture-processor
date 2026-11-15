const test = require('node:test');
const assert = require('node:assert/strict');
const edits = require('../static/js/study-edit-utils.js');

const R0 = 'a'.repeat(64), R1 = 'b'.repeat(64), R2 = 'c'.repeat(64);
const baseline = () => ({ title: 'Title', notes_markdown: 'Notes', flashcards: [{ front: 'Question?', back: 'Answer', image_ids: [] }], test_questions: [] });
function fixture(shared) {
  const values = shared || new Map(), faults = { set: false, retire: false }, token = {};
  const cache = {
    get: (_uid, _kind, id) => values.get(id)?.payload || null,
    set: (session, _kind, id, payload, options) => {
      if (session !== token || faults.set || (faults.retire && !options.pending)) return false;
      values.set(id, { payload: structuredClone(payload), pending: options.pending }); return true;
    },
  };
  const controller = edits.create({ uid: 'owner', packId: 'pack', epoch: 1, baseline: baseline(), revision: R0, cache, cacheSession: token });
  return { controller, values, faults };
}
function conflict(controller, request) {
  controller.reject(request, { status: 409, payload: { error_code: 'content_revision_conflict', content_revision: R2 } });
}

test('inline autosave skips unchanged content and sends only the edited section', () => {
  const replacements = {
    notes_markdown: 'Updated notes',
    flashcards: [{ front: 'Changed question?', back: 'Answer', image_ids: [] }],
    test_questions: [{ question: 'Which?', options: ['A', 'B', 'C', 'D'], answer: 'A', explanation: 'Because A.' }],
  };
  for (const [field, replacement] of Object.entries(replacements)) {
    const { controller, values } = fixture();
    const draft = baseline();
    assert.equal(controller.prepare(draft, 'inline'), null);
    assert.equal(values.size, 0);
    draft[field] = replacement;
    const request = controller.prepare(draft, 'inline');
    assert.deepEqual(request.payload, { [field]: replacement, base_content_revision: R0 });
    assert.equal(controller.acknowledge(request, { content_revision: R1 }), true);
    assert.equal(controller.prepare(draft, 'inline'), null);
    assert.equal([...values.values()].some(record => record.pending), false);
  }
});

test('metadata response never advances the known content baseline', () => {
  const { controller } = fixture();
  const title = { ...baseline(), title: 'Renamed' };
  const first = controller.prepare(title, 'builder');
  assert.deepEqual(first.payload, { title: 'Renamed' });
  assert.equal(controller.acknowledge(first, { content_revision: R1 }), true);
  assert.equal(controller.state.revision, R0);
  const second = controller.prepare({ ...title, notes_markdown: 'Local notes' }, 'builder');
  assert.deepEqual(second.payload, { notes_markdown: 'Local notes', base_content_revision: R0 });
});

test('a conditional acknowledgement advances only its fields and keeps later edits', () => {
  const { controller } = fixture();
  const firstDraft = { ...baseline(), notes_markdown: 'First notes' };
  const request = controller.prepare(firstDraft, 'inline');
  controller.state.generation++;
  const later = { ...firstDraft, title: 'Later title', notes_markdown: 'Later notes' };
  controller.persist(later, 'inline');
  assert.equal(controller.acknowledge(request, { content_revision: R1 }), true);
  assert.deepEqual(controller.delta(later), { title: 'Later title', notes_markdown: 'Later notes' });
  assert.equal(controller.state.baseline.notes_markdown, 'First notes');
  assert.equal(controller.prepare(later, 'inline').payload.base_content_revision, R1);
});

test('conflict blocks content repeats while allowing independent metadata', () => {
  const { controller } = fixture();
  const draft = { ...baseline(), notes_markdown: 'Local notes' };
  conflict(controller, controller.prepare(draft, 'inline'));
  for (let i = 0; i < 5; i++) assert.equal(controller.prepare(draft, 'inline'), null);
  assert.equal(controller.state.revision, R0);
  const metadata = controller.prepare({ ...draft, title: 'New title' }, 'inline');
  assert.deepEqual(metadata.payload, { title: 'New title' });
  assert.equal(controller.acknowledge(metadata, { content_revision: R2 }), true);
  assert.equal(controller.state.conflict, true);
  assert.equal(controller.state.revision, R0);
});

test('an old acknowledgement cannot settle a newer request', () => {
  const { controller } = fixture();
  const first = controller.prepare({ ...baseline(), title: 'First' }, 'inline');
  controller.acknowledge(first, {});
  const second = controller.prepare({ ...baseline(), title: 'Second' }, 'inline');
  assert.equal(controller.acknowledge(first, { content_revision: R2 }), false);
  assert.equal(controller.state.request, second);
  assert.equal(controller.state.baseline.title, 'First');
});

test('missing tokens and malformed conditional acknowledgements never enable unconditional content saves', () => {
  const { controller } = fixture();
  controller.state.revision = '';
  assert.equal(controller.prepare({ ...baseline(), notes_markdown: 'New' }, 'inline'), null);
  assert.equal(controller.state.blocked, true);
  const next = fixture().controller;
  const request = next.prepare({ ...baseline(), notes_markdown: 'New' }, 'inline');
  assert.equal(next.acknowledge(request, {}), false);
  assert.equal(next.state.revision, R0);
  assert.equal(next.state.blocked, true);
});

test('only the content conflict code creates the content review state', () => {
  const { controller } = fixture();
  const request = controller.prepare({ ...baseline(), title: 'Changed' }, 'inline');
  controller.reject(request, { status: 409, payload: { status: 'account_deletion_in_progress' } });
  assert.equal(controller.state.conflict, false);
  assert.equal(controller.state.blocked, true);
  assert.equal(controller.prepare({ ...baseline(), title: 'Again' }, 'inline'), null);
});

test('a network failure retains its baseline for a later lost-ack conflict', () => {
  const { controller } = fixture();
  const draft = { ...baseline(), notes_markdown: 'Applied but unacknowledged' };
  const first = controller.prepare(draft, 'inline');
  controller.reject(first, { status: 503 });
  const retry = controller.prepare(draft, 'inline');
  assert.equal(retry.payload.base_content_revision, R0);
  conflict(controller, retry);
  assert.deepEqual(controller.delta(draft), { notes_markdown: draft.notes_markdown });
});

test('immutable snapshot IDs keep two tabs and newer edits independent', () => {
  const shared = new Map(), first = fixture(shared), second = fixture(shared);
  first.controller.persist({ ...baseline(), title: 'First tab' }, 'inline');
  const old = first.controller.state.snapshot.payload;
  second.controller.persist({ ...baseline(), title: 'Second tab' }, 'builder');
  first.controller.persist({ ...baseline(), title: 'New first edit' }, 'inline');
  assert.notEqual(first.controller.state.snapshot.payload.snapshot_id, old.snapshot_id);
  assert.equal(shared.get(old.snapshot_id).pending, false);
  assert.deepEqual([...shared.values()].filter(record => record.pending).map(record => record.payload.changes.title).sort(), ['New first edit', 'Second tab']);
  assert.equal(shared.get(old.snapshot_id).payload.changes.title, 'First tab');
});

test('failed successor persistence keeps the older durable bytes and newest in-memory delta', () => {
  const { controller, values, faults } = fixture();
  controller.persist({ ...baseline(), title: 'Durable' }, 'inline');
  const before = structuredClone([...values]);
  faults.set = true;
  const latest = { ...baseline(), title: 'Newest unsaved' };
  assert.equal(controller.persist(latest, 'inline'), false);
  assert.deepEqual([...values], before);
  assert.deepEqual(controller.delta(latest), { title: 'Newest unsaved' });
  assert.equal(controller.state.deviceError, true);
});

test('failed local retirement remains visible after a successful cloud save', () => {
  const { controller, faults, values } = fixture();
  const draft = { ...baseline(), title: 'Saved on server' };
  const request = controller.prepare(draft, 'inline');
  controller.acknowledge(request, {});
  faults.retire = true;
  assert.equal(controller.persist(draft, 'inline'), false);
  assert.equal(controller.state.deviceError, true);
  assert.equal([...values.values()].filter(record => record.pending).length, 1);
});

test('recovering after lost response preserves the old token even when its fields now match', () => {
  const first = fixture().controller;
  first.persist({ ...baseline(), notes_markdown: 'Saved notes' }, 'inline');
  const payload = first.state.snapshot.payload;
  const recovered = fixture().controller;
  recovered.state.baseline.notes_markdown = 'Saved notes';
  recovered.state.revision = R1;
  const draft = recovered.restore(payload);
  assert.equal(recovered.state.revision, R0);
  assert.equal(recovered.state.conflict, true);
  assert.deepEqual(recovered.delta(draft), { notes_markdown: 'Saved notes' });
  assert.equal(recovered.prepare(draft, 'inline'), null);
});

test('recovered matching-baseline save settles retained fields normally', () => {
  const first = fixture().controller;
  first.persist({ ...baseline(), title: 'Local title' }, 'builder');
  const recovered = fixture().controller;
  const draft = recovered.restore(first.state.snapshot.payload);
  const request = recovered.prepare(draft, 'builder');
  recovered.acknowledge(request, { content_revision: R0 });
  assert.deepEqual(recovered.delta(draft), {});
});

test('image-only and ordering edits are conditional content', () => {
  const { controller } = fixture();
  const draft = baseline(); draft.flashcards[0].image_ids = ['d'.repeat(64)];
  const request = controller.prepare(draft, 'builder');
  assert.equal(request.payload.base_content_revision, R0);
  assert.deepEqual(request.payload.flashcards, draft.flashcards);
  assert.equal(edits.hasContent({ notes_highlights: {} }), false);
});

test('malformed and foreign recovered drafts are not adopted', () => {
  const first = fixture().controller;
  first.persist({ ...baseline(), title: 'Local title' }, 'builder');
  const payload = first.state.snapshot.payload;
  const recovered = fixture().controller;
  for (const change of [{ pack_id: 'foreign' }, { changes: { uid: 'foreign' } }, { changes: { flashcards: 'not cards' } }, { base_content_revision: '' }]) {
    assert.equal(recovered.restore({ ...payload, ...change }), null);
  }
  assert.equal(recovered.state.revision, R0);
});

test('reverting while an acknowledgement is held remains a pending explicit intent', () => {
  const { controller, values } = fixture();
  const request = controller.prepare({ ...baseline(), notes_markdown: 'First request' }, 'inline');
  const original = baseline();
  assert.equal(controller.persist(original, 'inline'), true);
  const latest = controller.state.snapshot.payload;
  assert.deepEqual(latest.changes, { notes_markdown: 'Notes' });
  assert.equal(values.get(latest.snapshot_id).pending, true);
  controller.acknowledge(request, { content_revision: R1 });
  assert.deepEqual(controller.delta(original), { notes_markdown: 'Notes' });
  assert.equal(controller.prepare(original, 'inline').payload.base_content_revision, R1);
});

test('a lost acknowledgement does not retire the intended reversion', () => {
  const { controller } = fixture();
  const request = controller.prepare({ ...baseline(), notes_markdown: 'Unacknowledged save' }, 'inline');
  controller.persist(baseline(), 'inline');
  controller.reject(request, { status: 503 });
  controller.persist(baseline(), 'inline');
  assert.deepEqual(controller.state.snapshot.payload.changes, { notes_markdown: 'Notes' });
  assert.equal(controller.prepare(baseline(), 'inline').payload.base_content_revision, R0);
});

test('a missing token draft is recoverable only through explicit review', () => {
  const { controller } = fixture();
  controller.state.revision = '';
  const draft = { ...baseline(), notes_markdown: 'Keep when the server token is unavailable' };
  assert.equal(controller.persist(draft, 'inline'), true);
  const payload = controller.state.snapshot.payload;
  assert.equal(edits.validDraft(payload, 'pack', payload.snapshot_id), true);
  assert.equal(controller.prepare(draft, 'inline'), null);
  const recovered = fixture().controller;
  assert.equal(recovered.restore(payload).notes_markdown, draft.notes_markdown);
  assert.equal(recovered.prepare(draft, 'inline'), null);
  assert.equal(recovered.state.blocked, true);
  assert.equal(recovered.state.conflict, false);
});

test('cache identity and nested draft types must match before recovery', () => {
  const { controller } = fixture();
  controller.persist({ ...baseline(), title: 'Draft' }, 'inline');
  const payload = controller.state.snapshot.payload;
  assert.equal(edits.validDraft(payload, 'pack', 'another-snapshot'), false);
  for (const changes of [{ title: {} }, { notes_markdown: [] }, { flashcards: [null] },
    { flashcards: [{ front: 'Question', back: {}, image_ids: [] }] },
    { flashcards: [{ front: 'Question', back: 'Answer', image_ids: ['not-an-id'] }] },
    { test_questions: [{ question: 'Question', options: [{}], answer: '', explanation: '' }] }]) {
    assert.equal(edits.validDraft({ ...payload, changes }, 'pack', payload.snapshot_id), false);
  }
});

test('an invalid acknowledgement retains the reversion for explicit recovery', () => {
  const { controller } = fixture();
  const request = controller.prepare({ ...baseline(), notes_markdown: 'Possibly committed' }, 'inline');
  controller.persist(baseline(), 'inline');
  assert.equal(controller.acknowledge(request, {}), false);
  controller.persist(baseline(), 'inline');
  const payload = controller.state.snapshot.payload;
  assert.deepEqual(payload.changes, { notes_markdown: 'Notes' });
  const recovered = fixture().controller;
  const draft = recovered.restore(payload, payload.snapshot_id);
  assert.equal(draft.notes_markdown, 'Notes');
  assert.equal(recovered.prepare(draft, 'inline'), null);
});

test('a permanently blocked recovered draft requires review even with a matching token', () => {
  const { controller } = fixture();
  const draft = { ...baseline(), notes_markdown: 'Rejected draft' };
  controller.reject(controller.prepare(draft, 'builder'), { status: 400 });
  controller.persist(draft, 'builder');
  const payload = controller.state.snapshot.payload;
  const recovered = fixture().controller;
  assert.equal(recovered.restore(payload).notes_markdown, draft.notes_markdown);
  assert.equal(recovered.prepare(draft, 'builder'), null);
  assert.equal(recovered.state.blocked, true);
});
