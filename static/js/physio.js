(function () {
  'use strict';

  var bootstrap = window.LectureProcessorBootstrap || {};
  var auth = bootstrap.getAuth ? bootstrap.getAuth() : (window.firebase ? window.firebase.auth() : null);
  if (!auth) return;

  var uxUtils = window.LectureProcessorUx || {};
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
  var outputCardEl = document.getElementById('physio-output-card');
  var alertsEl = document.getElementById('physio-alerts');

  var knowledgeQuestionInput = document.getElementById('physio-knowledge-question');
  var knowledgeContextInput = document.getElementById('physio-context-text');
  var knowledgeAskBtn = document.getElementById('physio-knowledge-ask-btn');
  var knowledgeMetaEl = document.getElementById('physio-knowledge-meta');
  var knowledgeAnswerEl = document.getElementById('physio-knowledge-answer');
  var knowledgeOutputCardEl = document.getElementById('physio-knowledge-output-card');
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
  var sessionPanelNoteEl = document.getElementById('physio-session-panel-note');

  var BODY_REGION_LABELS = {
    algemeen: 'Algemeen',
    nek: 'Nek / CWK',
    schouder: 'Schouder',
    elleboog_pols_hand: 'Elleboog / Pols / Hand',
    thoracaal: 'Thoracaal / BWK',
    lumbaal: 'Lumbaal / LWK',
    heup: 'Heup',
    knie: 'Knie',
    enkel_voet: 'Enkel / Voet',
    neurologisch: 'Neurologisch',
    overig: 'Overig'
  };

  var SOURCE_KIND_LABELS = {
    guidelines: 'Richtlijn',
    forms: 'Formulier',
    lectures: 'Hoorcollege',
    articles: 'Artikel',
    books: 'Boek',
    cases: 'Casus',
    overig: 'Bron'
  };

  var FIELD_LABELS = {
    hulpvraag: 'Hulpvraag',
    hoofdklacht: 'Hoofdklacht',
    pijn_beschrijving: 'Pijnbeschrijving',
    functionele_beperkingen: 'Functionele beperkingen',
    voorgeschiedenis: 'Voorgeschiedenis',
    medicatie: 'Medicatie',
    beloop: 'Beloop',
    verwachtingen_patient: 'Verwachtingen patiënt',
    overig_subjectief: 'Overig subjectief',
    inspectie: 'Inspectie',
    palpatie: 'Palpatie',
    actief_bewegingsonderzoek: 'Actief bewegingsonderzoek',
    passief_bewegingsonderzoek: 'Passief bewegingsonderzoek',
    spierkracht: 'Spierkracht',
    speciale_testen: 'Speciale testen',
    neurologisch_onderzoek: 'Neurologisch onderzoek',
    functionele_testen: 'Functionele testen',
    meetinstrumenten: 'Meetinstrumenten',
    overig_objectief: 'Overig objectief',
    fysiotherapeutische_diagnose: 'Fysiotherapeutische diagnose',
    betrokken_structuren: 'Betrokken structuren',
    fase_herstel: 'Fase herstel',
    belemmerende_factoren: 'Belemmerende factoren',
    bevorderende_factoren: 'Bevorderende factoren',
    prognose: 'Prognose',
    behandeldoelen: 'Behandeldoelen',
    behandelplan: 'Behandelplan',
    frequentie: 'Frequentie',
    thuisoefeningen: 'Thuisoefeningen',
    adviezen: 'Adviezen',
    evaluatie: 'Evaluatie',
    verwijzing: 'Verwijzing',
    naam_patient: 'Naam patiënt',
    leeftijd: 'Leeftijd',
    geslacht: 'Geslacht',
    datum: 'Datum',
    pathologie: 'Pathologie',
    volgens_patient: 'Volgens patiënt',
    volgens_therapeut: 'Volgens therapeut',
    functies_stoornissen: 'Functies en stoornissen',
    activiteiten: 'Activiteiten',
    participatie: 'Participatie',
    persoonlijke_factoren: 'Persoonlijke factoren',
    omgevingsfactoren: 'Omgevingsfactoren',
    differentiaal_diagnostiek: 'Differentiaaldiagnostiek',
    cognitief: 'Cognitief',
    emotioneel: 'Emotioneel',
    sociaal: 'Sociaal',
    beschrijving: 'Beschrijving',
    hypothese_1: 'Hypothese 1',
    hypothese_2: 'Hypothese 2',
    hypothese_3: 'Hypothese 3',
    pijn: 'Pijn',
    type: 'Type',
    nprs_score: 'NPRS-score',
    locatie: 'Locatie',
    provocatie: 'Provocatie',
    mobiliteit: 'Mobiliteit',
    arom: 'AROM',
    prom: 'PROM',
    spierfunctie: 'Spierfunctie',
    kracht: 'Kracht',
    uithoudingsvermogen: 'Uithoudingsvermogen',
    snelheid: 'Snelheid',
    coordinatie: 'Coördinatie',
    lenigheid: 'Lenigheid',
    sensibiliteit_proprioceptie: 'Sensibiliteit / proprioceptie',
    tonus: 'Tonus',
    stabiliteit: 'Stabiliteit',
    passief: 'Passief',
    actief: 'Actief',
    reiken: 'Reiken',
    grijpen: 'Grijpen',
    schrijven: 'Schrijven',
    dragen: 'Dragen',
    tillen: 'Tillen',
    haarkammen: 'Haarkammen',
    aankleden: 'Aankleden',
    wassen: 'Wassen',
    deur_open_maken: 'Deur openen',
    lopen: 'Lopen',
    overige_activiteiten: 'Overige activiteiten',
    deelname_verkeer: 'Deelname verkeer',
    deelname_werk: 'Deelname werk',
    deelname_hobbys: 'Deelname hobby\'s',
    sport: 'Sport',
    stap_1_onduidelijke_termen: 'Stap 1 · Onduidelijke termen',
    stap_2_3_probleemdefinitie: 'Stap 2/3 · Probleemdefinitie',
    stap_4_gezondheidsprobleem: 'Stap 4 · Gezondheidsprobleem',
    stap_5_diagnostisch_proces: 'Stap 5 · Diagnostisch proces',
    stap_6_therapeutisch_proces: 'Stap 6 · Therapeutisch proces',
    stap_7_effect_therapie: 'Stap 7 · Effect therapie',
    persoonsgegevens: 'Persoonsgegevens',
    patientencategorie: 'Patiëntencategorie',
    additioneel_onderzoek: 'Additioneel onderzoek',
    icf_classificatie: 'ICF-classificatie',
    horizontale_relaties: 'Horizontale relaties',
    persoonlijke_factor_invloed: 'Invloed persoonlijke factoren',
    externe_factor_invloed: 'Invloed externe factoren',
    medisch_biologische_processen: 'Medisch-biologische processen',
    screening: 'Screening',
    rode_vlaggen: 'Rode vlaggen',
    gele_vlaggen: 'Gele vlaggen',
    medische_diagnose_type: 'Medische diagnose / type',
    indicatie_fysiotherapie: 'Indicatie fysiotherapie',
    voorgesteld_onderzoek: 'Voorgesteld onderzoek',
    anamnese_vragen: 'Anamnesevragen',
    functieonderzoek: 'Functieonderzoek',
    fysiotherapeutische_conclusie: 'Fysiotherapeutische conclusie',
    hoofddoel: 'Hoofddoel',
    subdoelen: 'Subdoelen',
    evaluatieve_meetinstrumenten: 'Evaluatieve meetinstrumenten',
    behandelmethoden: 'Behandelmethoden',
    informeren_adviseren: 'Informeren en adviseren',
    interventies: 'Interventies',
    hulpmiddelen: 'Hulpmiddelen',
    multidisciplinair: 'Multidisciplinair',
    verwacht_effect_informeren: 'Verwacht effect informeren',
    verwacht_effect_interventies: 'Verwacht effect interventies',
    externe_factoren: 'Externe factoren',
    onderbouwing: 'Onderbouwing',
    hypothesen: 'Hypothesen',
    vlag: 'Vlag',
    actie: 'Aanbevolen actie',
    ernst: 'Ernst'
  };

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
    loading: false,
    lastOutputLabel: '',
    hasKnowledgeResult: false
  };

  var toastTimer = null;
  var sessionDatePicker = null;
  var defaultKnowledgeButtonLabel = knowledgeAskBtn ? String(knowledgeAskBtn.textContent || '').trim() : 'Vraag aan kennisbank';

  function todayIso() {
    var now = new Date();
    var year = now.getFullYear();
    var month = String(now.getMonth() + 1).padStart(2, '0');
    var day = String(now.getDate()).padStart(2, '0');
    return year + '-' + month + '-' + day;
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
    [generateBtn, saveBtn, exportDocxBtn, exportPdfBtn, knowledgeAskBtn, caseSaveBtn].forEach(function (node) {
      if (node) node.disabled = !!disabled;
    });
    if (transcribeBtn) {
      transcribeBtn.disabled = !!disabled || !state.selectedAudioFile;
    }
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

  function humanizeKey(key) {
    var safeKey = String(key || '').trim();
    if (FIELD_LABELS[safeKey]) return FIELD_LABELS[safeKey];
    return safeKey
      .replace(/^stap_(\d+)_/, 'Stap $1 ')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, function (match) { return match.toUpperCase(); });
  }

  function bodyRegionLabel(value) {
    var safe = String(value || '').trim().toLowerCase();
    return BODY_REGION_LABELS[safe] || humanizeKey(safe);
  }

  function sourceKindLabel(value) {
    var safe = String(value || '').trim().toLowerCase();
    return SOURCE_KIND_LABELS[safe] || humanizeKey(safe || 'bron');
  }

  function getValueAtPath(target, path) {
    var cursor = target;
    for (var index = 0; index < path.length; index += 1) {
      if (!cursor || typeof cursor !== 'object') return undefined;
      cursor = cursor[path[index]];
    }
    return cursor;
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

  function deleteArrayIndexAtPath(target, path, indexToRemove) {
    var list = getValueAtPath(target, path);
    if (!Array.isArray(list)) return;
    list.splice(indexToRemove, 1);
  }

  function ensureArrayAtPath(target, path) {
    var existing = getValueAtPath(target, path);
    if (Array.isArray(existing)) return existing;
    setValueAtPath(target, path, []);
    return getValueAtPath(target, path);
  }

  function normalizeEditorValue(currentValue, rawValue) {
    if (typeof currentValue === 'number') {
      if (String(rawValue || '').trim() === '') return null;
      var parsed = Number(rawValue);
      return Number.isFinite(parsed) ? parsed : currentValue;
    }
    if (typeof currentValue === 'boolean') {
      return String(rawValue || '').trim().toLowerCase() === 'true';
    }
    return String(rawValue || '');
  }

  function createNode(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function autoResizeTextarea(textarea) {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = Math.max(textarea.scrollHeight, 88) + 'px';
  }

  function buildInputField(label, path, value, options) {
    var opts = options || {};
    var wrap = createNode('label', 'physio-field editor-field' + (opts.full ? ' full' : ''));
    var title = createNode('span', '', label);
    var useTextarea = !!opts.multiline;
    var control = document.createElement(useTextarea ? 'textarea' : 'input');
    if (useTextarea) {
      control.rows = opts.rows || 4;
      control.value = value === null || value === undefined ? '' : String(value);
      autoResizeTextarea(control);
      control.addEventListener('input', function () {
        setValueAtPath(state.currentEditorData, path, normalizeEditorValue(value, control.value));
        autoResizeTextarea(control);
      });
    } else {
      control.type = opts.type || 'text';
      control.value = value === null || value === undefined ? '' : String(value);
      control.addEventListener('input', function () {
        setValueAtPath(state.currentEditorData, path, normalizeEditorValue(value, control.value));
      });
    }
    if (opts.placeholder) control.placeholder = opts.placeholder;
    wrap.appendChild(title);
    wrap.appendChild(control);
    return wrap;
  }

  function buildSectionCard(title, description) {
    var card = createNode('section', 'physio-section-card');
    card.appendChild(createNode('h3', '', title));
    if (description) card.appendChild(createNode('p', '', description));
    return card;
  }

  function buildSubsectionCard(title) {
    var card = createNode('div', 'physio-subsection-card');
    card.appendChild(createNode('h4', '', title));
    return card;
  }

  function buildFieldGrid() {
    return createNode('div', 'physio-section-grid');
  }

  function buildSubsectionGrid() {
    return createNode('div', 'physio-subsection-grid');
  }

  function appendConfiguredFields(grid, source, basePath, fieldConfigs) {
    (fieldConfigs || []).forEach(function (config) {
      var key = config.key;
      var value = source ? source[key] : null;
      grid.appendChild(
        buildInputField(
          config.label || humanizeKey(key),
          basePath.concat([key]),
          value,
          {
            multiline: !!config.multiline,
            full: !!config.full,
            rows: config.rows || 4
          }
        )
      );
    });
  }

  function buildStringRepeaterCard(title, path, values, options) {
    var opts = options || {};
    var card = buildSectionCard(title, opts.description || '');
    var actions = createNode('div', 'physio-inline-actions');
    var addBtn = createNode('button', 'physio-mini-btn primary', opts.addLabel || 'Item toevoegen');
    addBtn.type = 'button';
    addBtn.addEventListener('click', function () {
      var list = ensureArrayAtPath(state.currentEditorData, path);
      list.push('');
      renderCurrentOutputEditor();
    });
    actions.appendChild(addBtn);
    card.appendChild(actions);

    var listWrap = createNode('div', 'physio-array-list');
    if (!values.length) {
      listWrap.appendChild(createNode('div', 'physio-output-empty compact', opts.emptyMessage || 'Nog geen items toegevoegd.'));
    } else {
      values.forEach(function (item, index) {
        var itemCard = createNode('div', 'physio-array-item');
        var head = createNode('div', 'physio-array-item-head');
        head.appendChild(createNode('strong', '', (opts.itemLabel || 'Item') + ' ' + (index + 1)));
        var removeBtn = createNode('button', 'physio-mini-btn danger', 'Verwijderen');
        removeBtn.type = 'button';
        removeBtn.addEventListener('click', function () {
          deleteArrayIndexAtPath(state.currentEditorData, path, index);
          renderCurrentOutputEditor();
        });
        head.appendChild(removeBtn);
        itemCard.appendChild(head);
        itemCard.appendChild(
          buildInputField(
            opts.itemFieldLabel || humanizeKey(title),
            path.concat([index]),
            item,
            {
              multiline: opts.multiline !== false,
              full: true,
              rows: opts.rows || 3
            }
          )
        );
        listWrap.appendChild(itemCard);
      });
    }
    card.appendChild(listWrap);
    return card;
  }

  function buildObjectRepeaterCard(title, path, items, fieldConfigs, options) {
    var opts = options || {};
    var card = buildSectionCard(title, opts.description || '');
    var actions = createNode('div', 'physio-inline-actions');
    var addBtn = createNode('button', 'physio-mini-btn primary', opts.addLabel || 'Toevoegen');
    addBtn.type = 'button';
    addBtn.addEventListener('click', function () {
      var list = ensureArrayAtPath(state.currentEditorData, path);
      list.push(typeof opts.createItem === 'function' ? opts.createItem() : {});
      renderCurrentOutputEditor();
    });
    actions.appendChild(addBtn);
    card.appendChild(actions);

    var listWrap = createNode('div', 'physio-array-list');
    if (!items.length) {
      listWrap.appendChild(createNode('div', 'physio-output-empty compact', opts.emptyMessage || 'Nog geen items.'));
    } else {
      items.forEach(function (item, index) {
        var itemCard = createNode('div', 'physio-array-item');
        var head = createNode('div', 'physio-array-item-head');
        head.appendChild(createNode('strong', '', (opts.itemLabel || 'Item') + ' ' + (index + 1)));
        var removeBtn = createNode('button', 'physio-mini-btn danger', 'Verwijderen');
        removeBtn.type = 'button';
        removeBtn.addEventListener('click', function () {
          deleteArrayIndexAtPath(state.currentEditorData, path, index);
          renderCurrentOutputEditor();
        });
        head.appendChild(removeBtn);
        itemCard.appendChild(head);
        var grid = buildFieldGrid();
        appendConfiguredFields(grid, item || {}, path.concat([index]), fieldConfigs);
        itemCard.appendChild(grid);
        listWrap.appendChild(itemCard);
      });
    }
    card.appendChild(listWrap);
    return card;
  }

  function setOutputEmptyState(isEmpty) {
    if (outputEl) outputEl.classList.toggle('is-empty', !!isEmpty);
    if (outputCardEl) outputCardEl.classList.toggle('is-empty', !!isEmpty);
  }

  function setKnowledgeEmptyState(isEmpty) {
    if (knowledgeAnswerEl) knowledgeAnswerEl.classList.toggle('is-empty', !!isEmpty);
    if (sourceListEl) sourceListEl.classList.toggle('is-empty', !!isEmpty);
    if (knowledgeOutputCardEl) knowledgeOutputCardEl.classList.toggle('is-empty', !!isEmpty);
  }

  function renderEmptyOutput(message) {
    state.currentEditorData = {};
    state.lastOutputLabel = '';
    if (outputLabelEl) outputLabelEl.textContent = 'Nog niets gegenereerd.';
    if (!outputEl) return;
    outputEl.innerHTML = '';
    outputEl.appendChild(createNode('div', 'physio-output-empty', message || 'Nog geen output beschikbaar.'));
    setOutputEmptyState(true);
  }

  function renderAlerts(items) {
    if (!alertsEl) return;
    alertsEl.innerHTML = '';
    var list = Array.isArray(items) ? items : [];
    list.forEach(function (item, index) {
      var alert = createNode('div', 'physio-alert');
      alert.appendChild(createNode('strong', '', String((item && item.vlag) || ('Rode vlag ' + (index + 1)))));
      if (item && item.ernst) {
        alert.appendChild(createNode('div', '', 'Ernst: ' + String(item.ernst)));
      }
      if (item && item.actie) {
        alert.appendChild(createNode('div', '', String(item.actie)));
      }
      alertsEl.appendChild(alert);
    });
  }

  function renderSoapEditor() {
    var soap = ((state.currentEditorData || {}).soap || {});
    var container = createNode('div', 'physio-structured-stack');
    [
      {
        title: 'S · Subjectief',
        key: 'subjective',
        description: 'De hulpvraag, klachten en voorgeschiedenis van de patiënt.',
        fields: [
          { key: 'hulpvraag' },
          { key: 'hoofdklacht' },
          { key: 'medicatie' },
          { key: 'verwachtingen_patient' },
          { key: 'pijn_beschrijving', multiline: true, full: true },
          { key: 'functionele_beperkingen', multiline: true, full: true },
          { key: 'voorgeschiedenis', multiline: true, full: true },
          { key: 'beloop', multiline: true, full: true },
          { key: 'overig_subjectief', multiline: true, full: true }
        ]
      },
      {
        title: 'O · Objectief',
        key: 'objective',
        description: 'Onderzoeksbevindingen en relevante metingen.',
        fields: [
          { key: 'spierkracht' },
          { key: 'meetinstrumenten' },
          { key: 'inspectie', multiline: true, full: true },
          { key: 'palpatie', multiline: true, full: true },
          { key: 'actief_bewegingsonderzoek', multiline: true, full: true },
          { key: 'passief_bewegingsonderzoek', multiline: true, full: true },
          { key: 'speciale_testen', multiline: true, full: true },
          { key: 'neurologisch_onderzoek', multiline: true, full: true },
          { key: 'functionele_testen', multiline: true, full: true },
          { key: 'overig_objectief', multiline: true, full: true }
        ]
      },
      {
        title: 'A · Analyse',
        key: 'assessment',
        description: 'Fysiotherapeutische interpretatie en prognose.',
        fields: [
          { key: 'fysiotherapeutische_diagnose', full: true, multiline: true },
          { key: 'betrokken_structuren', full: true, multiline: true },
          { key: 'fase_herstel' },
          { key: 'prognose' },
          { key: 'belemmerende_factoren', full: true, multiline: true },
          { key: 'bevorderende_factoren', full: true, multiline: true }
        ]
      },
      {
        title: 'P · Plan',
        key: 'plan',
        description: 'Doelen, aanpak en vervolgafspraken.',
        fields: [
          { key: 'frequentie' },
          { key: 'evaluatie' },
          { key: 'behandeldoelen', full: true, multiline: true },
          { key: 'behandelplan', full: true, multiline: true },
          { key: 'thuisoefeningen', full: true, multiline: true },
          { key: 'adviezen', full: true, multiline: true },
          { key: 'verwijzing', full: true, multiline: true }
        ]
      }
    ].forEach(function (section) {
      var card = buildSectionCard(section.title, section.description);
      var grid = buildFieldGrid();
      appendConfiguredFields(grid, soap[section.key] || {}, ['soap', section.key], section.fields);
      card.appendChild(grid);
      container.appendChild(card);
    });
    outputEl.appendChild(container);
  }

  function renderRpsEditor() {
    var rps = ((state.currentEditorData || {}).rps || {});
    var container = createNode('div', 'physio-structured-stack');

    var headerCard = buildSectionCard('Header', 'Basisgegevens van patiënt en consult.');
    var headerGrid = buildFieldGrid();
    appendConfiguredFields(headerGrid, rps.header || {}, ['rps', 'header'], [
      { key: 'naam_patient' },
      { key: 'leeftijd' },
      { key: 'geslacht' },
      { key: 'datum' },
      { key: 'pathologie' },
      { key: 'medicatie' }
    ]);
    headerCard.appendChild(headerGrid);
    container.appendChild(headerCard);

    var patientCard = buildSectionCard('Volgens patiënt', 'Wat de patiënt ervaart in functies, activiteiten en participatie.');
    var patientGrid = buildFieldGrid();
    appendConfiguredFields(patientGrid, rps.volgens_patient || {}, ['rps', 'volgens_patient'], [
      { key: 'functies_stoornissen', multiline: true, full: true },
      { key: 'activiteiten', multiline: true, full: true },
      { key: 'participatie', multiline: true, full: true }
    ]);
    patientCard.appendChild(patientGrid);
    container.appendChild(patientCard);

    var therapistCard = buildSectionCard('Volgens therapeut', 'Observaties en bevindingen vanuit het fysiotherapeutisch onderzoek.');
    var therapistGrid = buildSubsectionGrid();
    var functies = ((rps.volgens_therapeut || {}).functies_stoornissen || {});
    var functiesCard = buildSubsectionCard('Functies en stoornissen');
    var functiesGrid = buildSubsectionGrid();

    var pijnCard = buildSubsectionCard('Pijn');
    var pijnGrid = buildFieldGrid();
    appendConfiguredFields(pijnGrid, functies.pijn || {}, ['rps', 'volgens_therapeut', 'functies_stoornissen', 'pijn'], [
      { key: 'type' },
      { key: 'nprs_score' },
      { key: 'locatie' },
      { key: 'provocatie' }
    ]);
    pijnCard.appendChild(pijnGrid);
    functiesGrid.appendChild(pijnCard);

    var mobiliteitCard = buildSubsectionCard('Mobiliteit');
    var mobiliteitGrid = buildFieldGrid();
    appendConfiguredFields(mobiliteitGrid, functies.mobiliteit || {}, ['rps', 'volgens_therapeut', 'functies_stoornissen', 'mobiliteit'], [
      { key: 'arom' },
      { key: 'prom' }
    ]);
    mobiliteitCard.appendChild(mobiliteitGrid);
    functiesGrid.appendChild(mobiliteitCard);

    var spierfunctieCard = buildSubsectionCard('Spierfunctie');
    var spierfunctieGrid = buildFieldGrid();
    appendConfiguredFields(spierfunctieGrid, functies.spierfunctie || {}, ['rps', 'volgens_therapeut', 'functies_stoornissen', 'spierfunctie'], [
      { key: 'kracht' },
      { key: 'uithoudingsvermogen' },
      { key: 'snelheid' },
      { key: 'coordinatie' },
      { key: 'lenigheid' }
    ]);
    spierfunctieCard.appendChild(spierfunctieGrid);
    functiesGrid.appendChild(spierfunctieCard);

    var stabiliteitCard = buildSubsectionCard('Stabiliteit');
    var stabiliteitGrid = buildFieldGrid();
    appendConfiguredFields(stabiliteitGrid, functies.stabiliteit || {}, ['rps', 'volgens_therapeut', 'functies_stoornissen', 'stabiliteit'], [
      { key: 'passief' },
      { key: 'actief' }
    ]);
    stabiliteitCard.appendChild(stabiliteitGrid);
    functiesGrid.appendChild(stabiliteitCard);

    var overigeFunctiesCard = buildSubsectionCard('Overige functies');
    var overigeFunctiesGrid = buildFieldGrid();
    appendConfiguredFields(overigeFunctiesGrid, functies, ['rps', 'volgens_therapeut', 'functies_stoornissen'], [
      { key: 'sensibiliteit_proprioceptie', multiline: true, full: true },
      { key: 'tonus', multiline: true, full: true }
    ]);
    overigeFunctiesCard.appendChild(overigeFunctiesGrid);
    functiesGrid.appendChild(overigeFunctiesCard);

    functiesCard.appendChild(functiesGrid);
    therapistGrid.appendChild(functiesCard);

    var activiteitenCard = buildSubsectionCard('Activiteiten');
    var activiteitenGrid = buildFieldGrid();
    appendConfiguredFields(activiteitenGrid, ((rps.volgens_therapeut || {}).activiteiten || {}), ['rps', 'volgens_therapeut', 'activiteiten'], [
      { key: 'reiken' },
      { key: 'grijpen' },
      { key: 'schrijven' },
      { key: 'dragen' },
      { key: 'tillen' },
      { key: 'haarkammen' },
      { key: 'aankleden' },
      { key: 'wassen' },
      { key: 'deur_open_maken' },
      { key: 'lopen' },
      { key: 'overige_activiteiten', full: true, multiline: true }
    ]);
    activiteitenCard.appendChild(activiteitenGrid);
    therapistGrid.appendChild(activiteitenCard);

    var participatieCard = buildSubsectionCard('Participatie');
    var participatieGrid = buildFieldGrid();
    appendConfiguredFields(participatieGrid, ((rps.volgens_therapeut || {}).participatie || {}), ['rps', 'volgens_therapeut', 'participatie'], [
      { key: 'deelname_verkeer' },
      { key: 'deelname_werk' },
      { key: 'deelname_hobbys' },
      { key: 'sport' }
    ]);
    participatieCard.appendChild(participatieGrid);
    therapistGrid.appendChild(participatieCard);

    therapistCard.appendChild(therapistGrid);
    container.appendChild(therapistCard);

    var factorsCard = buildSectionCard('Persoonlijke en omgevingsfactoren', 'Factoren die herstel en belastbaarheid mee bepalen.');
    var factorsGrid = buildSubsectionGrid();
    var personalCard = buildSubsectionCard('Persoonlijke factoren');
    var personalGrid = buildFieldGrid();
    appendConfiguredFields(personalGrid, rps.persoonlijke_factoren || {}, ['rps', 'persoonlijke_factoren'], [
      { key: 'cognitief', multiline: true, full: true },
      { key: 'emotioneel', multiline: true, full: true },
      { key: 'sociaal', multiline: true, full: true }
    ]);
    personalCard.appendChild(personalGrid);
    factorsGrid.appendChild(personalCard);

    var environmentCard = buildSubsectionCard('Omgevingsfactoren');
    var environmentGrid = buildFieldGrid();
    appendConfiguredFields(environmentGrid, rps.omgevingsfactoren || {}, ['rps', 'omgevingsfactoren'], [
      { key: 'beschrijving', multiline: true, full: true }
    ]);
    environmentCard.appendChild(environmentGrid);
    factorsGrid.appendChild(environmentCard);
    factorsCard.appendChild(factorsGrid);
    container.appendChild(factorsCard);

    var differentialCard = buildSectionCard('Differentiaaldiagnostiek', 'Werkhypothesen en de centrale hulpvraag.');
    var differentialGrid = buildFieldGrid();
    appendConfiguredFields(differentialGrid, rps.differentiaal_diagnostiek || {}, ['rps', 'differentiaal_diagnostiek'], [
      { key: 'hypothese_1', full: true, multiline: true },
      { key: 'hypothese_2', full: true, multiline: true },
      { key: 'hypothese_3', full: true, multiline: true },
      { key: 'hulpvraag', full: true, multiline: true }
    ]);
    differentialCard.appendChild(differentialGrid);
    container.appendChild(differentialCard);

    outputEl.appendChild(container);
  }

  function renderReasoningEditor() {
    var reasoning = ((state.currentEditorData || {}).reasoning || {});
    var differential = ((state.currentEditorData || {}).differential_diagnosis || {});
    var redFlags = Array.isArray((state.currentEditorData || {}).red_flags) ? state.currentEditorData.red_flags : [];
    var container = createNode('div', 'physio-structured-stack');

    container.appendChild(
      buildStringRepeaterCard(
        humanizeKey('stap_1_onduidelijke_termen'),
        ['reasoning', 'stap_1_onduidelijke_termen'],
        Array.isArray(reasoning.stap_1_onduidelijke_termen) ? reasoning.stap_1_onduidelijke_termen : [],
        {
          description: 'Losse termen of begrippen die eerst verduidelijkt moeten worden.',
          addLabel: 'Term toevoegen',
          itemLabel: 'Term',
          itemFieldLabel: 'Onbegrepen term',
          multiline: false,
          emptyMessage: 'Nog geen onduidelijke termen genoteerd.'
        }
      )
    );

    var probleemCard = buildSectionCard(humanizeKey('stap_2_3_probleemdefinitie'), 'Persoonsgegevens, verwijzing en ICF-ordening van het probleem.');
    var probleemGrid = buildFieldGrid();
    appendConfiguredFields(probleemGrid, reasoning.stap_2_3_probleemdefinitie || {}, ['reasoning', 'stap_2_3_probleemdefinitie'], [
      { key: 'persoonsgegevens', full: true, multiline: true },
      { key: 'verwijzing', full: true, multiline: true },
      { key: 'patientencategorie', full: true, multiline: true },
      { key: 'additioneel_onderzoek', full: true, multiline: true }
    ]);
    probleemCard.appendChild(probleemGrid);
    var icfGrid = buildSubsectionGrid();
    var icf = ((reasoning.stap_2_3_probleemdefinitie || {}).icf_classificatie || {});
    [
      { key: 'volgens_patient', fields: ['functies_stoornissen', 'activiteiten', 'participatie'] },
      { key: 'volgens_therapeut', fields: ['functies_stoornissen', 'activiteiten', 'participatie'] }
    ].forEach(function (section) {
      var card = buildSubsectionCard(humanizeKey(section.key));
      var grid = buildFieldGrid();
      section.fields.forEach(function (fieldKey) {
        grid.appendChild(buildInputField(humanizeKey(fieldKey), ['reasoning', 'stap_2_3_probleemdefinitie', 'icf_classificatie', section.key, fieldKey], ((icf[section.key] || {})[fieldKey]), { multiline: true, full: true }));
      });
      card.appendChild(grid);
      icfGrid.appendChild(card);
    });
    var overigeIcfCard = buildSubsectionCard('Factoren');
    var overigeIcfGrid = buildFieldGrid();
    appendConfiguredFields(overigeIcfGrid, icf, ['reasoning', 'stap_2_3_probleemdefinitie', 'icf_classificatie'], [
      { key: 'persoonlijke_factoren', full: true, multiline: true },
      { key: 'externe_factoren', full: true, multiline: true }
    ]);
    overigeIcfCard.appendChild(overigeIcfGrid);
    icfGrid.appendChild(overigeIcfCard);
    probleemCard.appendChild(icfGrid);
    container.appendChild(probleemCard);

    var gezondheidCard = buildSectionCard(humanizeKey('stap_4_gezondheidsprobleem'), 'Hypothesen over samenhang, beïnvloedende factoren en medisch-biologische processen.');
    var gezondheidGrid = buildFieldGrid();
    appendConfiguredFields(gezondheidGrid, reasoning.stap_4_gezondheidsprobleem || {}, ['reasoning', 'stap_4_gezondheidsprobleem'], [
      { key: 'persoonlijke_factor_invloed', full: true, multiline: true },
      { key: 'externe_factor_invloed', full: true, multiline: true },
      { key: 'medisch_biologische_processen', full: true, multiline: true }
    ]);
    gezondheidCard.appendChild(gezondheidGrid);
    gezondheidCard.appendChild(
      buildStringRepeaterCard(
        humanizeKey('horizontale_relaties'),
        ['reasoning', 'stap_4_gezondheidsprobleem', 'horizontale_relaties'],
        Array.isArray((reasoning.stap_4_gezondheidsprobleem || {}).horizontale_relaties) ? reasoning.stap_4_gezondheidsprobleem.horizontale_relaties : [],
        {
          addLabel: 'Relatie toevoegen',
          itemLabel: 'Relatie',
          itemFieldLabel: 'Relatie',
          emptyMessage: 'Nog geen horizontale relaties toegevoegd.'
        }
      )
    );
    container.appendChild(gezondheidCard);

    var diagnostiekCard = buildSectionCard(humanizeKey('stap_5_diagnostisch_proces'), 'Screening, diagnostiek en het voorgestelde onderzoek.');
    var screeningCard = buildSubsectionCard('Screening');
    var screeningGrid = buildFieldGrid();
    appendConfiguredFields(screeningGrid, ((reasoning.stap_5_diagnostisch_proces || {}).screening || {}), ['reasoning', 'stap_5_diagnostisch_proces', 'screening'], [
      { key: 'rode_vlaggen', full: true, multiline: true },
      { key: 'gele_vlaggen', full: true, multiline: true }
    ]);
    screeningCard.appendChild(screeningGrid);
    diagnostiekCard.appendChild(screeningCard);
    var diagnostiekGrid = buildFieldGrid();
    appendConfiguredFields(diagnostiekGrid, reasoning.stap_5_diagnostisch_proces || {}, ['reasoning', 'stap_5_diagnostisch_proces'], [
      { key: 'medische_diagnose_type', full: true, multiline: true },
      { key: 'indicatie_fysiotherapie', full: true, multiline: true },
      { key: 'fysiotherapeutische_conclusie', full: true, multiline: true }
    ]);
    diagnostiekCard.appendChild(diagnostiekGrid);
    var onderzoekCard = buildSubsectionCard('Voorgesteld onderzoek');
    var onderzoekGrid = buildFieldGrid();
    appendConfiguredFields(onderzoekGrid, ((reasoning.stap_5_diagnostisch_proces || {}).voorgesteld_onderzoek || {}), ['reasoning', 'stap_5_diagnostisch_proces', 'voorgesteld_onderzoek'], [
      { key: 'inspectie', full: true, multiline: true },
      { key: 'palpatie', full: true, multiline: true },
      { key: 'functieonderzoek', full: true, multiline: true }
    ]);
    onderzoekCard.appendChild(onderzoekGrid);
    onderzoekCard.appendChild(
      buildStringRepeaterCard(
        humanizeKey('anamnese_vragen'),
        ['reasoning', 'stap_5_diagnostisch_proces', 'voorgesteld_onderzoek', 'anamnese_vragen'],
        Array.isArray((((reasoning.stap_5_diagnostisch_proces || {}).voorgesteld_onderzoek || {}).anamnese_vragen)) ? reasoning.stap_5_diagnostisch_proces.voorgesteld_onderzoek.anamnese_vragen : [],
        {
          addLabel: 'Vraag toevoegen',
          itemLabel: 'Vraag',
          itemFieldLabel: 'Anamnesevraag',
          emptyMessage: 'Nog geen anamnesevragen toegevoegd.'
        }
      )
    );
    onderzoekCard.appendChild(
      buildStringRepeaterCard(
        humanizeKey('speciale_testen'),
        ['reasoning', 'stap_5_diagnostisch_proces', 'voorgesteld_onderzoek', 'speciale_testen'],
        Array.isArray((((reasoning.stap_5_diagnostisch_proces || {}).voorgesteld_onderzoek || {}).speciale_testen)) ? reasoning.stap_5_diagnostisch_proces.voorgesteld_onderzoek.speciale_testen : [],
        {
          addLabel: 'Test toevoegen',
          itemLabel: 'Test',
          itemFieldLabel: 'Speciale test',
          emptyMessage: 'Nog geen speciale testen toegevoegd.'
        }
      )
    );
    onderzoekCard.appendChild(
      buildStringRepeaterCard(
        humanizeKey('meetinstrumenten'),
        ['reasoning', 'stap_5_diagnostisch_proces', 'voorgesteld_onderzoek', 'meetinstrumenten'],
        Array.isArray((((reasoning.stap_5_diagnostisch_proces || {}).voorgesteld_onderzoek || {}).meetinstrumenten)) ? reasoning.stap_5_diagnostisch_proces.voorgesteld_onderzoek.meetinstrumenten : [],
        {
          addLabel: 'Instrument toevoegen',
          itemLabel: 'Instrument',
          itemFieldLabel: 'Meetinstrument',
          emptyMessage: 'Nog geen meetinstrumenten toegevoegd.'
        }
      )
    );
    diagnostiekCard.appendChild(onderzoekCard);
    container.appendChild(diagnostiekCard);

    var therapieCard = buildSectionCard(humanizeKey('stap_6_therapeutisch_proces'), 'Doelen, meetmomenten en behandelkeuzes.');
    var therapieGrid = buildFieldGrid();
    appendConfiguredFields(therapieGrid, reasoning.stap_6_therapeutisch_proces || {}, ['reasoning', 'stap_6_therapeutisch_proces'], [
      { key: 'hoofddoel', full: true, multiline: true },
      { key: 'hulpmiddelen', full: true, multiline: true },
      { key: 'multidisciplinair', full: true, multiline: true }
    ]);
    therapieCard.appendChild(therapieGrid);
    therapieCard.appendChild(
      buildStringRepeaterCard(
        humanizeKey('subdoelen'),
        ['reasoning', 'stap_6_therapeutisch_proces', 'subdoelen'],
        Array.isArray((reasoning.stap_6_therapeutisch_proces || {}).subdoelen) ? reasoning.stap_6_therapeutisch_proces.subdoelen : [],
        {
          addLabel: 'Subdoel toevoegen',
          itemLabel: 'Subdoel',
          itemFieldLabel: 'Subdoel',
          emptyMessage: 'Nog geen subdoelen toegevoegd.'
        }
      )
    );
    therapieCard.appendChild(
      buildStringRepeaterCard(
        humanizeKey('evaluatieve_meetinstrumenten'),
        ['reasoning', 'stap_6_therapeutisch_proces', 'evaluatieve_meetinstrumenten'],
        Array.isArray((reasoning.stap_6_therapeutisch_proces || {}).evaluatieve_meetinstrumenten) ? reasoning.stap_6_therapeutisch_proces.evaluatieve_meetinstrumenten : [],
        {
          addLabel: 'Meetinstrument toevoegen',
          itemLabel: 'Instrument',
          itemFieldLabel: 'Evaluatief meetinstrument',
          emptyMessage: 'Nog geen evaluatieve meetinstrumenten toegevoegd.'
        }
      )
    );
    var methodenCard = buildSubsectionCard('Behandelmethoden');
    var methodenGrid = buildFieldGrid();
    appendConfiguredFields(methodenGrid, ((reasoning.stap_6_therapeutisch_proces || {}).behandelmethoden || {}), ['reasoning', 'stap_6_therapeutisch_proces', 'behandelmethoden'], [
      { key: 'informeren_adviseren', full: true, multiline: true }
    ]);
    methodenCard.appendChild(methodenGrid);
    methodenCard.appendChild(
      buildStringRepeaterCard(
        humanizeKey('interventies'),
        ['reasoning', 'stap_6_therapeutisch_proces', 'behandelmethoden', 'interventies'],
        Array.isArray((((reasoning.stap_6_therapeutisch_proces || {}).behandelmethoden || {}).interventies)) ? reasoning.stap_6_therapeutisch_proces.behandelmethoden.interventies : [],
        {
          addLabel: 'Interventie toevoegen',
          itemLabel: 'Interventie',
          itemFieldLabel: 'Interventie',
          emptyMessage: 'Nog geen interventies toegevoegd.'
        }
      )
    );
    therapieCard.appendChild(methodenCard);
    container.appendChild(therapieCard);

    var effectCard = buildSectionCard(humanizeKey('stap_7_effect_therapie'), 'Verwachtingen over het effect van informatie en interventies.');
    var effectGrid = buildFieldGrid();
    appendConfiguredFields(effectGrid, reasoning.stap_7_effect_therapie || {}, ['reasoning', 'stap_7_effect_therapie'], [
      { key: 'verwacht_effect_informeren', full: true, multiline: true }
    ]);
    effectCard.appendChild(effectGrid);
    effectCard.appendChild(
      buildStringRepeaterCard(
        humanizeKey('verwacht_effect_interventies'),
        ['reasoning', 'stap_7_effect_therapie', 'verwacht_effect_interventies'],
        Array.isArray((reasoning.stap_7_effect_therapie || {}).verwacht_effect_interventies) ? reasoning.stap_7_effect_therapie.verwacht_effect_interventies : [],
        {
          addLabel: 'Effect toevoegen',
          itemLabel: 'Effect',
          itemFieldLabel: 'Verwacht effect',
          emptyMessage: 'Nog geen verwachte effecten toegevoegd.'
        }
      )
    );
    container.appendChild(effectCard);

    container.appendChild(
      buildObjectRepeaterCard(
        'Differentiaaldiagnose',
        ['differential_diagnosis', 'hypothesen'],
        Array.isArray(differential.hypothesen) ? differential.hypothesen : [],
        [
          { key: 'titel' },
          { key: 'onderbouwing', multiline: true, full: true }
        ],
        {
          addLabel: 'Hypothese toevoegen',
          itemLabel: 'Hypothese',
          createItem: function () { return { titel: '', onderbouwing: '' }; },
          emptyMessage: 'Nog geen hypotheses toegevoegd.'
        }
      )
    );

    var hulpvraagCard = buildSectionCard('Centrale hulpvraag', 'Welke hulpvraag staat centraal in de differentiaaldiagnose?');
    var hulpvraagGrid = buildFieldGrid();
    appendConfiguredFields(hulpvraagGrid, differential, ['differential_diagnosis'], [
      { key: 'hulpvraag', full: true, multiline: true }
    ]);
    hulpvraagCard.appendChild(hulpvraagGrid);
    container.appendChild(hulpvraagCard);

    container.appendChild(
      buildObjectRepeaterCard(
        'Rode vlaggen',
        ['red_flags'],
        redFlags,
        [
          { key: 'vlag' },
          { key: 'ernst' },
          { key: 'actie', full: true, multiline: true }
        ],
        {
          addLabel: 'Rode vlag toevoegen',
          itemLabel: 'Vlag',
          createItem: function () { return { vlag: '', ernst: '', actie: '' }; },
          emptyMessage: 'Nog geen losse rode vlaggen toegevoegd.'
        }
      )
    );

    outputEl.appendChild(container);
  }

  function renderCurrentOutputEditor() {
    if (!outputEl) return;
    outputEl.innerHTML = '';
    setOutputEmptyState(false);
    if (outputLabelEl) outputLabelEl.textContent = state.lastOutputLabel || 'Bewerkbare uitvoer';
    if (page === 'soap') {
      renderSoapEditor();
      return;
    }
    if (page === 'rps') {
      renderRpsEditor();
      return;
    }
    renderReasoningEditor();
  }

  function renderOutputEditor(payload, label) {
    state.currentEditorData = deepClone(payload || {});
    state.lastOutputLabel = String(label || 'Bewerkbare uitvoer');
    renderCurrentOutputEditor();
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
      '<div class="physio-inline-note">Geïndexeerde bronnen: ' + escapeHtml(String(data.indexed_source_count || 0)) + '</div>',
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
      + '<div>' + escapeHtml(bodyRegionLabel(session.body_region || '')) + '</div>'
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
      progressChartEl.innerHTML = '';
      progressChartEl.hidden = true;
      return;
    }
    progressChartEl.hidden = false;
    var width = 520;
    var height = 180;
    var padding = 28;
    var innerWidth = width - padding * 2;
    var innerHeight = height - padding * 2;
    var path = points.map(function (point, index) {
      var x = padding + (points.length === 1 ? innerWidth / 2 : (innerWidth * index / (points.length - 1)));
      var y = padding + innerHeight - ((point.y - 0) / 10) * innerHeight;
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

  function renderSessionPreview(session, emptyMessage) {
    if (!sessionPreviewEl) return;
    sessionPreviewEl.innerHTML = '';
    sessionPreviewEl.classList.toggle('compact-empty', !session);
    if (!session) {
      sessionPreviewEl.appendChild(createNode('div', 'physio-output-empty', emptyMessage || 'Sla eerst een sessie op om hier een overzicht te zien.'));
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
      if (sessionPanelNoteEl) {
        sessionPanelNoteEl.textContent = caseId ? 'Sla eerst een sessie op om voortgang te bekijken.' : 'Kies of maak eerst een casus.';
      }
      sessionListEl.hidden = true;
      renderProgressChart([]);
      renderSessionPreview(null, caseId ? 'Nog geen sessies in deze casus.' : 'Nog geen casus geselecteerd.');
      return;
    }
    if (sessionPanelNoteEl) {
      sessionPanelNoteEl.textContent = 'Klik een sessie om details te bekijken.';
    }
    sessionListEl.hidden = false;
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

  function getSelectedCase() {
    var currentCaseId = caseSelect ? String(caseSelect.value || state.selectedCaseId || '') : String(state.selectedCaseId || '');
    for (var index = 0; index < state.cases.length; index += 1) {
      if (String(state.cases[index].case_id || '') === currentCaseId) return state.cases[index];
    }
    return null;
  }

  function refreshSelectControl(select) {
    if (!select || !uxUtils || typeof uxUtils.refreshEnhancedSelect !== 'function') return;
    uxUtils.refreshEnhancedSelect(select);
  }

  function setSelectValue(select, value) {
    if (!select) return;
    select.value = value;
    refreshSelectControl(select);
  }

  function syncSessionDate(value) {
    var safeValue = String(value || '');
    if (sessionDatePicker && typeof sessionDatePicker.setDate === 'function') {
      sessionDatePicker.setDate(safeValue || todayIso(), false, 'Y-m-d');
    }
    if (sessionDateInput) sessionDateInput.value = safeValue || todayIso();
  }

  function populateCaseSelect() {
    if (!caseSelect) return;
    var previousValue = caseSelect.value || state.selectedCaseId || '';
    var placeholder = page === 'knowledge' ? 'Geen casus geselecteerd' : 'Kies een casus...';
    caseSelect.innerHTML = '<option value="">' + placeholder + '</option>';
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
    refreshSelectControl(caseSelect);
  }

  function renderCasesList() {
    if (!caseListEl) return;
    caseListEl.innerHTML = '';
    if (!state.cases.length) {
      caseListEl.appendChild(createNode('div', 'physio-output-empty', 'Nog geen casussen opgeslagen.'));
      return;
    }
    state.cases.forEach(function (item) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'physio-case-item' + (String(item.case_id || '') === state.selectedCaseId ? ' active' : '');
      button.innerHTML = '<strong>' + escapeHtml(item.display_label || item.patient_name || 'Casus') + '</strong>'
        + '<div>' + escapeHtml(item.primary_complaint || bodyRegionLabel(item.body_region || '')) + '</div>'
        + '<div class="physio-inline-note">' + escapeHtml(item.patient_name || '') + '</div>';
      button.addEventListener('click', function () {
        selectCase(String(item.case_id || ''), { syncForm: true });
      });
      caseListEl.appendChild(button);
    });
  }

  function fillSessionForm(session) {
    if (!session || typeof session !== 'object') return;
    state.selectedSessionId = String(session.session_id || '');
    syncSessionDate(session.session_date || '');
    setSelectValue(sessionTypeSelect, String(session.session_type || 'intake'));
    setSelectValue(bodyRegionSelect, String(session.body_region || 'algemeen'));
    if (transcriptInput) transcriptInput.value = String(session.transcript || '');
    if (sessionNotesInput) sessionNotesInput.value = String((session.metrics || {}).notes || '');
    if (nprsBeforeInput) nprsBeforeInput.value = String((session.metrics || {}).nprs_before || '');
    if (nprsAfterInput) nprsAfterInput.value = String((session.metrics || {}).nprs_after || '');
    loadOutputForPage(session);
  }

  function fillCaseForm(casePayload) {
    if (!casePayload) return;
    state.selectedCaseId = String(casePayload.case_id || '');
    if (caseMetaEl) {
      caseMetaEl.textContent = (casePayload.display_label || casePayload.patient_name || 'Casus') + ' · ' + bodyRegionLabel(casePayload.body_region || '');
    }
    if (caseDisplayLabelInput) caseDisplayLabelInput.value = String(casePayload.display_label || '');
    if (casePatientNameInput) casePatientNameInput.value = String(casePayload.patient_name || '');
    if (caseAgeInput) caseAgeInput.value = String(casePayload.age || '');
    if (caseSexInput) caseSexInput.value = String(casePayload.sex || '');
    if (caseReferralInput) caseReferralInput.value = String(casePayload.referral_source || '');
    setSelectValue(caseBodyRegionSelect, String(casePayload.body_region || 'algemeen'));
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
        .then(function (response) {
          return response.json().then(function (body) {
            return { ok: response.ok, body: body };
          });
        })
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
          return selectCase(nextCaseId, { syncForm: true });
        }
        return null;
      })
      .catch(function (error) {
        if (error && error.error) {
          setAuthBanner(error.error, 'error');
          setControlsDisabled(true);
          state.accessGranted = false;
        } else {
          setStatus('Casussen laden mislukt.', 'error');
        }
        return null;
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

  function applyCaseContextToPage(selectedCase) {
    if (!selectedCase) return;
    if (page === 'soap' || page === 'rps' || page === 'reasoning' || page === 'knowledge') {
      if (bodyRegionSelect && !state.selectedSessionId) {
        setSelectValue(bodyRegionSelect, String(selectedCase.body_region || bodyRegionSelect.value || 'algemeen'));
      }
      if (page === 'knowledge' && knowledgeContextInput) {
        var contextValue = String(knowledgeContextInput.value || '').trim();
        if (!contextValue) {
          var caseSummary = [];
          if (selectedCase.primary_complaint) caseSummary.push('Hoofdklacht: ' + selectedCase.primary_complaint);
          if (selectedCase.notes) caseSummary.push('Notities: ' + selectedCase.notes);
          if (caseSummary.length) knowledgeContextInput.value = caseSummary.join('\n');
        }
      }
    }
  }

  function selectCase(caseId, options) {
    var opts = options || {};
    state.selectedCaseId = String(caseId || '');
    if (caseSelect) setSelectValue(caseSelect, state.selectedCaseId);
    renderCasesList();
    var selectedCase = getSelectedCase();
    applyCaseContextToPage(selectedCase);
    if (selectedCase && opts.syncForm) {
      fillCaseForm(selectedCase);
    }
    if (!state.selectedCaseId) {
      state.selectedSessionId = '';
      if (page === 'cases') {
        renderSessionList('');
      }
      if (page === 'soap' || page === 'rps' || page === 'reasoning') {
        renderEmptyOutput('Genereer een nieuwe uitvoer of laad een opgeslagen sessie.');
      }
      return Promise.resolve(null);
    }
    return loadSessionsForCase(state.selectedCaseId).then(function (sessions) {
      if (page === 'soap' || page === 'rps' || page === 'reasoning') {
        var preferred = sessions.find(function (item) {
          return String(item.session_id || '') === (querySessionId || state.selectedSessionId);
        }) || sessions[0];
        if (preferred) {
          fillSessionForm(preferred);
        } else {
          state.selectedSessionId = '';
          syncSessionDate(todayIso());
          if (transcriptInput) transcriptInput.value = '';
          if (sessionNotesInput) sessionNotesInput.value = '';
          if (nprsBeforeInput) nprsBeforeInput.value = '';
          if (nprsAfterInput) nprsAfterInput.value = '';
          renderEmptyOutput('Voor deze casus is nog geen sessie opgeslagen. Genereer eerst output of sla een sessie op.');
          renderAlerts([]);
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
        var existing = (sessions || []).find(function (item) {
          return String(item.session_id || '') === state.selectedSessionId;
        });
        if (existing) fillSessionForm(existing);
      })
      .catch(function (error) {
        setStatus((error && error.error) || error.message || 'Opslaan mislukt.', 'error');
      })
      .finally(function () {
        setControlsDisabled(false);
      });
  }

  function buildSourceGroups(sources) {
    var groupsByKey = {};
    var orderedGroups = [];
    (sources || []).forEach(function (source, index) {
      var key = String(source.source_path || source.source_name || source.source_title || ('source-' + index));
      if (!groupsByKey[key]) {
        groupsByKey[key] = {
          key: key,
          source_name: String(source.source_name || '').trim(),
          source_title: String(source.source_title || source.source_name || 'Bron').trim(),
          source_kind: String(source.source_kind || '').trim(),
          hits: []
        };
        orderedGroups.push(groupsByKey[key]);
      }
      groupsByKey[key].hits.push({
        page_label: String(source.page_label || '').trim(),
        excerpt: String(source.excerpt || '').trim(),
        score: Number(source.score || 0) || 0
      });
    });
    return orderedGroups;
  }

  function renderKnowledgeResults(body) {
    setKnowledgeEmptyState(false);
    if (knowledgeAnswerEl) {
      knowledgeAnswerEl.innerHTML = renderMarkdown(body.answer_markdown || '');
    }
    if (citationsEl) {
      citationsEl.innerHTML = '';
      (body.citations || []).forEach(function (citation, index) {
        var chip = createNode('div', 'physio-citation-chip');
        chip.innerHTML = '<strong>[' + (index + 1) + ']</strong><span>' + escapeHtml(String(citation.label || citation.source_name || 'Bron')) + '</span>';
        citationsEl.appendChild(chip);
      });
    }
    if (sourceListEl) {
      sourceListEl.innerHTML = '';
      var groups = buildSourceGroups(body.retrieved_sources || []);
      if (!groups.length) {
        sourceListEl.appendChild(createNode('div', 'physio-output-empty', 'Geen bronfragmenten beschikbaar.'));
      } else {
        groups.forEach(function (group) {
          var card = createNode('div', 'physio-source-card');
          var head = createNode('div', 'physio-source-card-head');
          head.innerHTML = '<div><strong>' + escapeHtml(group.source_title) + '</strong><div class="physio-inline-note">' + escapeHtml(group.source_name) + '</div></div>'
            + '<span class="physio-source-kind">' + escapeHtml(sourceKindLabel(group.source_kind || 'overig')) + '</span>';
          card.appendChild(head);
          var list = createNode('div', 'physio-source-hit-list');
          group.hits.forEach(function (hit, hitIndex) {
            var item = createNode('div', 'physio-source-hit');
            item.innerHTML = '<div class="physio-source-hit-topline"><span class="physio-source-page">' + escapeHtml(hit.page_label || ('Fragment ' + (hitIndex + 1))) + '</span><span class="physio-source-score">Relevantie ' + escapeHtml(hit.score.toFixed(3)) + '</span></div>'
              + '<div>' + escapeHtml(hit.excerpt || '') + '</div>';
            list.appendChild(item);
          });
          card.appendChild(list);
          sourceListEl.appendChild(card);
        });
      }
    }
  }

  function handleAskKnowledge() {
    if (!knowledgeQuestionInput || !knowledgeQuestionInput.value.trim()) {
      setStatus('Typ eerst een vraag.', 'error');
      return;
    }
    setControlsDisabled(true);
    if (knowledgeAskBtn) knowledgeAskBtn.textContent = 'Bezig...';
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
        state.hasKnowledgeResult = true;
        renderKnowledgeResults(body);
        if (knowledgeAskBtn) knowledgeAskBtn.textContent = 'Vraag opnieuw';
        setStatus('Antwoord klaar.', 'success');
      })
      .catch(function (error) {
        if (knowledgeAskBtn) knowledgeAskBtn.textContent = state.hasKnowledgeResult ? 'Vraag opnieuw' : defaultKnowledgeButtonLabel;
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
    state.selectedSessionId = '';
    if (caseMetaEl) caseMetaEl.textContent = 'Nieuwe casus';
    [
      caseDisplayLabelInput,
      casePatientNameInput,
      caseAgeInput,
      caseSexInput,
      caseReferralInput,
      caseComplaintInput,
      caseTagsInput,
      caseNotesInput
    ].forEach(function (node) {
      if (node) node.value = '';
    });
    setSelectValue(caseBodyRegionSelect, 'algemeen');
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

  function getMicrophonePermissionState() {
    if (!navigator.permissions || typeof navigator.permissions.query !== 'function') {
      return Promise.resolve('prompt');
    }
    return navigator.permissions.query({ name: 'microphone' })
      .then(function (status) {
        return status && status.state ? String(status.state) : 'prompt';
      })
      .catch(function () {
        return 'prompt';
      });
  }

  function startRecorder() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      setStatus('Opnemen wordt niet ondersteund in deze browser.', 'error');
      return;
    }
    getMicrophonePermissionState()
      .then(function (permissionState) {
        if (permissionState === 'denied') {
          throw new Error('Microfoontoegang is geblokkeerd. Sta microfoontoegang toe in je browser en probeer opnieuw.');
        }
        return navigator.mediaDevices.getUserMedia({ audio: true });
      })
      .then(function (stream) {
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
          setStatus('Opname klaar. Je kunt nu een transcript maken.', 'success');
          showToast('Opname klaar');
        });
        state.recorder.start();
        if (recordStartBtn) recordStartBtn.disabled = true;
        if (recordStopBtn) recordStopBtn.disabled = false;
        setStatus('Opname loopt...', '');
      })
      .catch(function (error) {
        var message = (error && error.message) || 'Microfoontoegang is geweigerd.';
        setStatus(message, 'error');
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

  function initializeEnhancedControls() {
    [caseSelect, bodyRegionSelect, sessionTypeSelect, caseBodyRegionSelect].forEach(function (select) {
      if (!select || typeof uxUtils.enhanceNativeSelect !== 'function') return;
      uxUtils.enhanceNativeSelect(select);
      refreshSelectControl(select);
    });
    if (sessionDateInput && typeof flatpickr !== 'undefined') {
      sessionDatePicker = flatpickr(sessionDateInput, {
        dateFormat: 'Y-m-d',
        allowInput: true,
        defaultDate: sessionDateInput.value || todayIso()
      });
    }
  }

  function initializePage() {
    if (sessionDateInput && !sessionDateInput.value) sessionDateInput.value = todayIso();
    initializeEnhancedControls();

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
        return loadKnowledgeStatus();
      }).then(function () {
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
      setKnowledgeEmptyState(true);
      if (knowledgeAnswerEl) {
        knowledgeAnswerEl.innerHTML = '<div class="physio-output-empty">Stel een vraag om een antwoord uit je kennisbank te krijgen.</div>';
      }
      if (citationsEl) citationsEl.innerHTML = '';
      if (sourceListEl) sourceListEl.innerHTML = '';
    } else {
      renderEmptyOutput('Genereer een nieuwe uitvoer of laad een opgeslagen sessie.');
    }
    updateAudioNote();
  }

  initializePage();
})();
