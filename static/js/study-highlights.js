// Study Library note highlighting: selection marks, undo/redo, cache and
// server sync, legacy migration, and the annotated notes download.
// Loaded right after study.js as a classic script: it shares study.js's
// top-level names (state, DOM refs, helpers), and study.js calls the
// functions defined here only after both scripts have loaded.
// Shared with study.js.
/* global HIGHLIGHT_SYNC_DELAY_MS, LEGACY_NOTES_HIGHLIGHT_CACHE_PREFIX, NOTES_HIGHLIGHT_CACHE_PREFIX,
   activeModalOverlay, auth, authenticatedFetch, builderOverlay, downloadStudyPackNotes, downloadUtils,
   hashStudyContent, highlightCacheSessions, highlightDeviceSaved, highlightSavesInFlight,
   highlightSyncTimer:writable, hlDownloadWrap, learnStage, notesHighlightStatus, notesPaneShell,
   notesView, patchStudyPack, pendingHighlightSaves, permanentlyRejectedHighlights,
   registerLegacyStudyKey, removeKnownLegacyStudyKey, renderNotesForSelectedPackBase, selectedPack,
   selectedPackId, setSafeInnerHtml, showToast, studyCache, studyCacheEpoch, token */
// Defined here and used by study.js.
/* exported reapplyHighlightsForPack */
/* ── Note Highlighting ── */
var hlActiveColor = 'yellow';
var hlToolbar = document.getElementById('highlight-toolbar');
var hlClearAllBtn = document.getElementById('hl-clear-all');
var hlUndoBtn = document.getElementById('hl-undo');
var hlRedoBtn = document.getElementById('hl-redo');
var hlDownloadBtn = document.getElementById('hl-download');
var hlDownloadMenu = null;
var HL_HISTORY_LIMIT = 50;
var hlUndoStack = [];
var hlRedoStack = [];
var hlSelectionTimer = null;


function cloneHighlightPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return {
    base_key: String(payload.base_key || ''),
    ranges: Array.isArray(payload.ranges) ? payload.ranges.map(function (range) {
      return {
        start: Math.max(0, parseInt(range.start, 10) || 0),
        end: Math.max(0, parseInt(range.end, 10) || 0),
        color: String(range.color || '').trim().toLowerCase()
      };
    }) : [],
    updated_at: Math.max(0, Number(payload.updated_at || 0))
  };
}

function getHighlightCacheKey() {
  return selectedPackId ? (NOTES_HIGHLIGHT_CACHE_PREFIX + selectedPackId) : null;
}

function getLegacyHighlightStorageKey() {
  return selectedPackId ? (LEGACY_NOTES_HIGHLIGHT_CACHE_PREFIX + selectedPackId) : null;
}

function getHighlightBaseKey() {
  if (!selectedPack || !selectedPackId) return '';
  var notes = String(selectedPack.notes_markdown || '');
  return selectedPackId + ':notes:' + hashStudyContent(notes) + ':' + String(notes.length);
}

function isCompatibleHighlightBaseKey(baseKey) {
  if (!selectedPack || !selectedPackId || !baseKey) return false;
  if (baseKey === getHighlightBaseKey()) return true;
  var prefix = selectedPackId + ':';
  if (baseKey.indexOf(prefix) !== 0) return false;
  var legacy = baseKey.slice(prefix.length).split(':');
  return legacy.length === 2 && /^\d+(?:\.\d+)?$/.test(legacy[0]) && /^\d+$/.test(legacy[1]) &&
    Number(legacy[1]) === String(selectedPack.notes_markdown || '').length;
}

function normalizeClientHighlightPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  var baseKey = String(payload.base_key || '').trim();
  if (!isCompatibleHighlightBaseKey(baseKey)) return null;
  if (!Array.isArray(payload.ranges)) return null;
  var ranges = [];
  payload.ranges.forEach(function (rawRange) {
    if (!rawRange || typeof rawRange !== 'object') return;
    var start = parseInt(rawRange.start, 10);
    var end = parseInt(rawRange.end, 10);
    var color = String(rawRange.color || '').trim().toLowerCase();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    if (['yellow', 'green', 'blue', 'pink'].indexOf(color) < 0) return;
    ranges.push({ start: start, end: end, color: color });
  });
  if (!ranges.length && payload.ranges.length) return null;
  return {
    base_key: getHighlightBaseKey(),
    ranges: ranges,
    updated_at: Math.max(0, Number(payload.updated_at || 0))
  };
}

