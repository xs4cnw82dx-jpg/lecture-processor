(function () {
  'use strict';
  var cache = new Map(), generation = 0, viewer = null;
  var fetchImage = null;
  function urlFor(packId, id) {
    return '/api/study-packs/' + encodeURIComponent(packId) + '/images/' + encodeURIComponent(id);
  }
  function load(packId, id) {
    var key = packId + '/' + id;
    if (cache.has(key)) return cache.get(key);
    var started = generation;
    var pending = fetchImage(urlFor(packId, id)).then(function (response) {
      if (!response.ok) throw new Error('Picture unavailable. Try again later.');
      return response.blob();
    }).then(function (blob) {
      if (started !== generation) throw new Error('Signed out.');
      var url = URL.createObjectURL(blob);
      cache.set(key, Promise.resolve(url));
      return url;
    }).catch(function (error) { cache.delete(key); throw error; });
    cache.set(key, pending);
    return pending;
  }
  function openViewer(url, label) {
    if (!viewer) {
      viewer = document.createElement('dialog');
      viewer.className = 'study-picture-viewer';
      viewer.setAttribute('aria-label', 'Picture viewer');
      var close = document.createElement('button');
      close.type = 'button'; close.className = 'btn'; close.textContent = 'Close picture';
      close.addEventListener('click', function () { viewer.close(); });
      var image = document.createElement('img');
      viewer.append(close, image);
      document.body.appendChild(viewer);
    }
    viewer.querySelector('img').src = url;
    viewer.querySelector('img').alt = label;
    viewer.showModal();
  }
  function pictures(container, card, packId, remove) {
    var ids = Array.isArray(card.image_ids) ? card.image_ids.slice(0, 8) : [];
    if (!ids.length) return;
    var gallery = document.createElement('div'); gallery.className = 'study-picture-gallery';
    ids.forEach(function (id) {
      if (!/^[a-f0-9]{64}$/.test(id)) return;
      var figure = document.createElement('div'); figure.className = 'study-picture-item';
      var button = document.createElement('button'); button.type = 'button'; button.className = 'study-picture-open';
      var label = 'Picture for ' + (card.front || 'this flashcard');
      button.setAttribute('aria-label', 'Enlarge ' + label);
      var image = document.createElement('img'); image.alt = label;
      button.appendChild(image); figure.appendChild(button);
      var status = document.createElement('span'); status.className = 'study-picture-status'; status.textContent = 'Loading picture…';
      figure.appendChild(status);
      function fetchVisible() {
        load(packId, id).then(function (url) {
          if (!figure.isConnected) return;
          image.src = url; status.remove();
          button.addEventListener('click', function (event) { event.stopPropagation(); openViewer(url, label); });
        }).catch(function () { status.textContent = 'Picture unavailable'; });
      }
      if (typeof IntersectionObserver === 'function') {
        var observer = new IntersectionObserver(function (entries) {
          if (!figure.isConnected) { observer.disconnect(); return; }
          if (entries.some(function (entry) { return entry.isIntersecting; })) { observer.disconnect(); fetchVisible(); }
        });
        observer.observe(figure);
      } else { fetchVisible(); }
      if (remove) {
        var unlink = document.createElement('button'); unlink.type = 'button'; unlink.className = 'btn u-btn-compact';
        unlink.textContent = 'Remove picture';
        unlink.addEventListener('click', function () { remove(id); }); figure.appendChild(unlink);
      }
      gallery.appendChild(figure);
    });
    container.appendChild(gallery);
  }
  function editor(container, card, pack, save, rerender) {
    if (!pack || !pack.pictures_enabled) return;
    var panel = document.createElement('div'); panel.className = 'study-picture-editor';
    var heading = document.createElement('span'); heading.textContent = 'Pictures'; heading.className = 'study-picture-heading';
    panel.appendChild(heading);
    pictures(panel, card, pack.study_pack_id, function (id) {
      card.image_ids = (card.image_ids || []).filter(function (item) { return item !== id; }); save(); rerender();
    });
    var add = document.createElement('button'); add.type = 'button'; add.className = 'btn u-btn-compact'; add.textContent = 'Add picture';
    add.disabled = (card.image_ids || []).length >= 8;
    var input = document.createElement('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp'; input.hidden = true;
    var status = document.createElement('span'); status.className = 'study-picture-status'; status.setAttribute('role', 'status');
    add.addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () {
      var file = input.files && input.files[0]; if (!file) return;
      if (file.size > 10 * 1024 * 1024) { status.textContent = 'Choose a picture smaller than 10 MB.'; return; }
      var started = generation;
      var body = new FormData(); body.append('image', file);
      add.disabled = true; status.textContent = 'Saving picture…';
      fetchImage('/api/study-packs/' + encodeURIComponent(pack.study_pack_id) + '/images', { method: 'POST', body: body }).then(function (response) {
        return response.json().then(function (data) { if (!response.ok) throw new Error(data.error || 'Could not save picture.'); return data; });
      }).then(function (data) {
        if (started !== generation || !panel.isConnected) return;
        card.image_ids = Array.from(new Set((card.image_ids || []).concat(data.image.id)));
        save(); rerender();
      }).catch(function (error) { status.textContent = error.message; }).finally(function () { add.disabled = false; input.value = ''; });
    });
    panel.append(add, input, status); container.appendChild(panel);
  }
  function clear() {
    generation += 1;
    cache.forEach(function (promise) { promise.then(function (url) { URL.revokeObjectURL(url); }).catch(function () {}); });
    cache.clear();
    if (viewer) { viewer.remove(); viewer = null; }
  }
  window.StudyPictures = { configure: function (fetcher) { fetchImage = fetcher; }, pictures: pictures, editor: editor, clear: clear };
})();
