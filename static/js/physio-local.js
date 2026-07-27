(function () {
  'use strict';

  var root = typeof document === 'undefined' ? null : document.querySelector('.clinical-app');
  var apiBase = String((root && root.dataset.apiBase) || '/api/local/physio').replace(/\/$/, '');
  var state = {
    csrf: '', region: 'schouder', type: '', query: '', currentNote: null,
    activeCaseId: '', cases: [], regions: [], jobId: '', searchController: null,
    sources: [], sourceCategories: [], currentSourceId: '', pendingSourceFiles: [],
    sourceViewMode: 'all', sourceRegion: ''
  };
  var $ = function (selector, scope) { return (scope || document).querySelector(selector); };
  var $$ = function (selector, scope) { return Array.from((scope || document).querySelectorAll(selector)); };
  var labels = {
    condition: 'Aandoening', test: 'Test', structure: 'Anatomie', intervention: 'Interventie',
    measure: 'Meetinstrument', source: 'Bron', region: 'Regioportaal', 'clinical-pathway': 'Workflow'
  };
  var icons = { condition: 'A', test: 'T', structure: '⌁', intervention: 'I', measure: 'M', source: 'B', region: 'R', 'clinical-pathway': 'W' };

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>'"]/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char];
    });
  }

  function slugLabel(value) {
    return String(value || '').replace(/[-_]/g, ' ').replace(/\b\w/g, function (letter) { return letter.toUpperCase(); });
  }

  var sourceCategoryLabels = {
    guidelines: 'Richtlijnen', 'semester-summaries': 'Semestersamenvattingen', anatomy: 'Anatomie',
    craft: 'Craft-notities', lectures: 'Colleges', books: 'Boeken', other: 'Overig'
  };
  var portalSectionTerms = {
    screening: ['snelle screening', 'screening', 'rode vlaggen'],
    anamnese: ['anamnese'],
    onderzoek: ['lichamelijk onderzoek', 'onderzoek'],
    differentiaal: ['differentiële diagnostiek', 'differentiele diagnostiek', 'differentiaal'],
    behandeling: ['behandeling', 'beleid', 'interventie'],
    herbeoordeling: ['progressie en herbeoordeling', 'herbeoordeling', 'progressie']
  };

  function closePrettySelects(except) {
    $$('.pretty-select.is-open').forEach(function (wrapper) {
      if (wrapper === except) return;
      wrapper.classList.remove('is-open');
      var trigger = $('.pretty-select-trigger', wrapper);
      if (trigger) trigger.setAttribute('aria-expanded', 'false');
    });
  }

  function refreshPrettySelect(select) {
    if (!select) return;
    var wrapper = select.closest('.pretty-select');
    if (!wrapper) return;
    var trigger = $('.pretty-select-trigger', wrapper);
    var menu = $('.pretty-select-menu', wrapper);
    var selected = select.options[select.selectedIndex] || select.options[0];
    trigger.innerHTML = '<span>' + escapeHtml(selected ? selected.textContent : '') + '</span><i aria-hidden="true"></i>';
    menu.innerHTML = Array.from(select.options).map(function (option) {
      var active = option.value === select.value;
      return '<button type="button" class="pretty-select-option' + (active ? ' is-selected' : '') + '" role="option" aria-selected="' + active + '" data-value="' + escapeHtml(option.value) + '"><span>' + escapeHtml(option.textContent) + '</span>' + (active ? '<b aria-hidden="true">✓</b>' : '') + '</button>';
    }).join('');
    $$('.pretty-select-option', menu).forEach(function (optionButton) {
      optionButton.addEventListener('click', function (event) {
        event.stopPropagation();
        select.value = optionButton.dataset.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        wrapper.classList.remove('is-open');
        trigger.setAttribute('aria-expanded', 'false');
        refreshPrettySelect(select);
      });
    });
  }

  function enhanceSelect(select) {
    if (!select || select.closest('.pretty-select')) { refreshPrettySelect(select); return; }
    var wrapper = document.createElement('div');
    wrapper.className = 'pretty-select';
    select.parentNode.insertBefore(wrapper, select);
    wrapper.appendChild(select);
    select.classList.add('pretty-select-native');
    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'pretty-select-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    var menu = document.createElement('div');
    menu.className = 'pretty-select-menu';
    menu.setAttribute('role', 'listbox');
    wrapper.appendChild(trigger);
    wrapper.appendChild(menu);
    trigger.addEventListener('click', function (event) {
      event.stopPropagation();
      var opening = !wrapper.classList.contains('is-open');
      closePrettySelects(wrapper);
      wrapper.classList.toggle('is-open', opening);
      trigger.setAttribute('aria-expanded', String(opening));
    });
    select.addEventListener('change', function () { refreshPrettySelect(select); });
    refreshPrettySelect(select);
  }

  function enhanceSelects(scope) {
    $$('select', scope || document).forEach(enhanceSelect);
  }

  function openContextPanel() {
    $('#clinical-context').classList.add('is-open');
    $('#context-backdrop').classList.add('is-open');
  }

  function closeContextPanel() {
    $('#clinical-context').classList.remove('is-open');
    $('#context-backdrop').classList.remove('is-open');
  }

  function toast(message, isError) {
    var node = $('#clinical-toast');
    node.textContent = message;
    node.classList.toggle('is-error', Boolean(isError));
    node.classList.add('is-visible');
    window.clearTimeout(toast.timer);
    toast.timer = window.setTimeout(function () { node.classList.remove('is-visible'); }, 3200);
  }

  async function ensureCsrf() {
    if (state.csrf) return state.csrf;
    var response = await fetch(apiBase + '/csrf', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('CSRF-token kon niet worden geladen.');
    var payload = await response.json();
    state.csrf = payload.csrf_token || '';
    return state.csrf;
  }

  async function establishOwnerSessionFromFragment() {
    var fragment = new URLSearchParams(String(window.location.hash || '').replace(/^#/, ''));
    var ownerToken = String(fragment.get('owner_token') || '');
    if (!ownerToken) return;
    var response = await fetch('/owner-session', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ owner_token: ownerToken })
    });
    window.history.replaceState({}, '', window.location.pathname + window.location.search);
    if (!response.ok) throw new Error('Eigenaar-autorisatie voor de lokale companion is mislukt.');
  }

  async function api(path, options) {
    options = Object.assign({ credentials: 'same-origin', cache: 'no-store' }, options || {});
    var method = String(options.method || 'GET').toUpperCase();
    options.headers = Object.assign({ Accept: 'application/json' }, options.headers || {});
    if (['POST', 'PATCH', 'PUT', 'DELETE'].indexOf(method) !== -1) {
      options.headers['X-CSRF-Token'] = await ensureCsrf();
    }
    if (options.body && !(options.body instanceof FormData) && typeof options.body !== 'string') {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
    var response = await fetch(apiBase + path, options);
    var contentType = response.headers.get('content-type') || '';
    var payload = contentType.indexOf('json') !== -1 ? await response.json() : await response.text();
    if (!response.ok) {
      var message = payload && typeof payload === 'object' ? (payload.error || payload.message) : payload;
      if (message && typeof message === 'object') message = message.message || message.code;
      throw new Error(message || ('Verzoek mislukt (' + response.status + ').'));
    }
    return payload;
  }

  function setConnection(online, detail) {
    var node = $('#clinical-connection');
    node.classList.toggle('is-online', online);
    node.classList.toggle('is-offline', !online);
    $('strong', node).textContent = online ? 'Lokaal actief' : 'Niet verbonden';
    $('small', node).textContent = detail || (online ? 'privé op 127.0.0.1' : 'start companion');
  }

  async function bootstrap() {
    try {
      var data = await api('/health');
      var indexed = data.index && data.index.notes;
      setConnection(true, indexed != null ? indexed + ' notities' : 'privé op 127.0.0.1');
      await Promise.all([loadRegions(), loadCases()]);
      await search();
    } catch (error) {
      setConnection(false, 'companion onbereikbaar');
      $('#search-results').innerHTML = '<div class="empty-state"><strong>Lokale companion niet bereikbaar</strong><br>Start <code>scripts/run_physio_companion.py</code> en vernieuw de pagina.</div>';
    }
  }

  async function loadRegions() {
    var data = await api('/regions');
    var regions = Array.isArray(data.regions) ? data.regions : [];
    if (!regions.length) return;
    state.regions = regions;
    $('#region-list').innerHTML = regions.map(function (region) {
      var slug = region.slug || region.name;
      return '<button data-region="' + escapeHtml(slug) + '" class="' + (slug === state.region ? 'is-active' : '') + '"><span>' + escapeHtml(region.name || slugLabel(slug)) + '</span><small>' + escapeHtml(region.count || '') + '</small></button>';
    }).join('');
    bindRegionButtons();
    renderSourceRegionFilter();
  }

  function setRegion(region) {
    closeContextPanel();
    state.region = region || '';
    $$('#region-list [data-region]').forEach(function (button) { button.classList.toggle('is-active', button.dataset.region === state.region); });
    $$('.body-hotspots [data-region]').forEach(function (spot) { spot.classList.toggle('is-active', spot.dataset.region === state.region); });
    var name = slugLabel(state.region || 'Alle regio’s');
    $('#body-map-label').textContent = name + ' geselecteerd';
    $('#portal-hero h1').textContent = name;
    $('#portal-hero p').textContent = 'Snel van presentatie naar screening, onderzoek, klinische afweging en plan voor ' + name.toLowerCase() + '.';
    search();
  }

  function bindRegionButtons() {
    $$('#region-list [data-region]').forEach(function (button) {
      button.addEventListener('click', function () { setRegion(button.dataset.region); });
    });
  }

  function resultCard(result) {
    var type = result.type || 'note';
    var reviewed = Boolean(result.reviewed || result.curation_status === 'reviewed');
    return '<button class="result-card" data-note-id="' + escapeHtml(result.note_id) + '" data-note-anchor="' + escapeHtml(result.anchor || '') + '" data-type="' + escapeHtml(type) + '">' +
      '<span class="result-icon">' + escapeHtml(icons[type] || 'K') + '</span><span>' +
      '<h3>' + escapeHtml(result.title || result.heading || result.note_id) + '</h3>' +
      '<p>' + escapeHtml(result.snippet || result.heading || '') + '</p>' +
      '<span class="result-meta"><span>' + escapeHtml(labels[type] || slugLabel(type)) + '</span>' +
      '<span class="' + (reviewed ? 'is-reviewed' : '') + '">' + (reviewed ? 'Gereviewd' : 'Reviewwachtrij') + '</span>' +
      (result.heading ? '<span>' + escapeHtml(result.heading) + '</span>' : '') + '</span></span><span class="result-arrow">›</span></button>';
  }

  async function search(queryOverride) {
    if (typeof queryOverride === 'string') {
      state.query = queryOverride;
      $('#clinical-search-input').value = queryOverride;
    } else {
      state.query = $('#clinical-search-input').value.trim();
    }
    if (state.searchController) state.searchController.abort();
    state.searchController = new AbortController();
    var params = new URLSearchParams({ q: state.query || state.region, region: state.region, type: state.type, limit: '100' });
    if ($('#include-unreviewed').checked) params.set('include_unreviewed', '1');
    $('#search-results').innerHTML = '<div class="loading-row">Lokale index doorzoeken…</div>';
    $('#result-title').textContent = state.query ? 'Zoekresultaten' : 'Klinische startpunten';
    try {
      var data = await api('/search?' + params.toString(), { signal: state.searchController.signal });
      var results = Array.isArray(data.results) ? data.results : [];
      var seenNotes = new Set();
      results = results.filter(function (result) {
        if (seenNotes.has(result.note_id)) return false;
        seenNotes.add(result.note_id);
        return true;
      });
      $('#result-count').textContent = results.length + (results.length === 1 ? ' resultaat' : ' resultaten');
      $('#search-results').innerHTML = results.length ? results.map(resultCard).join('') : '<div class="empty-state">Niet gevonden in de geselecteerde bronnen.</div>';
      $$('#search-results [data-note-id]').forEach(function (button) {
        button.addEventListener('click', function () { openNote(button.dataset.noteId, button.dataset.noteAnchor, '', state.query); });
      });
    } catch (error) {
      if (error.name !== 'AbortError') $('#search-results').innerHTML = '<div class="empty-state">' + escapeHtml(error.message) + '</div>';
    }
  }

  function tableCells(line) {
    var clean = String(line || '').trim().replace(/^\|/, '').replace(/\|$/, '');
    return clean.split('|').map(function (cell) { return cell.trim(); });
  }

  function isTableDivider(line) {
    var cells = tableCells(line);
    return cells.length > 0 && cells.every(function (cell) { return /^:?-{3,}:?$/.test(cell); });
  }

  function markdownToHtml(markdown, inlineAssets) {
    var lines = String(markdown || '').split(/\r?\n/);
    var html = [];
    var inList = false;
    function closeList() { if (inList) { html.push('</ul>'); inList = false; } }
    for (var index = 0; index < lines.length; index += 1) {
      var rawLine = lines[index];
      if (rawLine.indexOf('|') !== -1 && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
        closeList();
        var headings = tableCells(rawLine);
        var alignments = tableCells(lines[index + 1]).map(function (cell) {
          return cell.startsWith(':') && cell.endsWith(':') ? 'center' : (cell.endsWith(':') ? 'right' : 'left');
        });
        html.push('<div class="reader-table-wrap"><table><thead><tr>' + headings.map(function (cell, cellIndex) {
          return '<th style="text-align:' + alignments[cellIndex] + '">' + inlineMarkup(escapeHtml(cell), inlineAssets) + '</th>';
        }).join('') + '</tr></thead><tbody>');
        index += 2;
        while (index < lines.length && lines[index].trim() && lines[index].indexOf('|') !== -1) {
          html.push('<tr>' + tableCells(lines[index]).map(function (cell, cellIndex) {
            return '<td style="text-align:' + (alignments[cellIndex] || 'left') + '">' + inlineMarkup(escapeHtml(cell), inlineAssets) + '</td>';
          }).join('') + '</tr>');
          index += 1;
        }
        html.push('</tbody></table></div>');
        index -= 1;
        continue;
      }
      var line = escapeHtml(rawLine);
      var heading = line.match(/^(#{1,4})\s+(.+)$/);
      var item = line.match(/^\s*[-*]\s+(.+)$/);
      if (item) {
        if (!inList) { html.push('<ul>'); inList = true; }
        html.push('<li>' + inlineMarkup(item[1], inlineAssets) + '</li>');
        continue;
      }
      closeList();
      if (heading) html.push('<h' + heading[1].length + ' id="note-heading-' + escapeHtml(headingAnchor(heading[2])) + '">' + inlineMarkup(heading[2], inlineAssets) + '</h' + heading[1].length + '>');
      else if (line.trim()) html.push('<p>' + inlineMarkup(line, inlineAssets) + '</p>');
    }
    closeList();
    return html.join('');
  }

  function headingAnchor(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[*_`~]/g, '').replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s-]+/g, '-') || 'sectie';
  }

  function inlineMarkup(value, inlineAssets) {
    return value
      .replace(/!\[([^\]]*)\]\(((?:[^()]|\([^)]*\))+)\)/g, function (_match, alt, target) {
        var assetId = inlineAssets && (inlineAssets[target] || inlineAssets[target.replace(/&amp;/g, '&')]);
        if (!assetId) return '<span class="missing-inline-image">Afbeelding niet gekoppeld: ' + alt + '</span>';
        var url = apiBase + '/sources-manager/' + encodeURIComponent(assetId) + '/preview';
        return '<img class="reader-inline-image" src="' + escapeHtml(url) + '" alt="' + alt + '" loading="lazy">';
      })
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, function (_match, target, alias) { return '<span class="wiki-link">' + (alias || target) + '</span>'; })
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  function arrayValue(value) { return Array.isArray(value) ? value : (value ? [value] : []); }

  function noteReader(note) {
    var properties = note.properties || {};
    var reviewed = Boolean(note.reviewed || properties.curation_status === 'reviewed');
    var path = note.path || '';
    var vault = 'Physio Knowledge Vault';
    var obsidian = note.obsidian_uri || ('obsidian://open?vault=' + encodeURIComponent(vault) + '&file=' + encodeURIComponent(path.replace(/\.md$/, '')));
    var primaryLink = note.source_uri
      ? '<a href="' + escapeHtml(note.source_uri) + '" target="_blank" rel="noreferrer">Open bronbestand</a>'
      : '<a href="' + escapeHtml(obsidian) + '">Open in Obsidian</a>';
    var related = arrayValue(note.backlinks).concat(arrayValue(note.links)).slice(0, 12);
    var relationButtons = related.map(function (link) {
      var id = typeof link === 'object' ? (link.note_id || link.id || link.target) : link;
      var title = typeof link === 'object' ? (link.title || link.label || id) : link;
      return '<button data-related-id="' + escapeHtml(id || '') + '">' + escapeHtml(title || '') + '</button>';
    }).join('');
    var embeds = arrayValue(note.embeds).map(function (embed) {
      var id = typeof embed === 'object' ? (embed.manifest_id || embed.media_id || embed.id) : embed;
      var label = typeof embed === 'object' ? (embed.label || embed.title || 'Open bron') : 'Open bron';
      var page = typeof embed === 'object' ? (embed.page || '') : '';
      return id ? '<button data-media-id="' + escapeHtml(id) + '" data-media-page="' + escapeHtml(page) + '">' + escapeHtml(label) + (page ? ' · p. ' + escapeHtml(page) : '') + '</button>' : '';
    }).join('');
    return '<div class="reader-head"><div class="reader-head-top"><span class="review-chip ' + (reviewed ? 'is-reviewed' : '') + '">' + (reviewed ? 'Gereviewd' : 'Reviewwachtrij') + '</span><div class="reader-actions">' +
      '<button data-action="pin">+ Pin</button>' + primaryLink + '</div></div>' +
      '<h2>' + escapeHtml(note.title || properties.title || note.note_id) + '</h2><span class="eyebrow">' + escapeHtml(labels[properties.type || note.type] || properties.type || note.type || 'Notitie') + '</span></div>' +
      '<div class="reader-body">' + markdownToHtml(note.body || note.content || '', note.inline_assets || {}) + '</div>' +
      ((embeds || relationButtons) ? '<div class="reader-related"><strong>Bronnen en verbanden</strong>' + embeds + relationButtons + '</div>' : '');
  }

  function highlightTerms(query) {
    var stop = new Set(['aan', 'als', 'bij', 'dat', 'de', 'die', 'dit', 'een', 'en', 'het', 'hoe', 'in', 'is', 'met', 'na', 'of', 'om', 'op', 'te', 'van', 'voor', 'wat']);
    return Array.from(new Set(String(query || '').match(/[^\W_]+/gu) || []))
      .filter(function (term) { return term.length > 2 && !stop.has(term.toLowerCase()); })
      .sort(function (left, right) { return right.length - left.length; }).slice(0, 12);
  }

  function applySearchHighlights(query) {
    var body = $('#note-reader .reader-body');
    var terms = highlightTerms(query);
    if (!body || !terms.length) return null;
    var expression = new RegExp('(' + terms.map(function (term) { return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|') + ')', 'giu');
    var walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    var nodes = [];
    while (walker.nextNode()) {
      var parent = walker.currentNode.parentElement;
      if (parent && !parent.closest('mark, code, button, a') && expression.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
      expression.lastIndex = 0;
    }
    nodes.forEach(function (node) {
      var fragment = document.createDocumentFragment();
      var offset = 0;
      String(node.nodeValue).replace(expression, function (match, _group, matchOffset) {
        fragment.appendChild(document.createTextNode(node.nodeValue.slice(offset, matchOffset)));
        var mark = document.createElement('mark');
        mark.className = 'search-highlight';
        mark.textContent = match;
        fragment.appendChild(mark);
        offset = matchOffset + match.length;
        return match;
      });
      fragment.appendChild(document.createTextNode(node.nodeValue.slice(offset)));
      node.replaceWith(fragment);
      expression.lastIndex = 0;
    });
    var marks = $$('.search-highlight', body);
    if (!marks.length) return null;
    var activeIndex = 0;
    var nav = document.createElement('div');
    nav.className = 'reader-match-nav';
    nav.innerHTML = '<strong>' + marks.length + ' ' + (marks.length === 1 ? 'treffer' : 'treffers') + '</strong><button type="button" data-match-prev aria-label="Vorige treffer">↑</button><button type="button" data-match-next aria-label="Volgende treffer">↓</button>';
    $('#note-reader .reader-head').appendChild(nav);
    function show(index) {
      marks[activeIndex].classList.remove('is-current');
      activeIndex = (index + marks.length) % marks.length;
      marks[activeIndex].classList.add('is-current');
      marks[activeIndex].scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    marks[0].classList.add('is-current');
    $('[data-match-prev]', nav).addEventListener('click', function () { show(activeIndex - 1); });
    $('[data-match-next]', nav).addEventListener('click', function () { show(activeIndex + 1); });
    return marks[0];
  }

  async function openNote(noteId, anchor, sectionKey, highlightQuery) {
    if (!noteId) return;
    try {
      var note = await api('/notes/' + encodeURIComponent(noteId));
      state.currentNote = note.note || note;
      $('#note-reader').innerHTML = noteReader(state.currentNote);
      openContextPanel();
      var pin = $('#note-reader [data-action="pin"]');
      if (pin) pin.addEventListener('click', pinCurrentNote);
      $$('#note-reader [data-related-id]').forEach(function (button) { button.addEventListener('click', function () { openNote(button.dataset.relatedId); }); });
      $$('#note-reader [data-media-id]').forEach(function (button) { button.addEventListener('click', function () { openMedia(button.dataset.mediaId, button.dataset.mediaPage); }); });
      if (anchor || sectionKey || highlightQuery) {
        window.requestAnimationFrame(function () {
          var target = anchor ? document.getElementById('note-heading-' + String(anchor).replace(/^#/, '')) : null;
          if (!target && sectionKey) {
            var terms = portalSectionTerms[sectionKey] || [sectionKey];
            target = $$('#note-reader .reader-body h1, #note-reader .reader-body h2, #note-reader .reader-body h3').find(function (heading) {
              var text = heading.textContent.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
              return terms.some(function (term) {
                var normalizedTerm = term.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
                return text.indexOf(normalizedTerm) !== -1 || normalizedTerm.indexOf(text) !== -1;
              });
            });
          }
          var firstMatch = applySearchHighlights(highlightQuery);
          if (firstMatch) target = firstMatch;
          if (target) target.scrollIntoView({ block: 'start' });
        });
      }
      loadGraph(state.currentNote.note_id || noteId);
    } catch (error) { toast(error.message, true); }
  }

  async function openPortalNote(sectionKey) {
    try {
      var data = await api('/search?' + new URLSearchParams({ q: state.region, region: state.region, type: 'region', limit: '1' }));
      if (data.results && data.results[0]) await openNote(data.results[0].note_id, '', sectionKey);
      else toast('Het regioportaal kon niet in de lokale index worden gevonden.', true);
    } catch (error) { toast(error.message, true); }
  }

  async function openMedia(id, page) {
    var viewer = $('#media-viewer');
    var url = apiBase + '/media/' + encodeURIComponent(id);
    var fragment = page ? '#page=' + encodeURIComponent(page) + '&zoom=page-width' : '#view=FitH';
    viewer.innerHTML = '<iframe title="Lokale anatomie- of PDF-bron" src="' + escapeHtml(url + fragment) + '"></iframe>';
    $('#media-dialog').showModal();
  }

  async function loadGraph(noteId) {
    try {
      var data = await api('/graph?' + new URLSearchParams({ note_id: noteId, global: '0' }));
      renderGraph(data.nodes || [], data.edges || []);
    } catch (_error) { renderGraph([], []); }
  }

  async function loadGlobalGraph() {
    try {
      var data = await api('/graph?global=1');
      renderGraph(data.nodes || [], data.edges || []);
      toast('Volledige gereviewde kennisgraaf geladen.');
    } catch (error) { toast(error.message, true); }
  }

  function renderGraph(nodes, edges) {
    var svg = $('#clinical-graph');
    if (!nodes.length) { svg.innerHTML = ''; $('#graph-empty').hidden = false; return; }
    $('#graph-empty').hidden = true;
    var width = 900, height = 560, cx = width / 2, cy = height / 2;
    var positions = {};
    var currentId = state.currentNote && (state.currentNote.note_id || state.currentNote.id);
    var rootId = nodes.some(function (node) { return node.id === currentId; }) ? currentId : nodes[0].id;
    var neighborIndex = 0;
    nodes.forEach(function (node, index) {
      var rootNode = node.id === rootId;
      var angle = (neighborIndex / Math.max(1, nodes.length - 1)) * Math.PI * 2;
      if (!rootNode) neighborIndex += 1;
      positions[node.id] = rootNode ? { x: cx, y: cy } : { x: cx + Math.cos(angle) * 265, y: cy + Math.sin(angle) * 205 };
    });
    var html = edges.map(function (edge) {
      var a = positions[edge.source], b = positions[edge.target];
      return a && b ? '<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '"></line>' : '';
    }).join('');
    html += nodes.map(function (node, index) {
      var p = positions[node.id];
      var title = node.title || node.label || node.id;
      var isRoot = node.id === rootId;
      return '<g data-graph-id="' + escapeHtml(node.id) + '"><circle class="' + (isRoot ? 'root' : '') + '" cx="' + p.x + '" cy="' + p.y + '" r="' + (isRoot ? 27 : 20) + '"></circle><text x="' + p.x + '" y="' + (p.y + 39) + '">' + escapeHtml(title.length > 28 ? title.slice(0, 27) + '…' : title) + '</text></g>';
    }).join('');
    svg.innerHTML = html;
    $$('[data-graph-id]', svg).forEach(function (node) { node.addEventListener('click', function () { openNote(node.dataset.graphId); }); });
  }

  async function loadCases() {
    try {
      var data = await api('/cases');
      state.cases = Array.isArray(data.cases) ? data.cases : [];
      renderCases();
    } catch (error) { toast(error.message, true); }
  }

  function caseId(item) { return item.id || item.case_id; }
  function caseLabel(item) { return item.title || item.label || item.display_label || item.case_label || caseId(item); }

  function renderCases() {
    var select = $('#active-case-select');
    select.innerHTML = '<option value="">Geen casus geselecteerd</option>' + state.cases.map(function (item) { return '<option value="' + escapeHtml(caseId(item)) + '">' + escapeHtml(caseLabel(item)) + '</option>'; }).join('');
    select.value = state.activeCaseId;
    var deepSelect = $('#deep-case-select');
    if (deepSelect) {
      var deepValue = deepSelect.value;
      deepSelect.innerHTML = '<option value="">Geen casus geselecteerd</option>' + state.cases.map(function (item) { return '<option value="' + escapeHtml(caseId(item)) + '">' + escapeHtml(caseLabel(item)) + '</option>'; }).join('');
      deepSelect.value = state.cases.some(function (item) { return caseId(item) === deepValue; }) ? deepValue : '';
    }
    refreshPrettySelect(select);
    refreshPrettySelect(deepSelect);
    $('#case-list').innerHTML = state.cases.length ? state.cases.map(function (item) {
      var id = caseId(item);
      return '<button data-case-id="' + escapeHtml(id) + '" class="' + (id === state.activeCaseId ? 'is-active' : '') + '"><strong>' + escapeHtml(caseLabel(item)) + '</strong><small>' + escapeHtml(slugLabel(item.region || 'algemeen')) + '</small></button>';
    }).join('') : '<div class="empty-state">Nog geen casussen.</div>';
    $$('#case-list [data-case-id]').forEach(function (button) { button.addEventListener('click', function () { selectCase(button.dataset.caseId); }); });
    renderActiveCase();
  }

  function activeCase() { return state.cases.find(function (item) { return caseId(item) === state.activeCaseId; }) || null; }

  function selectCase(id) {
    state.activeCaseId = id || '';
    renderCases();
    if ($('[data-view-panel="cases"]').classList.contains('is-active')) renderCaseEditor();
  }

  function renderActiveCase() {
    var item = activeCase();
    var summary = $('#active-case-summary');
    if (!item) { summary.innerHTML = '<p>Pin kennis vanuit een notitie in je werkplan.</p>'; return; }
    var pins = arrayValue(item.pinned_note_ids || item.pins);
    summary.innerHTML = '<p><strong>' + escapeHtml(caseLabel(item)) + '</strong><br>' + pins.length + ' kennisitem' + (pins.length === 1 ? '' : 's') + ' vastgezet.</p>';
  }

  function renderCaseEditor() {
    var item = activeCase();
    if (!item) { $('#case-editor').innerHTML = '<div class="empty-state">Selecteer of maak een casus.</div>'; return; }
    var pins = arrayValue(item.pinned_note_ids || item.pins);
    var regionOptions = state.regions.map(function (region) {
      var slug = region.slug || region.name;
      return '<option value="' + escapeHtml(slug) + '">' + escapeHtml(region.name || slugLabel(slug)) + '</option>';
    }).join('');
    if (!regionOptions) regionOptions = '<option value="schouder">Schouder</option>';
    $('#case-editor').innerHTML = '<form class="case-form" id="case-form"><label>Casuslabel<input name="label" value="' + escapeHtml(caseLabel(item)) + '" autocomplete="off" required></label>' +
      '<label>Regio<select name="region">' + regionOptions + '</select></label>' +
      '<label>Presentatie en hulpvraag<textarea name="presenting_complaint" placeholder="Klacht, hulpvraag en relevante context">' + escapeHtml(item.presenting_complaint || '') + '</textarea></label>' +
      '<label>Klinische context<textarea name="notes" placeholder="Bevindingen, klinische afwegingen en verloop">' + escapeHtml(item.notes || '') + '</textarea></label>' +
      '<div><strong>Vastgezette kennis (' + pins.length + ')</strong><div class="result-meta">' + pins.map(function (pin) { return '<span>' + escapeHtml(pin) + '</span>'; }).join('') + '</div></div>' +
      '<div class="case-form-actions"><button class="primary" type="submit">Lokaal opslaan</button><button type="button" data-doc="soap">Concept SOAP</button><button type="button" data-doc="rps">Concept RPS</button><button type="button" data-doc="clinical_reasoning">Klinisch redeneren</button><a href="' + apiBase + '/cases/' + encodeURIComponent(caseId(item)) + '/export">Exporteer JSON</a><button class="danger" data-delete-case type="button">Permanent verwijderen</button></div></form><article id="documentation-output" class="deep-answer" contenteditable="true">Documentatie verschijnt hier als bewerkbaar concept en wordt pas opgeslagen wanneer jij dat doet.</article><button type="button" id="save-document-session">Bewaar bewerkt concept als sessie</button>';
    $('[name="region"]', $('#case-form')).value = item.region || 'schouder';
    enhanceSelects($('#case-form'));
    $('#case-form').addEventListener('submit', saveCase);
    $$('[data-doc]').forEach(function (button) { button.addEventListener('click', function () { startDocumentation(button.dataset.doc); }); });
    $('[data-delete-case]').addEventListener('click', deleteCase);
    $('#save-document-session').addEventListener('click', saveDocumentSession);
  }

  async function createCase() {
    var label = window.prompt('Casuslabel (bijv. S01 schouder):');
    if (!label) return;
    try {
      var data = await api('/cases', { method: 'POST', body: { title: label, region: state.region || 'schouder', mode: 'clinical', presenting_complaint: '', notes: '', pinned_note_ids: [] } });
      var item = data.case || data;
      state.cases.unshift(item);
      state.activeCaseId = caseId(item);
      renderCases(); renderCaseEditor();
      toast('Casus lokaal aangemaakt.');
    } catch (error) { toast(error.message, true); }
  }

  async function saveCase(event) {
    event.preventDefault();
    var item = activeCase();
    var form = event.currentTarget;
    var label = form.elements.label.value.trim();
    var presentingComplaint = form.elements.presenting_complaint.value.trim();
    var notes = form.elements.notes.value.trim();
    try {
      var data = await api('/cases/' + encodeURIComponent(caseId(item)), { method: 'PATCH', body: { title: label, region: form.elements.region.value, presenting_complaint: presentingComplaint, notes: notes, pinned_note_ids: arrayValue(item.pinned_note_ids || item.pins) } });
      replaceCase(data.case || data); toast('Casus lokaal opgeslagen.');
    } catch (error) { toast(error.message, true); }
  }

  function replaceCase(updated) {
    var id = caseId(updated);
    state.cases = state.cases.map(function (item) { return caseId(item) === id ? updated : item; });
    renderCases();
  }

  async function pinCurrentNote() {
    var item = activeCase();
    if (!item) { toast('Selecteer eerst een casus.', true); return; }
    var noteId = state.currentNote && (state.currentNote.note_id || state.currentNote.id);
    var pins = arrayValue(item.pinned_note_ids || item.pins).slice();
    if (pins.indexOf(noteId) === -1) pins.push(noteId);
    try {
      var data = await api('/cases/' + encodeURIComponent(caseId(item)), { method: 'PATCH', body: { pinned_note_ids: pins } });
      replaceCase(data.case || data); toast('Kennis vastgezet in de casus.');
    } catch (error) { toast(error.message, true); }
  }

  async function deleteCase() {
    var item = activeCase();
    if (!item || !window.confirm('Deze lokale casus en alle sessies permanent verwijderen?')) return;
    try {
      await api('/cases/' + encodeURIComponent(caseId(item)), { method: 'DELETE' });
      state.cases = state.cases.filter(function (candidate) { return caseId(candidate) !== caseId(item); });
      state.activeCaseId = ''; renderCases(); renderCaseEditor(); toast('Casus permanent verwijderd.');
    } catch (error) { toast(error.message, true); }
  }

  async function saveDocumentSession() {
    var item = activeCase();
    var output = $('#documentation-output');
    var content = output ? output.textContent.trim() : '';
    if (!item || !content) return;
    var kind = output.dataset.documentType || 'clinical_reasoning';
    try {
      await api('/cases/' + encodeURIComponent(caseId(item)) + '/sessions', { method: 'POST', body: { kind: kind, content: content } });
      toast('Bewerkt concept als lokale sessie opgeslagen.');
    } catch (error) { toast(error.message, true); }
  }

  function showDeepDialog() {
    $('#deep-query-input').value = state.query;
    $('#deep-answer').textContent = '';
    $('#deep-case-select').value = state.activeCaseId || '';
    refreshPrettySelect($('#deep-case-select'));
    syncDeepCaseContext();
    $('#deep-dialog').showModal();
  }

  function caseContext(item) {
    if (!item) return '';
    return [
      'Casus: ' + caseLabel(item),
      item.region ? 'Regio: ' + slugLabel(item.region) : '',
      item.presenting_complaint ? 'Presentatie en hulpvraag:\n' + item.presenting_complaint : '',
      item.notes ? 'Klinische context:\n' + item.notes : ''
    ].filter(Boolean).join('\n\n');
  }

  function syncDeepCaseContext() {
    var selectedId = $('#deep-case-select').value;
    var selected = state.cases.find(function (item) { return caseId(item) === selectedId; });
    $('#deep-case-context').value = caseContext(selected);
  }

  async function startDeepQuery() {
    var query = $('#deep-query-input').value.trim();
    if (!query) return;
    $('#deep-answer').textContent = 'Lokale passages selecteren; daarna verwerkt Codex de actieve bronnen…';
    try {
      var selectedCase = state.cases.find(function (item) { return caseId(item) === $('#deep-case-select').value; });
      var noteIds = arrayValue(selectedCase && (selectedCase.pinned_note_ids || selectedCase.pins)).slice();
      var currentNoteId = state.currentNote && (state.currentNote.note_id || state.currentNote.id);
      if (currentNoteId && noteIds.indexOf(currentNoteId) === -1) noteIds.push(currentNoteId);
      var data = await api('/jobs/deep-query', { method: 'POST', body: {
        query: query,
        region: state.region,
        case_id: $('#deep-case-select').value,
        case_context: $('#deep-case-context').value.trim(),
        note_ids: noteIds
      } });
      state.jobId = data.job_id || data.id;
      $('#cancel-deep-job').hidden = false;
      pollJob(state.jobId, $('#deep-answer'));
    } catch (error) { $('#deep-answer').textContent = error.message; }
  }

  async function startDocumentation(type) {
    var item = activeCase();
    var output = $('#documentation-output');
    output.dataset.documentType = type;
    output.textContent = 'Codex maakt een bewerkbaar ' + type + '-concept…';
    try {
      var data = await api('/jobs/documentation', { method: 'POST', body: { case_id: caseId(item), document_type: type, note_ids: arrayValue(item.pinned_note_ids || item.pins) } });
      state.jobId = data.job_id || data.id;
      pollJob(state.jobId, output);
    } catch (error) { output.textContent = error.message; }
  }

  function resultText(result) {
    if (typeof result === 'string') return result;
    if (!result) return '';
    if (result.answer) return result.answer;
    if (result.answer_markdown) return result.answer_markdown;
    if (result.direct_answer) {
      var citationLines = arrayValue(result.citations).map(function (citation) { return (citation.note_id || '') + (citation.anchor ? '#' + citation.anchor : ''); });
      return [result.direct_answer, result.clinical_application, arrayValue(result.conditions_exceptions).join('\n'), citationLines.length ? 'Bronnen:\n' + citationLines.join('\n') : ''].filter(Boolean).join('\n\n');
    }
    if (result.draft) {
      var draftCitations = arrayValue(result.citations).map(function (citation) { return (citation.note_id || '') + (citation.anchor ? '#' + citation.anchor : ''); });
      return JSON.stringify(result.draft, null, 2) + (draftCitations.length ? '\n\nBronnen:\n' + draftCitations.join('\n') : '');
    }
    if (result.document) return typeof result.document === 'string' ? result.document : JSON.stringify(result.document, null, 2);
    return JSON.stringify(result, null, 2);
  }

  function setJobOutput(output, result) {
    output.textContent = resultText(result);
    var citations = arrayValue(result && result.citations);
    if (!citations.length) return;
    var links = document.createElement('div');
    links.className = 'job-citations';
    citations.forEach(function (citation) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = (citation.note_id || '') + (citation.anchor ? '#' + String(citation.anchor).replace(/^#/, '') : '');
      button.addEventListener('click', function () {
        if ($('#deep-dialog').open) $('#deep-dialog').close();
        switchView('knowledge');
        openNote(citation.note_id, citation.anchor);
      });
      links.appendChild(button);
    });
    output.appendChild(links);
  }

  async function pollJob(id, output) {
    try {
      var data = await api('/jobs/' + encodeURIComponent(id));
      var status = data.status || data.state;
      if (status === 'complete' || status === 'completed' || status === 'succeeded') {
        setJobOutput(output, data.result || data.output || data);
        $('#cancel-deep-job').hidden = true; state.jobId = ''; return;
      }
      if (status === 'error' || status === 'failed' || status === 'cancelled') {
        output.textContent = data.error || ('Taak ' + status + '.');
        $('#cancel-deep-job').hidden = true; state.jobId = ''; return;
      }
      output.textContent = data.message || data.step_description || 'Codex verwerkt de geselecteerde bronnen…';
      window.setTimeout(function () { pollJob(id, output); }, 850);
    } catch (error) { output.textContent = error.message; state.jobId = ''; }
  }

  async function cancelJob() {
    if (!state.jobId) return;
    try { await api('/jobs/' + encodeURIComponent(state.jobId), { method: 'DELETE' }); $('#deep-answer').textContent = 'Zoektaak gestopt.'; }
    catch (error) { toast(error.message, true); }
    state.jobId = ''; $('#cancel-deep-job').hidden = true;
  }

  function sourceId(item) { return item && (item.source_id || item.id || item.manifest_id); }
  function sourceTitle(item) { return item && (item.title || item.original_filename || item.filename || item.name || sourceId(item)); }
  function sourceStatus(item) { return String(item && (item.review_status || item.curation_status || item.status) || 'pending').toLowerCase(); }
  function sourceCategory(item) { return String(item && (item.category || item.source_type) || 'other'); }
  function sourceStatusLabel(status) { return { pending: 'Te beoordelen', reviewed: 'Gereviewd', active: 'Actief', rejected: 'Afgewezen' }[status] || slugLabel(status); }
  function sourceRegions(item) { return arrayValue(item && item.regions).map(function (region) { return String(region).toLowerCase(); }); }
  function sourceSuffix(item) {
    return String(item && (item.suffix || item.extension) || (sourceTitle(item).match(/\.[^.]+$/) || [''])[0]).toLowerCase();
  }
  function regionLabel(slug) {
    var match = state.regions.find(function (region) { return String(region.slug || region.name).toLowerCase() === String(slug).toLowerCase(); });
    return match ? (match.name || slugLabel(slug)) : slugLabel(slug);
  }

  function renderSourceRegionFilter() {
    var select = $('#source-region-filter');
    if (!select) return;
    var available = state.regions.map(function (region) {
      var slug = region.slug || region.name;
      return '<option value="' + escapeHtml(slug) + '">' + escapeHtml(region.name || slugLabel(slug)) + '</option>';
    }).join('');
    select.innerHTML = available + '<option value="__unlinked__">Niet gekoppeld</option>';
    if (!state.sourceRegion || !Array.from(select.options).some(function (option) { return option.value === state.sourceRegion; })) {
      state.sourceRegion = state.region || (select.options[0] && select.options[0].value) || '__unlinked__';
    }
    select.value = state.sourceRegion;
    refreshPrettySelect(select);
  }

  function setSourceViewMode(mode) {
    state.sourceViewMode = mode === 'region' ? 'region' : 'all';
    if (state.sourceViewMode === 'region') state.sourceRegion = state.region || state.sourceRegion || 'schouder';
    $$('[data-source-view-mode]').forEach(function (button) { button.classList.toggle('is-active', button.dataset.sourceViewMode === state.sourceViewMode); });
    $('#source-region-filter-wrap').hidden = state.sourceViewMode !== 'region';
    $('#source-view-help').textContent = state.sourceViewMode === 'region'
      ? 'Alleen bronnen die aan de gekozen regio zijn gekoppeld. Pas koppelingen aan in de bronmetadata.'
      : 'Bekijk en beheer de volledige lokale bronnenbibliotheek.';
    renderSourceRegionFilter();
    renderSources();
  }

  async function loadSources() {
    try {
      var data = await api('/sources-manager?limit=1000');
      var sources = Array.isArray(data.sources) ? data.sources : (Array.isArray(data.items) ? data.items : []);
      var total = Number(data.total || sources.length);
      while (sources.length < total) {
        var page = await api('/sources-manager?limit=1000&offset=' + sources.length);
        var next = Array.isArray(page.sources) ? page.sources : [];
        if (!next.length) break;
        sources = sources.concat(next);
      }
      state.sources = sources;
      state.sourceCategories = Array.isArray(data.categories) ? data.categories : [];
      renderSourceCategories();
      renderSources();
      if (state.currentSourceId) {
        var current = state.sources.find(function (item) { return sourceId(item) === state.currentSourceId; });
        if (current) renderSourceEditor(current);
      }
    } catch (error) {
      $('#source-manager-list').innerHTML = '<div class="empty-state">' + escapeHtml(error.message) + '</div>';
    }
  }

  function categoryValue(category) { return typeof category === 'object' ? (category.id || category.value || category.slug) : category; }
  function categoryLabel(category) {
    var value = categoryValue(category);
    return (typeof category === 'object' && (category.label || category.name)) || sourceCategoryLabels[value] || slugLabel(value);
  }

  function renderSourceCategories() {
    var upload = $('#source-upload-category');
    var current = upload.value;
    upload.innerHTML = '<option value="">Automatisch bepalen</option>' + state.sourceCategories.map(function (category) {
      return '<option value="' + escapeHtml(categoryValue(category)) + '">' + escapeHtml(categoryLabel(category)) + '</option>';
    }).join('');
    upload.value = current;
    refreshPrettySelect(upload);
  }

  function renderSources() {
    var query = $('#source-manager-search').value.trim().toLowerCase();
    var status = $('#source-status-filter').value;
    var items = state.sources.filter(function (item) {
      var haystack = [sourceTitle(item), item.original_filename, item.filename, sourceCategory(item), item.source_type].join(' ').toLowerCase();
      var regions = sourceRegions(item);
      var regionMatches = state.sourceViewMode !== 'region' || (state.sourceRegion === '__unlinked__' ? !regions.length : regions.indexOf(state.sourceRegion) !== -1);
      return (!query || haystack.indexOf(query) !== -1) && (!status || sourceStatus(item) === status) && regionMatches;
    });
    $('#source-manager-count').textContent = items.length + (items.length === 1 ? ' bron' : ' bronnen');
    $('#source-manager-list').innerHTML = items.length ? items.map(function (item) {
      var id = sourceId(item), itemStatus = sourceStatus(item), extension = String(item.extension || item.suffix || sourceTitle(item).split('.').pop() || 'BRON').replace(/^\./, '').slice(0, 5).toUpperCase();
      var regions = sourceRegions(item);
      var regionText = regions.length ? regions.map(regionLabel).join(', ') : 'Niet gekoppeld';
      return '<button class="source-row ' + (id === state.currentSourceId ? 'is-active' : '') + '" data-source-id="' + escapeHtml(id) + '"><span class="source-row-icon">' + escapeHtml(extension) + '</span><span><strong>' + escapeHtml(sourceTitle(item)) + '</strong><small>' + escapeHtml(sourceCategoryLabels[sourceCategory(item)] || slugLabel(sourceCategory(item))) + ' · ' + escapeHtml(item.source_type || 'bron') + '</small><small class="source-row-regions">' + escapeHtml(regionText) + '</small></span><span class="source-status" data-status="' + escapeHtml(itemStatus) + '">' + escapeHtml(sourceStatusLabel(itemStatus)) + '</span></button>';
    }).join('') : '<div class="empty-state">Geen bronnen voor dit filter.</div>';
    $$('#source-manager-list [data-source-id]').forEach(function (button) {
      button.addEventListener('click', function () {
        state.currentSourceId = button.dataset.sourceId;
        renderSources();
        renderSourceEditor(state.sources.find(function (item) { return sourceId(item) === state.currentSourceId; }));
      });
    });
  }

  function renderSourceEditor(item) {
    if (!item) return;
    var categories = state.sourceCategories.map(function (category) {
      var value = categoryValue(category);
      return '<option value="' + escapeHtml(value) + '">' + escapeHtml(categoryLabel(category)) + '</option>';
    }).join('');
    var sourceNoteLink = item.obsidian_uri ? '<a href="' + escapeHtml(item.obsidian_uri) + '">Open bronnotitie in Obsidian</a>' : '';
    var deleteButton = (item.managed || item.managed_import) ? '<button type="button" class="danger" data-delete-source>Verwijder bron</button>' : '';
    var selectedRegions = sourceRegions(item);
    var regionChecks = state.regions.map(function (region) {
      var slug = String(region.slug || region.name).toLowerCase();
      return '<label><input type="checkbox" name="regions" value="' + escapeHtml(slug) + '"' + (selectedRegions.indexOf(slug) !== -1 ? ' checked' : '') + '><span>' + escapeHtml(region.name || slugLabel(slug)) + '</span></label>';
    }).join('');
    $('#source-manager-editor').innerHTML = '<form id="source-editor-form" class="source-editor-form"><span class="source-status" data-status="' + escapeHtml(sourceStatus(item)) + '">' + escapeHtml(sourceStatusLabel(sourceStatus(item))) + '</span><h2>' + escapeHtml(sourceTitle(item)) + '</h2>' + sourceNoteLink +
      '<section class="source-preview"><div class="source-preview-head"><strong>Voorvertoning</strong><button type="button" data-refresh-preview>Opnieuw laden</button></div><div id="source-preview-body" class="source-preview-body"><div class="loading-row">Voorvertoning laden…</div></div></section>' +
      '<label>Titel<input name="title" value="' + escapeHtml(sourceTitle(item)) + '" required></label>' +
      '<label>Categorie<select name="category">' + categories + '</select></label>' +
      '<label>Brontype<input name="source_type" value="' + escapeHtml(item.source_type || sourceCategory(item)) + '"></label>' +
      '<label>Brondatum<input name="source_date" type="date" value="' + escapeHtml(item.source_date || item.date || '') + '"></label>' +
      '<label>Vertrouwensniveau<select name="trust_tier"><option value="500">Richtlijn</option><option value="400">Boek / evidence-publicatie</option><option value="300">Semestersamenvatting / anatomie</option><option value="200">Persoonlijke of Craft-notitie</option><option value="150">College</option><option value="100">Nog niet ingedeeld</option></select></label>' +
      '<label>Privacyklasse<select name="privacy_class"><option value="private-local">Privé lokaal</option><option value="private_notes">Privé notities</option><option value="private_education">Privé onderwijsmateriaal</option><option value="private_clinical">Privé klinisch</option><option value="private">Privé</option><option value="deidentified">Geanonimiseerd</option><option value="public">Publiek</option><option value="review-required">Eerst controleren</option><option value="unknown">Onbekend</option></select></label>' +
      '<label>Auteursrecht<select name="copyright_class"><option value="publisher-restricted">Uitgever — privé gebruik</option><option value="private-study">Privé studiemateriaal</option><option value="commercial_copyright">Commercieel auteursrecht</option><option value="institutional">Institutioneel</option><option value="personal">Eigen/persoonlijk</option><option value="open_license">Open licentie</option><option value="public_domain">Publiek domein</option><option value="private">Privé</option><option value="unknown">Onbekend</option></select></label>' +
      '<fieldset class="source-region-editor"><legend>Gekoppelde regio’s</legend><p>Deze koppeling bepaalt waar de bron verschijnt en geeft Diep zoeken voorrang aan passende bronnen.</p><div>' + regionChecks + '</div></fieldset>' +
      '<label>Eigen notitie bij deze bron<textarea name="notes" placeholder="Bijvoorbeeld relevante regio, hoofdstukken of reden van afwijzen">' + escapeHtml(item.notes || '') + '</textarea></label>' +
      '<div class="source-editor-meta">Bestand: ' + escapeHtml(item.original_filename || item.filename || '') + '<br>SHA-256: ' + escapeHtml(item.sha256 || item.hash || '') + '<br>Lokale map: ' + escapeHtml(item.managed_path || item.local_path || '') + '</div>' +
      '<button class="primary" type="submit">Metadata opslaan</button><div class="source-review-actions"><button type="button" data-source-action="activate">Activeer</button><button type="button" data-source-action="review">Markeer gereviewd</button><button type="button" data-source-action="pending">Terug naar beoordelen</button><button type="button" data-source-action="reject">Afwijzen</button>' + deleteButton + '</div></form>';
    var form = $('#source-editor-form');
    if (form.elements.category) form.elements.category.value = sourceCategory(item);
    if (form.elements.trust_tier) form.elements.trust_tier.value = String(item.trust_tier || '100');
    if (form.elements.privacy_class) form.elements.privacy_class.value = item.privacy_class || 'private-local';
    if (form.elements.copyright_class) form.elements.copyright_class.value = item.copyright_class || 'unknown';
    enhanceSelects(form);
    form.addEventListener('submit', saveSourceMetadata);
    $$('[data-source-action]', form).forEach(function (button) { button.addEventListener('click', function () { reviewSource(button.dataset.sourceAction); }); });
    $('[data-refresh-preview]', form).addEventListener('click', function () { renderSourcePreview(item); });
    var deleteControl = $('[data-delete-source]', form);
    if (deleteControl) deleteControl.addEventListener('click', deleteSource);
    renderSourcePreview(item);
  }

  async function renderSourcePreview(item) {
    var preview = $('#source-preview-body');
    if (!preview || sourceId(item) !== state.currentSourceId) return;
    var id = sourceId(item);
    var suffix = sourceSuffix(item);
    var url = apiBase + '/sources-manager/' + encodeURIComponent(id) + '/preview';
    preview.innerHTML = '<div class="loading-row">Voorvertoning laden…</div>';
    if (['.png', '.jpg', '.jpeg', '.heic'].indexOf(suffix) !== -1) {
      preview.innerHTML = '<a href="' + escapeHtml(url) + '" target="_blank" rel="noreferrer"><img src="' + escapeHtml(url) + '" alt="Voorvertoning van ' + escapeHtml(sourceTitle(item)) + '"></a>';
      return;
    }
    if (suffix === '.pdf') {
      preview.innerHTML = '<iframe title="PDF-voorvertoning" src="' + escapeHtml(url + '#view=FitH') + '"></iframe>';
      return;
    }
    if (['.mp3', '.m4a', '.wav'].indexOf(suffix) !== -1) {
      preview.innerHTML = '<audio controls preload="metadata" src="' + escapeHtml(url) + '"></audio>';
      return;
    }
    if (['.mp4', '.mov'].indexOf(suffix) !== -1) {
      preview.innerHTML = '<video controls preload="metadata" src="' + escapeHtml(url) + '"></video>';
      return;
    }
    if (['.md', '.txt', '.csv', '.rtf', '.docx'].indexOf(suffix) !== -1) {
      try {
        var note = await api('/notes/source--' + encodeURIComponent(id) + '?include_unreviewed=1');
        if (sourceId(item) !== state.currentSourceId) return;
        preview.innerHTML = '<article class="source-text-preview">' + markdownToHtml(note.body || note.content || '', note.inline_assets || {}) + '</article>';
      } catch (error) {
        preview.innerHTML = '<div class="source-preview-unavailable"><strong>Tekstpreview niet beschikbaar</strong><span>' + escapeHtml(error.message) + '</span><a href="' + escapeHtml(url) + '" target="_blank" rel="noreferrer">Open het bestand</a></div>';
      }
      return;
    }
    preview.innerHTML = '<div class="source-preview-unavailable"><strong>Geen ingebouwde preview voor ' + escapeHtml(suffix || 'dit bestandstype') + '</strong><a href="' + escapeHtml(url) + '" target="_blank" rel="noreferrer">Open het lokale bestand</a></div>';
  }

  async function autoTriageSources() {
    var button = $('#auto-triage-sources');
    button.disabled = true;
    button.textContent = 'Bezig met beoordelen…';
    try {
      var result = await api('/sources-manager/auto-triage', { method: 'POST', body: {} });
      $('#source-status-filter').value = '';
      refreshPrettySelect($('#source-status-filter'));
      await loadSources();
      toast(result.changed + ' duidelijke bronnen ingedeeld; ' + result.remaining_pending + ' blijven voor handmatige beoordeling.');
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; button.textContent = 'Beoordeel duidelijke bronnen'; }
  }

  async function saveSourceMetadata(event) {
    event.preventDefault();
    var form = event.currentTarget;
    try {
      var updated = await api('/sources-manager/' + encodeURIComponent(state.currentSourceId), { method: 'PATCH', body: {
        title: form.elements.title.value.trim(), category: form.elements.category.value,
        source_type: form.elements.source_type.value.trim(), source_date: form.elements.source_date.value,
        notes: form.elements.notes.value.trim(), trust_tier: form.elements.trust_tier.value,
        privacy_class: form.elements.privacy_class.value, copyright_class: form.elements.copyright_class.value,
        regions: $$('[name="regions"]:checked', form).map(function (input) { return input.value; })
      } });
      replaceSource(updated.source || updated); toast('Bronmetadata opgeslagen.');
    } catch (error) { toast(error.message, true); }
  }

  function replaceSource(updated) {
    var id = sourceId(updated);
    state.sources = state.sources.map(function (item) { return sourceId(item) === id ? updated : item; });
    renderSources(); renderSourceEditor(updated);
  }

  async function reviewSource(action) {
    try {
      var updated = await api('/sources-manager/' + encodeURIComponent(state.currentSourceId) + '/review', { method: 'POST', body: { action: action } });
      replaceSource(updated.source || updated); toast('Bronstatus bijgewerkt.');
    } catch (error) { toast(error.message, true); }
  }

  async function deleteSource() {
    var item = state.sources.find(function (candidate) { return sourceId(candidate) === state.currentSourceId; });
    if (!item || !window.confirm('Verwijder deze geïmporteerde bronkopie en de manifestregistratie permanent?')) return;
    try {
      await api('/sources-manager/' + encodeURIComponent(state.currentSourceId), { method: 'DELETE' });
      state.sources = state.sources.filter(function (candidate) { return sourceId(candidate) !== state.currentSourceId; });
      state.currentSourceId = ''; renderSources();
      $('#source-manager-editor').innerHTML = '<div class="empty-state">Bron verwijderd. Selecteer een andere bron.</div>';
      toast('Geïmporteerde bron verwijderd.');
    } catch (error) { toast(error.message, true); }
  }

  async function uploadSourceFiles(files) {
    files = Array.from(files || []);
    if (!files.length) { toast('Kies of sleep eerst één of meer bronbestanden.', true); return; }
    var progress = $('#source-upload-progress');
    var category = $('#source-upload-category').value;
    var imported = 0;
    var lastImported = null;
    for (var index = 0; index < files.length; index += 1) {
      progress.textContent = 'Importeer ' + (index + 1) + ' van ' + files.length + ': ' + files[index].name;
      var body = new FormData();
      body.set('file', files[index]);
      if (category) body.set('category', category);
      try {
        var response = await api('/sources-manager/upload', { method: 'POST', body: body });
        lastImported = response.source || response;
        imported += 1;
      }
      catch (error) { toast(files[index].name + ': ' + error.message, true); }
    }
    state.pendingSourceFiles = [];
    $('#source-file-input').value = '';
    progress.textContent = imported + ' van ' + files.length + ' bron' + (files.length === 1 ? '' : 'nen') + ' lokaal geïmporteerd.';
    if (lastImported) {
      state.currentSourceId = sourceId(lastImported);
      $('#source-status-filter').value = sourceStatus(lastImported);
      refreshPrettySelect($('#source-status-filter'));
    }
    await loadSources();
    if (lastImported) {
      var importedSource = state.sources.find(function (item) { return sourceId(item) === state.currentSourceId; });
      if (importedSource) renderSourceEditor(importedSource);
    }
  }

  function bindSourceManager() {
    var dropzone = $('#source-dropzone');
    ['dragenter', 'dragover'].forEach(function (name) { dropzone.addEventListener(name, function (event) { event.preventDefault(); dropzone.classList.add('is-dragging'); }); });
    ['dragleave', 'drop'].forEach(function (name) { dropzone.addEventListener(name, function (event) { event.preventDefault(); dropzone.classList.remove('is-dragging'); }); });
    dropzone.addEventListener('drop', function (event) { uploadSourceFiles(event.dataTransfer.files); });
    $('#source-file-input').addEventListener('change', function (event) { state.pendingSourceFiles = Array.from(event.target.files || []); $('#source-upload-progress').textContent = state.pendingSourceFiles.length + ' bestand(en) geselecteerd.'; });
    $('#source-upload-form').addEventListener('submit', function (event) { event.preventDefault(); uploadSourceFiles(state.pendingSourceFiles); });
    $('#source-manager-search').addEventListener('input', renderSources);
    $('#source-status-filter').addEventListener('change', renderSources);
    $('#source-region-filter').addEventListener('change', function (event) { state.sourceRegion = event.target.value; renderSources(); });
    $$('[data-source-view-mode]').forEach(function (button) { button.addEventListener('click', function () { setSourceViewMode(button.dataset.sourceViewMode); }); });
    $('#auto-triage-sources').addEventListener('click', autoTriageSources);
    $('#reload-sources').addEventListener('click', loadSources);
  }

  function switchView(view) {
    if (view !== 'knowledge') closeContextPanel();
    $$('.workspace-tabs [data-view]').forEach(function (button) { button.classList.toggle('is-active', button.dataset.view === view); });
    $$('[data-view-panel]').forEach(function (panel) { panel.classList.toggle('is-active', panel.dataset.viewPanel === view); });
    if (view === 'cases') renderCaseEditor();
    if (view === 'sources') loadSources();
  }

  async function refreshIndex() {
    try { var data = await api('/index/refresh', { method: 'POST', body: {} }); toast('Index vernieuwd: ' + (data.notes || data.note_count || 0) + ' notities.'); await search(); }
    catch (error) { toast(error.message, true); }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { escapeHtml: escapeHtml, markdownToHtml: markdownToHtml, caseContext: caseContext, highlightTerms: highlightTerms };
  }
  if (!root) return;

  $('#clinical-search-form').addEventListener('submit', function (event) { event.preventDefault(); search(); });
  $('#clinical-search-input').addEventListener('input', function () { window.clearTimeout(search.timer); search.timer = window.setTimeout(search, 180); });
  document.addEventListener('click', function () { closePrettySelects(); });
  document.addEventListener('keydown', function (event) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#clinical-search-input').focus(); }
    if (event.key === 'Escape') { closePrettySelects(); closeContextPanel(); }
  });
  bindRegionButtons();
  $$('.body-hotspots [data-region]').forEach(function (spot) { spot.addEventListener('click', function () { setRegion(spot.dataset.region); }); });
  $$('#type-filters [data-type]').forEach(function (button) { button.addEventListener('click', function () { state.type = button.dataset.type; $$('#type-filters [data-type]').forEach(function (other) { other.classList.toggle('is-active', other === button); }); search(); }); });
  $$('#portal-shortcuts [data-section]').forEach(function (button) { button.addEventListener('click', function () { openPortalNote(button.dataset.section); }); });
  $$('.workspace-tabs [data-view]').forEach(function (button) { button.addEventListener('click', function () { switchView(button.dataset.view); }); });
  $('#include-unreviewed').addEventListener('change', function () { search(); });
  $('#active-case-select').addEventListener('change', function (event) { selectCase(event.target.value); });
  $('#open-cases').addEventListener('click', function () { switchView('cases'); });
  $('#create-case').addEventListener('click', createCase);
  $('#refresh-index').addEventListener('click', refreshIndex);
  $('#open-portal-note').addEventListener('click', function () { openPortalNote(); });
  $('#close-context').addEventListener('click', closeContextPanel);
  $('#context-backdrop').addEventListener('click', closeContextPanel);
  $('#global-graph').addEventListener('click', loadGlobalGraph);
  $('#deep-search').addEventListener('click', showDeepDialog);
  $('#run-deep-query').addEventListener('click', startDeepQuery);
  $('#cancel-deep-job').addEventListener('click', cancelJob);
  $('#deep-case-select').addEventListener('change', syncDeepCaseContext);
  bindSourceManager();
  enhanceSelects(document);
  establishOwnerSessionFromFragment().then(bootstrap).catch(function (error) {
    setConnection(false, 'eigenaar-autorisatie nodig');
    $('#search-results').innerHTML = '<div class="empty-state"><strong>Lokale autorisatie vereist</strong><br>' + escapeHtml(error.message) + ' Start de companion opnieuw via het installatiescript.</div>';
  });
})();