function readStructuredHighlightCache() {
  var key = getHighlightCacheKey();
  if (!key || !auth.currentUser) return null;
  var scoped = studyCache ? normalizeClientHighlightPayload(studyCache.get(auth.currentUser.uid, 'highlights', selectedPackId)) : null;
  try {
    var raw = localStorage.getItem(key);
    var legacy = normalizeClientHighlightPayload(JSON.parse(raw || 'null'));
    if (legacy) registerLegacyStudyKey(key, auth.currentUser.uid, selectedPackId, raw);
    if (legacy && (!scoped || legacy.updated_at > scoped.updated_at)) {
      writeStructuredHighlightCache(legacy, true);
      return legacy;
    }
    return scoped;
  } catch (e) {
    return scoped;
  }
}

function storeHighlightForPack(packId, payload, pending, session) {
  var saved = !!(studyCache && studyCache.set(session, 'highlights', packId, payload, { packId: packId, pending: !!pending }));
  highlightDeviceSaved.set(packId, saved);
  if (saved && auth.currentUser) {
    removeKnownLegacyStudyKey(NOTES_HIGHLIGHT_CACHE_PREFIX + packId, auth.currentUser.uid, packId);
    removeKnownLegacyStudyKey(LEGACY_NOTES_HIGHLIGHT_CACHE_PREFIX + packId, auth.currentUser.uid, packId);
  }
  return saved;
}

function writeStructuredHighlightCache(payload, pending) {
  if (!selectedPackId || !auth.currentUser || !payload || !payload.ranges) return false;
  return storeHighlightForPack(selectedPackId, payload, pending, highlightCacheSessions.get(selectedPackId));
}

function clearStructuredHighlightCache() {
  if (!studyCache || !auth.currentUser || !selectedPackId) return false;
  var removed = studyCache.remove(auth.currentUser.uid, 'highlights', selectedPackId);
  // This deliberate reset belongs to the currently opened, owned pack.
  highlightCacheSessions.set(selectedPackId, studyCache.capture(auth.currentUser.uid));
  highlightDeviceSaved.delete(selectedPackId);
  return removed;
}

function readLegacyHighlightPayload() {
  var key = getLegacyHighlightStorageKey();
  if (!key) return null;
  try {
    var raw = localStorage.getItem(key);
    var parsed = JSON.parse(raw || 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    if (!isCompatibleHighlightBaseKey(String(parsed.base_key || ''))) return null;
    if (typeof parsed.annotated_html !== 'string' || !parsed.annotated_html) return null;
    if (auth.currentUser) registerLegacyStudyKey(key, auth.currentUser.uid, selectedPackId, raw);
    return Object.assign({}, parsed, { base_key: getHighlightBaseKey() });
  } catch (e) {
    return null;
  }
}

function setNotesHtml(html) {
  if (!notesView) return;
  setSafeInnerHtml(notesView, html);
}
function updateHighlightHistoryButtons() {
  if (hlUndoBtn) hlUndoBtn.disabled = hlUndoStack.length === 0;
  if (hlRedoBtn) hlRedoBtn.disabled = hlRedoStack.length === 0;
}

function payloadFingerprint(payload) {
  return JSON.stringify(payload || null);
}

function pushUndoSnapshot(snapshot) {
  var cloned = cloneHighlightPayload(snapshot);
  if (hlUndoStack.length && payloadFingerprint(hlUndoStack[hlUndoStack.length - 1]) === payloadFingerprint(cloned)) return;
  hlUndoStack.push(cloned);
  if (hlUndoStack.length > HL_HISTORY_LIMIT) {
    hlUndoStack.splice(0, hlUndoStack.length - HL_HISTORY_LIMIT);
  }
  updateHighlightHistoryButtons();
}

function resetHighlightHistory(initialSnapshot) {
  hlUndoStack = [];
  hlRedoStack = [];
  void initialSnapshot;
  updateHighlightHistoryButtons();
}

function setHighlightStatus(message, warning) {
  if (!notesHighlightStatus) return;
  notesHighlightStatus.textContent = String(message || 'Highlights save to this study pack automatically.');
  notesHighlightStatus.hidden = !warning;
}

function buildTextNodeIndex(root) {
  var entries = [];
  if (!root) return entries;
  var offset = 0;
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
  var node;
  while ((node = walker.nextNode())) {
    var length = String(node.nodeValue || '').length;
    entries.push({ node: node, start: offset, end: offset + length });
    offset += length;
  }
  return entries;
}

function findTextPosition(entries, offset, preferEnd) {
  if (!entries.length) return null;
  var target = Math.max(0, parseInt(offset, 10) || 0);
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    if (target < entry.end) {
      return { node: entry.node, offset: target - entry.start };
    }
    if (target === entry.end) {
      if (preferEnd || i === entries.length - 1) {
        return { node: entry.node, offset: entry.node.nodeValue.length };
      }
      return { node: entries[i + 1].node, offset: 0 };
    }
  }
  var lastEntry = entries[entries.length - 1];
  return { node: lastEntry.node, offset: lastEntry.node.nodeValue.length };
}

