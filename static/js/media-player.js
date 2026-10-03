(function (global) {
  'use strict';
  var serial = 0;
  var icons = {
    play: '<path d="m9 5 11 7-11 7z"/>', pause: '<path d="M8 5v14M16 5v14"/>',
    volume: '<path d="M11 5 6 9H3v6h3l5 4zM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/>',
    muted: '<path d="M11 5 6 9H3v6h3l5 4zM16 9l5 6m0-6-5 6"/>',
    fullscreen: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>'
  };
  function node(tag, className, text) { var element = document.createElement(tag); if (className) element.className = className; if (text) element.textContent = text; return element; }
  function icon(button, name, label) {
    button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + icons[name] + '</svg>';
    button.setAttribute('aria-label', label); button.title = label;
  }
  function clock(value) { var seconds = Math.floor(Math.max(0, Number(value) || 0)); return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'); }
  function enhance(media) {
    if (media._appMediaPlayer || !media.controls) return;
    var video = media.tagName === 'VIDEO';
    var shell = node('div', 'app-media-player' + (video ? ' app-media-video' : ' app-media-audio'));
    shell.setAttribute('role', 'group'); shell.setAttribute('aria-label', media.getAttribute('aria-label') || (video ? 'Video player' : 'Audio player'));
    media.insertAdjacentElement('beforebegin', shell); shell.appendChild(media);
    media.classList.add('app-media-source');
    var controls = node('div', 'app-media-controls');
    var row = node('div', 'app-media-main');
    var play = node('button', 'app-media-play'); play.type = 'button';
    var timeline = node('div', 'app-media-timeline');
    var time = node('span', 'app-media-time');
    var track = node('div', 'app-media-track');
    var fill = node('progress', 'app-media-progress'); fill.max = 100; fill.value = 0; fill.setAttribute('aria-hidden', 'true');
    var seek = node('input', 'app-media-seek'); seek.type = 'range'; seek.min = '0'; seek.max = '100'; seek.step = '0.1'; seek.value = '0'; seek.setAttribute('aria-label', 'Playback position');
    track.append(fill, seek); timeline.append(time, track);
    var speed = node('select'); speed.id = 'app-media-speed-' + (++serial); speed.setAttribute('aria-label', 'Playback speed');
    [0.5, 0.75, 1, 1.25, 1.5, 2].forEach(function (value) { var option = node('option', '', value + '×'); option.value = String(value); speed.appendChild(option); }); speed.value = String(media.playbackRate || 1);
    var speedWrap = node('div', 'app-media-speed'); speedWrap.appendChild(speed);
    row.append(play, timeline, speedWrap);
    var bottom = node('div', 'app-media-bottom');
    var mute = node('button', 'app-media-mute'); mute.type = 'button';
    var volume = node('input', 'app-media-volume'); volume.type = 'range'; volume.min = '0'; volume.max = '1'; volume.step = '0.05'; volume.value = String(media.volume); volume.setAttribute('aria-label', 'Volume');
    var status = node('span', 'app-media-status'); status.setAttribute('role', 'status');
    bottom.append(mute, volume, status);
    var fullscreen = null;
    if (video && typeof shell.requestFullscreen === 'function') { fullscreen = node('button', 'app-media-fullscreen'); fullscreen.type = 'button'; icon(fullscreen, 'fullscreen', 'Enter fullscreen'); bottom.appendChild(fullscreen); }
    controls.append(row, bottom); shell.appendChild(controls);
    var busy = false, failure = '';
    function hasSource() { return !!(media.getAttribute('src') || media.querySelector('source[src]') || media.srcObject); }
    function sync() {
      var duration = Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0;
      var available = hasSource();
      shell.hidden = media.hidden;
      icon(play, media.paused ? 'play' : 'pause', media.paused ? 'Play' : 'Pause');
      play.disabled = !available;
      seek.disabled = !available || !duration;
      var current = Number.isFinite(media.currentTime) ? media.currentTime : 0;
      seek.max = String(duration || 100); seek.value = String(current);
      seek.setAttribute('aria-valuetext', clock(current) + ' of ' + clock(duration));
      fill.value = duration ? current / duration * 100 : 0;
      time.textContent = clock(current) + ' / ' + (duration ? clock(duration) : '—');
      icon(mute, media.muted || media.volume === 0 ? 'muted' : 'volume', media.muted ? 'Unmute' : 'Mute');
      mute.setAttribute('aria-pressed', String(media.muted)); volume.value = String(media.muted ? 0 : media.volume);
      speed.value = String(media.playbackRate);
      if (speed._appSelectInstance) speed._appSelectInstance.sync();
      var message = failure || (!available ? 'No audio or video available' : busy ? 'Loading media…' : '');
      if (status.textContent !== message) status.textContent = message;
      shell.classList.toggle('has-error', !!failure); shell.setAttribute('aria-busy', String(busy));
    }
    play.addEventListener('click', function () {
      if (!media.paused) { media.pause(); return; }
      failure = ''; busy = true; sync();
      try { Promise.resolve(media.play()).then(function () { busy = false; sync(); }).catch(function () { busy = false; failure = 'Could not play. Try again or download the file.'; sync(); }); }
      catch (_) { busy = false; failure = 'Could not play this file.'; sync(); }
    });
    seek.addEventListener('input', function () { if (!seek.disabled) { media.currentTime = Number(seek.value); sync(); } });
    volume.addEventListener('input', function () { media.volume = Number(volume.value); media.muted = media.volume === 0; sync(); });
    mute.addEventListener('click', function () { media.muted = !media.muted; if (!media.muted && media.volume === 0) media.volume = 1; sync(); });
    speed.addEventListener('change', function () { media.playbackRate = Number(speed.value); sync(); });
    if (fullscreen) fullscreen.addEventListener('click', function () {
      var action = document.fullscreenElement === shell ? document.exitFullscreen() : shell.requestFullscreen();
      Promise.resolve(action).catch(function () { failure = 'Fullscreen is unavailable in this browser.'; sync(); });
    });
    if (fullscreen) document.addEventListener('fullscreenchange', function () { icon(fullscreen, 'fullscreen', document.fullscreenElement === shell ? 'Exit fullscreen' : 'Enter fullscreen'); });
    ['timeupdate', 'durationchange', 'play', 'pause', 'ended', 'volumechange', 'ratechange'].forEach(function (name) { media.addEventListener(name, sync); });
    media.addEventListener('loadedmetadata', function () { if (media.paused && !media.seeking) busy = false; sync(); });
    ['waiting', 'loadstart'].forEach(function (name) { media.addEventListener(name, function () { busy = true; failure = ''; sync(); }); });
    ['playing', 'canplay', 'loadeddata'].forEach(function (name) { media.addEventListener(name, function () { busy = false; failure = ''; sync(); }); });
    media.addEventListener('error', function () { busy = false; failure = 'This media is unavailable. Try downloading the original.'; sync(); });
    media.addEventListener('emptied', function () { busy = false; failure = ''; sync(); });
    media._appMediaPlayer = { sync: sync, shell: shell };
    media.controls = false;
    if (global.LectureProcessorUx) global.LectureProcessorUx.enhanceNativeSelect(speed);
    sync();
  }
  function scan(root) {
    if (root.matches && root.matches('audio[controls],video[controls]')) enhance(root);
    if (root.querySelectorAll) root.querySelectorAll('audio[controls],video[controls]').forEach(enhance);
  }
  function init() {
    scan(document);
    new MutationObserver(function (changes) {
      changes.forEach(function (change) {
        var media = change.target.closest && change.target.closest('audio,video');
        if (media && media._appMediaPlayer) media._appMediaPlayer.sync();
        (change.addedNodes || []).forEach(function (item) { if (item.nodeType === 1) scan(item); });
        if (change.type === 'attributes' && change.attributeName === 'controls') scan(change.target);
      });
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'src', 'controls'] });
  }
  global.LectureProcessorMedia = { enhance: enhance };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(window);
