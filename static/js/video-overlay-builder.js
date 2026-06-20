(function () {
  'use strict';

  var utils = window.LectureProcessorVideoOverlayBuilderUtils || {};
  if (!utils.createTableData) return;

  var bootstrap = window.LectureProcessorBootstrap || {};
  var auth = bootstrap.getAuth ? bootstrap.getAuth() : (window.firebase && window.firebase.auth ? window.firebase.auth() : null);
  var userCache = window.LectureProcessorUserCache || {};
  var uiCache = window.LectureProcessorUiCache || null;
  var uxUtils = window.LectureProcessorUx || {};

  var PROJECTS_CACHE_KEY = 'video_overlay_projects_v1';
  var GUEST_STORAGE_KEY = 'lecture_processor_video_overlay_builder_guest_v2';
  var MAX_PROJECTS = 40;
  var COLORS = [
    { id: 'orange', label: 'Orange', accent: '#f97316', soft: '#fff7ed', text: '#9a3412' },
    { id: 'teal', label: 'Teal', accent: '#0f766e', soft: '#f0fdfa', text: '#115e59' },
    { id: 'indigo', label: 'Indigo', accent: '#4f46e5', soft: '#eef2ff', text: '#3730a3' },
    { id: 'green', label: 'Green', accent: '#16a34a', soft: '#f0fdf4', text: '#166534' },
    { id: 'rose', label: 'Rose', accent: '#e11d48', soft: '#fff1f2', text: '#9f1239' }
  ];
  var ANIMATION_OPTIONS = [
    { value: 'rise', label: 'Rise' },
    { value: 'fade', label: 'Fade' },
    { value: 'scale', label: 'Scale' },
    { value: 'wipe', label: 'Wipe' },
    { value: 'none', label: 'None' }
  ];
  var SHAPE_OPTIONS = [
    { value: 'rounded', label: 'Rounded square' },
    { value: 'circle', label: 'Circle' },
    { value: 'triangle', label: 'Triangle' },
    { value: 'pentagon', label: 'Pentagon' },
    { value: 'square', label: 'Square' },
    { value: 'diamond', label: 'Diamond' },
    { value: 'pill', label: 'Pill' },
    { value: 'parallelogram', label: 'Parallelogram' },
    { value: 'arrow-right', label: 'Block arrow' }
  ];
  var ARROW_OPTIONS = [
    { value: 'line', label: 'Line' },
    { value: 'arrow', label: 'Arrow' },
    { value: 'curve', label: 'Curved arrow' }
  ];

  var refs = {
    authState: document.getElementById('overlay-auth-state'),
    projectTitle: document.getElementById('overlay-project-title'),
    projectList: document.getElementById('overlay-project-list'),
    stageFrame: document.querySelector('.overlay-stage-frame'),
    stagePanel: document.querySelector('.overlay-stage-panel'),
    stage: document.getElementById('overlay-stage'),
    stageLabel: document.getElementById('overlay-stage-label'),
    previewProgress: document.getElementById('overlay-preview-progress'),
    slideList: document.getElementById('overlay-slide-list'),
    itemList: document.getElementById('overlay-item-list'),
    inspector: document.getElementById('overlay-inspector'),
    status: document.getElementById('overlay-builder-status'),
    addSlide: document.getElementById('overlay-add-slide'),
    addText: document.getElementById('overlay-add-text'),
    addTable: document.getElementById('overlay-add-table'),
    addImage: document.getElementById('overlay-add-image'),
    addFlow: document.getElementById('overlay-add-flow'),
    addArrow: document.getElementById('overlay-add-arrow'),
    addShape: document.getElementById('overlay-add-shape'),
    tableRows: document.getElementById('overlay-table-rows'),
    tableCols: document.getElementById('overlay-table-cols'),
    imageInput: document.getElementById('overlay-image-input'),
    importInput: document.getElementById('overlay-import-input'),
    newProject: document.getElementById('overlay-new-project'),
    save: document.getElementById('overlay-save-draft'),
    export: document.getElementById('overlay-export-json'),
    import: document.getElementById('overlay-import-json'),
    reset: document.getElementById('overlay-reset'),
    preview: document.getElementById('overlay-preview'),
    zoomIn: document.getElementById('overlay-zoom-in'),
    zoomOut: document.getElementById('overlay-zoom-out'),
    zoomInput: document.getElementById('overlay-zoom-input'),
    prevSlide: document.getElementById('overlay-prev-slide'),
    nextSlide: document.getElementById('overlay-next-slide'),
    stopPreview: document.getElementById('overlay-stop-preview'),
    recordVoice: document.getElementById('overlay-record-voice'),
    recordScreen: document.getElementById('overlay-record-screen'),
    stopRecording: document.getElementById('overlay-stop-recording'),
    recordingStatus: document.getElementById('overlay-recording-status'),
    recorderVisual: document.querySelector('.overlay-recorder-visual'),
    confirmModal: document.getElementById('overlay-confirm-modal'),
    confirmTitle: document.getElementById('overlay-confirm-title'),
    confirmMessage: document.getElementById('overlay-confirm-message'),
    confirmClose: document.getElementById('overlay-confirm-close'),
    confirmCancel: document.getElementById('overlay-confirm-cancel'),
    confirmConfirm: document.getElementById('overlay-confirm-confirm')
  };

  var currentUser = auth && auth.currentUser ? auth.currentUser : null;
  var projectLibrary = { activeProjectId: '', projects: [] };
  var project = createEmptyProject();
  var activeSlideId = project.activeSlideId;
  var selectedItemId = '';
  var previewTimers = [];
  var persistTimer = null;
  var fitTimer = null;
  var imageTargetItemId = '';
  var isPreviewing = false;
  var dynamicCssRuleCount = 0;
  var dynamicStyleSheet = null;
  var confirmResolver = null;
  var openSelectRoot = null;
  var stageZoom = 1;
  var statusTimer = null;
  var recordingStatusTimer = null;
  var draggedSlideId = '';
  var suppressSlideClick = false;

  var recording = {
    state: 'idle',
    recorder: null,
    chunks: [],
    screenStream: null,
    micStream: null,
    combinedStream: null,
    lastBlob: null,
    fullscreenRequested: false
  };
  var micPreview = {
    stream: null,
    starting: false
  };
  var micMeter = {
    audioContext: null,
    analyser: null,
    source: null,
    data: null,
    frame: 0,
    level: 0
  };

  function uid(prefix) {
    return String(prefix || 'id') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function now() {
    return Date.now();
  }

  function getRequestedProjectId() {
    try {
      return String(new URLSearchParams(window.location.search).get('project_id') || '').trim();
    } catch (_error) {
      return '';
    }
  }

  function createEmptyProject(title) {
    var slideId = uid('slide');
    return {
      version: 1,
      project_id: uid('overlay-project'),
      title: String(title || 'Untitled overlay project').trim() || 'Untitled overlay project',
      activeSlideId: slideId,
      slides: [
        {
          id: slideId,
          title: 'New slide',
          duration: 12,
          items: []
        }
      ]
    };
  }

  function normalizeProject(rawProject) {
    var source = rawProject && typeof rawProject === 'object' ? rawProject : createEmptyProject();
    var slides = Array.isArray(source.slides) ? source.slides : [];
    var normalizedSlides = slides.map(function (slide, index) {
      var safeSlide = slide && typeof slide === 'object' ? slide : {};
      var items = Array.isArray(safeSlide.items) ? safeSlide.items : [];
      return {
        id: String(safeSlide.id || uid('slide')),
        title: String(safeSlide.title || ('Slide ' + String(index + 1))).trim() || ('Slide ' + String(index + 1)),
        duration: utils.clampNumber(safeSlide.duration, 1, 600, 12),
        items: items.map(normalizeItem)
      };
    });
    if (!normalizedSlides.length) normalizedSlides = createEmptyProject().slides;
    var activeId = String(source.activeSlideId || normalizedSlides[0].id);
    if (!normalizedSlides.some(function (slide) { return slide.id === activeId; })) activeId = normalizedSlides[0].id;
    return {
      version: 1,
      project_id: String(source.project_id || uid('overlay-project')),
      title: String(source.title || 'Untitled overlay project').trim() || 'Untitled overlay project',
      activeSlideId: activeId,
      slides: normalizedSlides
    };
  }

  function normalizeItem(item) {
    var normalized = utils.normalizeOverlayItem(item);
    var color = COLORS.some(function (entry) { return entry.id === normalized.color; }) ? normalized.color : 'orange';
    var result = Object.assign({}, normalized, {
      id: String(normalized.id || uid('item')),
      color: color
    });
    clampItemGeometry(result);
    if (result.type === 'table') result.table = utils.normalizeTableData(result.table);
    if (result.type === 'flow') {
      result.steps = (Array.isArray(result.steps) ? result.steps : ['Step 1', 'Step 2']).map(function (step) {
        return String(step || '').trim();
      }).filter(Boolean);
      if (!result.steps.length) result.steps = ['Step 1'];
    }
    if (result.type === 'image') {
      result.src = String(result.src || '');
      result.alt = String(result.alt || 'Overlay image');
      result.fit = result.fit === 'contain' ? 'contain' : 'cover';
      result.edge = result.edge === 'glass' ? 'glass' : 'accent';
    }
    if (result.type === 'shape') {
      result.shape = SHAPE_OPTIONS.some(function (entry) { return entry.value === result.shape; }) ? result.shape : 'rounded';
      result.rotation = utils.clampNumber(result.rotation, -180, 180, 0);
    }
    if (result.type === 'arrow') {
      result.arrow = ARROW_OPTIONS.some(function (entry) { return entry.value === result.arrow; }) ? result.arrow : 'arrow';
      result.rotation = utils.clampNumber(result.rotation, -180, 180, 0);
    }
    return result;
  }

  function normalizeProjectEntry(entry) {
    var safeEntry = entry && typeof entry === 'object' ? entry : {};
    var normalizedProject = normalizeProject(safeEntry.project || safeEntry);
    var projectId = String(safeEntry.project_id || normalizedProject.project_id || uid('overlay-project'));
    normalizedProject.project_id = projectId;
    return {
      project_id: projectId,
      title: String(safeEntry.title || normalizedProject.title || 'Untitled overlay project').trim() || 'Untitled overlay project',
      created_at: Number(safeEntry.created_at || now()),
      updated_at: Number(safeEntry.updated_at || now()),
      project: normalizedProject
    };
  }

  function normalizeProjectLibrary(rawLibrary) {
    var source = rawLibrary && typeof rawLibrary === 'object' ? rawLibrary : {};
    var seen = {};
    var projects = (Array.isArray(source.projects) ? source.projects : []).map(normalizeProjectEntry).filter(function (entry) {
      if (!entry.project_id || seen[entry.project_id]) return false;
      seen[entry.project_id] = true;
      return true;
    }).slice(0, MAX_PROJECTS);
    if (!projects.length) {
      var emptyProject = createEmptyProject();
      projects.push(normalizeProjectEntry({
        project_id: emptyProject.project_id,
        title: emptyProject.title,
        project: emptyProject,
        created_at: now(),
        updated_at: now()
      }));
    }
    var requestedProjectId = getRequestedProjectId();
    var activeProjectId = requestedProjectId || String(source.activeProjectId || projects[0].project_id);
    if (!projects.some(function (entry) { return entry.project_id === activeProjectId; })) activeProjectId = projects[0].project_id;
    return {
      activeProjectId: activeProjectId,
      projects: projects
    };
  }

  function readUserProjectLibrary(user) {
    if (!user || !user.uid) return normalizeProjectLibrary(null);
    if (typeof userCache.getUserJson === 'function') {
      return normalizeProjectLibrary(userCache.getUserJson(user, PROJECTS_CACHE_KEY, null, uiCache));
    }
    return normalizeProjectLibrary(null);
  }

  function writeUserProjectLibrary(user, library) {
    if (!user || !user.uid) return false;
    if (typeof userCache.setUserJson === 'function') {
      return userCache.setUserJson(user, PROJECTS_CACHE_KEY, library, uiCache);
    }
    return false;
  }

  function readGuestProjectLibrary() {
    try {
      var saved = window.localStorage ? JSON.parse(window.localStorage.getItem(GUEST_STORAGE_KEY) || 'null') : null;
      return normalizeProjectLibrary(saved);
    } catch (_error) {
      return normalizeProjectLibrary(null);
    }
  }

  function writeGuestProjectLibrary(library) {
    try {
      if (!window.localStorage) return false;
      window.localStorage.setItem(GUEST_STORAGE_KEY, JSON.stringify(library));
      return true;
    } catch (_error) {
      return false;
    }
  }

  function getActiveProjectEntry() {
    var entry = projectLibrary.projects.find(function (candidate) {
      return candidate.project_id === projectLibrary.activeProjectId;
    });
    if (entry) return entry;
    projectLibrary.activeProjectId = projectLibrary.projects[0].project_id;
    return projectLibrary.projects[0];
  }

  function syncProjectFromLibrary() {
    var entry = getActiveProjectEntry();
    project = normalizeProject(entry.project);
    project.project_id = entry.project_id;
    project.title = entry.title || project.title;
    activeSlideId = project.activeSlideId || (project.slides[0] && project.slides[0].id);
    selectedItemId = '';
  }

  function updateCurrentProjectEntry() {
    var entry = getActiveProjectEntry();
    project.activeSlideId = activeSlideId;
    entry.title = project.title;
    entry.updated_at = now();
    entry.project = clone(project);
    projectLibrary.activeProjectId = entry.project_id;
    projectLibrary.projects = [entry].concat(projectLibrary.projects.filter(function (candidate) {
      return candidate.project_id !== entry.project_id;
    })).slice(0, MAX_PROJECTS);
  }

  function persistProjectLibrary(silent) {
    updateCurrentProjectEntry();
    var ok = currentUser && currentUser.uid
      ? writeUserProjectLibrary(currentUser, projectLibrary)
      : writeGuestProjectLibrary(projectLibrary);
    if (!ok) {
      setStatus('Project is too large to save locally. Export JSON instead.', 'error');
      return false;
    }
    if (!silent) setStatus(currentUser ? 'Project saved in Study Library.' : 'Local project saved on this browser.', 'success');
    try {
      window.dispatchEvent(new CustomEvent('video-overlay-projects-updated'));
    } catch (_error) {}
    return true;
  }

  function saveProject() {
    persistProjectLibrary(false);
    renderProjects();
  }

  function queuePersist() {
    if (persistTimer) window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(function () {
      persistTimer = null;
      persistProjectLibrary(true);
      renderProjects();
    }, 450);
  }

  function setStatus(message, type, autoClearMs) {
    if (!refs.status) return;
    if (statusTimer) {
      window.clearTimeout(statusTimer);
      statusTimer = null;
    }
    refs.status.textContent = String(message || '');
    refs.status.className = type ? ('status ' + type) : 'status';
    if (message && autoClearMs) {
      statusTimer = window.setTimeout(function () {
        statusTimer = null;
        if (refs.status.textContent === String(message || '')) {
          refs.status.textContent = '';
          refs.status.className = 'status';
        }
      }, autoClearMs);
    }
  }

  function setRecordingStatus(message, autoClearMs) {
    if (!refs.recordingStatus) return;
    if (recordingStatusTimer) {
      window.clearTimeout(recordingStatusTimer);
      recordingStatusTimer = null;
    }
    refs.recordingStatus.textContent = String(message || '');
    if (message && autoClearMs) {
      recordingStatusTimer = window.setTimeout(function () {
        recordingStatusTimer = null;
        if (refs.recordingStatus.textContent === String(message || '')) refs.recordingStatus.textContent = '';
      }, autoClearMs);
    }
  }

  function getActiveSlide() {
    if (!project.slides.length) {
      var slide = createEmptyProject().slides[0];
      project.slides.push(slide);
      activeSlideId = slide.id;
    }
    var activeSlide = project.slides.find(function (entry) { return entry.id === activeSlideId; });
    if (activeSlide) return activeSlide;
    activeSlideId = project.slides[0].id;
    return project.slides[0];
  }

  function getSelectedItem() {
    var slide = getActiveSlide();
    return slide.items.find(function (item) { return item.id === selectedItemId; }) || null;
  }

  function getColor(colorId) {
    return COLORS.find(function (entry) { return entry.id === colorId; }) || COLORS[0];
  }

  function escapeName(name) {
    return String(name || 'video-overlay').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'video-overlay';
  }

  function formatProjectDate(timestamp) {
    var value = Number(timestamp || 0);
    if (!value) return 'Not saved yet';
    try {
      return new Date(value).toLocaleString(navigator.language || 'en-US', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (_error) {
      return 'Saved locally';
    }
  }

  function setProjectTitle(value) {
    project.title = String(value || '').trim() || 'Untitled overlay project';
    renderStageLabel();
    queuePersist();
  }

  function render() {
    renderProjectHeader();
    renderProjects();
    renderSlides();
    renderStage();
    renderItems();
    renderInspector();
    updateSlideNavigation();
    updateAuthStateText();
    updateRecordingButtons();
    updateStageZoom();
  }

  function renderProjectHeader() {
    if (refs.projectTitle && refs.projectTitle.value !== project.title) refs.projectTitle.value = project.title;
  }

  function updateAuthStateText() {
    if (!refs.authState) return;
    refs.authState.textContent = currentUser && currentUser.uid
      ? 'Projects save to your pinned Video Overlay Projects folder in Study Library.'
      : 'Empty local workspace. Sign in to save projects in Study Library.';
  }

  function renderProjects() {
    if (!refs.projectList) return;
    var fragment = document.createDocumentFragment();
    projectLibrary.projects.forEach(function (entry, index) {
      var li = document.createElement('li');
      li.className = 'overlay-project-row' + (entry.project_id === projectLibrary.activeProjectId ? ' active' : '');
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'overlay-project-main';
      button.dataset.projectId = entry.project_id;
      button.innerHTML = '<span class="overlay-project-badge"></span><span class="overlay-project-copy"><strong></strong><span></span></span>';
      button.querySelector('.overlay-project-badge').textContent = String(index + 1);
      button.querySelector('strong').textContent = entry.title || 'Untitled overlay project';
      button.querySelector('.overlay-project-copy span').textContent = formatProjectDate(entry.updated_at);
      li.appendChild(button);
      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'overlay-icon-btn danger';
      remove.dataset.deleteProjectId = entry.project_id;
      remove.disabled = projectLibrary.projects.length <= 1;
      remove.setAttribute('aria-label', 'Delete project');
      remove.innerHTML = iconSvg('trash');
      li.appendChild(remove);
      fragment.appendChild(li);
    });
    refs.projectList.replaceChildren(fragment);
  }

  function renderStageLabel() {
    var slide = getActiveSlide();
    if (refs.stageLabel) {
      var slideIndex = getActiveSlideIndex() + 1;
      refs.stageLabel.textContent = project.title + ' / Slide ' + slideIndex + ' of ' + project.slides.length + ' / ' + slide.title;
    }
  }

  function renderSlides() {
    var fragment = document.createDocumentFragment();
    project.slides.forEach(function (slide, index) {
      var item = document.createElement('li');
      item.className = 'overlay-slide-row' + (slide.id === activeSlideId ? ' active' : '');
      item.dataset.slideRowId = slide.id;
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'overlay-slide-main';
      button.dataset.slideId = slide.id;
      button.setAttribute('aria-current', slide.id === activeSlideId ? 'true' : 'false');
      button.innerHTML = '<span class="overlay-slide-drag" aria-hidden="true"><span></span><span></span><span></span></span><span class="overlay-slide-number"></span><span class="overlay-slide-copy"><strong></strong><span></span></span>';
      button.querySelector('.overlay-slide-number').textContent = String(index + 1);
      button.querySelector('strong').textContent = slide.title;
      button.querySelector('.overlay-slide-copy span').textContent = slide.items.length + ' overlay' + (slide.items.length === 1 ? '' : 's') + ' / ' + slide.duration + 's';
      var actions = document.createElement('div');
      actions.className = 'overlay-slide-actions';
      var duplicate = document.createElement('button');
      duplicate.type = 'button';
      duplicate.className = 'overlay-icon-btn';
      duplicate.dataset.duplicateSlideId = slide.id;
      duplicate.setAttribute('aria-label', 'Duplicate slide');
      duplicate.innerHTML = iconSvg('copy');
      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'overlay-icon-btn danger';
      remove.dataset.deleteSlideId = slide.id;
      remove.disabled = project.slides.length <= 1;
      remove.setAttribute('aria-label', 'Delete slide');
      remove.innerHTML = iconSvg('trash');
      actions.appendChild(duplicate);
      actions.appendChild(remove);
      item.appendChild(button);
      item.appendChild(actions);
      fragment.appendChild(item);
    });
    refs.slideList.replaceChildren(fragment);
  }

  function renderStage() {
    var slide = getActiveSlide();
    renderStageLabel();
    stopPreview(false);
    var fragment = document.createDocumentFragment();
    slide.items.forEach(function (item, index) {
      fragment.appendChild(createStageItem(item, index));
    });
    refs.stage.replaceChildren(fragment);
    syncDynamicRules(slide);
    scheduleAutoFitAll();
  }

  function createStageItem(item, index) {
    var color = getColor(item.color);
    var node = document.createElement('article');
    node.className = [
      'overlay-stage-item',
      'overlay-type-' + item.type,
      'overlay-color-' + color.id,
      item.type === 'image' ? 'overlay-image-fit-' + (item.fit || 'contain') : '',
      item.type === 'image' ? 'overlay-image-edge-' + (item.edge || 'accent') : '',
      item.id === selectedItemId ? 'is-selected' : ''
    ].filter(Boolean).join(' ');
    node.dataset.itemId = item.id;
    node.dataset.stageIndex = String(index);
    node.dataset.animation = item.animation;
    node.appendChild(createStageItemBody(item));
    var meta = document.createElement('div');
    meta.className = 'overlay-stage-item-meta';
    meta.textContent = formatTimingMeta(item);
    node.appendChild(meta);

    var resize = document.createElement('button');
    resize.type = 'button';
    resize.className = 'overlay-resize-handle';
    resize.dataset.resizeItemId = item.id;
    resize.setAttribute('aria-label', 'Resize overlay');
    resize.innerHTML = iconSvg('corner');
    node.appendChild(resize);
    return node;
  }

  function createStageItemBody(item) {
    var body = document.createElement('div');
    body.className = 'overlay-stage-item-body';
    if (item.type === 'table') {
      renderTableItem(body, item);
    } else if (item.type === 'flow') {
      renderFlowItem(body, item);
    } else if (item.type === 'image') {
      renderImageItem(body, item);
    } else if (item.type === 'shape') {
      renderShapeItem(body, item);
    } else if (item.type === 'arrow') {
      renderArrowItem(body, item);
    } else {
      renderTextItem(body, item);
    }
    return body;
  }

  function makeEditable(tagName, className, text, itemId, field) {
    var node = document.createElement(tagName);
    node.className = className;
    node.textContent = text;
    node.contentEditable = 'true';
    node.spellcheck = false;
    node.dataset.itemId = itemId;
    node.dataset.editField = field;
    node.setAttribute('role', 'textbox');
    if (!String(text || '').trim()) {
      node.dataset.placeholder = field === 'body' ? 'Type overlay text...' : 'Type here...';
    }
    return node;
  }

  function renderTextItem(container, item) {
    var title = makeEditable('h2', 'overlay-card-title', item.title, item.id, 'title');
    var body = makeEditable('p', 'overlay-card-body', item.body || '', item.id, 'body');
    container.appendChild(title);
    container.appendChild(body);
  }

  function renderTableItem(container, item) {
    var title = makeEditable('div', 'overlay-table-title', item.title, item.id, 'title');
    var tableData = utils.normalizeTableData(item.table);
    item.table = tableData;
    var tableWrap = document.createElement('div');
    tableWrap.className = 'overlay-table-wrap';
    var table = document.createElement('table');
    table.className = 'overlay-table';
    tableData.cells.forEach(function (row, rowIndex) {
      var tr = document.createElement('tr');
      row.forEach(function (cell, colIndex) {
        var cellNode = document.createElement(rowIndex === 0 ? 'th' : 'td');
        cellNode.contentEditable = 'true';
        cellNode.spellcheck = false;
        cellNode.textContent = cell;
        cellNode.dataset.itemId = item.id;
        cellNode.dataset.tableRow = String(rowIndex);
        cellNode.dataset.tableCol = String(colIndex);
        cellNode.setAttribute('role', 'textbox');
        tr.appendChild(cellNode);
      });
      table.appendChild(tr);
    });
    tableWrap.appendChild(table);
    container.appendChild(title);
    container.appendChild(tableWrap);
  }

  function renderFlowItem(container, item) {
    var title = makeEditable('div', 'overlay-flow-title', item.title, item.id, 'title');
    var stepsWrap = document.createElement('div');
    stepsWrap.className = 'overlay-flow-steps';
    (item.steps || ['Step 1']).forEach(function (step, index) {
      var stepNode = makeEditable('div', 'overlay-flow-step', step, item.id, 'step');
      stepNode.dataset.stepIndex = String(index);
      stepsWrap.appendChild(stepNode);
      if (index < item.steps.length - 1) {
        var connector = document.createElement('span');
        connector.className = 'overlay-flow-connector';
        connector.setAttribute('aria-hidden', 'true');
        connector.innerHTML = iconSvg('arrow-right');
        stepsWrap.appendChild(connector);
      }
    });
    container.appendChild(title);
    container.appendChild(stepsWrap);
  }

  function renderImageItem(container, item) {
    if (item.src) {
      var image = document.createElement('img');
      image.src = item.src;
      image.alt = item.alt || '';
      image.draggable = false;
      container.appendChild(image);
      return;
    }
    var placeholder = document.createElement('div');
    placeholder.className = 'overlay-image-placeholder';
    placeholder.innerHTML = iconSvg('image') + '<span>No image selected</span>';
    container.appendChild(placeholder);
  }

  function renderShapeItem(container, item) {
    var wrap = document.createElement('div');
    wrap.className = 'overlay-shape-wrap';
    var shape = document.createElement('div');
    shape.className = 'overlay-shape overlay-shape-' + (item.shape || 'rounded');
    shape.setAttribute('aria-label', item.title || 'Shape');
    wrap.appendChild(shape);
    container.appendChild(wrap);
  }

  function renderArrowItem(container, item) {
    var wrap = document.createElement('div');
    wrap.className = 'overlay-arrow-wrap';
    wrap.innerHTML = arrowSvg(item.arrow || 'arrow');
    container.appendChild(wrap);
  }

  function formatTimingMeta(item) {
    var delay = Math.round(utils.clampNumber(item.delay, 0, 600, 0) * 10) / 10;
    var duration = Math.round(utils.clampNumber(item.duration, 0.1, 10, 0.55) * 10) / 10;
    var animation = (ANIMATION_OPTIONS.find(function (entry) { return entry.value === item.animation; }) || ANIMATION_OPTIONS[0]).label;
    return '+' + delay + 's / ' + duration + 's / ' + animation;
  }

  function renderItems() {
    var slide = getActiveSlide();
    var fragment = document.createDocumentFragment();
    if (!slide.items.length) {
      var empty = document.createElement('li');
      empty.className = 'overlay-empty-row';
      empty.textContent = 'No overlays yet.';
      fragment.appendChild(empty);
    }
    slide.items.forEach(function (item, index) {
      var li = document.createElement('li');
      li.className = 'overlay-item-row' + (item.id === selectedItemId ? ' active' : '');
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'overlay-item-main';
      button.dataset.itemId = item.id;
      button.innerHTML = '<span class="overlay-item-type"></span><span class="overlay-item-copy"><strong></strong><span></span></span>';
      button.querySelector('.overlay-item-type').textContent = String(index + 1);
      button.querySelector('strong').textContent = item.title;
      button.querySelector('.overlay-item-copy span').textContent = utils.summarizeItem(item) + ' / +' + item.delay + 's';
      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'overlay-icon-btn danger';
      remove.dataset.deleteItemId = item.id;
      remove.setAttribute('aria-label', 'Delete overlay');
      remove.innerHTML = iconSvg('trash');
      li.appendChild(button);
      li.appendChild(remove);
      fragment.appendChild(li);
    });
    refs.itemList.replaceChildren(fragment);
  }

  function renderInspector() {
    var slide = getActiveSlide();
    var item = getSelectedItem();
    refs.inspector.replaceChildren();
    if (!item) {
      refs.inspector.appendChild(createSlideInspector(slide));
      return;
    }
    refs.inspector.appendChild(createItemInspector(slide, item));
  }

  function createSlideInspector(slide) {
    var wrap = document.createElement('div');
    wrap.className = 'overlay-inspector-stack';
    wrap.innerHTML = [
      '<div class="overlay-inspector-head"><strong>Slide Settings</strong><span>No overlay selected</span></div>',
      '<label class="overlay-field"><span>Slide title</span><input type="text" data-slide-field="title"></label>',
      '<label class="overlay-field"><span>Duration seconds</span><input type="number" min="1" max="600" step="1" data-slide-field="duration"></label>'
    ].join('');
    wrap.querySelector('[data-slide-field="title"]').value = slide.title;
    wrap.querySelector('[data-slide-field="duration"]').value = slide.duration;
    bindInput(wrap, '[data-slide-field="title"]', function (value) {
      slide.title = value.trim() || 'Untitled slide';
      renderSlides();
      renderStageLabel();
      queuePersist();
    });
    bindInput(wrap, '[data-slide-field="duration"]', function (value) {
      slide.duration = utils.clampNumber(value, 1, 600, slide.duration);
      renderSlides();
      syncDynamicRules(slide);
      queuePersist();
    });
    return wrap;
  }

  function createItemInspector(slide, item) {
    var wrap = document.createElement('div');
    wrap.className = 'overlay-inspector-stack';
    wrap.appendChild(createCommonInspector(item));
    if (item.type === 'table') wrap.appendChild(createTableInspector(item));
    if (item.type === 'flow') wrap.appendChild(createFlowInspector(item));
    if (item.type === 'image') wrap.appendChild(createImageInspector(item));
    if (item.type === 'shape') wrap.appendChild(createShapeInspector(item));
    if (item.type === 'arrow') wrap.appendChild(createArrowInspector(item));

    var actions = document.createElement('div');
    actions.className = 'overlay-action-row';
    if (['shape', 'arrow', 'image'].indexOf(item.type) < 0) {
      var fit = document.createElement('button');
      fit.type = 'button';
      fit.className = 'secondary-btn';
      fit.dataset.fitItem = '';
      fit.textContent = 'Fit to content';
      fit.addEventListener('click', function () {
        fitItemToContent(item, true);
        renderInspector();
        queuePersist();
      });
      actions.appendChild(fit);
    }
    var duplicate = document.createElement('button');
    duplicate.type = 'button';
    duplicate.className = 'secondary-btn';
    duplicate.dataset.duplicateItem = '';
    duplicate.textContent = 'Duplicate';
    actions.appendChild(duplicate);
    var remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'ghost-btn danger-text';
    remove.dataset.deleteSelected = '';
    remove.textContent = 'Delete';
    actions.appendChild(remove);
    actions.querySelector('[data-duplicate-item]').addEventListener('click', function () {
      duplicateItem(item.id);
    });
    actions.querySelector('[data-delete-selected]').addEventListener('click', function () {
      deleteItem(item.id);
    });
    wrap.appendChild(actions);
    return wrap;
  }

  function createCommonInspector(item) {
    var wrap = document.createElement('section');
    wrap.className = 'overlay-control-section';
    wrap.innerHTML = [
      '<div class="overlay-inspector-head"><strong>Overlay</strong><span></span></div>',
      '<label class="overlay-field"><span>Title</span><input type="text" data-item-field="title"></label>',
      '<div class="overlay-field-grid compact">',
      '<label class="overlay-field"><span>X</span><input type="number" min="0" max="96" step="0.5" data-item-field="x"></label>',
      '<label class="overlay-field"><span>Y</span><input type="number" min="0" max="90" step="0.5" data-item-field="y"></label>',
      '<label class="overlay-field"><span>W</span><input type="number" min="8" max="96" step="0.5" data-item-field="w"></label>',
      '<label class="overlay-field"><span>H</span><input type="number" min="8" max="92" step="0.5" data-item-field="h"></label>',
      '</div>',
      '<div class="overlay-field-grid">',
      '<label class="overlay-field"><span>Delay</span><input type="number" min="0" max="600" step="0.1" data-item-field="delay"></label>',
      '<label class="overlay-field"><span>Duration</span><input type="number" min="0.1" max="10" step="0.05" data-item-field="duration"></label>',
      '</div>'
    ].join('');
    wrap.querySelector('.overlay-inspector-head span').textContent = utils.summarizeItem(item);
    ['title', 'x', 'y', 'w', 'h', 'delay', 'duration'].forEach(function (field) {
      var input = wrap.querySelector('[data-item-field="' + field + '"]');
      input.value = item[field];
      input.addEventListener('input', function () {
        setItemField(item, field, input.value);
      });
      input.addEventListener('change', function () {
        setItemField(item, field, input.value);
      });
    });
    wrap.appendChild(createCustomSelect('Animation', item.animation, ANIMATION_OPTIONS, function (value) {
      setItemField(item, 'animation', value);
    }));
    if (item.type === 'image' && item.edge === 'glass') {
      wrap.appendChild(createDisabledSelectField('Color', 'Disabled for glass edge'));
    } else {
      wrap.appendChild(createCustomSelect('Color', item.color, COLORS.map(function (color) {
        return { value: color.id, label: color.label };
      }), function (value) {
        setItemField(item, 'color', value);
      }));
    }
    if (item.type === 'shape' || item.type === 'arrow') {
      var rotation = document.createElement('label');
      rotation.className = 'overlay-field';
      rotation.innerHTML = '<span>Rotation</span><input type="number" min="-180" max="180" step="1" data-item-field="rotation">';
      var rotationInput = rotation.querySelector('[data-item-field="rotation"]');
      rotationInput.value = item.rotation || 0;
      rotationInput.addEventListener('input', function () { setItemField(item, 'rotation', rotationInput.value); });
      rotationInput.addEventListener('change', function () { setItemField(item, 'rotation', rotationInput.value); });
      wrap.appendChild(rotation);
    }
    return wrap;
  }

  function createTableInspector(item) {
    var tableData = utils.normalizeTableData(item.table);
    var wrap = document.createElement('section');
    wrap.className = 'overlay-control-section';
    wrap.innerHTML = [
      '<div class="overlay-inspector-head"><strong>Table</strong><span></span></div>',
      '<div class="overlay-field-grid">',
      '<label class="overlay-field"><span>Rows</span><input type="number" min="1" max="8" step="1" data-table-rows></label>',
      '<label class="overlay-field"><span>Columns</span><input type="number" min="1" max="8" step="1" data-table-cols></label>',
      '</div>',
      '<div class="overlay-action-row wrap">',
      '<button type="button" class="ghost-btn" data-table-add-row>Add row</button>',
      '<button type="button" class="ghost-btn" data-table-add-col>Add column</button>',
      '<button type="button" class="ghost-btn" data-table-remove-row>Remove row</button>',
      '<button type="button" class="ghost-btn" data-table-remove-col>Remove column</button>',
      '</div>'
    ].join('');
    wrap.querySelector('.overlay-inspector-head span').textContent = tableData.rowCount + ' x ' + tableData.colCount;
    var rowInput = wrap.querySelector('[data-table-rows]');
    var colInput = wrap.querySelector('[data-table-cols]');
    rowInput.value = tableData.rowCount;
    colInput.value = tableData.colCount;
    function applyInputSize() {
      resizeSelectedTable(item, rowInput.value, colInput.value, true);
      var updated = utils.normalizeTableData(item.table);
      rowInput.value = updated.rowCount;
      colInput.value = updated.colCount;
      wrap.querySelector('.overlay-inspector-head span').textContent = updated.rowCount + ' x ' + updated.colCount;
    }
    rowInput.addEventListener('input', applyInputSize);
    colInput.addEventListener('input', applyInputSize);
    rowInput.addEventListener('change', applyInputSize);
    colInput.addEventListener('change', applyInputSize);
    wrap.querySelector('[data-table-add-row]').addEventListener('click', function () {
      var current = utils.normalizeTableData(item.table);
      resizeSelectedTable(item, current.rowCount + 1, current.colCount);
    });
    wrap.querySelector('[data-table-add-col]').addEventListener('click', function () {
      var current = utils.normalizeTableData(item.table);
      resizeSelectedTable(item, current.rowCount, current.colCount + 1);
    });
    wrap.querySelector('[data-table-remove-row]').addEventListener('click', function () {
      var current = utils.normalizeTableData(item.table);
      resizeSelectedTable(item, current.rowCount - 1, current.colCount);
    });
    wrap.querySelector('[data-table-remove-col]').addEventListener('click', function () {
      var current = utils.normalizeTableData(item.table);
      resizeSelectedTable(item, current.rowCount, current.colCount - 1);
    });
    return wrap;
  }

  function createFlowInspector(item) {
    var wrap = document.createElement('section');
    wrap.className = 'overlay-control-section';
    wrap.innerHTML = [
      '<div class="overlay-inspector-head"><strong>Flow Steps</strong><span>One step per line</span></div>',
      '<label class="overlay-field"><span>Steps</span><textarea rows="5" data-flow-steps></textarea></label>'
    ].join('');
    var textarea = wrap.querySelector('[data-flow-steps]');
    textarea.value = (item.steps || []).join('\n');
    textarea.addEventListener('input', function () {
      item.steps = textarea.value.split('\n').map(function (line) {
        return line.trim();
      }).filter(Boolean);
      if (!item.steps.length) item.steps = ['Step 1'];
      renderStage();
      renderItems();
      queuePersist();
    });
    return wrap;
  }

  function createImageInspector(item) {
    var wrap = document.createElement('section');
    wrap.className = 'overlay-control-section';
    wrap.innerHTML = [
      '<div class="overlay-inspector-head"><strong>Image</strong><span></span></div>',
      '<label class="overlay-field"><span>Alt text</span><input type="text" data-image-alt></label>',
      '<button type="button" class="secondary-btn" data-replace-image>Replace image</button>'
    ].join('');
    wrap.querySelector('.overlay-inspector-head span').textContent = item.src ? 'Image selected' : 'No image selected';
    wrap.querySelector('[data-image-alt]').value = item.alt || '';
    bindInput(wrap, '[data-image-alt]', function (value) {
      item.alt = value;
      queuePersist();
    });
    wrap.appendChild(createCustomSelect('Fit', item.fit || 'contain', [
      { value: 'contain', label: 'Contain' },
      { value: 'cover', label: 'Cover' }
    ], function (value) {
      item.fit = value === 'cover' ? 'cover' : 'contain';
      renderStage();
      queuePersist();
    }));
    wrap.appendChild(createCustomSelect('Edge', item.edge || 'accent', [
      { value: 'accent', label: 'Accent edge' },
      { value: 'glass', label: 'Glass edge' }
    ], function (value) {
      item.edge = value === 'glass' ? 'glass' : 'accent';
      renderStage();
      renderInspector();
      queuePersist();
    }));
    wrap.querySelector('[data-replace-image]').addEventListener('click', function () {
      imageTargetItemId = item.id;
      refs.imageInput.click();
    });
    return wrap;
  }

  function createShapeInspector(item) {
    var wrap = document.createElement('section');
    wrap.className = 'overlay-control-section overlay-color-' + item.color;
    wrap.innerHTML = '<div class="overlay-inspector-head"><strong>Shape</strong><span>Choose a symbol</span></div>';
    wrap.appendChild(createChoiceGrid(SHAPE_OPTIONS, item.shape || 'rounded', 'Shape', function (entry) {
      return '<span class="overlay-choice-swatch overlay-shape-' + entry.value + '" aria-hidden="true"></span>';
    }, function (value) {
      item.shape = value;
      renderStage();
      renderInspector();
      queuePersist();
    }));
    return wrap;
  }

  function createArrowInspector(item) {
    var wrap = document.createElement('section');
    wrap.className = 'overlay-control-section overlay-color-' + item.color;
    wrap.innerHTML = '<div class="overlay-inspector-head"><strong>Arrow</strong><span>Draws during preview</span></div>';
    wrap.appendChild(createChoiceGrid(ARROW_OPTIONS, item.arrow || 'arrow', 'Arrow style', function (entry) {
      return '<span class="overlay-choice-arrow" aria-hidden="true">' + arrowSvg(entry.value) + '</span>';
    }, function (value) {
      item.arrow = value;
      renderStage();
      renderInspector();
      queuePersist();
    }));
    return wrap;
  }

  function createChoiceGrid(options, value, label, renderContent, onChange) {
    var grid = document.createElement('div');
    grid.className = 'overlay-choice-grid';
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', label);
    options.forEach(function (entry) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'overlay-choice-button';
      button.setAttribute('aria-label', entry.label);
      button.setAttribute('aria-pressed', entry.value === value ? 'true' : 'false');
      button.title = entry.label;
      button.innerHTML = renderContent(entry);
      button.addEventListener('click', function () {
        if (entry.value === value) return;
        onChange(entry.value);
      });
      grid.appendChild(button);
    });
    return grid;
  }

  function createDisabledSelectField(labelText, valueText) {
    var field = document.createElement('div');
    field.className = 'overlay-field';
    var label = document.createElement('span');
    label.textContent = labelText;
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'app-select-button is-disabled';
    button.disabled = true;
    button.innerHTML = '<span class="app-select-label"></span>';
    button.querySelector('.app-select-label').textContent = valueText;
    field.appendChild(label);
    field.appendChild(button);
    return field;
  }

  function createCustomSelect(labelText, value, options, onChange) {
    var field = document.createElement('div');
    field.className = 'overlay-field';
    var label = document.createElement('span');
    label.textContent = labelText;
    var root = document.createElement('div');
    root.className = 'app-select';
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'app-select-button';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML = '<span class="app-select-label"></span>' + iconSvg('chevron-down');
    var menu = document.createElement('div');
    menu.className = 'app-select-menu';
    menu.setAttribute('role', 'listbox');
    root.appendChild(button);
    root.appendChild(menu);
    field.appendChild(label);
    field.appendChild(root);

    function selectedLabel(nextValue) {
      var selected = options.find(function (option) { return String(option.value) === String(nextValue); }) || options[0];
      return selected ? selected.label : '';
    }
    function setOpen(open, focusMode) {
      closeCustomSelects(root);
      var shouldOpen = !!open;
      menu.classList.toggle('visible', shouldOpen);
      button.classList.toggle('open', shouldOpen);
      button.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
      openSelectRoot = shouldOpen ? root : null;
      if (shouldOpen && focusMode) focusMenuItem(menu, '.app-select-item', focusMode);
    }
    function renderOptions(currentValue) {
      menu.replaceChildren();
      options.forEach(function (option) {
        var item = document.createElement('button');
        item.type = 'button';
        item.className = 'app-select-item' + (String(option.value) === String(currentValue) ? ' active' : '');
        item.dataset.value = option.value;
        item.textContent = option.label;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(option.value) === String(currentValue) ? 'true' : 'false');
        item.addEventListener('click', function () {
          button.querySelector('.app-select-label').textContent = selectedLabel(option.value);
          setOpen(false);
          if (typeof onChange === 'function') onChange(option.value);
          button.focus();
        });
        menu.appendChild(item);
      });
    }

    button.querySelector('.app-select-label').textContent = selectedLabel(value);
    renderOptions(value);
    button.addEventListener('click', function (event) {
      event.stopPropagation();
      setOpen(!menu.classList.contains('visible'), 'active');
    });
    button.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true, 'first'); }
      if (event.key === 'ArrowUp') { event.preventDefault(); setOpen(true, 'last'); }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setOpen(!menu.classList.contains('visible'), 'active');
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
      }
    });
    menu.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowDown') { event.preventDefault(); focusMenuItem(menu, '.app-select-item', 'next'); }
      if (event.key === 'ArrowUp') { event.preventDefault(); focusMenuItem(menu, '.app-select-item', 'prev'); }
      if (event.key === 'Home') { event.preventDefault(); focusMenuItem(menu, '.app-select-item', 'first'); }
      if (event.key === 'End') { event.preventDefault(); focusMenuItem(menu, '.app-select-item', 'last'); }
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        button.focus();
      }
      if (event.key === 'Tab') setOpen(false);
    });
    return field;
  }

  function closeCustomSelects(exceptRoot) {
    Array.prototype.slice.call(document.querySelectorAll('.overlay-builder-page .app-select')).forEach(function (root) {
      if (exceptRoot && root === exceptRoot) return;
      var button = root.querySelector('.app-select-button');
      var menu = root.querySelector('.app-select-menu');
      if (button) {
        button.classList.remove('open');
        button.setAttribute('aria-expanded', 'false');
      }
      if (menu) menu.classList.remove('visible');
    });
    if (!exceptRoot) openSelectRoot = null;
  }

  function getVisibleMenuItems(menu, selector) {
    if (uxUtils.getVisibleMenuItems) return uxUtils.getVisibleMenuItems(menu, selector || 'button:not([disabled])');
    if (!menu) return [];
    return Array.prototype.slice.call(menu.querySelectorAll(selector || 'button:not([disabled])')).filter(function (item) {
      return !item.disabled;
    });
  }

  function focusMenuItem(menu, selector, mode) {
    if (uxUtils.focusMenuItem) {
      uxUtils.focusMenuItem(menu, selector, mode);
      return;
    }
    var items = getVisibleMenuItems(menu, selector);
    if (!items.length) return;
    if (mode === 'last') {
      items[items.length - 1].focus();
      return;
    }
    var active = document.activeElement;
    var index = items.indexOf(active);
    if (mode === 'next') {
      items[(index + 1 + items.length) % items.length].focus();
      return;
    }
    if (mode === 'prev') {
      items[(index - 1 + items.length) % items.length].focus();
      return;
    }
    if (mode === 'active') {
      var selected = items.find(function (item) { return item.classList.contains('active') || item.getAttribute('aria-selected') === 'true'; });
      (selected || items[0]).focus();
      return;
    }
    items[0].focus();
  }

  function bindInput(root, selector, handler) {
    var input = root.querySelector(selector);
    if (!input) return;
    input.addEventListener('input', function () { handler(input.value); });
    input.addEventListener('change', function () { handler(input.value); });
  }

  function setItemField(item, field, value) {
    var refreshInspector = false;
    if (field === 'x' || field === 'y' || field === 'w' || field === 'h' || field === 'delay' || field === 'duration') {
      var min = field === 'duration' ? 0.1 : 0;
      var max = field === 'duration' ? 10 : (field === 'delay' ? 600 : (field === 'h' ? 92 : 96));
      if (field === 'w') min = 8;
      if (field === 'h') min = 8;
      if (field === 'y') max = 90;
      item[field] = roundToHalf(utils.clampNumber(value, min, max, item[field]));
      if (field === 'x' || field === 'y' || field === 'w' || field === 'h') clampItemGeometry(item);
    } else if (field === 'animation') {
      item.animation = utils.normalizeAnimation(value);
    } else if (field === 'color') {
      item.color = COLORS.some(function (entry) { return entry.id === value; }) ? value : item.color;
      refreshInspector = true;
    } else if (field === 'rotation') {
      item.rotation = Math.round(utils.clampNumber(value, -180, 180, item.rotation || 0));
    } else {
      item[field] = String(value || '').trim() || item[field];
    }
    renderStage();
    renderItems();
    if (refreshInspector) renderInspector();
    queuePersist();
  }

  function resizeSelectedTable(item, rows, cols, keepInspector) {
    item.table = utils.resizeTableData(item.table, rows, cols);
    renderStage();
    renderItems();
    if (!keepInspector) renderInspector();
    queuePersist();
  }

  function roundToHalf(value) {
    return Math.round(Number(value || 0) * 2) / 2;
  }

  function roundToTenth(value) {
    return Math.round(Number(value || 0) * 10) / 10;
  }

  function cssNumber(value, min, max, fallbackValue) {
    return String(Math.round(utils.clampNumber(value, min, max, fallbackValue) * 1000) / 1000);
  }

  function cssSeconds(value, min, max, fallbackValue) {
    return cssNumber(value, min, max, fallbackValue) + 's';
  }

  function cssPercent(value, min, max, fallbackValue) {
    return cssNumber(value, min, max, fallbackValue) + '%';
  }

  function clampItemGeometry(item) {
    item.w = roundToTenth(utils.clampNumber(item.w, 8, 96, 42));
    item.h = roundToTenth(utils.clampNumber(item.h, 8, 92, item.type === 'table' ? 28 : 24));
    item.x = roundToTenth(utils.clampNumber(item.x, 0, Math.max(0, 100 - item.w), 8));
    item.y = roundToTenth(utils.clampNumber(item.y, 0, Math.max(0, 100 - item.h), 10));
    item.w = roundToTenth(utils.clampNumber(item.w, 8, Math.max(8, 100 - item.x), item.w));
    item.h = roundToTenth(utils.clampNumber(item.h, 8, Math.max(8, 100 - item.y), item.h));
    return item;
  }

  function getDynamicStyleSheet() {
    if (dynamicStyleSheet) return dynamicStyleSheet;
    var sheets = Array.prototype.slice.call(document.styleSheets || []);
    for (var index = 0; index < sheets.length; index += 1) {
      var sheet = sheets[index];
      var href = String(sheet.href || '');
      if (href.indexOf('video-overlay-builder.css') < 0) continue;
      try {
        sheet.cssRules;
        dynamicStyleSheet = sheet;
        return dynamicStyleSheet;
      } catch (_error) {
        return null;
      }
    }
    return null;
  }

  function clearDynamicRules(sheet) {
    while (dynamicCssRuleCount > 0 && sheet.cssRules && sheet.cssRules.length) {
      sheet.deleteRule(sheet.cssRules.length - 1);
      dynamicCssRuleCount -= 1;
    }
  }

  function insertDynamicRule(sheet, rule) {
    sheet.insertRule(rule, sheet.cssRules.length);
    dynamicCssRuleCount += 1;
  }

  function syncDynamicRules(slide) {
    var sheet = getDynamicStyleSheet();
    if (!sheet) return;
    clearDynamicRules(sheet);
    insertDynamicRule(
      sheet,
      '.overlay-stage-frame{--preview-duration:' + cssSeconds(slide.duration, 1, 600, 12) + ';}'
    );
    insertDynamicRule(sheet, getStageSizingRule());
    slide.items.forEach(function (item, index) {
      insertDynamicRule(sheet, [
        '.overlay-stage-item[data-stage-index="' + String(index) + '"]{',
        'left:' + cssPercent(item.x, 0, 96, 8) + ';',
        'top:' + cssPercent(item.y, 0, 92, 10) + ';',
        'width:' + cssPercent(item.w, 8, 96, 42) + ';',
        'height:' + cssPercent(item.h, 8, 92, 24) + ';',
        '--motion-duration:' + cssSeconds(item.duration, 0.1, 10, 0.55) + ';',
        '--overlay-rotation:' + cssNumber(item.rotation, -180, 180, 0) + 'deg;',
        '}'
      ].join(''));
    });
  }

  function getStageSizingRule() {
    if (!refs.stageFrame) return '.overlay-stage{width:min(100%,150vh);height:auto;font-size:16px;--overlay-stage-scale:1;}';
    var frameRect = refs.stageFrame.getBoundingClientRect();
    var availableWidth = Math.max(240, frameRect.width - 4);
    var availableHeight = Math.max(160, frameRect.height - 4);
    var fittedWidth = Math.min(availableWidth, availableHeight * (16 / 9));
    var presenterMode = document.body && document.body.classList.contains('overlay-recording-presenter');
    var zoomedWidth = Math.max(240, fittedWidth * (presenterMode ? 1 : stageZoom));
    var zoomedHeight = zoomedWidth * 9 / 16;
    var contentScale = Math.max(0.44, Math.min(1.08, zoomedWidth / 1600));
    var fontSize = Math.round(16 * contentScale * 1000) / 1000;
    return [
      '.overlay-stage{',
      'width:' + Math.round(zoomedWidth) + 'px;',
      'height:' + Math.round(zoomedHeight) + 'px;',
      'font-size:' + fontSize + 'px;',
      '--overlay-stage-scale:' + cssNumber(contentScale, 0.3, 1.2, 1) + ';',
      '}'
    ].join('');
  }

  function scheduleAutoFitAll() {
    if (fitTimer) window.cancelAnimationFrame(fitTimer);
    fitTimer = window.requestAnimationFrame(function () {
      fitTimer = null;
      var changed = false;
      getActiveSlide().items.forEach(function (item) {
        changed = fitItemToContent(item, false) || changed;
      });
      if (changed) {
        syncDynamicRules(getActiveSlide());
        renderItems();
      }
    });
  }

  function updateStageZoom() {
    if (!refs.stage || !refs.stageFrame) return;
    if (refs.zoomInput && String(refs.zoomInput.value) !== String(Math.round(stageZoom * 100))) {
      refs.zoomInput.value = String(Math.round(stageZoom * 100));
    }
    syncDynamicRules(getActiveSlide());
  }

  function setStageZoom(percent) {
    var next = utils.clampNumber(percent, 50, 200, 100);
    stageZoom = Math.round(next) / 100;
    updateStageZoom();
  }

  function adjustStageZoom(deltaPercent) {
    setStageZoom(Math.round(stageZoom * 100) + deltaPercent);
  }

  function fitItemToContent(item, force) {
    if (!item || item.type === 'image' || !refs.stage) return false;
    var node = findStageItemNode(item.id);
    var body = node ? node.querySelector('.overlay-stage-item-body') : null;
    if (!node || !body) return false;
    var stageRect = refs.stage.getBoundingClientRect();
    if (!stageRect.width || !stageRect.height) return false;
    var changed = false;
    var heightOverflow = body.scrollHeight > node.clientHeight + 2;
    var widthOverflow = body.scrollWidth > node.clientWidth + 2;
    var wantedHeight = roundToHalf(((body.scrollHeight + 10) / stageRect.height) * 100);
    var wantedWidth = roundToHalf(((body.scrollWidth + 10) / stageRect.width) * 100);
    var maxHeight = Math.max(8, 100 - item.y);
    var maxWidth = Math.max(8, 100 - item.x);
    if ((force || heightOverflow) && wantedHeight > item.h + 0.25 && wantedHeight <= maxHeight) {
      item.h = utils.clampNumber(wantedHeight, 8, Math.min(92, maxHeight), item.h);
      changed = true;
    } else if (heightOverflow && wantedHeight > item.h + 0.25 && item.h < maxHeight) {
      item.h = utils.clampNumber(maxHeight, 8, Math.min(92, maxHeight), item.h);
      changed = true;
    }
    if ((item.type === 'flow' || item.type === 'table') && (force || widthOverflow) && wantedWidth > item.w + 0.25 && wantedWidth <= maxWidth) {
      item.w = utils.clampNumber(wantedWidth, 8, Math.min(96, maxWidth), item.w);
      changed = true;
    } else if ((item.type === 'flow' || item.type === 'table') && widthOverflow && wantedWidth > item.w + 0.25 && item.w < maxWidth) {
      item.w = utils.clampNumber(maxWidth, 8, Math.min(96, maxWidth), item.w);
      changed = true;
    }
    if (changed) clampItemGeometry(item);
    return changed;
  }

  function addProject() {
    persistProjectLibrary(true);
    var nextProject = createEmptyProject('Untitled overlay project');
    var entry = normalizeProjectEntry({
      project_id: nextProject.project_id,
      title: nextProject.title,
      created_at: now(),
      updated_at: now(),
      project: nextProject
    });
    projectLibrary.projects.unshift(entry);
    projectLibrary.activeProjectId = entry.project_id;
    syncProjectFromLibrary();
    render();
    persistProjectLibrary(false);
    if (refs.projectTitle) refs.projectTitle.focus();
  }

  function switchProject(projectId) {
    var safeId = String(projectId || '');
    if (!safeId || safeId === projectLibrary.activeProjectId) return;
    persistProjectLibrary(true);
    projectLibrary.activeProjectId = safeId;
    syncProjectFromLibrary();
    render();
    persistProjectLibrary(true);
  }

  function deleteProject(projectId) {
    var safeId = String(projectId || '');
    if (!safeId || projectLibrary.projects.length <= 1) return;
    var entry = projectLibrary.projects.find(function (candidate) { return candidate.project_id === safeId; });
    openConfirmModal(
      'Delete Project',
      'Delete "' + (entry && entry.title ? entry.title : 'this project') + '" from this browser? This cannot be undone.',
      'Delete Project',
      'danger'
    ).then(function (confirmed) {
      if (!confirmed) return;
      projectLibrary.projects = projectLibrary.projects.filter(function (candidate) { return candidate.project_id !== safeId; });
      if (projectLibrary.activeProjectId === safeId) projectLibrary.activeProjectId = projectLibrary.projects[0].project_id;
      syncProjectFromLibrary();
      render();
      persistProjectLibrary(false);
    });
  }

  function addSlide() {
    var slide = {
      id: uid('slide'),
      title: 'New slide',
      duration: 12,
      items: []
    };
    project.slides.push(slide);
    activeSlideId = slide.id;
    selectedItemId = '';
    render();
    queuePersist();
  }

  function duplicateSlide(slideId) {
    var source = project.slides.find(function (slide) { return slide.id === slideId; });
    if (!source) return;
    var copy = clone(source);
    copy.id = uid('slide');
    copy.title = source.title + ' copy';
    copy.items = copy.items.map(function (item) {
      item.id = uid('item');
      item.x = utils.clampNumber(Number(item.x || 0) + 3, 0, 96, item.x);
      item.y = utils.clampNumber(Number(item.y || 0) + 3, 0, 90, item.y);
      return normalizeItem(item);
    });
    var index = project.slides.indexOf(source);
    project.slides.splice(index + 1, 0, copy);
    activeSlideId = copy.id;
    selectedItemId = copy.items[0] ? copy.items[0].id : '';
    render();
    queuePersist();
  }

  function deleteSlide(slideId) {
    if (project.slides.length <= 1) return;
    var index = project.slides.findIndex(function (slide) { return slide.id === slideId; });
    if (index < 0) return;
    project.slides.splice(index, 1);
    if (activeSlideId === slideId) activeSlideId = project.slides[Math.max(0, index - 1)].id;
    selectedItemId = '';
    render();
    queuePersist();
  }

  function reorderSlide(sourceId, targetId) {
    if (!sourceId || !targetId || sourceId === targetId) return;
    var sourceIndex = project.slides.findIndex(function (slide) { return slide.id === sourceId; });
    var targetIndex = project.slides.findIndex(function (slide) { return slide.id === targetId; });
    if (sourceIndex < 0 || targetIndex < 0) return;
    var moved = project.slides.splice(sourceIndex, 1)[0];
    project.slides.splice(targetIndex, 0, moved);
    activeSlideId = moved.id;
    selectedItemId = '';
    render();
    queuePersist();
  }

  function clearSlideDropTargets() {
    if (!refs.slideList) return;
    Array.prototype.slice.call(refs.slideList.querySelectorAll('.is-dragging, .is-drop-target')).forEach(function (row) {
      row.classList.remove('is-dragging', 'is-drop-target');
    });
  }

  function getSlideRowFromPoint(x, y) {
    var element = document.elementFromPoint(x, y);
    return element && element.closest ? element.closest('[data-slide-row-id]') : null;
  }

  function getSlideRowByY(y, sourceId) {
    if (!refs.slideList) return null;
    var rows = Array.prototype.slice.call(refs.slideList.querySelectorAll('[data-slide-row-id]')).filter(function (row) {
      return row.dataset.slideRowId !== sourceId;
    });
    if (!rows.length) return null;
    var bestRow = rows[0];
    var bestDistance = Infinity;
    rows.forEach(function (row) {
      var rect = row.getBoundingClientRect();
      var center = rect.top + rect.height / 2;
      var distance = Math.abs(center - y);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestRow = row;
      }
    });
    return bestRow;
  }

  function startSlidePointerDrag(event) {
    if (event.button !== undefined && event.button !== 0) return;
    if (event.target.closest && event.target.closest('[data-duplicate-slide-id], [data-delete-slide-id]')) return;
    var row = event.target.closest ? event.target.closest('[data-slide-row-id]') : null;
    if (!row) return;
    var sourceId = row.dataset.slideRowId;
    var drag = {
      sourceId: sourceId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      targetId: '',
      finished: false
    };

    function markTarget(targetRow) {
      Array.prototype.slice.call(refs.slideList.querySelectorAll('.is-drop-target')).forEach(function (entry) {
        if (entry !== targetRow) entry.classList.remove('is-drop-target');
      });
      if (targetRow && targetRow.dataset.slideRowId !== drag.sourceId) {
        targetRow.classList.add('is-drop-target');
        drag.targetId = targetRow.dataset.slideRowId;
      } else {
        drag.targetId = '';
      }
    }

    function onMove(moveEvent) {
      var distance = Math.abs(moveEvent.clientX - drag.startX) + Math.abs(moveEvent.clientY - drag.startY);
      if (!drag.active && distance < 6) return;
      drag.active = true;
      moveEvent.preventDefault();
      row.classList.add('is-dragging');
      markTarget(getSlideRowByY(moveEvent.clientY, drag.sourceId) || getSlideRowFromPoint(moveEvent.clientX, moveEvent.clientY));
    }

    function onUp(upEvent) {
      if (drag.finished) return;
      drag.finished = true;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (drag.active) {
        upEvent.preventDefault();
        suppressSlideClick = true;
        var targetRow = drag.targetId ? null : (getSlideRowByY(upEvent.clientY, drag.sourceId) || getSlideRowFromPoint(upEvent.clientX, upEvent.clientY));
        var targetId = drag.targetId || (targetRow && targetRow.dataset.slideRowId) || '';
        clearSlideDropTargets();
        if (targetId && targetId !== drag.sourceId) reorderSlide(drag.sourceId, targetId);
        window.setTimeout(function () { suppressSlideClick = false; }, 0);
      } else {
        clearSlideDropTargets();
      }
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function addItem(type, data) {
    var slide = getActiveSlide();
    var base = {
      id: uid('item'),
      type: type,
      title: type === 'table' ? 'Table' : (type === 'flow' ? 'Flow' : (type === 'image' ? 'Image' : (type === 'shape' ? 'Shape' : (type === 'arrow' ? 'Arrow' : 'Text card')))),
      x: 10 + Math.min(18, slide.items.length * 3),
      y: 12 + Math.min(18, slide.items.length * 3),
      w: type === 'table' ? 44 : (type === 'flow' ? 62 : (type === 'arrow' ? 32 : (type === 'shape' ? 24 : 38))),
      h: type === 'flow' ? 18 : (type === 'table' ? 30 : (type === 'arrow' ? 14 : (type === 'shape' ? 24 : 24))),
      delay: 0,
      duration: 0.55,
      animation: 'rise',
      color: type === 'table' ? 'teal' : (type === 'flow' || type === 'arrow' ? 'indigo' : (type === 'shape' ? 'green' : 'orange'))
    };
    var item = normalizeItem(Object.assign(base, data || {}));
    slide.items.push(item);
    selectedItemId = item.id;
    render();
    queuePersist();
  }

  function duplicateItem(itemId) {
    var slide = getActiveSlide();
    var source = slide.items.find(function (item) { return item.id === itemId; });
    if (!source) return;
    var copy = normalizeItem(Object.assign(clone(source), {
      id: uid('item'),
      title: source.title + ' copy',
      x: utils.clampNumber(Number(source.x || 0) + 4, 0, 96, source.x),
      y: utils.clampNumber(Number(source.y || 0) + 4, 0, 90, source.y)
    }));
    slide.items.splice(slide.items.indexOf(source) + 1, 0, copy);
    selectedItemId = copy.id;
    render();
    queuePersist();
  }

  function deleteItem(itemId) {
    var slide = getActiveSlide();
    var index = slide.items.findIndex(function (item) { return item.id === itemId; });
    if (index < 0) return;
    slide.items.splice(index, 1);
    selectedItemId = slide.items[Math.min(index, slide.items.length - 1)] ? slide.items[Math.min(index, slide.items.length - 1)].id : '';
    render();
    queuePersist();
  }

  function getActiveSlideIndex() {
    return Math.max(0, project.slides.findIndex(function (slide) { return slide.id === activeSlideId; }));
  }

  function updateSlideNavigation() {
    var index = getActiveSlideIndex();
    var lastIndex = Math.max(0, project.slides.length - 1);
    if (refs.prevSlide) refs.prevSlide.disabled = index <= 0;
    if (refs.nextSlide) {
      refs.nextSlide.disabled = recording.state !== 'recording' && index >= lastIndex;
      refs.nextSlide.textContent = recording.state === 'recording' && index >= lastIndex ? 'Finish & Download' : (index >= lastIndex ? 'Last Slide' : 'Next Slide');
    }
  }

  function goToSlideByOffset(offset) {
    var index = getActiveSlideIndex();
    var nextIndex = utils.clampInteger(index + offset, 0, project.slides.length - 1, index);
    if (nextIndex === index) {
      if (offset > 0 && recording.state === 'recording' && index >= project.slides.length - 1) stopRecording(true);
      return;
    }
    activeSlideId = project.slides[nextIndex].id;
    selectedItemId = '';
    render();
    queuePersist();
  }

  function startPreview() {
    var slide = getActiveSlide();
    stopPreview(false);
    isPreviewing = true;
    refs.stage.classList.add('is-previewing');
    Array.prototype.slice.call(refs.stage.querySelectorAll('.overlay-stage-item')).forEach(function (node) {
      node.classList.add('is-preview-hidden');
      node.classList.remove('is-preview-active');
    });
    refs.preview.disabled = true;
    refs.stopPreview.disabled = false;
    if (refs.previewProgress) refs.previewProgress.offsetWidth;
    if (refs.stageFrame) refs.stageFrame.classList.add('is-previewing');
    setStatus('Previewing slide.', '');

    var schedule = utils.buildAnimationSchedule(slide.items, slide.duration);
    schedule.forEach(function (entry) {
      var timer = window.setTimeout(function () {
        var node = findStageItemNode(entry.id);
        if (!node) return;
        node.classList.remove('is-preview-hidden');
        node.classList.add('is-preview-active');
        node.dataset.previewAnimation = entry.animation;
        var cleanup = window.setTimeout(function () {
          if (!node) return;
          node.classList.remove('is-preview-active');
          node.removeAttribute('data-preview-animation');
        }, entry.durationMs + 80);
        previewTimers.push(cleanup);
      }, entry.delayMs);
      previewTimers.push(timer);
    });
    previewTimers.push(window.setTimeout(function () {
      stopPreview(false);
      setStatus('Preview complete.', 'success', 2400);
    }, Math.max(250, slide.duration * 1000)));
  }

  function stopPreview(report) {
    previewTimers.forEach(function (timer) { window.clearTimeout(timer); });
    previewTimers = [];
    isPreviewing = false;
    if (refs.stage) {
      refs.stage.classList.remove('is-previewing');
      Array.prototype.slice.call(refs.stage.querySelectorAll('.overlay-stage-item')).forEach(function (node) {
        node.classList.remove('is-preview-hidden', 'is-preview-active');
        node.removeAttribute('data-preview-animation');
      });
    }
    if (refs.stageFrame) refs.stageFrame.classList.remove('is-previewing');
    if (refs.previewProgress) refs.previewProgress.offsetWidth;
    if (refs.preview) refs.preview.disabled = false;
    if (refs.stopPreview) refs.stopPreview.disabled = true;
    if (report) setStatus('Preview stopped.', '');
  }

  function findStageItemNode(itemId) {
    var nodes = refs.stage ? refs.stage.querySelectorAll('.overlay-stage-item') : [];
    for (var index = 0; index < nodes.length; index += 1) {
      if (String(nodes[index].dataset.itemId || '') === String(itemId)) return nodes[index];
    }
    return null;
  }

  function exportJson() {
    project.activeSlideId = activeSlideId;
    var blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    saveBlob(blob, escapeName(project.title) + '.json');
    setStatus('JSON export started.', 'success');
  }

  function importJsonFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var importedProject = normalizeProject(JSON.parse(String(reader.result || '{}')));
        importedProject.project_id = uid('overlay-project');
        var entry = normalizeProjectEntry({
          project_id: importedProject.project_id,
          title: importedProject.title,
          created_at: now(),
          updated_at: now(),
          project: importedProject
        });
        persistProjectLibrary(true);
        projectLibrary.projects.unshift(entry);
        projectLibrary.activeProjectId = entry.project_id;
        syncProjectFromLibrary();
        render();
        persistProjectLibrary(false);
        setStatus('Project imported.', 'success');
      } catch (_error) {
        setStatus('Could not import this JSON file.', 'error');
      }
    };
    reader.readAsText(file);
  }

  function getImageGeometry(naturalWidth, naturalHeight) {
    var imageRatio = Math.max(0.05, Number(naturalWidth || 1) / Math.max(1, Number(naturalHeight || 1)));
    var stageRatio = 16 / 9;
    var width = 52;
    var height = width * stageRatio / imageRatio;
    if (height > 68) {
      height = 68;
      width = height * imageRatio / stageRatio;
    }
    if (width > 68) {
      width = 68;
      height = width * stageRatio / imageRatio;
    }
    width = Math.max(12, Math.min(68, width));
    height = Math.max(12, Math.min(68, height));
    return {
      w: roundToTenth(width),
      h: roundToTenth(height),
      x: roundToTenth((100 - width) / 2),
      y: roundToTenth((100 - height) / 2)
    };
  }

  function importImageFile(file) {
    if (!file) return;
    if (!/^image\//i.test(String(file.type || ''))) {
      setStatus('Choose an image file.', 'error');
      return;
    }
    if (Number(file.size || 0) > 6 * 1024 * 1024) {
      setStatus('Image must be 6 MB or smaller.', 'error');
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      var src = String(reader.result || '');
      var image = new Image();
      image.onload = function () {
        var imageData = Object.assign(getImageGeometry(image.naturalWidth, image.naturalHeight), {
          src: src,
          alt: String(file.name || 'Overlay image'),
          fit: 'cover'
        });
        if (imageTargetItemId) {
          var item = getActiveSlide().items.find(function (entry) { return entry.id === imageTargetItemId; });
          if (item) Object.assign(item, imageData);
          imageTargetItemId = '';
          render();
        } else {
          addItem('image', Object.assign({ title: String(file.name || 'Image') }, imageData));
        }
        queuePersist();
      };
      image.onerror = function () {
        setStatus('Could not read this image.', 'error');
      };
      image.src = src;
    };
    reader.readAsDataURL(file);
  }

  function resetProject() {
    openConfirmModal(
      'Reset Project',
      'Reset this project to one empty slide? Saved project data for this project will be replaced.',
      'Reset Project',
      'danger'
    ).then(function (confirmed) {
      if (!confirmed) return;
      var entry = getActiveProjectEntry();
      var fresh = createEmptyProject(project.title || entry.title);
      fresh.project_id = entry.project_id;
      fresh.title = project.title || entry.title || fresh.title;
      entry.project = fresh;
      entry.title = fresh.title;
      entry.updated_at = now();
      syncProjectFromLibrary();
      render();
      persistProjectLibrary(false);
    });
  }

  function handleStageInput(event) {
    var target = event.target;
    if (!target) return;
    var itemId = target.dataset.itemId;
    if (!itemId) return;
    var item = getActiveSlide().items.find(function (entry) { return entry.id === itemId; });
    if (!item) return;
    selectedItemId = item.id;
    if (target.dataset.editField) {
      var field = target.dataset.editField;
      if (field === 'step') {
        var stepIndex = utils.clampInteger(target.dataset.stepIndex, 0, 99, 0);
        item.steps[stepIndex] = String(target.textContent || '').trim() || ('Step ' + String(stepIndex + 1));
      } else if (field === 'body') {
        item[field] = String(target.textContent || '');
      } else {
        item[field] = String(target.textContent || '').trim() || item[field];
      }
    }
    if (target.dataset.tableRow != null && target.dataset.tableCol != null) {
      var rowIndex = utils.clampInteger(target.dataset.tableRow, 0, 7, 0);
      var colIndex = utils.clampInteger(target.dataset.tableCol, 0, 7, 0);
      item.table = utils.normalizeTableData(item.table);
      if (item.table.cells[rowIndex] && item.table.cells[rowIndex][colIndex] != null) {
        item.table.cells[rowIndex][colIndex] = String(target.textContent || '');
      }
    }
    fitItemToContent(item, false);
    syncDynamicRules(getActiveSlide());
    renderItems();
    renderInspector();
    queuePersist();
  }

  function handleStageClick(event) {
    var itemNode = event.target.closest ? event.target.closest('.overlay-stage-item') : null;
    if (!itemNode) {
      selectedItemId = '';
      render();
      return;
    }
    selectedItemId = String(itemNode.dataset.itemId || '');
    renderStageSelectionOnly();
    renderItems();
    renderInspector();
  }

  function renderStageSelectionOnly() {
    Array.prototype.slice.call(refs.stage.querySelectorAll('.overlay-stage-item')).forEach(function (node) {
      node.classList.toggle('is-selected', String(node.dataset.itemId || '') === selectedItemId);
    });
  }

  function handlePointerDown(event) {
    if (isPreviewing) return;
    var resizeHandle = event.target.closest ? event.target.closest('[data-resize-item-id]') : null;
    var itemNode = event.target.closest ? event.target.closest('.overlay-stage-item') : null;
    if (!itemNode && !resizeHandle) return;
    if (!resizeHandle && event.target.closest('[contenteditable="true"], button, input, textarea, select')) return;
    var itemId = resizeHandle ? resizeHandle.dataset.resizeItemId : itemNode.dataset.itemId;
    var item = getActiveSlide().items.find(function (entry) { return entry.id === itemId; });
    if (!item) return;
    event.preventDefault();
    selectedItemId = item.id;
    renderStageSelectionOnly();
    renderItems();
    renderInspector();

    var stageRect = refs.stage.getBoundingClientRect();
    var startX = event.clientX;
    var startY = event.clientY;
    var start = { x: item.x, y: item.y, w: item.w, h: item.h };
    var mode = resizeHandle ? 'resize' : 'move';
    var pointerId = event.pointerId;
    itemNode.classList.add(mode === 'resize' ? 'is-resizing' : 'is-dragging');
    if (itemNode && itemNode.setPointerCapture) {
      try { itemNode.setPointerCapture(pointerId); } catch (_error) {}
    }

    function onMove(moveEvent) {
      moveEvent.preventDefault();
      var dx = ((moveEvent.clientX - startX) / stageRect.width) * 100;
      var dy = ((moveEvent.clientY - startY) / stageRect.height) * 100;
      if (mode === 'resize') {
        item.w = roundToTenth(utils.clampNumber(start.w + dx, 8, 100 - item.x, start.w));
        item.h = roundToTenth(utils.clampNumber(start.h + dy, 8, 100 - item.y, start.h));
      } else {
        item.x = roundToTenth(utils.clampNumber(start.x + dx, 0, Math.max(0, 100 - item.w), start.x));
        item.y = roundToTenth(utils.clampNumber(start.y + dy, 0, Math.max(0, 100 - item.h), start.y));
      }
      clampItemGeometry(item);
      syncDynamicRules(getActiveSlide());
    }

    function onUp() {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      itemNode.classList.remove('is-dragging', 'is-resizing');
      clampItemGeometry(item);
      syncDynamicRules(getActiveSlide());
      renderInspector();
      queuePersist();
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  function isTypingTarget(target) {
    if (!target) return false;
    var tagName = String(target.tagName || '').toUpperCase();
    return target.isContentEditable || tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
  }

  function handleGlobalKeydown(event) {
    if (refs.confirmModal && refs.confirmModal.classList.contains('visible')) {
      if (event.key === 'Escape') closeConfirmModal(false);
      return;
    }
    if (openSelectRoot && event.key === 'Escape') {
      closeCustomSelects();
      return;
    }
    if (isTypingTarget(event.target)) return;
    if (event.key === 'Escape' && recording.state === 'recording') {
      event.preventDefault();
      stopRecording(true);
      return;
    }
    if ((event.key === 'Backspace' || event.key === 'Delete') && selectedItemId) {
      event.preventDefault();
      deleteItem(selectedItemId);
      return;
    }
    if (event.key === 'ArrowRight' || event.key === ' ') {
      event.preventDefault();
      goToSlideByOffset(1);
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      goToSlideByOffset(-1);
    }
  }

  function chooseRecordingMimeType() {
    var types = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm'
    ];
    if (!window.MediaRecorder || typeof window.MediaRecorder.isTypeSupported !== 'function') return '';
    for (var index = 0; index < types.length; index += 1) {
      if (window.MediaRecorder.isTypeSupported(types[index])) return types[index];
    }
    return '';
  }

  function startRecording() {
    if (recording.state === 'recording') return;
    if (!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) || !window.MediaRecorder) {
      setRecordingStatus('Screen recording is not supported in this browser.', 10000);
      return;
    }
    stopMicPreview(false);
    recording.chunks = [];
    recording.lastBlob = null;
    enterRecordingPresentationMode();
    setRecordingStatus('Choose a screen, window, or tab to record.');
    var displayOptions = {
      video: { frameRate: { ideal: 30, max: 60 } },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      surfaceSwitching: 'include',
      systemAudio: 'include'
    };
    var displayRequest = navigator.mediaDevices.getDisplayMedia(displayOptions).catch(function (error) {
      if (error && error.name === 'TypeError') {
        return navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      }
      throw error;
    });
    displayRequest.then(function (screenStream) {
      recording.screenStream = screenStream;
      if (!refs.recordVoice || !refs.recordVoice.checked) return null;
      return navigator.mediaDevices.getUserMedia({ audio: true }).catch(function () {
        setRecordingStatus('Microphone was unavailable, so recording will continue without voice.');
        return null;
      });
    }).then(function (micStream) {
      recording.micStream = micStream || null;
      if (recording.micStream) startMicMeter(recording.micStream);
      var tracks = [];
      if (recording.screenStream) {
        recording.screenStream.getVideoTracks().forEach(function (track) { tracks.push(track); });
        recording.screenStream.getAudioTracks().forEach(function (track) { tracks.push(track); });
      }
      if (recording.micStream) {
        recording.micStream.getAudioTracks().forEach(function (track) { tracks.push(track); });
      }
      recording.combinedStream = new MediaStream(tracks);
      var options = {};
      var mimeType = chooseRecordingMimeType();
      if (mimeType) options.mimeType = mimeType;
      recording.recorder = new MediaRecorder(recording.combinedStream, options);
      recording.recorder.addEventListener('dataavailable', function (event) {
        if (event.data && event.data.size) recording.chunks.push(event.data);
      });
      recording.recorder.addEventListener('stop', function () {
        finishRecordingDownload(true);
      });
      recording.combinedStream.getTracks().forEach(function (track) {
        track.addEventListener('ended', function () {
          if (recording.state === 'recording') stopRecording(true);
        });
      });
      recording.recorder.start(250);
      recording.state = 'recording';
      document.body.classList.add('overlay-recording-active');
      setRecordingStatus('Recording. Use Next Slide, arrow keys, or Space while presenting.');
      updateRecordingButtons();
      updateSlideNavigation();
    }).catch(function (error) {
      stopStreams();
      recording.state = 'idle';
      document.body.classList.remove('overlay-recording-active');
      exitRecordingPresentationMode();
      updateRecordingButtons();
      setRecordingStatus(error && error.name === 'NotAllowedError' ? 'Recording permission was cancelled.' : 'Could not start screen recording.', 10000);
      if (refs.recordVoice && refs.recordVoice.checked) startMicPreview({ silent: true });
    });
  }

  function stopRecording(downloadAfterStop) {
    if (recording.state !== 'recording') {
      if (downloadAfterStop && recording.lastBlob) downloadRecordingBlob(recording.lastBlob);
      return;
    }
    recording.state = 'stopping';
    updateRecordingButtons();
    setRecordingStatus('Preparing download...');
    try {
      recording.recorder.stop();
    } catch (_error) {
      finishRecordingDownload(!!downloadAfterStop);
    }
  }

  function finishRecordingDownload(download) {
    var blob = new Blob(recording.chunks, { type: recording.recorder && recording.recorder.mimeType ? recording.recorder.mimeType : 'video/webm' });
    recording.lastBlob = blob && blob.size ? blob : null;
    recording.state = 'idle';
    stopStreams();
    document.body.classList.remove('overlay-recording-active');
    exitRecordingPresentationMode();
    updateRecordingButtons();
    updateSlideNavigation();
    if (!recording.lastBlob) {
      setRecordingStatus('Recording stopped, but no video data was captured.', 10000);
      return;
    }
    setRecordingStatus('Recording ready. Download started.', 15000);
    if (download !== false) downloadRecordingBlob(recording.lastBlob);
  }

  function enterRecordingPresentationMode() {
    selectedItemId = '';
    if (document.body) document.body.classList.add('overlay-recording-presenter');
    renderStageSelectionOnly();
    syncDynamicRules(getActiveSlide());
    var target = refs.stagePanel || document.documentElement;
    if (!target || !target.requestFullscreen || document.fullscreenElement) return;
    recording.fullscreenRequested = true;
    target.requestFullscreen().catch(function () {
      recording.fullscreenRequested = false;
    });
  }

  function exitRecordingPresentationMode() {
    if (document.body) document.body.classList.remove('overlay-recording-presenter');
    syncDynamicRules(getActiveSlide());
    if (recording.fullscreenRequested && document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(function () {});
    }
    recording.fullscreenRequested = false;
  }

  function stopStreams() {
    stopMicMeter();
    [recording.screenStream, recording.micStream, recording.combinedStream].forEach(function (stream) {
      if (!stream) return;
      stream.getTracks().forEach(function (track) {
        try { track.stop(); } catch (_error) {}
      });
    });
    recording.screenStream = null;
    recording.micStream = null;
    recording.combinedStream = null;
    recording.recorder = null;
  }

  function setMicMeterLevel(level) {
    if (!refs.recorderVisual) return;
    var next = Math.max(0, Math.min(8, Math.round(Number(level || 0) * 8)));
    for (var index = 0; index <= 8; index += 1) {
      refs.recorderVisual.classList.toggle('level-' + index, index === next);
    }
  }

  function stopMicMeter() {
    if (micMeter.frame) {
      window.cancelAnimationFrame(micMeter.frame);
      micMeter.frame = 0;
    }
    if (micMeter.source && typeof micMeter.source.disconnect === 'function') {
      try { micMeter.source.disconnect(); } catch (_error) {}
    }
    if (micMeter.audioContext && typeof micMeter.audioContext.close === 'function') {
      micMeter.audioContext.close().catch(function () {});
    }
    micMeter.audioContext = null;
    micMeter.analyser = null;
    micMeter.source = null;
    micMeter.data = null;
    micMeter.level = 0;
    setMicMeterLevel(0);
    if (refs.recorderVisual) refs.recorderVisual.classList.remove('is-live');
  }

  function startMicMeter(stream) {
    var AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor || !stream || !refs.recorderVisual) return;
    stopMicMeter();
    try {
      micMeter.audioContext = new AudioContextCtor();
      micMeter.analyser = micMeter.audioContext.createAnalyser();
      micMeter.analyser.fftSize = 512;
      micMeter.data = new Uint8Array(micMeter.analyser.fftSize);
      micMeter.source = micMeter.audioContext.createMediaStreamSource(stream);
      micMeter.source.connect(micMeter.analyser);
      refs.recorderVisual.classList.add('is-live');
      if (micMeter.audioContext.state === 'suspended' && typeof micMeter.audioContext.resume === 'function') {
        micMeter.audioContext.resume().catch(function () {});
      }
      var tick = function () {
        if (!micMeter.analyser || !micMeter.data) return;
        micMeter.analyser.getByteTimeDomainData(micMeter.data);
        var sum = 0;
        for (var index = 0; index < micMeter.data.length; index += 1) {
          var normalized = (micMeter.data[index] - 128) / 128;
          sum += normalized * normalized;
        }
        var targetLevel = Math.min(1, Math.sqrt(sum / micMeter.data.length) * 4.6);
        micMeter.level = (micMeter.level * 0.65) + (targetLevel * 0.35);
        setMicMeterLevel(micMeter.level);
        micMeter.frame = window.requestAnimationFrame(tick);
      };
      tick();
    } catch (_error) {
      stopMicMeter();
    }
  }

  function stopMicPreview(resetStatus) {
    micPreview.starting = false;
    if (micPreview.stream) {
      micPreview.stream.getTracks().forEach(function (track) {
        try { track.stop(); } catch (_error) {}
      });
    }
    micPreview.stream = null;
    if (recording.state !== 'recording' && recording.state !== 'stopping') stopMicMeter();
    if (resetStatus && recording.state === 'idle') setRecordingStatus('Ready to record WebM video.');
  }

  function startMicPreview(options) {
    var silent = !!(options && options.silent);
    if (!refs.recordVoice || !refs.recordVoice.checked || recording.state !== 'idle') return Promise.resolve();
    if (micPreview.stream || micPreview.starting) return Promise.resolve();
    if (!(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function')) {
      refs.recordVoice.checked = false;
      if (!silent) setRecordingStatus('Microphone testing is not supported in this browser.', 10000);
      return Promise.resolve();
    }
    micPreview.starting = true;
    if (!silent) setRecordingStatus('Starting microphone test...');
    return navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      micPreview.starting = false;
      if (!refs.recordVoice.checked || recording.state !== 'idle') {
        stream.getTracks().forEach(function (track) { track.stop(); });
        return;
      }
      micPreview.stream = stream;
      startMicMeter(stream);
      if (!silent) setRecordingStatus('Microphone test active. Speak to check your level.');
    }).catch(function (error) {
      micPreview.starting = false;
      stopMicPreview(false);
      refs.recordVoice.checked = false;
      if (!silent) {
        setRecordingStatus(error && error.name === 'NotAllowedError' ? 'Microphone permission was cancelled.' : 'Microphone was unavailable.', 10000);
      }
    });
  }

  function downloadRecordingBlob(blob) {
    if (!blob) return;
    saveBlob(blob, escapeName(project.title) + '-recording.webm');
  }

  function updateRecordingButtons() {
    var isRecording = recording.state === 'recording' || recording.state === 'stopping';
    if (refs.recordScreen) {
      refs.recordScreen.disabled = isRecording;
      refs.recordScreen.textContent = recording.state === 'recording' ? 'Recording...' : 'Record Screen';
    }
    if (refs.stopRecording) refs.stopRecording.disabled = !isRecording;
    if (refs.recordVoice) refs.recordVoice.disabled = isRecording;
  }

  function saveBlob(blob, filename) {
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  }

  function openConfirmModal(title, message, confirmLabel, tone) {
    if (!refs.confirmModal) return Promise.resolve(false);
    refs.confirmTitle.textContent = title || 'Confirm Action';
    refs.confirmMessage.textContent = message || '';
    refs.confirmConfirm.textContent = confirmLabel || 'Confirm';
    refs.confirmConfirm.classList.toggle('danger', tone !== 'primary');
    refs.confirmConfirm.classList.toggle('primary', tone === 'primary');
    refs.confirmModal.classList.add('visible');
    refs.confirmModal.setAttribute('aria-hidden', 'false');
    if (refs.confirmCancel) refs.confirmCancel.focus();
    return new Promise(function (resolve) {
      confirmResolver = resolve;
    });
  }

  function closeConfirmModal(confirmed) {
    if (!refs.confirmModal) return;
    refs.confirmModal.classList.remove('visible');
    refs.confirmModal.setAttribute('aria-hidden', 'true');
    if (confirmResolver) {
      confirmResolver(Boolean(confirmed));
      confirmResolver = null;
    }
  }

  function iconSvg(name) {
    var icons = {
      copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><rect x="4" y="4" width="11" height="11" rx="2"></rect></svg>',
      trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M6 6l1 15h10l1-15"></path></svg>',
      corner: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 20h6v-6"></path><path d="M20 20l-7-7"></path></svg>',
      image: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><path d="M21 15l-5-5L5 21"></path></svg>',
      'arrow-right': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"></path><path d="M13 6l6 6-6 6"></path></svg>',
      'chevron-down': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg>'
    };
    return icons[name] || '';
  }

  function arrowSvg(kind) {
    var safeKind = ARROW_OPTIONS.some(function (entry) { return entry.value === kind; }) ? kind : 'arrow';
    var head = safeKind === 'line' ? '' : '<path class="overlay-arrow-head" d="M148 39 L174 60 L148 81"></path>';
    var path = safeKind === 'curve'
      ? '<path class="overlay-arrow-path" d="M20 100 C56 30, 122 24, 174 60"></path>'
      : '<path class="overlay-arrow-path" d="M18 60 L174 60"></path>';
    return '<svg class="overlay-arrow-svg" viewBox="0 0 190 120" aria-hidden="true">' + path + head + '</svg>';
  }

  function wireEvents() {
    refs.projectTitle.addEventListener('input', function () { setProjectTitle(refs.projectTitle.value); });
    refs.newProject.addEventListener('click', addProject);
    refs.addSlide.addEventListener('click', addSlide);
    refs.addText.addEventListener('click', function () {
      addItem('text', { body: '' });
    });
    refs.addTable.addEventListener('click', function () {
      var table = utils.createTableData(refs.tableRows.value, refs.tableCols.value);
      addItem('table', { table: table });
    });
    refs.addFlow.addEventListener('click', function () {
      addItem('flow', { steps: ['Start', 'Decision', 'Next step'] });
    });
    refs.addArrow.addEventListener('click', function () {
      addItem('arrow', { arrow: 'arrow', animation: 'wipe' });
    });
    refs.addShape.addEventListener('click', function () {
      addItem('shape', { shape: 'rounded', animation: 'scale' });
    });
    refs.addImage.addEventListener('click', function () {
      imageTargetItemId = '';
      refs.imageInput.click();
    });
    refs.imageInput.addEventListener('change', function () {
      importImageFile(refs.imageInput.files && refs.imageInput.files[0]);
      refs.imageInput.value = '';
    });
    refs.import.addEventListener('click', function () { refs.importInput.click(); });
    refs.importInput.addEventListener('change', function () {
      importJsonFile(refs.importInput.files && refs.importInput.files[0]);
      refs.importInput.value = '';
    });
    refs.save.addEventListener('click', saveProject);
    refs.export.addEventListener('click', exportJson);
    refs.reset.addEventListener('click', resetProject);
    refs.preview.addEventListener('click', startPreview);
    refs.stopPreview.addEventListener('click', function () { stopPreview(true); });
    refs.zoomOut.addEventListener('click', function () { adjustStageZoom(-10); });
    refs.zoomIn.addEventListener('click', function () { adjustStageZoom(10); });
    refs.zoomInput.addEventListener('input', function () { setStageZoom(refs.zoomInput.value); });
    refs.zoomInput.addEventListener('change', function () { setStageZoom(refs.zoomInput.value); });
    refs.prevSlide.addEventListener('click', function () { goToSlideByOffset(-1); });
    refs.nextSlide.addEventListener('click', function () { goToSlideByOffset(1); });
    refs.recordScreen.addEventListener('click', startRecording);
    refs.stopRecording.addEventListener('click', function () { stopRecording(true); });
    refs.recordVoice.addEventListener('change', function () {
      if (refs.recordVoice.checked) {
        startMicPreview();
      } else {
        stopMicPreview(true);
      }
    });

    refs.projectList.addEventListener('click', function (event) {
      var remove = event.target.closest ? event.target.closest('[data-delete-project-id]') : null;
      var main = event.target.closest ? event.target.closest('[data-project-id]') : null;
      if (remove) {
        deleteProject(remove.dataset.deleteProjectId);
      } else if (main) {
        switchProject(main.dataset.projectId);
      }
    });

    refs.slideList.addEventListener('click', function (event) {
      if (suppressSlideClick) {
        suppressSlideClick = false;
        event.preventDefault();
        return;
      }
      var main = event.target.closest ? event.target.closest('[data-slide-id]') : null;
      var duplicate = event.target.closest ? event.target.closest('[data-duplicate-slide-id]') : null;
      var remove = event.target.closest ? event.target.closest('[data-delete-slide-id]') : null;
      if (duplicate) {
        duplicateSlide(duplicate.dataset.duplicateSlideId);
      } else if (remove) {
        deleteSlide(remove.dataset.deleteSlideId);
      } else if (main) {
        activeSlideId = main.dataset.slideId;
        selectedItemId = '';
        render();
        queuePersist();
      }
    });
    refs.slideList.addEventListener('pointerdown', startSlidePointerDrag);
    refs.slideList.addEventListener('dragstart', function (event) {
      var row = event.target.closest ? event.target.closest('[data-slide-row-id]') : null;
      if (!row) return;
      draggedSlideId = row.dataset.slideRowId;
      row.classList.add('is-dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', draggedSlideId);
      }
    });
    refs.slideList.addEventListener('dragover', function (event) {
      var row = event.target.closest ? event.target.closest('[data-slide-row-id]') : null;
      if (!row || !draggedSlideId || row.dataset.slideRowId === draggedSlideId) return;
      event.preventDefault();
      row.classList.add('is-drop-target');
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    });
    refs.slideList.addEventListener('dragleave', function (event) {
      var row = event.target.closest ? event.target.closest('[data-slide-row-id]') : null;
      if (row) row.classList.remove('is-drop-target');
    });
    refs.slideList.addEventListener('drop', function (event) {
      var row = event.target.closest ? event.target.closest('[data-slide-row-id]') : null;
      if (!row || !draggedSlideId) return;
      event.preventDefault();
      reorderSlide(draggedSlideId, row.dataset.slideRowId);
      draggedSlideId = '';
    });
    refs.slideList.addEventListener('dragend', function () {
      draggedSlideId = '';
      clearSlideDropTargets();
    });

    refs.itemList.addEventListener('click', function (event) {
      var remove = event.target.closest ? event.target.closest('[data-delete-item-id]') : null;
      var main = event.target.closest ? event.target.closest('[data-item-id]') : null;
      if (remove) {
        deleteItem(remove.dataset.deleteItemId);
      } else if (main) {
        selectedItemId = main.dataset.itemId;
        renderStageSelectionOnly();
        renderItems();
        renderInspector();
      }
    });

    refs.stage.addEventListener('input', handleStageInput);
    refs.stage.addEventListener('click', handleStageClick);
    refs.stage.addEventListener('pointerdown', handlePointerDown);
    refs.stageFrame.addEventListener('wheel', function (event) {
      if (!event.ctrlKey) return;
      event.preventDefault();
      adjustStageZoom(event.deltaY > 0 ? -10 : 10);
    }, { passive: false });

    refs.confirmClose.addEventListener('click', function () { closeConfirmModal(false); });
    refs.confirmCancel.addEventListener('click', function () { closeConfirmModal(false); });
    refs.confirmConfirm.addEventListener('click', function () { closeConfirmModal(true); });
    refs.confirmModal.addEventListener('click', function (event) {
      if (event.target === refs.confirmModal) closeConfirmModal(false);
    });

    document.addEventListener('keydown', handleGlobalKeydown);
    document.addEventListener('click', function (event) {
      if (!event.target.closest || !event.target.closest('.app-select')) closeCustomSelects();
    });
    window.addEventListener('resize', function () {
      updateStageZoom();
      scheduleAutoFitAll();
    });
    window.addEventListener('beforeunload', function (event) {
      if (recording.state === 'recording') {
        event.preventDefault();
        event.returnValue = '';
      }
      stopMicPreview(false);
    });
  }

  function hydrateForUser(user) {
    currentUser = user || null;
    projectLibrary = currentUser && currentUser.uid ? readUserProjectLibrary(currentUser) : readGuestProjectLibrary();
    syncProjectFromLibrary();
    if (getActiveSlide().items.length) selectedItemId = getActiveSlide().items[0].id;
    render();
  }

  wireEvents();
  refs.stopPreview.disabled = true;
  refs.stopRecording.disabled = true;
  if (auth && bootstrap.onAuthStateReady) {
    bootstrap.onAuthStateReady(auth, function (user) {
      hydrateForUser(user || null);
    });
  } else {
    hydrateForUser(currentUser || null);
  }
})();