function createRangeFromOffsets(startOffset, endOffset) {
  if (!notesView) return null;
  var entries = buildTextNodeIndex(notesView);
  if (!entries.length) return null;
  var start = findTextPosition(entries, startOffset, false);
  var end = findTextPosition(entries, endOffset, true);
  if (!start || !end) return null;
  try {
    var range = document.createRange();
    range.setStart(start.node, Math.max(0, start.offset));
    range.setEnd(end.node, Math.max(0, end.offset));
    if (range.collapsed) return null;
    return range;
  } catch (e) {
    return null;
  }
}

function collectHighlightRangesFromDom() {
  if (!notesView) return [];
  var index = buildTextNodeIndex(notesView);
  var map = new Map();
  index.forEach(function (entry) { map.set(entry.node, entry); });
  var ranges = [];
  notesView.querySelectorAll('mark[data-hl]').forEach(function (mark) {
    var color = String(mark.getAttribute('data-hl') || '').trim().toLowerCase();
    if (['yellow', 'green', 'blue', 'pink'].indexOf(color) < 0) return;
    var walker = document.createTreeWalker(mark, NodeFilter.SHOW_TEXT, null, false);
    var node;
    var start = null;
    var end = null;
    while ((node = walker.nextNode())) {
      var entry = map.get(node);
      if (!entry) continue;
      if (start === null) start = entry.start;
      end = entry.end;
    }
    if (start !== null && end !== null && end > start) {
      ranges.push({ start: start, end: end, color: color });
    }
  });
  return ranges;
}

function collectCurrentHighlightPayload() {
  var baseKey = getHighlightBaseKey();
  if (!baseKey) return null;
  var ranges = collectHighlightRangesFromDom();
  if (!ranges.length) return null;
  return {
    base_key: baseKey,
    ranges: ranges,
    updated_at: Date.now() / 1000
  };
}

function persistHighlightPayloadLocally(payload, pending) {
  if (payload && payload.ranges) {
    return writeStructuredHighlightCache(payload, pending);
  } else {
    return clearStructuredHighlightCache();
  }
}

function getPermanentlyRejectedHighlight(packId) {
  var rejected = permanentlyRejectedHighlights.get(packId);
  return rejected && auth.currentUser && rejected.uid === auth.currentUser.uid && rejected.epoch === studyCacheEpoch ? rejected : null;
}

function hasPermanentlyRejectedHighlights() {
  return Array.from(permanentlyRejectedHighlights.keys()).some(function (packId) { return !!getPermanentlyRejectedHighlight(packId); });
}

function queueHighlightSync(payload, fromCache) {
  var safePackId = String(selectedPack && selectedPack.study_pack_id || '');
  if (!safePackId || safePackId !== selectedPackId) return;
  var cloned = cloneHighlightPayload(payload) || { base_key: getHighlightBaseKey(), ranges: [], updated_at: Date.now() / 1000 };
  var rejected = getPermanentlyRejectedHighlight(safePackId);
  if (fromCache && rejected && payloadFingerprint(rejected.payload) === payloadFingerprint(cloned)) return;
  permanentlyRejectedHighlights.delete(safePackId);
  pendingHighlightSaves.set(safePackId, cloned);
  if (selectedPack && selectedPack.study_pack_id === safePackId) {
    selectedPack.notes_highlights = cloned;
  }
  if (!persistHighlightPayloadLocally(cloned, true)) setHighlightStatus('Highlights could not be saved on this device. Keep this tab open until syncing succeeds.', true);
  if (highlightSyncTimer) { clearTimeout(highlightSyncTimer); }
  highlightSyncTimer = setTimeout(function () {
    highlightSyncTimer = null;
    flushHighlightSync();
  }, HIGHLIGHT_SYNC_DELAY_MS);
}

