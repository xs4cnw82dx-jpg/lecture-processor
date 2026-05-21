(function (root) {
  'use strict';

  function parseTags(value) {
    var parts = Array.isArray(value)
      ? value
      : String(value || '').split(',');
    var seen = {};
    var tags = [];
    parts.forEach(function (part) {
      var tag = String(part || '').trim().replace(/\s+/g, ' ').slice(0, 32);
      var key = tag.toLowerCase();
      if (!tag || seen[key]) return;
      seen[key] = true;
      tags.push(tag);
    });
    return tags.slice(0, 12);
  }

  function formatDuration(seconds) {
    var total = Math.max(0, Math.floor(Number(seconds || 0)));
    var minutes = Math.floor(total / 60);
    var secs = total % 60;
    return String(minutes).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
  }

  function normalizeStatus(rawStatus) {
    var status = String(rawStatus || '').trim().toLowerCase();
    if (status === 'synced' || status === 'complete') return 'synced';
    if (status === 'syncing' || status === 'processing' || status === 'queued' || status === 'starting') return 'syncing';
    if (status === 'error' || status === 'failed') return 'error';
    return 'pending';
  }

  function searchableText(note) {
    var item = note && typeof note === 'object' ? note : {};
    return [
      item.title,
      item.transcript,
      item.notes_markdown,
      item.status,
      Array.isArray(item.tags) ? item.tags.join(' ') : '',
    ].join(' ').toLowerCase();
  }

  function filterVoiceNotes(notes, options) {
    var list = Array.isArray(notes) ? notes.slice() : [];
    var settings = options || {};
    var query = String(settings.query || '').trim().toLowerCase();
    var filter = String(settings.filter || 'all').trim().toLowerCase();
    return list.filter(function (note) {
      var status = normalizeStatus(note && note.status);
      if (filter === 'pinned' && !(note && note.pinned)) return false;
      if (filter === 'pending' && status !== 'pending' && status !== 'syncing' && status !== 'error') return false;
      if (filter === 'archived' && !(note && note.archived)) return false;
      if (filter !== 'archived' && note && note.archived) return false;
      if (query && searchableText(note).indexOf(query) === -1) return false;
      return true;
    }).sort(function (a, b) {
      var pinnedDiff = Number(!!(b && b.pinned)) - Number(!!(a && a.pinned));
      if (pinnedDiff) return pinnedDiff;
      return Number((b && b.created_at) || 0) - Number((a && a.created_at) || 0);
    });
  }

  function normalizePackPayload(pack, fallback) {
    var source = pack && typeof pack === 'object' ? pack : {};
    var base = fallback && typeof fallback === 'object' ? fallback : {};
    return Object.assign({}, base, {
      id: String(source.study_pack_id || base.study_pack_id || base.id || ''),
      study_pack_id: String(source.study_pack_id || base.study_pack_id || ''),
      title: String(source.title || base.title || 'Untitled voice note'),
      status: 'synced',
      mode: String(source.mode || base.mode || 'voice-note'),
      transcript: String(source.source_transcript || source.transcript || base.transcript || ''),
      notes_markdown: String(source.notes_markdown || base.notes_markdown || ''),
      notes_highlights: source.notes_highlights || base.notes_highlights || null,
      flashcards: Array.isArray(source.flashcards) ? source.flashcards : (Array.isArray(base.flashcards) ? base.flashcards : []),
      test_questions: Array.isArray(source.test_questions) ? source.test_questions : (Array.isArray(base.test_questions) ? base.test_questions : []),
      tags: parseTags(source.tags || base.tags || []),
      pinned: Boolean(source.pinned || base.pinned),
      archived: Boolean(source.archived || base.archived),
      custom_instruction: String(source.custom_instruction || base.custom_instruction || ''),
      has_audio_playback: Boolean(source.has_audio_playback || base.has_audio_playback),
      updated_at: Number(source.updated_at || Date.now() / 1000),
    });
  }

  function estimateOfflineBytes(notes) {
    return (Array.isArray(notes) ? notes : []).reduce(function (sum, note) {
      return sum + Number((note && note.audio_size) || 0);
    }, 0);
  }

  var exported = {
    parseTags: parseTags,
    formatDuration: formatDuration,
    normalizeStatus: normalizeStatus,
    searchableText: searchableText,
    filterVoiceNotes: filterVoiceNotes,
    normalizePackPayload: normalizePackPayload,
    estimateOfflineBytes: estimateOfflineBytes,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
  root.LectureProcessorVoiceNotes = Object.assign({}, root.LectureProcessorVoiceNotes || {}, exported);
})(typeof window !== 'undefined' ? window : globalThis);
