(function (root) {
  'use strict';

  var CONTENT = ['notes_markdown', 'flashcards', 'test_questions'];
  var FIELDS = ['title', 'folder_id', 'course', 'subject', 'semester', 'block'].concat(CONTENT);
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function equal(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
  function validRevision(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
  function hasContent(payload) { return CONTENT.some(function (field) { return Object.prototype.hasOwnProperty.call(payload, field); }); }
  function uniqueId() {
    return root.crypto && typeof root.crypto.randomUUID === 'function' ? root.crypto.randomUUID()
      : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2);
  }
  function changes(baseline, draft, retained) {
    var result = {};
    FIELDS.forEach(function (field) {
      if (Object.prototype.hasOwnProperty.call(draft, field)
        && (!equal(baseline[field], draft[field]) || (retained && retained.indexOf(field) !== -1))) result[field] = clone(draft[field]);
    });
    return result;
  }
  function validField(field, value) {
    if (field !== 'flashcards' && field !== 'test_questions') return typeof value === 'string';
    if (!Array.isArray(value)) return false;
    return value.every(function (item) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      if (field === 'flashcards') return typeof item.front === 'string' && typeof item.back === 'string'
        && (item.image_ids === undefined || (Array.isArray(item.image_ids) && item.image_ids.length <= 8
          && item.image_ids.every(function (id) { return typeof id === 'string' && /^[a-f0-9]{64}$/.test(id); })));
      return typeof item.question === 'string' && typeof item.answer === 'string' && typeof item.explanation === 'string'
        && Array.isArray(item.options) && item.options.length === 4 && item.options.every(function (option) { return typeof option === 'string'; });
    });
  }
  function validDraft(payload, packId, recordId) {
    return !!payload && payload.schema === 1 && payload.pack_id === packId
      && typeof payload.snapshot_id === 'string' && !!payload.snapshot_id
      && (recordId === undefined || payload.snapshot_id === recordId)
      && typeof payload.editor_session_id === 'string' && !!payload.editor_session_id
      && ['inline', 'builder', 'create'].indexOf(payload.editor_mode) !== -1
      && ['pending', 'conflict', 'blocked', 'needs_review'].indexOf(payload.phase) !== -1
      && (payload.editor_mode === 'create' || validRevision(payload.base_content_revision)
        || (payload.phase === 'needs_review' && payload.base_content_revision === ''))
      && Number.isFinite(payload.saved_at) && Number.isSafeInteger(payload.edit_generation)
      && payload.changes && typeof payload.changes === 'object' && !Array.isArray(payload.changes)
      && Object.keys(payload.changes).every(function (field) { return FIELDS.indexOf(field) !== -1 && validField(field, payload.changes[field]); });
  }

  function create(options) {
    var cache = options.cache, cacheSession = options.cacheSession, newId = options.newId || uniqueId;
    var pending = new Map();
    var state = { uid: options.uid, packId: options.packId, epoch: options.epoch, id: newId(),
      baseline: clone(options.baseline), revision: options.revision, generation: 0,
      conflict: false, blocked: false, deviceError: false, request: null, snapshot: null, retainedFields: [] };
    function delta(draft) {
      var retained = state.retainedFields.slice();
      if (state.request) FIELDS.forEach(function (field) {
        // Reverting to the old baseline is still an edit when an earlier
        // request can commit a different value after this page disappears.
        if (Object.prototype.hasOwnProperty.call(state.request.payload, field)
          && !equal(draft[field], state.request.snapshot[field])) retained.push(field);
      });
      return changes(state.baseline, draft, retained);
    }
    function retire(exceptId) {
      var success = true;
      pending.forEach(function (payload, id) {
        if (id === exceptId) return;
        if (cache && equal(cache.get(state.uid, 'pack-edit', id), payload)
          && cache.set(cacheSession, 'pack-edit', id, payload, { packId: state.packId, pending: false })) pending.delete(id);
        else success = false;
      });
      return success;
    }
    function persist(draft, mode) {
      var fields = delta(draft);
      if (!Object.keys(fields).length && !state.conflict && !state.blocked) {
        state.deviceError = !retire();
        if (!state.deviceError) state.snapshot = null;
        return !state.deviceError;
      }
      var signature = JSON.stringify([state.revision, fields, state.conflict, state.blocked, mode]);
      if (state.snapshot && state.snapshot.signature === signature
        && cache && equal(cache.get(state.uid, 'pack-edit', state.snapshot.payload.snapshot_id), state.snapshot.payload)) {
        state.deviceError = !retire(state.snapshot.payload.snapshot_id);
        return !state.deviceError;
      }
      var payload = { schema: 1, pack_id: state.packId, editor_session_id: state.id, snapshot_id: newId(),
        edit_generation: state.generation, editor_mode: mode, base_content_revision: validRevision(state.revision) ? state.revision : '',
        changes: fields, saved_at: Date.now(), phase: !validRevision(state.revision) && mode !== 'create' ? 'needs_review'
          : state.conflict ? 'conflict' : state.blocked ? 'blocked' : 'pending' };
      if (!cache || !cache.set(cacheSession, 'pack-edit', payload.snapshot_id, payload, { packId: state.packId, pending: true })) {
        state.deviceError = true;
        return false;
      }
      pending.set(payload.snapshot_id, payload);
      state.snapshot = { signature: signature, payload: payload };
      state.deviceError = !retire(payload.snapshot_id);
      return !state.deviceError;
    }
    function prepare(draft, mode) {
      persist(draft, mode);
      if (state.request || state.blocked) return null;
      var payload = delta(draft);
      if (state.conflict) CONTENT.forEach(function (field) { delete payload[field]; });
      if (!Object.keys(payload).length) return null;
      if (hasContent(payload)) {
        if (!validRevision(state.revision)) {
          state.blocked = true;
          return null;
        }
        payload.base_content_revision = state.revision;
      }
      state.request = { id: newId(), sessionId: state.id, generation: state.generation,
        payload: clone(payload), snapshot: clone(draft), mode: mode };
      return state.request;
    }
    function acknowledge(request, response) {
      if (state.request !== request || request.sessionId !== state.id) return false;
      if (hasContent(request.payload) && !validRevision(response && response.content_revision)) {
        reject(request, {});
        state.blocked = true;
        return false;
      }
      state.request = null;
      FIELDS.forEach(function (field) {
        if (Object.prototype.hasOwnProperty.call(request.payload, field)) state.baseline[field] = clone(request.payload[field]);
      });
      state.retainedFields = state.retainedFields.filter(function (field) { return !Object.prototype.hasOwnProperty.call(request.payload, field); });
      // An unconditional metadata response may describe content never opened.
      if (hasContent(request.payload)) state.revision = response.content_revision;
      return true;
    }
    function reject(request, error) {
      if (state.request !== request) return false;
      state.request = null;
      state.retainedFields = Array.from(new Set(state.retainedFields.concat(FIELDS.filter(function (field) {
        return Object.prototype.hasOwnProperty.call(request.payload, field);
      }))));
      if (error && error.status === 409 && error.payload && error.payload.error_code === 'content_revision_conflict') state.conflict = true;
      else if (error && [400, 403, 404, 409].indexOf(error.status) !== -1) state.blocked = true;
      return true;
    }
    function restore(payload, recordId) {
      if (!validDraft(payload, state.packId, recordId)) return null;
      var draft = Object.assign(clone(state.baseline), clone(payload.changes));
      state.conflict = (validRevision(payload.base_content_revision) && validRevision(state.revision)
        && state.revision !== payload.base_content_revision) || payload.phase === 'conflict';
      state.revision = payload.base_content_revision;
      state.blocked = !validRevision(state.revision) || payload.phase === 'blocked';
      state.retainedFields = Object.keys(payload.changes);
      state.generation += 1;
      return draft;
    }
    return { state: state, delta: delta, persist: persist, prepare: prepare, acknowledge: acknowledge, reject: reject, restore: restore,
      pendingIds: function () { return Array.from(pending.keys()); } };
  }
  var exported = { create: create, changes: changes, hasContent: hasContent, validRevision: validRevision, validDraft: validDraft, clone: clone, fields: FIELDS.slice() };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  root.LectureProcessorStudyEdits = exported;
})(typeof window !== 'undefined' ? window : globalThis);