function flushHighlightSync(options) {
  var opts = options || {};
  if (highlightSyncTimer) { clearTimeout(highlightSyncTimer); highlightSyncTimer = null; }
  if (!token || !auth.currentUser) return Promise.resolve(false);
  var uid = auth.currentUser.uid, cacheEpoch = studyCacheEpoch;
  function isCurrent() { return cacheEpoch === studyCacheEpoch && auth.currentUser && auth.currentUser.uid === uid; }
  return Promise.all(Array.from(pendingHighlightSaves.keys()).map(function (packId) {
    if (highlightSavesInFlight.has(packId)) {
      return highlightSavesInFlight.get(packId).then(function (saved) {
        if (!isCurrent()) return false;
        if (opts.keepalive && pendingHighlightSaves.has(packId)) return flushHighlightSync(opts);
        return saved;
      });
    }
    var payload = pendingHighlightSaves.get(packId);
    var cacheSession = highlightCacheSessions.get(packId);
    pendingHighlightSaves.delete(packId);
    var request = patchStudyPack(packId, { notes_highlights: payload.ranges.length ? payload : null }, opts).then(function () {
      if (!isCurrent() || highlightSavesInFlight.get(packId) !== request) return false;
      permanentlyRejectedHighlights.delete(packId);
      if (!pendingHighlightSaves.has(packId)) {
        storeHighlightForPack(packId, payload, false, cacheSession);
      }
      if (selectedPack && selectedPack.study_pack_id === packId && !pendingHighlightSaves.has(packId)) {
        selectedPack.notes_highlights = payload;
        setHighlightStatus(payload.ranges.length
          ? 'Highlights save to this study pack automatically.'
          : 'Highlights cleared for this study pack.');
      }
      return true;
    }).catch(function (e) {
      if (!isCurrent() || highlightSavesInFlight.get(packId) !== request) return false;
      if (e.status === 403 || e.status === 404) {
        if (pendingHighlightSaves.has(packId)) return false;
        var durable = studyCache && studyCache.get(uid, 'highlights', packId);
        // Only this exact request can settle its durable revision. A later
        // local edit or another tab's edit still needs its own response.
        var durableMatches = !!durable && payloadFingerprint(durable) === payloadFingerprint(payload);
        if (durable && !durableMatches) {
          var durableTime = Number(durable.updated_at), requestTime = Number(payload.updated_at);
          if (Number.isFinite(durableTime) && Number.isFinite(requestTime) && durableTime > requestTime) return false;
        }
        // A failed local write can leave an older or ambiguous durable revision.
        // Keep this rejected edit pending in memory without changing those bytes.
        var acknowledged = durableMatches && storeHighlightForPack(packId, payload, false, cacheSession);
        if (!acknowledged) permanentlyRejectedHighlights.set(packId, { uid: uid, epoch: cacheEpoch, payload: payload });
        if (selectedPackId === packId) setHighlightStatus(acknowledged
          ? 'Highlights remain on this device; this pack cannot be updated.'
          : 'Highlights could not be saved on this device, and this pack cannot be updated. Closing this tab may lose your changes.', true);
        return acknowledged;
      }
      console.warn('Could not sync note highlights:', e && e.message ? e.message : e);
      // A failed older request must never replace a newer local edit.
      if (!pendingHighlightSaves.has(packId)) pendingHighlightSaves.set(packId, payload);
      if (selectedPackId === packId) setHighlightStatus(highlightDeviceSaved.get(packId)
        ? 'Highlights are saved locally and will retry syncing.'
        : 'Highlights could not be saved on this device. Keep this tab open until syncing succeeds.', true);
      return false;
    }).finally(function () {
      if (highlightSavesInFlight.get(packId) !== request) return;
      highlightSavesInFlight.delete(packId);
      if (pendingHighlightSaves.size && !highlightSyncTimer) {
        highlightSyncTimer = setTimeout(function () {
          highlightSyncTimer = null;
          flushHighlightSync(opts);
        }, HIGHLIGHT_SYNC_DELAY_MS * 2);
      }
    });
    highlightSavesInFlight.set(packId, request);
    return request;
  })).then(function (results) { return isCurrent() && !hasPermanentlyRejectedHighlights() && results.every(function (saved) { return saved !== false; }); });
}

function applyHighlightPayloadToNotes(payload) {
  renderNotesForSelectedPackBase();
  var normalized = normalizeClientHighlightPayload(payload);
  if (!normalized) return null;
  normalized.ranges.slice().sort(function (left, right) {
    if (left.start !== right.start) return left.start - right.start;
    return left.end - right.end;
  }).forEach(function (rangeData) {
    var range = createRangeFromOffsets(rangeData.start, rangeData.end);
    if (!range) return;
    removeHighlightsInRange(range);
    applyColorToRange(range, rangeData.color);
  });
  mergeAdjacentHighlightMarks(notesView);
  return collectCurrentHighlightPayload();
}

function applyHighlightSnapshot(payload, shouldPersist) {
  var appliedPayload = applyHighlightPayloadToNotes(payload);
  if (shouldPersist !== false) {
    queueHighlightSync(appliedPayload);
  }
  return appliedPayload;
}

function commitHighlightMutation(mutator, successMessage) {
  if (!notesView || !selectedPackId || typeof mutator !== 'function') return;
  var before = collectCurrentHighlightPayload();
  mutator();
  mergeAdjacentHighlightMarks(notesView);
  var after = collectCurrentHighlightPayload();
  if (payloadFingerprint(before) === payloadFingerprint(after)) return;
  pushUndoSnapshot(before);
  hlRedoStack = [];
  updateHighlightHistoryButtons();
  queueHighlightSync(after);
  if (successMessage) showToast(successMessage);
}

