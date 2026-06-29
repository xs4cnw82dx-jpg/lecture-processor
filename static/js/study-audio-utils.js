(function (global) {
  'use strict';

  function fetchAudioStreamUrl(authenticatedFetch, packId) {
    if (typeof authenticatedFetch !== 'function') {
      return Promise.reject(new Error('Audio playback is unavailable.'));
    }
    var safePackId = String(packId || '').trim();
    if (!safePackId) {
      return Promise.reject(new Error('No study pack selected.'));
    }
    return authenticatedFetch('/api/study-packs/' + encodeURIComponent(safePackId) + '/audio-token', {
      method: 'POST'
    }).then(function (response) {
      if (!response.ok) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          throw new Error((body && body.error) || 'Could not load audio');
        });
      }
      return response.json();
    }).then(function (payload) {
      var streamUrl = String(payload && payload.stream_url || '').trim();
      if (!streamUrl) throw new Error('Could not prepare audio playback');
      return streamUrl;
    });
  }

  global.LectureProcessorStudyAudio = {
    fetchAudioStreamUrl: fetchAudioStreamUrl
  };
})(window);
