(function () {
  'use strict';

  var bootstrap = window.LectureProcessorBootstrap || {};
  var auth = bootstrap.getAuth ? bootstrap.getAuth() : (window.firebase ? window.firebase.auth() : null);
  if (!auth) return;

  var config = window.PhysioConfig || {};
  var page = String(config.page || '').trim();
  if (!page) return;

  var authBanner = document.getElementById('physio-auth-banner');
  var statusEl = document.getElementById('physio-status');
  var toastEl = document.getElementById('physio-toast');
  var pageUrl = new URL(window.location.href);
  var queryCaseId = pageUrl.searchParams.get('case_id') || '';
  var querySessionId = pageUrl.searchParams.get('session_id') || '';

  var caseSelect = document.getElementById('physio-case-select');
  var bodyRegionSelect = document.getElementById('physio-body-region');
  var sessionTypeSelect = document.getElementById('physio-session-type');
  var sessionDateInput = document.getElementById('physio-session-date');
  var nprsBeforeInput = document.getElementById('physio-nprs-before');
  var nprsAfterInput = document.getElementById('physio-nprs-after');
  var sessionNotesInput = document.getElementById('physio-session-notes');
  var transcriptInput = document.getElementById('physio-transcript');
  var audioInput = document.getElementById('physio-audio-input');
  var audioNote = document.getElementById('physio-audio-note');
  var recordStartBtn = document.getElementById('physio-record-start');
  var recordStopBtn = document.getElementById('physio-record-stop');
  var transcribeBtn = document.getElementById('physio-transcribe-btn');
  var generateBtn = document.getElementById('physio-generate-btn');
  var saveBtn = document.getElementById('physio-save-btn');
  var exportDocxBtn = document.getElementById('physio-export-docx-btn');
  var exportPdfBtn = document.getElementById('physio-export-pdf-btn');
  var outputEl = document.getElementById('physio-output');
  var outputLabelEl = document.getElementById('physio-output-label');
  var alertsEl = document.getElementById('physio-alerts');

  var knowledgeQuestionInput = document.getElementById('physio-knowledge-question');
  var knowledgeContextInput = document.getElementById('physio-context-text');
  var knowledgeAskBtn = document.getElementById('physio-knowledge-ask-btn');
  var knowledgeMetaEl = document.getElementById('physio-knowledge-meta');
  var knowledgeAnswerEl = document.getElementById('physio-knowledge-answer');
  var citationsEl = document.getElementById('physio-citations');
  var sourceListEl = document.getElementById('physio-source-list');

  var caseListEl = document.getElementById('physio-case-list');
  var caseNewBtn = document.getElementById('physio-case-new-btn');
  var caseMetaEl = document.getElementById('physio-case-meta');
  var caseDisplayLabelInput = document.getElementById('physio-case-display-label');
  var casePatientNameInput = document.getElementById('physio-case-patient-name');
  var caseAgeInput = document.getElementById('physio-case-age');
  var caseSexInput = document.getElementById('physio-case-sex');
  var caseReferralInput = document.getElementById('physio-case-referral-source');
  var caseBodyRegionSelect = document.getElementById('physio-case-body-region');
  var caseComplaintInput = document.getElementById('physio-case-primary-complaint');
  var caseTagsInput = document.getElementById('physio-case-tags');
  var caseNotesInput = document.getElementById('physio-case-notes');
  var caseSaveBtn = document.getElementById('physio-case-save-btn');
  var sessionListEl = document.getElementById('physio-session-list');
  var sessionPreviewEl = document.getElementById('physio-session-preview');
  var progressChartEl = document.getElementById('physio-progress-chart');

  var state = {
    user: null,
    accessGranted: false,
    cases: [],
    sessionsByCase: {},
    selectedCaseId: '',
    selectedSessionId: '',
    selectedAudioFile: null,
    recorder: null,
    recorderChunks: [],
    currentOutput: {},
    currentEditorData: {},
    loading: false
  };
  var toastTimer = null;

  function todayIso() {
    return new Date().toISOString().slice(0, 10);
  }

  function setStatus(message, tone) {
    if (!statusEl) return;
    statusEl.textContent = String(message || '');
    statusEl.className = 'physio-status' + (tone ? ' ' + tone : '');
  }

  function setAuthBanner(message, tone) {
    if (!authBanner) return;
    if (!message) {
      authBanner.hidden = true;
      authBanner.textContent = '';
      authBanner.className = 'physio-auth-banner';
      return;
    }
    authBanner.hidden = false;
    authBanner.textContent = String(message);
    authBanner.className = 'physio-auth-banner' + (tone ? ' ' + tone : '');
  }

  function showToast(message) {
    if (!toastEl || !message) return;
    toastEl.textContent = String(message);
    toastEl.classList.add('visible');
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      toastEl.classList.remove('visible');
    }, 2200);
  }

  function setControlsDisabled(disabled) {
    var ids = [
      'physio-generate-btn',
      'physio-save-btn',
      'physio-export-docx-btn',
      'physio-export-pdf-btn',
      'physio-transcribe-btn',
      'physio-knowledge-ask-btn',
      'physio-case-save-btn'
    ];
    ids.forEach(function (id) {
      var node = document.getElementById(id);
      if (node) node.disabled = !!disabled;
    });
  }

  function authFetch(path, options) {
    if (!auth.currentUser) {
      return Promise.reject(new Error('Please sign in'));
    }
    return auth.currentUser.getIdToken().then(function (token) {
      var opts = options || {};
      var headers = Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + token });
      return fetch(path, Object.assign({}, opts, { headers: headers }));
    });
  }

  function deepClone(value) {
    return JSON.parse(JSON.stringify(value == null ? null : value));
  }

  function setValueAtPath(target, path, value) {
    if (!target || !Array.isArray(path) || !path.length) return;
    var cursor = target;
    for (var index = 0; index < path.length - 1; index += 1) {
      var key = path[index];
      if (cursor[key] === undefined) {
        cursor[key] = typeof path[index + 1] === 'number' ? [] : {};
      }
      cursor = cursor[key];
    }
    cursor[path[path.length - 1]] = value;
  }

  function renderEmptyOutput(message) {
    if (!outputEl) return;
    outputEl.innerHTML = '';
    var empty = document.createElement('div');
    empty.className = 'physio-output-empty';
    empty.textContent = message || 'Nog geen output beschikbaar.';
    outputEl.appendChild(empty);
  }

  function normalizeEditorValue(type, rawValue) {
    if (type === 'number') {
      var parsed = Number(rawValue);
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (type === 'boolean') {
      return String(rawValue || '').trim().toLowerCase() === 'true';
    }
    if (String(rawValue || '').trim() === 'null') {
      return null;
    }
    return String(rawValue || '');
  }

  function createField(label, path, value) {
    var wrap = document.createElement('label');
    wrap.className = 'physio-field full';
    var title = document.createElement('span');
    title.textContent = String(label || '');
    var textarea = document.createElement('textarea');
    textarea.rows = 3;
    textarea.value = value === null || value === undefined ? '' : String(value);
    var valueType = typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string';
    textarea.addEventListener('input', function () {
      setValueAtPath(state.currentEditorData, path, normalizeEditorValue(valueType, textarea.value));
    });
    wrap.appendChild(title);
    wrap.appendChild(textarea);
    return wrap;
  }

  function renderStructuredNode(container, label, value, path) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      var card = document.createElement('section');
      card.className = 'physio-section-card';
      var heading = document.createElement(path.length ? 'h4' : 'h3');
      heading.textContent = String(label || 'Sectie');
      card.appendChild(heading);
      Object.keys(value).forEach(function (key) {
        renderStructuredNode(card, key.replace(/_/g, ' '), value[key], path.concat([key]));
      });
      container.appendChild(card);
      return;
    }
    if (Array.isArray(value)) {
      var listCard = document.createElement('section');
      listCard.className = 'physio-section-card';
      var listHeading = document.createElement(path.length ? 'h4' : 'h3');
      listHeading.textContent = String(label || 'Lijst');
      listCard.appendChild(listHeading);
      if (!value.length) {
        var note = document.createElement('div');
        note.className = 'physio-inline-note';
        note.textContent = 'Geen items';
        listCard.appendChild(note);
      } else {
        var listBlock = document.createElement('div');
        listBlock.className = 'physio-list-block';
        value.forEach(function (item, index) {
          var listItem = document.createElement('div');
          listItem.className = 'physio-list-item';
          renderStructuredNode(listItem, (label || 'Item') + ' ' + (index + 1), item, path.concat([index]));
          listBlock.appendChild(listItem);
        });
        listCard.appendChild(listBlock);
      }
      container.appendChild(listCard);
      return;
    }
    container.appendChild(createField(label, path, value));
  }

  function renderOutputEditor(payload, label) {
    if (!outputEl) return;
    state.currentEditorData = deepClone(payload || {});
    outputEl.innerHTML = '';
    Object.keys(state.currentEditorData || {}).forEach(function (key) {
      renderStructuredNode(outputEl, key.replace(/_/g, ' '), state.currentEditorData[key], [key]);
    });
    if (outputLabelEl) {
      outputLabelEl.textContent = label || 'Bewerkbare uitvoer';
    }
  }

  function renderAlerts(items) {
    if (!alertsEl) return;
    alertsEl.innerHTML = '';
    var list = Array.isArray(items) ? items : [];
    list.forEach(function (item) {
      var alert = document.createElement('div');
      alert.className = 'physio-alert';
      var title = document.createElement('strong');
      title.textContent = String(item.vlag || 'Rode vlag');
      alert.appendChild(title);
      var body = document.createElement('div');
      body.textContent = String(item.actie || item.ernst || '');
      alert.appendChild(body);
      alertsEl.appendChild(alert);
    });
  }

  function loadOutputForPage(session) {
    if (!session || typeof session !== 'object') {
      renderEmptyOutput('Genereer een nieuwe uitvoer of laad een opgeslagen sessie.');
      renderAlerts([]);
      state.currentOutput = {};
      return;
    }
    if (page === 'soap' && session.soap) {
      state.currentOutput = {
        soap: deepClone(session.soap),
        rps: deepClone(session.rps || {}),
        reasoning: deepClone(session.reasoning || {}),
        differential_diagnosis: deepClone(session.differential_diagnosis || {}),
        red_flags: deepClone(session.red_flags || [])
      };
      renderAlerts(session.red_flags || []);
      renderOutputEditor({ soap: session.soap }, 'SOAP-notitie');
      return;
    }
    if (page === 'rps' && session.rps) {
      state.currentOutput = {
        soap: deepClone(session.soap || {}),
        rps: deepClone(session.rps),
        reasoning: deepClone(session.reasoning || {}),
        differential_diagnosis: deepClone(session.differential_diagnosis || {}),
        red_flags: deepClone(session.red_flags || [])
      };
      renderAlerts(session.red_flags || []);
      renderOutputEditor({ rps: session.rps }, 'RPS-formulier');
      return;
    }
    if (page === 'reasoning' && (session.reasoning || session.differential_diagnosis)) {
      state.currentOutput = {
        soap: deepClone(session.soap || {}),
        rps: deepClone(session.rps || {}),
        reasoning: deepClone(session.reasoning || {}),
        differential_diagnosis: deepClone(session.differential_diagnosis || {}),
        red_flags: deepClone(session.red_flags || [])
      };
      renderAlerts(session.red_flags || []);
      renderOutputEditor({
        reasoning: session.reasoning || {},
        differential_diagnosis: session.differential_diagnosis || {},
        red_flags: session.red_flags || []
      }, 'Klinisch redeneren');
      return;
    }
    renderEmptyOutput('Voor deze sessie is nog geen output opgeslagen voor deze pagina.');
    renderAlerts(session.red_flags || []);
  }

  function fillSessionForm(session) {
    if (!session || typeof session !== 'object') return;
    state.selectedSessionId = String(session.session_id || '');
    if (sessionDateInput) sessionDateInput.value = String(session.session_date || '');
    if (sessionTypeSelect) sessionTypeSelect.value = String(session.session_type || 'intake');
    if (bodyRegionSelect) bodyRegionSelect.value = String(session.body_region || 'algemeen');
    if (transcriptInput) transcriptInput.value = String(session.transcript || '');
    if (sessionNotesInput) sessionNotesInput.value = String((session.metrics || {}).notes || '');
    if (nprsBeforeInput) nprsBeforeInput.value = String((session.metrics || {}).nprs_before || '');
    if (nprsAfterInput) nprsAfterInput.value = String((session.metrics || {}).nprs_after || '');
    loadOutputForPage(session);
  }

  function getSelectedCase() {
    var currentCaseId = caseSelect ? String(caseSelect.value || state.selectedCaseId || '') : String(state.selectedCaseId || '');
    for (var index = 0; index < state.cases.length; index += 1) {
      if (String(state.cases[index].case_id || '') === currentCaseId) return state.cases[index];
    }
    return null;
  }

  function populateCaseSelect() {
    if (!caseSelect) return;
    var previousValue = caseSelect.value || state.selectedCaseId || '';
    caseSelect.innerHTML = '<option value="">Kies een casus...</option>';
    state.cases.forEach(function (item) {
      var option = document.createElement('option');
      option.value = String(item.case_id || '');
      option.textContent = String(item.display_label || item.patient_name || item.case_id || 'Casus');
      caseSelect.appendChild(option);
    });
    if (previousValue) {
      caseSelect.value = previousValue;
    } else if (queryCaseId) {
      caseSelect.value = queryCaseId;
    }
    state.selectedCaseId = String(caseSelect.value || '');
  }

  function renderCasesList() {
    if (!caseListEl) return;
    caseListEl.innerHTML = '';
    if (!state.cases.length) {
      var empty = document.createElement('div');
      empty.className = 'physio-output-empty';
      empty.textContent = 'Nog geen casussen opgeslagen.';
      caseListEl.appendChild(empty);
      return;
    }
    state.cases.forEach(function (item) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'physio-case-item' + (String(item.case_id || '') === state.selectedCaseId ? ' active' : '');
      button.innerHTML = '<strong>' + escapeHtml(item.display_label || item.patient_name || 'Casus') + '</strong>'
        + '<div>' + escapeHtml(item.primary_complaint || item.body_region || '') + '</div>'
        + '<div class="physio-inline-note">' + escapeHtml(item.patient_name || '') + '</div>';
      button.addEventListener('click', function () {
        selectCase(String(item.case_id || ''), { syncForm: true });
      });
      caseListEl.appendChild(button);
    });
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderMarkdown(text) {
    var lines = String(text || '').split('\n');
    var html = [];
    var inList = false;
    lines.forEach(function (line) {
      var trimmed = line.trim();
      if (!trimmed) {
        if (inList) {
          html.push('</ul>');
          inList = false;
        }
        return;
      }
      if (trimmed.indexOf('### ') === 0) {
        if (inList) {
          html.push('</ul>');
          inList = false;
        }
        html.push('<h3>' + escapeHtml(trimmed.slice(4)) + '</h3>');
        return;
      }
      if (trimmed.indexOf('## ') === 0) {
        if (inList) {
          html.push('</ul>');
          inList = false;
        }
        html.push('<h2>' + escapeHtml(trimmed.slice(3)) + '</h2>');
        return;
      }
      if (trimmed.indexOf('# ') === 0) {
        if (inList) {
          html.push('</ul>');
          inList = false;
        }
        html.push('<h1>' + escapeHtml(trimmed.slice(2)) + '</h1>');
        return;
      }
      if (trimmed.indexOf('- ') === 0) {
        if (!inList) {
          html.push('<ul>');
          inList = true;
        }
        html.push('<li>' + escapeHtml(trimmed.slice(2)) + '</li>');
        return;
      }
      if (inList) {
        html.push('</ul>');
        inList = false;
      }
      html.push('<p>' + escapeHtml(trimmed) + '</p>');
    });
    if (inList) html.push('</ul>');
    return html.join('');
  }

  function formatTimestamp(ts) {
    var parsed = Number(ts);
    if (!Number.isFinite(parsed) || parsed <= 0) return 'onbekend';
    try {
      return new Date(parsed * 1000).toLocaleString('nl-NL');
    } catch (_error) {
      return 'onbekend';
    }
  }

  function renderKnowledgeStatus(payload) {
    if (!knowledgeMetaEl) return;
    var data = payload || {};
    var parts = [
      '<strong>Kennisbankstatus</strong>',
      '<div class="physio-inline-note">Gebouwd: ' + escapeHtml(formatTimestamp(data.generated_at)) + '</div>',
      '<div class="physio-inline-note">Bronbestanden op schijf: ' + escapeHtml(String(data.source_count_on_disk || 0)) + '</div>',
      '<div class="physio-inline-note">Geindexeerde bronnen: ' + escapeHtml(String(data.indexed_source_count || 0)) + '</div>',
      '<div class="physio-inline-note">Chunks in index: ' + escapeHtml(String(data.document_count || 0)) + '</div>'
    ];
    if (data.stale) {
      parts.push('<div class="physio-inline-note">De index is ouder dan een of meer bronbestanden. Bouw de kennisbank opnieuw en deploy daarna opnieuw.</div>');
    }
    if (data.error_count) {
      parts.push('<div class="physio-inline-note">Bestanden zonder indexeerbare tekst/fouten: ' + escapeHtml(String(data.error_count)) + '</div>');
    }
    if (Array.isArray(data.missing_source_paths) && data.missing_source_paths.length) {
      parts.push('<div class="physio-inline-note">Niet in index opgenomen: ' + escapeHtml(data.missing_source_paths.slice(0, 3).join(', ')) + (data.missing_source_paths.length > 3 ? ' ...' : '') + '</div>');
    }
    knowledgeMetaEl.className = 'physio-knowledge-meta' + (data.stale ? ' stale' : '');
    knowledgeMetaEl.innerHTML = parts.join('');
  }

  function loadKnowledgeStatus() {
    if (page !== 'knowledge') return Promise.resolve(null);
    return authFetch('/api/physio/knowledge/status')
      .then(function (response) {
        return response.json().then(function (body) {
          if (!response.ok) throw body;
          return body;
        });
      })
      .then(function (body) {
        renderKnowledgeStatus(body);
        return body;
      })
      .catch(function (error) {
        if (knowledgeMetaEl) {
          knowledgeMetaEl.className = 'physio-knowledge-meta stale';
          knowledgeMetaEl.textContent = (error && error.error) || 'Kennisbankstatus laden mislukt.';
        }
        return null;
      });
  }

  function sessionSummaryHtml(session) {
    var transcript = String(session.transcript || '').slice(0, 260);
    return '<strong>' + escapeHtml(session.session_date || 'Onbekende datum') + ' · ' + escapeHtml(session.session_type || '') + '</strong>'
      + '<div>' + escapeHtml(session.body_region || '') + '</div>'
      + '<div class="physio-inline-note">' + escapeHtml(transcript) + (transcript.length >= 260 ? '...' : '') + '</div>';
  }

  function renderProgressChart(sessions) {
    if (!progressChartEl) return;
    var points = [];
    (sessions || []).slice().reverse().forEach(function (session, index) {
      var metrics = session.metrics || {};
      var value = Number(metrics.nprs_after || metrics.nprs_before);
      if (!Number.isFinite(value)) return;
      points.push({ x: index, y: value, label: String(session.session_date || '') });
    });
    if (!points.length) {
      progressChartEl.innerHTML = '<div class="physio-output-empty">Nog geen NPRS-gegevens om te tonen.</div>';
      return;
    }
    var width = 520;
    var height = 180;
    var padding = 28;
    var innerWidth = width - padding * 2;
    var innerHeight = height - padding * 2;
    var maxY = 10;
    var minY = 0;
    var path = points.map(function (point, index) {
      var x = padding + (points.length === 1 ? innerWidth / 2 : (innerWidth * index / (points.length - 1)));
      var y = padding + innerHeight - ((point.y - minY) / (maxY - minY)) * innerHeight;
      point.svgX = x;
      point.svgY = y;
      return (index === 0 ? 'M' : 'L') + x + ' ' + y;
    }).join(' ');
    var circles = points.map(function (point) {
      return '<circle cx="' + point.svgX + '" cy="' + point.svgY + '" r="4" fill="#136f63"></circle>'
        + '<text x="' + point.svgX + '" y="' + (point.svgY - 10) + '" text-anchor="middle" font-size="10" fill="#12324a">' + escapeHtml(String(point.y)) + '</text>';
    }).join('');
    progressChartEl.innerHTML = '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="NPRS verloop">'
      + '<rect x="0" y="0" width="' + width + '" height="' + height + '" fill="transparent"></rect>'
      + '<line x1="' + padding + '" y1="' + padding + '" x2="' + padding + '" y2="' + (height - padding) + '" stroke="#b7cddd"></line>'
      + '<line x1="' + padding + '" y1="' + (height - padding) + '" x2="' + (width - padding) + '" y2="' + (height - padding) + '" stroke="#b7cddd"></line>'
      + '<path d="' + path + '" fill="none" stroke="#136f63" stroke-width="3" stroke-linecap="round"></path>'
      + circles
      + '</svg>';
  }

  function renderSessionPreview(session) {
    if (!sessionPreviewEl) return;
    if (!session) {
      sessionPreviewEl.innerHTML = '';
      return;
    }
    var links = ''
      + '<div class="physio-session-links">'
      + '<a class="physio-session-link" href="/physio/soap?case_id=' + encodeURIComponent(session.case_id || '') + '&session_id=' + encodeURIComponent(session.session_id || '') + '">Open in SOAP</a>'
      + '<a class="physio-session-link" href="/physio/rps?case_id=' + encodeURIComponent(session.case_id || '') + '&session_id=' + encodeURIComponent(session.session_id || '') + '">Open in RPS</a>'
      + '<a class="physio-session-link" href="/physio/reasoning?case_id=' + encodeURIComponent(session.case_id || '') + '&session_id=' + encodeURIComponent(session.session_id || '') + '">Open in Redeneren</a>'
      + '</div>';
    sessionPreviewEl.innerHTML =
      '<h3>' + escapeHtml(session.session_date || 'Sessie') + ' · ' + escapeHtml(session.session_type || '') + '</h3>'
      + links
      + '<div><strong>Transcript</strong><div class="physio-inline-note">' + escapeHtml(String(session.transcript || '').slice(0, 900)) + '</div></div>'
      + '<div><strong>Opgeslagen onderdelen</strong><div class="physio-inline-note">'
      + (session.soap ? 'SOAP · ' : '')
      + (session.rps ? 'RPS · ' : '')
      + (session.reasoning ? '7-stappenplan · ' : '')
      + (session.differential_diagnosis ? 'Differentiaaldiagnose' : 'Nog geen gegenereerde output')
      + '</div></div>';
  }

  function renderSessionList(caseId) {
    if (!sessionListEl) return;
    var sessions = state.sessionsByCase[caseId] || [];
    sessionListEl.innerHTML = '';
    if (!sessions.length) {
      sessionListEl.innerHTML = '<div class="physio-output-empty">Nog geen sessies in deze casus.</div>';
      renderProgressChart([]);
      renderSessionPreview(null);
      return;
    }
    sessions.forEach(function (session) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'physio-session-item' + (String(session.session_id || '') === state.selectedSessionId ? ' active' : '');
      button.innerHTML = sessionSummaryHtml(session);
      button.addEventListener('click', function () {
        state.selectedSessionId = String(session.session_id || '');
        renderSessionList(caseId);
        renderSessionPreview(session);
      });
      sessionListEl.appendChild(button);
    });
    renderProgressChart(sessions);
    var preview = sessions.find(function (session) { return String(session.session_id || '') === state.selectedSessionId; }) || sessions[0];
    if (preview) {
      state.selectedSessionId = String(preview.session_id || '');
      renderSessionPreview(preview);
    }
  }

  function fillCaseForm(casePayload) {
    if (!casePayload) return;
    state.selectedCaseId = String(casePayload.case_id || '');
    if (caseMetaEl) {
      caseMetaEl.textContent = (casePayload.display_label || casePayload.patient_name || 'Casus') + ' · ' + (casePayload.body_region || '');
    }
    if (caseDisplayLabelInput) caseDisplayLabelInput.value = String(casePayload.display_label || '');
    if (casePatientNameInput) casePatientNameInput.value = String(casePayload.patient_name || '');
    if (caseAgeInput) caseAgeInput.value = String(casePayload.age || '');
    if (caseSexInput) caseSexInput.value = String(casePayload.sex || '');
    if (caseReferralInput) caseReferralInput.value = String(casePayload.referral_source || '');
    if (caseBodyRegionSelect) caseBodyRegionSelect.value = String(casePayload.body_region || 'algemeen');
    if (caseComplaintInput) caseComplaintInput.value = String(casePayload.primary_complaint || '');
    if (caseTagsInput) caseTagsInput.value = Array.isArray(casePayload.tags) ? casePayload.tags.join(', ') : String(casePayload.tags || '');
    if (caseNotesInput) caseNotesInput.value = String(casePayload.notes || '');
  }

  function casePayloadFromForm() {
    return {
      display_label: caseDisplayLabelInput ? caseDisplayLabelInput.value : '',
      patient_name: casePatientNameInput ? casePatientNameInput.value : '',
      age: caseAgeInput ? caseAgeInput.value : '',
      sex: caseSexInput ? caseSexInput.value : '',
      referral_source: caseReferralInput ? caseReferralInput.value : '',
      body_region: caseBodyRegionSelect ? caseBodyRegionSelect.value : 'algemeen',
      primary_complaint: caseComplaintInput ? caseComplaintInput.value : '',
      tags: caseTagsInput ? caseTagsInput.value : '',
      notes: caseNotesInput ? caseNotesInput.value : ''
    };
  }

  function workspaceSessionPayload() {
    var selectedCase = getSelectedCase();
    var payload = {
      session_date: sessionDateInput ? sessionDateInput.value : '',
      session_type: sessionTypeSelect ? sessionTypeSelect.value : 'intake',
      body_region: bodyRegionSelect ? bodyRegionSelect.value : 'algemeen',
      transcript: transcriptInput ? transcriptInput.value : '',
      metrics: {
        nprs_before: nprsBeforeInput ? nprsBeforeInput.value : '',
        nprs_after: nprsAfterInput ? nprsAfterInput.value : '',
        notes: sessionNotesInput ? sessionNotesInput.value : ''
      },
      soap: state.currentOutput.soap || {},
      rps: state.currentOutput.rps || {},
      reasoning: state.currentOutput.reasoning || {},
      differential_diagnosis: state.currentOutput.differential_diagnosis || {},
      red_flags: state.currentOutput.red_flags || []
    };
    if (page === 'soap') {
      payload.soap = (state.currentEditorData || {}).soap || state.currentOutput.soap || {};
    } else if (page === 'rps') {
      payload.rps = (state.currentEditorData || {}).rps || state.currentOutput.rps || {};
    } else if (page === 'reasoning') {
      payload.reasoning = (state.currentEditorData || {}).reasoning || state.currentOutput.reasoning || {};
      payload.differential_diagnosis = (state.currentEditorData || {}).differential_diagnosis || state.currentOutput.differential_diagnosis || {};
      payload.red_flags = (state.currentEditorData || {}).red_flags || state.currentOutput.red_flags || [];
    }
    if (selectedCase) {
      payload.case_context = selectedCase;
    }
    return payload;
  }

  function currentExportPayload() {
    if (page === 'soap') {
      return { kind: 'SOAP', title: (getSelectedCase() || {}).display_label || 'SOAP Notitie', data: (state.currentEditorData || {}).soap || {} };
    }
    if (page === 'rps') {
      return { kind: 'RPS', title: (getSelectedCase() || {}).display_label || 'RPS Formulier', data: (state.currentEditorData || {}).rps || {} };
    }
    return {
      kind: 'Klinisch Redeneren',
      title: (getSelectedCase() || {}).display_label || 'Klinisch Redeneren',
      data: {
        reasoning: (state.currentEditorData || {}).reasoning || {},
        differential_diagnosis: (state.currentEditorData || {}).differential_diagnosis || {},
        red_flags: (state.currentEditorData || {}).red_flags || []
      }
    };
  }

  function pollRuntimeJob(jobId) {
    setStatus('Transcript wordt gemaakt...', '');
    var attempts = 0;
    function tick() {
      attempts += 1;
      return authFetch('/status/' + encodeURIComponent(jobId))
        .then(function (response) { return response.json().then(function (body) { return { ok: response.ok, body: body }; }); })
        .then(function (result) {
          if (!result.ok) {
            throw new Error((result.body || {}).error || 'Transcript ophalen mislukt.');
          }
          var body = result.body || {};
          if (body.status === 'complete') {
            if (transcriptInput) transcriptInput.value = String(body.transcript || body.result || '');
            setStatus('Transcript klaar. Controleer en bewerk het waar nodig.', 'success');
            showToast('Transcript klaar');
            return;
          }
          if (body.status === 'error') {
            throw new Error(body.error || 'Transcriptie is mislukt.');
          }
          if (attempts > 150) {
            throw new Error('Transcriptie duurt langer dan verwacht.');
          }
          setStatus(String(body.step_description || 'Bezig met verwerken...'), '');
          return new Promise(function (resolve) {
            window.setTimeout(resolve, 1600);
          }).then(tick);
        })
        .catch(function (error) {
          setStatus(error.message || 'Transcriptie is mislukt.', 'error');
        });
    }
    return tick();
  }

  function loadCases() {
    return authFetch('/api/physio/cases')
      .then(function (response) {
        return response.json().then(function (body) {
          if (!response.ok) throw body;
          return body;
        });
      })
      .then(function (body) {
        state.accessGranted = true;
        state.cases = Array.isArray(body.cases) ? body.cases : [];
        populateCaseSelect();
        renderCasesList();
        if (page === 'cases' && state.cases.length) {
          var nextCaseId = state.selectedCaseId || queryCaseId || String(state.cases[0].case_id || '');
          selectCase(nextCaseId, { syncForm: true });
        }
      })
      .catch(function (error) {
        if (error && error.error) {
          setAuthBanner(error.error, 'error');
          setControlsDisabled(true);
          state.accessGranted = false;
        } else {
          setStatus('Casussen laden mislukt.', 'error');
        }
      });
  }

  function loadSessionsForCase(caseId) {
    if (!caseId) return Promise.resolve([]);
    return authFetch('/api/physio/cases/' + encodeURIComponent(caseId) + '/sessions')
      .then(function (response) {
        return response.json().then(function (body) {
          if (!response.ok) throw body;
          return body;
        });
      })
      .then(function (body) {
        var sessions = Array.isArray(body.sessions) ? body.sessions : [];
        state.sessionsByCase[caseId] = sessions;
        if (page === 'cases') {
          renderSessionList(caseId);
        }
        return sessions;
      })
      .catch(function (error) {
        setStatus((error && error.error) || 'Sessies laden mislukt.', 'error');
        return [];
      });
  }

  function selectCase(caseId, options) {
    var opts = options || {};
    state.selectedCaseId = String(caseId || '');
    if (caseSelect) caseSelect.value = state.selectedCaseId;
    renderCasesList();
    var selectedCase = getSelectedCase();
    if (selectedCase && opts.syncForm) {
      fillCaseForm(selectedCase);
    }
    if (!state.selectedCaseId) {
      if (page === 'cases') {
        renderSessionList('');
      }
      return Promise.resolve(null);
    }
    return loadSessionsForCase(state.selectedCaseId).then(function (sessions) {
      if ((page === 'soap' || page === 'rps' || page === 'reasoning') && querySessionId) {
        var existing = sessions.find(function (item) { return String(item.session_id || '') === querySessionId; });
        if (existing) {
          fillSessionForm(existing);
        }
      }
      return selectedCase;
    });
  }

  function submitExport(format) {
    var exportPayload = currentExportPayload();
    if (!exportPayload.data || !Object.keys(exportPayload.data).length) {
      setStatus('Er is nog geen uitvoer om te exporteren.', 'error');
      return;
    }
    setStatus('Export voorbereiden...', '');
    authFetch('/api/physio/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: exportPayload.kind,
        title: exportPayload.title,
        format: format,
        data: exportPayload.data
      })
    })
      .then(function (response) {
        if (!response.ok) {
          return response.json().then(function (body) {
            throw new Error(body.error || 'Export mislukt.');
          });
        }
        return Promise.all([response.blob(), Promise.resolve(response.headers.get('Content-Disposition') || '')]);
      })
      .then(function (parts) {
        var blob = parts[0];
        var disposition = parts[1];
        var match = disposition.match(/filename=\"?([^\";]+)\"?/i);
        var filename = match && match[1] ? match[1] : ('physio-export.' + format);
        var link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.setTimeout(function () { URL.revokeObjectURL(link.href); }, 1200);
        setStatus('Export gestart.', 'success');
      })
      .catch(function (error) {
        setStatus(error.message || 'Export mislukt.', 'error');
      });
  }

  function ensureCaseSelected() {
    if (state.selectedCaseId) return true;
    setStatus('Kies eerst een casus of maak er één aan op de pagina Casussen.', 'error');
    return false;
  }

  function handleGenerate() {
    if (!transcriptInput || !transcriptInput.value.trim()) {
      setStatus('Vul eerst een transcript in.', 'error');
      return;
    }
    var endpoint = page === 'soap' ? '/api/physio/soap' : page === 'rps' ? '/api/physio/rps' : '/api/physio/reasoning';
    var payload = workspaceSessionPayload();
    setControlsDisabled(true);
    setStatus('AI-uitvoer genereren...', '');
    authFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (response) {
        return response.json().then(function (body) {
          if (!response.ok) throw body;
          return body;
        });
      })
      .then(function (body) {
        if (page === 'soap') {
          state.currentOutput.soap = body.soap || {};
          renderAlerts([]);
          renderOutputEditor({ soap: state.currentOutput.soap }, 'SOAP-notitie');
        } else if (page === 'rps') {
          state.currentOutput.rps = body.rps || {};
          renderAlerts([]);
          renderOutputEditor({ rps: state.currentOutput.rps }, 'RPS-formulier');
        } else {
          state.currentOutput.reasoning = body.seven_step || {};
          state.currentOutput.differential_diagnosis = body.differential_diagnosis || {};
          state.currentOutput.red_flags = Array.isArray(body.red_flags) ? body.red_flags : [];
          renderAlerts(state.currentOutput.red_flags);
          renderOutputEditor({
            reasoning: state.currentOutput.reasoning,
            differential_diagnosis: state.currentOutput.differential_diagnosis,
            red_flags: state.currentOutput.red_flags
          }, 'Klinisch redeneren');
        }
        setStatus('Uitvoer gegenereerd. Controleer alles goed voor je opslaat.', 'success');
      })
      .catch(function (error) {
        setStatus((error && error.error) || error.message || 'Genereren mislukt.', 'error');
      })
      .finally(function () {
        setControlsDisabled(false);
      });
  }

  function handleSaveSession() {
    if (!ensureCaseSelected()) return;
    var payload = workspaceSessionPayload();
    if (!payload.transcript || !String(payload.transcript).trim()) {
      setStatus('Transcript is verplicht om een sessie op te slaan.', 'error');
      return;
    }
    if (state.selectedSessionId) {
      payload.session_id = state.selectedSessionId;
    }
    setControlsDisabled(true);
    setStatus('Sessie opslaan...', '');
    authFetch('/api/physio/cases/' + encodeURIComponent(state.selectedCaseId) + '/sessions', {
      method: state.selectedSessionId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (response) {
        return response.json().then(function (body) {
          if (!response.ok) throw body;
          return body;
        });
      })
      .then(function (body) {
        var session = body.session || {};
        state.selectedSessionId = String(session.session_id || '');
        showToast('Sessie opgeslagen');
        setStatus('Sessie opgeslagen in de gekozen casus.', 'success');
        return loadSessionsForCase(state.selectedCaseId);
      })
      .then(function (sessions) {
        if (querySessionId || state.selectedSessionId) {
          var existing = (sessions || []).find(function (item) { return String(item.session_id || '') === state.selectedSessionId; });
          if (existing) fillSessionForm(existing);
        }
      })
      .catch(function (error) {
        setStatus((error && error.error) || error.message || 'Opslaan mislukt.', 'error');
      })
      .finally(function () {
        setControlsDisabled(false);
      });
  }

  function handleAskKnowledge() {
    if (!knowledgeQuestionInput || !knowledgeQuestionInput.value.trim()) {
      setStatus('Typ eerst een vraag.', 'error');
      return;
    }
    setControlsDisabled(true);
    setStatus('Kennisbank doorzoeken...', '');
    authFetch('/api/physio/knowledge/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: knowledgeQuestionInput.value,
        context_text: knowledgeContextInput ? knowledgeContextInput.value : '',
        body_region: bodyRegionSelect ? bodyRegionSelect.value : '',
        case_id: caseSelect ? caseSelect.value : ''
      })
    })
      .then(function (response) {
        return response.json().then(function (body) {
          if (!response.ok) throw body;
          return body;
        });
      })
      .then(function (body) {
        if (knowledgeAnswerEl) knowledgeAnswerEl.innerHTML = renderMarkdown(body.answer_markdown || '');
        if (citationsEl) {
          citationsEl.innerHTML = '';
          (body.citations || []).forEach(function (citation) {
            var chip = document.createElement('div');
            chip.className = 'physio-citation-chip';
            chip.textContent = String(citation.label || citation.source_name || 'Bron');
            citationsEl.appendChild(chip);
          });
        }
        if (sourceListEl) {
          sourceListEl.innerHTML = '';
          (body.retrieved_sources || []).forEach(function (source) {
            var card = document.createElement('div');
            card.className = 'physio-source-card';
            card.innerHTML = '<strong>' + escapeHtml(source.source_title || source.source_name || 'Bron') + '</strong>'
              + '<div class="physio-inline-note">' + escapeHtml(source.page_label || '') + '</div>'
              + '<div>' + escapeHtml(source.excerpt || '') + '</div>';
            sourceListEl.appendChild(card);
          });
        }
        setStatus('Antwoord klaar.', 'success');
      })
      .catch(function (error) {
        setStatus((error && error.error) || error.message || 'Kennisbankquery mislukt.', 'error');
      })
      .finally(function () {
        setControlsDisabled(false);
      });
  }

  function handleSaveCase() {
    var payload = casePayloadFromForm();
    if (!payload.display_label && !payload.patient_name) {
      setStatus('Geef minimaal een label of patiëntnaam op.', 'error');
      return;
    }
    setControlsDisabled(true);
    setStatus('Casus opslaan...', '');
    var path = '/api/physio/cases' + (state.selectedCaseId ? '/' + encodeURIComponent(state.selectedCaseId) : '');
    authFetch(path, {
      method: state.selectedCaseId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (response) {
        return response.json().then(function (body) {
          if (!response.ok) throw body;
          return body;
        });
      })
      .then(function (body) {
        var savedCase = body.case || {};
        state.selectedCaseId = String(savedCase.case_id || '');
        showToast('Casus opgeslagen');
        setStatus('Casus opgeslagen.', 'success');
        return loadCases().then(function () {
          return selectCase(state.selectedCaseId, { syncForm: true });
        });
      })
      .catch(function (error) {
        setStatus((error && error.error) || error.message || 'Casus opslaan mislukt.', 'error');
      })
      .finally(function () {
        setControlsDisabled(false);
      });
  }

  function resetCaseForm() {
    state.selectedCaseId = '';
    if (caseMetaEl) caseMetaEl.textContent = 'Nieuwe casus';
    [caseDisplayLabelInput, casePatientNameInput, caseAgeInput, caseSexInput, caseReferralInput, caseComplaintInput, caseTagsInput, caseNotesInput].forEach(function (node) {
      if (node) node.value = '';
    });
    if (caseBodyRegionSelect) caseBodyRegionSelect.value = 'algemeen';
    renderCasesList();
    renderSessionList('');
  }

  function updateAudioNote() {
    if (!audioNote) return;
    if (state.selectedAudioFile) {
      audioNote.textContent = state.selectedAudioFile.name + ' geselecteerd.';
      if (transcribeBtn) transcribeBtn.disabled = false;
      return;
    }
    audioNote.textContent = 'Nog geen audio geselecteerd.';
    if (transcribeBtn) transcribeBtn.disabled = true;
  }

  function startRecorder() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      setStatus('Opnemen wordt niet ondersteund in deze browser.', 'error');
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      state.recorderChunks = [];
      state.recorder = new window.MediaRecorder(stream);
      state.recorder.addEventListener('dataavailable', function (event) {
        if (event.data && event.data.size > 0) {
          state.recorderChunks.push(event.data);
        }
      });
      state.recorder.addEventListener('stop', function () {
        stream.getTracks().forEach(function (track) { track.stop(); });
        var blob = new Blob(state.recorderChunks, { type: state.recorder.mimeType || 'audio/webm' });
        state.selectedAudioFile = new File([blob], 'physio-opname.webm', { type: blob.type || 'audio/webm' });
        updateAudioNote();
        if (recordStartBtn) recordStartBtn.disabled = false;
        if (recordStopBtn) recordStopBtn.disabled = true;
        showToast('Opname klaar');
      });
      state.recorder.start();
      if (recordStartBtn) recordStartBtn.disabled = true;
      if (recordStopBtn) recordStopBtn.disabled = false;
      setStatus('Opname loopt...', '');
    }).catch(function () {
      setStatus('Microfoontoegang geweigerd.', 'error');
    });
  }

  function stopRecorder() {
    if (state.recorder && state.recorder.state !== 'inactive') {
      state.recorder.stop();
      setStatus('Opname wordt afgerond...', '');
    }
  }

  function handleTranscribe() {
    if (!state.selectedAudioFile) {
      setStatus('Kies eerst een audiobestand of neem iets op.', 'error');
      return;
    }
    setControlsDisabled(true);
    var formData = new FormData();
    formData.append('audio', state.selectedAudioFile);
    authFetch('/api/physio/transcriptions', {
      method: 'POST',
      body: formData
    })
      .then(function (response) {
        return response.json().then(function (body) {
          if (!response.ok) throw body;
          return body;
        });
      })
      .then(function (body) {
        if (!body.job_id) {
          throw new Error('Er is geen job-id ontvangen.');
        }
        return pollRuntimeJob(body.job_id);
      })
      .catch(function (error) {
        setStatus((error && error.error) || error.message || 'Transcriptie starten mislukt.', 'error');
      })
      .finally(function () {
        setControlsDisabled(false);
      });
  }

  function initializePage() {
    if (sessionDateInput && !sessionDateInput.value) sessionDateInput.value = todayIso();

    auth.onAuthStateChanged(function (user) {
      state.user = user;
      if (!user) {
        setAuthBanner('Meld je aan om Physio Assistant te gebruiken.', 'error');
        setControlsDisabled(true);
        state.accessGranted = false;
        return;
      }
      setAuthBanner('', '');
      setControlsDisabled(false);
      loadCases().then(function () {
        loadKnowledgeStatus();
        if ((page === 'soap' || page === 'rps' || page === 'reasoning' || page === 'knowledge') && state.selectedCaseId) {
          return selectCase(state.selectedCaseId || queryCaseId, { syncForm: page === 'cases' });
        }
        return null;
      });
    });

    if (caseSelect) {
      caseSelect.addEventListener('change', function () {
        selectCase(caseSelect.value, { syncForm: false });
      });
    }
    if (audioInput) {
      audioInput.addEventListener('change', function () {
        state.selectedAudioFile = audioInput.files && audioInput.files[0] ? audioInput.files[0] : null;
        updateAudioNote();
      });
    }
    if (recordStartBtn) recordStartBtn.addEventListener('click', startRecorder);
    if (recordStopBtn) recordStopBtn.addEventListener('click', stopRecorder);
    if (transcribeBtn) transcribeBtn.addEventListener('click', handleTranscribe);
    if (generateBtn) generateBtn.addEventListener('click', handleGenerate);
    if (saveBtn) saveBtn.addEventListener('click', handleSaveSession);
    if (exportDocxBtn) exportDocxBtn.addEventListener('click', function () { submitExport('docx'); });
    if (exportPdfBtn) exportPdfBtn.addEventListener('click', function () { submitExport('pdf'); });
    if (knowledgeAskBtn) knowledgeAskBtn.addEventListener('click', handleAskKnowledge);
    if (caseSaveBtn) caseSaveBtn.addEventListener('click', handleSaveCase);
    if (caseNewBtn) caseNewBtn.addEventListener('click', resetCaseForm);

    if (page === 'cases') {
      renderCasesList();
      renderSessionList('');
    } else if (page === 'knowledge') {
      if (knowledgeAnswerEl) knowledgeAnswerEl.innerHTML = '<div class="physio-output-empty">Stel een vraag om een antwoord uit je kennisbank te krijgen.</div>';
    } else {
      renderEmptyOutput('Genereer een nieuwe uitvoer of laad een opgeslagen sessie.');
    }
    updateAudioNote();
  }

  initializePage();
})();