function unwrapHighlightMark(mark) {
  if (!mark || !mark.parentNode) return;
  var parent = mark.parentNode;
  while (mark.firstChild) {
    parent.insertBefore(mark.firstChild, mark);
  }
  parent.removeChild(mark);
  parent.normalize();
}
function removeHighlightsInRange(range) {
  if (!notesView || !range) return;
  var marks = notesView.querySelectorAll('mark[data-hl]');
  marks.forEach(function (mark) {
    try {
      if (range.intersectsNode(mark)) unwrapHighlightMark(mark);
    } catch (e) { }
  });
}
function wrapTextNodeSegment(node, startOffset, endOffset, color) {
  if (!node || startOffset >= endOffset) return;
  var target = node;
  if (startOffset > 0) target = target.splitText(startOffset);
  var selectedLen = endOffset - startOffset;
  if (selectedLen < target.nodeValue.length) {
    target.splitText(selectedLen);
  }
  var parentMark = target.parentElement && target.parentElement.closest('mark[data-hl]');
  if (parentMark) {
    parentMark.setAttribute('data-hl', color);
    return;
  }
  var mark = document.createElement('mark');
  mark.setAttribute('data-hl', color);
  target.parentNode.insertBefore(mark, target);
  mark.appendChild(target);
}
function mergeAdjacentHighlightMarks(root) {
  if (!root) return;
  var marks = root.querySelectorAll('mark[data-hl]');
  marks.forEach(function (mark) {
    if (!mark.parentNode) return;
    if (!mark.textContent) {
      mark.remove();
      return;
    }
    var next = mark.nextSibling;
    while (
      next &&
      next.nodeType === Node.ELEMENT_NODE &&
      next.tagName === 'MARK' &&
      next.getAttribute('data-hl') === mark.getAttribute('data-hl')
    ) {
      while (next.firstChild) {
        mark.appendChild(next.firstChild);
      }
      var toRemove = next;
      next = next.nextSibling;
      toRemove.remove();
    }
  });
}
function getTextNodesIntersectingRange(range) {
  if (!range || !notesView) return [];
  var walker = document.createTreeWalker(notesView, NodeFilter.SHOW_TEXT, {
    acceptNode: function (node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      try {
        return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      } catch (e) {
        return NodeFilter.FILTER_REJECT;
      }
    }
  }, false);
  var nodes = [];
  var current;
  while ((current = walker.nextNode())) {
    nodes.push(current);
  }
  return nodes;
}
function applyColorToRange(range, color) {
  var textNodes = getTextNodesIntersectingRange(range);
  textNodes.forEach(function (node) {
    var start = 0;
    var end = node.nodeValue.length;
    if (node === range.startContainer) start = range.startOffset;
    if (node === range.endContainer) end = range.endOffset;
    start = Math.max(0, Math.min(start, node.nodeValue.length));
    end = Math.max(0, Math.min(end, node.nodeValue.length));
    if (start < end) {
      wrapTextNodeSegment(node, start, end, color);
    }
  });
  mergeAdjacentHighlightMarks(notesView);
}

function migrateLegacyHighlightsForPack() {
  var legacyPayload = readLegacyHighlightPayload();
  if (!legacyPayload || !legacyPayload.annotated_html) return null;
  setNotesHtml(legacyPayload.annotated_html);
  var migratedPayload = collectCurrentHighlightPayload();
  renderNotesForSelectedPackBase();
  if (migratedPayload) {
    queueHighlightSync(migratedPayload, true);
  }
  return migratedPayload;
}

function reapplyHighlightsForPack(alreadySyncingHighlights) {
  if (!notesView || !selectedPackId) return;
  var serverPayload = normalizeClientHighlightPayload(selectedPack && selectedPack.notes_highlights);
  var localPayload = readStructuredHighlightCache();
  var localWins = !!(localPayload && (!serverPayload || localPayload.updated_at > serverPayload.updated_at));
  var payload = localWins ? localPayload : serverPayload;
  var rejected = getPermanentlyRejectedHighlight(selectedPackId);
  if (rejected && (!payload || rejected.payload.updated_at >= payload.updated_at)) payload = rejected.payload;
  var rejectedPayload = rejected && payloadFingerprint(rejected.payload) === payloadFingerprint(payload);
  var migrated = false;
  if (!payload) {
    payload = migrateLegacyHighlightsForPack();
    migrated = !!payload;
  }
  var appliedPayload = applyHighlightPayloadToNotes(payload);
  if (payload) {
    if (!appliedPayload && !payload.ranges.length) appliedPayload = cloneHighlightPayload(payload);
    if (appliedPayload) appliedPayload.updated_at = payload.updated_at;
  }
  if (!appliedPayload) {
    renderNotesForSelectedPackBase();
    clearStructuredHighlightCache();
    setHighlightStatus('Highlights save to this study pack automatically.');
  } else if (rejectedPayload) {
    setHighlightStatus('Highlights could not be saved on this device, and this pack cannot be updated. Closing this tab may lose your changes.', true);
  } else {
    var stored = persistHighlightPayloadLocally(appliedPayload, localWins || migrated);
    var warning = !stored && (localWins || migrated);
    setHighlightStatus(warning ? 'Highlights could not be saved on this device. Keep this tab open until syncing succeeds.' : 'Highlights save to this study pack automatically.', warning);
  }
  resetHighlightHistory(appliedPayload);
  var alreadyQueued = (pendingHighlightSaves.has(selectedPackId) || highlightSavesInFlight.has(selectedPackId)) &&
    payloadFingerprint(alreadySyncingHighlights) === payloadFingerprint(appliedPayload);
  if (localWins && !alreadyQueued) queueHighlightSync(appliedPayload, true);
}

