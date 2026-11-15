(function (global) {
  'use strict';

  var MAX_AGE = 30 * 24 * 60 * 60 * 1000;
  var MAX_RECORDS = 50;
  var MAX_BYTES = 2 * 1024 * 1024;
  // Deletion fences remain durable, including old and undated legacy markers.
  var FENCE_PREFIX = 'lp_study_cache_fence_v1:';
  var activeUid = '', session = 0, epoch = 0;
  var sequence = 0;
  var tokens = new WeakMap();
  var userEpochs = new Map(), packEpochs = new Map(), keyEpochs = new Map();

  function text(value) { return typeof value === 'string' ? value : ''; }
  function prefix(uid) { return 'lp_ui_v2:user:' + uid + ':study_cache:'; }
  function packKey(uid, packId) { return JSON.stringify([uid, packId]); }
  function storageKey(uid, kind, id) {
    if (!uid || !text(kind) || !text(id)) return '';
    return prefix(uid) + encodeURIComponent(kind) + ':' + encodeURIComponent(id);
  }

  function uniqueId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') return global.crypto.randomUUID();
    sequence += 1;
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + '-' + sequence;
  }

  function fencePrefix(uid) { return FENCE_PREFIX + encodeURIComponent(uid) + ':'; }
  function fenceKeys(uid, kind, id, packId) {
    var start = fencePrefix(uid);
    return { user: start + 'user', pack: packId ? start + 'pack:' + encodeURIComponent(packId) : '',
      key: start + 'key:' + encodeURIComponent(kind) + ':' + encodeURIComponent(id) };
  }

  function parseFence(raw) {
    if (raw === null) return { version: '', retained: [] };
    var marker;
    try { marker = JSON.parse(raw); } catch (_) { marker = null; }
    if (!marker || !(marker.schema === 1 || (marker.schema === 2 && marker.quarantine_pending === true))
      || typeof marker.version !== 'string' || !marker.version
      || !Array.isArray(marker.retained) || !marker.retained.every(function (id) { return typeof id === 'string'; })
      || (marker.quarantine_pending !== undefined && typeof marker.quarantine_pending !== 'boolean')) {
      var error = new Error('Invalid cache fence');
      error.invalidFence = true;
      throw error;
    }
    return marker;
  }

  function readFence(storage, key) { return parseFence(key ? storage.getItem(key) : null); }

  function snapshotFences(storage, uid) {
    var result = new Map(), start = fencePrefix(uid);
    for (var i = 0; i < storage.length; i += 1) {
      var key = storage.key(i);
      if (key && key.indexOf(start) === 0) result.set(key, readFence(storage, key).version);
    }
    return result;
  }

  function currentFences(storage, uid, kind, id, packId) {
    var keys = fenceKeys(uid, kind, id, packId), result = {};
    Object.keys(keys).forEach(function (scope) { result[scope] = readFence(storage, keys[scope]); });
    return result;
  }

  function writerIsCurrent(storage, owner, kind, id, packId) {
    var keys = fenceKeys(owner.uid, kind, id, packId);
    return Object.keys(keys).every(function (scope) {
      return readFence(storage, keys[scope]).version === (owner.fences.get(keys[scope]) || '');
    });
  }

  function recordState(storage, record) {
    var current = currentFences(storage, record.uid, record.kind, record.id, record.pack_id);
    var saved = record.fences || { user: '', pack: '', key: '' };
    var quarantined = false;
    for (var scope of ['user', 'pack', 'key']) {
      var marker = current[scope];
      if (saved[scope] === marker.version || (scope === 'user' && record.pending && marker.retained.indexOf(saved.user) !== -1)) continue;
      if (record.pending && marker.quarantine_pending) quarantined = true;
      else return 'stale';
    }
    return quarantined ? 'quarantined' : 'current';
  }

  function recordIsCurrent(storage, record) { return recordState(storage, record) === 'current'; }

  function publishFence(storage, key, retained, quarantinePending) {
    try {
      // Older readers reject schema2 and retain bytes instead of treating these
      // uncertain generations as stale records to delete.
      var marker = { schema: quarantinePending ? 2 : 1, version: uniqueId(), retained: retained || [], created_at: Date.now() };
      if (quarantinePending) marker.quarantine_pending = true;
      return storage.setItem(key, JSON.stringify(marker)) !== false;
    } catch (_) { return false; }
  }

  function byteLength(value) {
    var size = 0;
    for (var i = 0; i < value.length; i += 1) {
      var code = value.charCodeAt(i);
      if (code < 128) size += 1;
      else if (code < 2048) size += 2;
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length
        && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) {
        size += 4; i += 1;
      } else size += 3;
    }
    return size;
  }

  function parseRecord(raw, uid, kind, id) {
    try {
      var record = JSON.parse(raw);
      if (!record || record.schema !== 1 || record.uid !== uid || record.kind !== kind || record.id !== id
        || typeof record.pack_id !== 'string' || typeof record.pending !== 'boolean'
        || !Number.isFinite(record.updated_at) || record.updated_at < 0
        || !Object.prototype.hasOwnProperty.call(record, 'payload')) return null;
      if (record.write_id !== undefined && (typeof record.write_id !== 'string' || !record.write_id
        || !record.fences || !['user', 'pack', 'key'].every(function (scope) { return typeof record.fences[scope] === 'string'; }))) return null;
      return record;
    } catch (_) { return null; }
  }

  function readEntries(storage, uid) {
    var entries = [], start = prefix(uid);
    for (var i = 0; i < storage.length; i += 1) {
      var key = storage.key(i);
      if (typeof key !== 'string' || key.indexOf(start) !== 0) continue;
      var parts = key.slice(start.length).split(':');
      var raw = storage.getItem(key);
      if (raw === null) continue;
      var record = null;
      try {
        if (parts.length === 2) record = parseRecord(raw, uid, decodeURIComponent(parts[0]), decodeURIComponent(parts[1]));
      } catch (_) { /* Preserve unknown data. */ }
      entries.push({ key: key, raw: raw, record: record, bytes: byteLength(raw) });
    }
    return entries;
  }

  function entriesUnchanged(storage, uid, entries) {
    var current = readEntries(storage, uid);
    if (current.length !== entries.length) return false;
    var originals = new Map(entries.map(function (entry) { return [entry.key, entry.raw]; }));
    return current.every(function (entry) { return originals.get(entry.key) === entry.raw; });
  }

  function maintainFences(storage, uid) {
    var start = fencePrefix(uid), keys = [], entries = readEntries(storage, uid);
    for (var i = 0; i < storage.length; i += 1) {
      var key = storage.key(i);
      if (key && key.indexOf(start) === 0) keys.push(key);
    }
    keys.forEach(function (key) {
      var raw = storage.getItem(key);
      if (raw === null) return;
      try { parseFence(raw); } catch (error) {
        if (!error.invalidFence) throw error;
        var pending = entries.filter(function (entry) { return !entry.record || entry.record.pending; });
        if (pending.length > MAX_RECORDS || pending.reduce(function (size, entry) { return size + entry.bytes; }, 0) > MAX_BYTES) throw error;
        if (storage.getItem(key) !== raw || !entriesUnchanged(storage, uid, entries)) throw new Error('Cache changed during fence repair');
        // Corruption erased the authoritative generation. Keep uncertain pending
        // bytes quarantined; never infer that an older generation is current.
        if (!publishFence(storage, key, [], true)) throw new Error('Could not repair cache fence');
        if (!entriesUnchanged(storage, uid, entries)) throw new Error('Cache changed during fence repair');
      }
    });
    var quarantined = entries.filter(function (entry) { return entry.record && recordState(storage, entry.record) === 'quarantined'; });
    if (quarantined.length > MAX_RECORDS || quarantined.reduce(function (size, entry) { return size + entry.bytes; }, 0) > MAX_BYTES) throw new Error('Pending quarantine is full');
    if (!entriesUnchanged(storage, uid, entries)) throw new Error('Cache changed during capture');
  }

  function activate(uid) {
    uid = text(uid).trim();
    if (activeUid !== uid) { activeUid = uid; session += 1; }
    return true;
  }

  function capture(uid) {
    uid = text(uid).trim();
    if (!uid || uid !== activeUid) return null;
    try {
      if (!global.localStorage) return null;
      maintainFences(global.localStorage, uid);
      var token = Object.freeze({});
      tokens.set(token, { uid: uid, session: session, epoch: epoch, fences: snapshotFences(global.localStorage, uid) });
      return token;
    } catch (_) { return null; }
  }

  function get(uid, kind, id) {
    try {
      uid = text(uid).trim();
      var key = storageKey(uid, kind, id);
      if (!key || uid !== activeUid || !global.localStorage) return null;
      var record = parseRecord(global.localStorage.getItem(key), uid, kind, id);
      if (!record || !recordIsCurrent(global.localStorage, record)
        || (!record.pending && record.updated_at < Date.now() - MAX_AGE)) return null;
      return record.payload;
    } catch (_) { return null; }
  }

  function set(token, kind, id, payload, options) {
    try {
      var owner = token && tokens.get(token);
      if (!owner || owner.uid !== activeUid || owner.session !== session) return false;
      var key = storageKey(owner.uid, kind, id), packId = text(options && options.packId);
      if (!key || owner.epoch < (userEpochs.get(owner.uid) || 0)
        || owner.epoch < (keyEpochs.get(key) || 0)
        || owner.epoch < (packEpochs.get(packKey(owner.uid, packId)) || 0)) return false;
      var storage = global.localStorage;
      if (!storage || payload === undefined || !writerIsCurrent(storage, owner, kind, id, packId)) return false;
      var existing = parseRecord(storage.getItem(key), owner.uid, kind, id);
      if (existing && recordState(storage, existing) === 'quarantined') return false;
      var keys = fenceKeys(owner.uid, kind, id, packId);
      var now = Date.now();
      var raw = JSON.stringify({ schema: 1, uid: owner.uid, kind: kind, id: id, pack_id: packId,
        updated_at: now, pending: !!(options && options.pending), payload: payload,
        write_id: uniqueId(), fences: { user: owner.fences.get(keys.user) || '',
          pack: owner.fences.get(keys.pack) || '', key: owner.fences.get(keys.key) || '' } });
      if (!parseRecord(raw, owner.uid, kind, id)) return false;
      var bytes = byteLength(raw);
      if (bytes > MAX_BYTES) return false;
      var entries = readEntries(storage, owner.uid).filter(function (entry) { return entry.key !== key; });
      var count = entries.length + 1;
      entries.forEach(function (entry) { bytes += entry.bytes; });
      var eligible = entries.filter(function (entry) { return entry.record && !entry.record.pending; });
      eligible.sort(function (left, right) { return left.record.updated_at - right.record.updated_at; });
      var removals = [];
      eligible.forEach(function (entry) {
        if (entry.record.updated_at < now - MAX_AGE || count > MAX_RECORDS || bytes > MAX_BYTES) {
          removals.push(entry); count -= 1; bytes -= entry.bytes;
        }
      });
      if (count > MAX_RECORDS || bytes > MAX_BYTES) return false;
      for (var i = 0; i < removals.length; i += 1) {
        // Capacity was calculated from this exact revision. A different tab may
        // have replaced it with pending work while we were enumerating entries.
        if (storage.getItem(removals[i].key) !== removals[i].raw) return false;
        keyEpochs.set(removals[i].key, ++epoch);
        if (storage.removeItem(removals[i].key) === false) return false;
      }
      var previous = storage.getItem(key);
      var previousRecord = parseRecord(previous, owner.uid, kind, id);
      if (previousRecord && recordState(storage, previousRecord) === 'quarantined') return false;
      if (storage.setItem(key, raw) === false) return false;
      if (writerIsCurrent(storage, owner, kind, id, packId)) return true;
      // The other tab may clear between our precheck and write. Touch only our
      // own revision, and restore a retained pending predecessor if applicable.
      if (storage.getItem(key) === raw) {
        if (previousRecord && recordState(storage, previousRecord) !== 'stale') storage.setItem(key, previous);
        else if (recordState(storage, parseRecord(raw, owner.uid, kind, id)) !== 'quarantined') storage.removeItem(key);
      }
      return false;
    } catch (_) { return false; }
  }

  function remove(uid, kind, id) {
    try {
      uid = text(uid).trim();
      var key = storageKey(uid, kind, id);
      if (!key) return false;
      keyEpochs.set(key, ++epoch);
      var storage = global.localStorage;
      if (!storage) return false;
      var published = publishFence(storage, fenceKeys(uid, kind, id, '').key);
      var removed = published ? removeStaleEntry(storage, key, uid, kind, id) : storage.removeItem(key) !== false;
      return published && removed;
    } catch (_) { return false; }
  }

  function removeStaleEntry(storage, key, uid, kind, id) {
    var raw = storage.getItem(key);
    if (raw === null) return true;
    var current = parseRecord(raw, uid, kind, id);
    if (current && recordState(storage, current) !== 'stale') return true;
    // A delayed storage event can refer to a record that has since been replaced.
    if (storage.getItem(key) !== raw) return true;
    return storage.removeItem(key) !== false;
  }

  function removeEntries(storage, entries, published) {
    var success = true;
    entries.forEach(function (entry) {
      try {
        var record = entry.record;
        if (published && record) {
          if (!removeStaleEntry(storage, entry.key, record.uid, record.kind, record.id)) success = false;
        } else if (storage.getItem(entry.key) === entry.raw && storage.removeItem(entry.key) === false) success = false;
      } catch (_) { success = false; }
    });
    return success;
  }

  function removePack(uid, packId) {
    uid = text(uid).trim(); packId = text(packId);
    if (!uid || !packId) return false;
    packEpochs.set(packKey(uid, packId), ++epoch);
    try {
      var storage = global.localStorage;
      if (!storage) return false;
      var entries = readEntries(storage, uid);
      var published = publishFence(storage, fenceKeys(uid, '', '', packId).pack);
      var known = entries.every(function (entry) { return !!entry.record; });
      var removed = removeEntries(storage, entries.filter(function (entry) { return entry.record && entry.record.pack_id === packId; }), published);
      return published && known && removed;
    } catch (_) { return false; }
  }

  function clearUser(uid, options) {
    uid = text(uid).trim();
    if (!uid) return false;
    userEpochs.set(uid, ++epoch);
    try {
      var storage = global.localStorage;
      if (!storage) return false;
      if (options && options.preservePending) maintainFences(storage, uid);
      var entries = readEntries(storage, uid), retained = [], known = true, quarantinePending = false;
      if (options && options.preservePending) {
        // Keep generations, not revision IDs: another tab can finish a pending
        // edit between this enumeration and publication of the new user fence.
        var userFence = readFence(storage, fenceKeys(uid, '', '', '').user);
        retained.push(userFence.version);
        quarantinePending = !!userFence.quarantine_pending;
        entries.forEach(function (entry) {
          var record = entry.record;
          if (!record) { known = false; return; }
          if (!record.pending || recordState(storage, record) === 'stale') return;
          var version = record.fences ? record.fences.user : '';
          // A repaired user fence must not promote its unknown generations into
          // readable state during an external identity change.
          if (quarantinePending && version !== userFence.version && userFence.retained.indexOf(version) < 0) return;
          if (retained.indexOf(version) === -1) retained.push(version);
        });
      }
      var published = publishFence(storage, fenceKeys(uid, '', '', '').user, retained, quarantinePending);
      var removals = options && options.preservePending
        ? entries.filter(function (entry) { return entry.record && (published || !entry.record.pending); }) : entries;
      var removed = removeEntries(storage, removals, published);
      return published && known && removed;
    } catch (_) { return false; }
  }

  function hasPending(uid) {
    uid = text(uid).trim();
    if (!uid) return false;
    try {
      if (!global.localStorage) return true;
      readFence(global.localStorage, fenceKeys(uid, '', '', '').user);
      return readEntries(global.localStorage, uid).some(function (entry) {
        return !entry.record || (entry.record.pending && recordState(global.localStorage, entry.record) !== 'stale');
      });
    } catch (_) { return true; }
  }

  if (typeof global.addEventListener === 'function') global.addEventListener('storage', function (event) {
    try {
      var storage = global.localStorage, key = text(event.key);
      if (!storage || (event.storageArea && event.storageArea !== storage)) return;
      if (key.indexOf(FENCE_PREFIX) === 0) {
        var uid = decodeURIComponent(key.slice(FENCE_PREFIX.length).split(':')[0]);
        removeEntries(storage, readEntries(storage, uid).filter(function (entry) { return !!entry.record; }), true);
      } else if (event.newValue) {
        var record = JSON.parse(event.newValue);
        if (record && key === storageKey(record.uid, record.kind, record.id)) {
          removeStaleEntry(storage, key, record.uid, record.kind, record.id);
        }
      }
    } catch (_) { /* A later read or write checks the durable fence again. */ }
  });

  var exported = { activate: activate, capture: capture, get: get, set: set, remove: remove,
    removePack: removePack, clearUser: clearUser, hasPending: hasPending };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  global.LectureProcessorStudyCache = exported;
})(typeof window !== 'undefined' ? window : globalThis);