function applyHighlightToSelection() {
  if (hlSelectionTimer) {
    window.clearTimeout(hlSelectionTimer);
    hlSelectionTimer = null;
  }
  var sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount || !notesView) return;
  var range = sel.getRangeAt(0);
  if (!notesView.contains(range.commonAncestorContainer)) return;
  if (!range.toString().trim()) return;
  commitHighlightMutation(function () {
    removeHighlightsInRange(range);
    if (hlActiveColor !== 'eraser') {
      applyColorToRange(range, hlActiveColor);
    }
  });
  sel.removeAllRanges();
}

function selectionIsInsideNotes() {
  var sel = window.getSelection ? window.getSelection() : null;
  if (!sel || sel.isCollapsed || !sel.rangeCount || !notesView) return false;
  try {
    return notesView.contains(sel.getRangeAt(0).commonAncestorContainer);
  } catch (e) {
    return false;
  }
}

function scheduleHighlightToSelection(delayMs) {
  if (!selectionIsInsideNotes()) return;
  if (hlSelectionTimer) window.clearTimeout(hlSelectionTimer);
  hlSelectionTimer = window.setTimeout(function () {
    hlSelectionTimer = null;
    applyHighlightToSelection();
  }, Math.max(80, Number(delayMs || 120)));
}

function undoHighlightChange() {
  if (!hlUndoStack.length || !notesView) return;
  var current = collectCurrentHighlightPayload();
  var previous = cloneHighlightPayload(hlUndoStack.pop());
  hlRedoStack.push(cloneHighlightPayload(current));
  if (hlRedoStack.length > HL_HISTORY_LIMIT) {
    hlRedoStack.splice(0, hlRedoStack.length - HL_HISTORY_LIMIT);
  }
  applyHighlightSnapshot(previous, true);
  updateHighlightHistoryButtons();
}
function redoHighlightChange() {
  if (!hlRedoStack.length || !notesView) return;
  var current = collectCurrentHighlightPayload();
  var next = cloneHighlightPayload(hlRedoStack.pop());
  pushUndoSnapshot(current);
  applyHighlightSnapshot(next, true);
  updateHighlightHistoryButtons();
}

// Toolbar color selection
if (hlToolbar) {
  hlToolbar.querySelectorAll('.hl-btn[data-hl-color]').forEach(function (btn) {
    btn.setAttribute('aria-pressed', btn.getAttribute('data-hl-color') === hlActiveColor ? 'true' : 'false');
    btn.addEventListener('click', function () {
      hlActiveColor = btn.getAttribute('data-hl-color') || 'yellow';
      hlToolbar.querySelectorAll('.hl-btn[data-hl-color]').forEach(function (button) {
        var active = button === btn;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    });
  });
}

// Clear all highlights
if (hlClearAllBtn) {
  hlClearAllBtn.addEventListener('click', function () {
    if (!notesView || !selectedPack) return;
    commitHighlightMutation(function () {
      renderNotesForSelectedPackBase();
    }, 'All highlights cleared.');
  });
}

// Click to remove individual highlight
if (notesView) {
  notesView.addEventListener('click', function (e) {
    if (hlActiveColor !== 'eraser') return;
    var mark = e.target.closest('mark[data-hl]');
    if (!mark) return;
    commitHighlightMutation(function () { unwrapHighlightMark(mark); });
  });
}

// Apply highlight on text selection (mouseup)
if (notesView) {
  notesView.addEventListener('mouseup', function () {
    scheduleHighlightToSelection(120);
  });
  notesView.addEventListener('touchend', function () {
    scheduleHighlightToSelection(1000);
  });
}

document.addEventListener('selectionchange', function () {
  if (!selectionIsInsideNotes()) return;
  scheduleHighlightToSelection(1000);
});

function downloadOriginalNotesDocx() {
  if (!selectedPackId) {
    showToast('No notes to download.', 'error');
    return;
  }
  showToast('Original notes Word export started.', 'success');
  downloadStudyPackNotes(selectedPackId, 'docx').catch(function (e) {
    showToast(e.message || 'Could not export Word file.', 'error');
  });
}
function unwrapExportNode(node) {
  if (!node || !node.parentNode) return;
  while (node.firstChild) {
    node.parentNode.insertBefore(node.firstChild, node);
  }
  node.parentNode.removeChild(node);
}
function buildAnnotatedNotesExportHtml() {
  if (!notesView) return '';
  var clone = notesView.cloneNode(true);
  clone.querySelectorAll('.notes-audio-btn').forEach(function (button) {
    button.remove();
  });
  clone.querySelectorAll('.notes-audio-section').forEach(function (section) {
    section.classList.remove('audio-active');
    section.classList.remove('has-audio');
    section.removeAttribute('data-section-index');
    unwrapExportNode(section);
  });
  clone.querySelectorAll('[aria-hidden="true"]').forEach(function (node) {
    node.remove();
  });
  return String(clone.innerHTML || '').trim();
}
function downloadAnnotatedNotesPdf() {
  if (!selectedPackId) {
    showToast('No notes to download.', 'error');
    return;
  }
  var exportHtml = buildAnnotatedNotesExportHtml();
  if (!exportHtml) {
    showToast('No notes to download.', 'error');
    return;
  }
  var title = (selectedPack && selectedPack.title) ? selectedPack.title : 'Study Notes';
  var filename = title.replace(/[^a-zA-Z0-9 _-]/g, '').substring(0, 60).trim() || 'Study Notes';
  showToast('Annotated PDF export started.', 'success');
  authenticatedFetch('/api/study-packs/' + encodeURIComponent(selectedPackId) + '/export-annotated-pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: title,
      annotated_html: exportHtml
    })
  }).then(function (response) {
    if (!response.ok) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        throw new Error(payload.error || 'Could not export annotated PDF');
      });
    }
    if (downloadUtils.downloadResponseBlob) {
      return downloadUtils.downloadResponseBlob(response, filename + ' - Annotated.pdf');
    }
    return response.blob().then(function (blob) {
      var url = URL.createObjectURL(blob);
      var anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename + ' - Annotated.pdf';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
      return filename + ' - Annotated.pdf';
    });
  }).then(function () {
    showToast('Annotated notes downloaded as PDF.', 'success');
  }).catch(function (e) {
    showToast(e && e.message ? e.message : 'Could not export annotated PDF.', 'error');
  });
}
function getHighlightDownloadMenuHost() {
  if (hlDownloadWrap) {
    return hlDownloadWrap;
  }
  if (hlToolbar) {
    return hlToolbar;
  }
  return notesPaneShell || document.body || document.documentElement;
}
function syncHighlightDownloadMenuHost() {
  if (!hlDownloadMenu) return null;
  var host = getHighlightDownloadMenuHost();
  if (host && hlDownloadMenu.parentNode !== host) {
    host.appendChild(hlDownloadMenu);
  }
  return host;
}
function resetHighlightDownloadMenuPosition() {
  if (!hlDownloadMenu) return;
  hlDownloadMenu.classList.remove('is-upward', 'is-align-left');
}
function setHighlightDownloadMenuOpen(open) {
  var menu = ensureHighlightDownloadMenu();
  if (!menu) return;
  var shouldOpen = !!open;
  if (shouldOpen) {
    syncHighlightDownloadMenuHost();
  }
  if (!shouldOpen) {
    resetHighlightDownloadMenuPosition();
  }
  menu.classList.toggle('visible', shouldOpen);
  if (hlDownloadBtn) {
    hlDownloadBtn.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
  }
  if (shouldOpen) {
    window.requestAnimationFrame(positionHighlightDownloadMenu);
  }
}
function positionHighlightDownloadMenu() {
  if (!hlDownloadMenu || !hlDownloadMenu.classList.contains('visible')) return;
  syncHighlightDownloadMenuHost();
  resetHighlightDownloadMenuPosition();
  var viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  var viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  if (!hlDownloadBtn) return;
  var buttonRect = hlDownloadBtn.getBoundingClientRect();
  var menuWidth = hlDownloadMenu.offsetWidth || 280;
  var menuHeight = hlDownloadMenu.offsetHeight || 108;
  var alignLeft = false;
  var upward = false;
  if ((buttonRect.right - menuWidth) < 16) {
    alignLeft = true;
  }
  if (buttonRect.bottom + 10 + menuHeight > viewportHeight - 16) {
    upward = true;
  }
  if (alignLeft && buttonRect.left + menuWidth > viewportWidth - 16) {
    alignLeft = false;
  }
  if (upward && buttonRect.top - menuHeight - 10 < 16) {
    upward = false;
  }
  hlDownloadMenu.classList.toggle('is-upward', upward);
  hlDownloadMenu.classList.toggle('is-align-left', alignLeft);
}
function ensureHighlightDownloadMenu() {
  if (hlDownloadMenu || !hlToolbar) return hlDownloadMenu;
  hlDownloadMenu = document.createElement('div');
  hlDownloadMenu.className = 'hl-download-menu';
  hlDownloadMenu.setAttribute('role', 'menu');
  var originalDocxBtn = document.createElement('button');
  originalDocxBtn.type = 'button';
  originalDocxBtn.className = 'hl-download-item';
  originalDocxBtn.setAttribute('role', 'menuitem');
  originalDocxBtn.textContent = 'Download Original Notes (.docx)';
  originalDocxBtn.addEventListener('click', function () {
    setHighlightDownloadMenuOpen(false);
    downloadOriginalNotesDocx();
  });
  var annotatedBtn = document.createElement('button');
  annotatedBtn.type = 'button';
  annotatedBtn.className = 'hl-download-item';
  annotatedBtn.setAttribute('role', 'menuitem');
  annotatedBtn.textContent = 'Download Annotated Notes (.pdf)';
  annotatedBtn.addEventListener('click', function () {
    setHighlightDownloadMenuOpen(false);
    downloadAnnotatedNotesPdf();
  });
  hlDownloadMenu.appendChild(originalDocxBtn);
  hlDownloadMenu.appendChild(annotatedBtn);
  syncHighlightDownloadMenuHost();
  document.addEventListener('click', function (e) {
    if (!hlDownloadBtn || !hlDownloadMenu) return;
    if (!hlDownloadMenu.contains(e.target) && !hlDownloadBtn.contains(e.target)) {
      setHighlightDownloadMenuOpen(false);
    }
  });
  return hlDownloadMenu;
}
if (hlDownloadBtn) {
  ensureHighlightDownloadMenu();
  hlDownloadBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    var menu = ensureHighlightDownloadMenu();
    if (!menu) return;
    setHighlightDownloadMenuOpen(!menu.classList.contains('visible'));
  });
}
window.addEventListener('resize', function () {
  if (hlDownloadMenu && hlDownloadMenu.classList.contains('visible')) {
    positionHighlightDownloadMenu();
  }
});
window.addEventListener('scroll', function () {
  if (hlDownloadMenu && hlDownloadMenu.classList.contains('visible')) {
    positionHighlightDownloadMenu();
  }
}, true);
document.addEventListener('fullscreenchange', function () {
  syncHighlightDownloadMenuHost();
  if (hlDownloadMenu && hlDownloadMenu.classList.contains('visible')) {
    positionHighlightDownloadMenu();
  } else {
    resetHighlightDownloadMenuPosition();
  }
});
document.addEventListener('webkitfullscreenchange', function () {
  syncHighlightDownloadMenuHost();
  if (hlDownloadMenu && hlDownloadMenu.classList.contains('visible')) {
    positionHighlightDownloadMenu();
  } else {
    resetHighlightDownloadMenuPosition();
  }
});
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape' || !hlDownloadMenu || !hlDownloadMenu.classList.contains('visible')) return;
  setHighlightDownloadMenuOpen(false);
  if (hlDownloadBtn) { hlDownloadBtn.focus(); }
});
if (hlUndoBtn) {
  hlUndoBtn.addEventListener('click', function () { undoHighlightChange(); });
}
if (hlRedoBtn) {
  hlRedoBtn.addEventListener('click', function () { redoHighlightChange(); });
}
document.addEventListener('keydown', function (e) {
  if (!selectedPackId || !notesView) return;
  var active = document.activeElement;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
  var selection = window.getSelection ? window.getSelection() : null;
  var selectionInsideNotes = !!(selection && selection.rangeCount && notesView.contains(selection.getRangeAt(0).commonAncestorContainer));
  var focusInsideNotes = !!(active && notesView.contains(active));
  var notesVisible = notesView.getClientRects().length > 0 && !learnStage.classList.contains('visible') && !builderOverlay.classList.contains('visible') && !activeModalOverlay;
  if (!selectionInsideNotes && !focusInsideNotes && !notesVisible) return;
  if (active && active.closest && active.closest('[role=dialog]')) return;
  var cmdOrCtrl = e.metaKey || e.ctrlKey;
  if (!cmdOrCtrl) return;
  var isZ = (e.key || '').toLowerCase() === 'z';
  var isY = (e.key || '').toLowerCase() === 'y';
  if (!isZ && !isY) return;
  e.preventDefault();
  if (e.shiftKey || isY) {
    redoHighlightChange();
  } else {
    undoHighlightChange();
  }
});
updateHighlightHistoryButtons();
