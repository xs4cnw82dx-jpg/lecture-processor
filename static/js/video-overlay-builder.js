(function () {
  'use strict';

  var utils = window.LectureProcessorVideoOverlayBuilderUtils || {};
  if (!utils.createTableData) return;

  var STORAGE_KEY = 'lecture_processor_video_overlay_builder_v1';
  var COLORS = [
    { id: 'orange', label: 'Orange', accent: '#f97316', soft: '#fff7ed', text: '#9a3412' },
    { id: 'teal', label: 'Teal', accent: '#0f766e', soft: '#f0fdfa', text: '#115e59' },
    { id: 'indigo', label: 'Indigo', accent: '#4f46e5', soft: '#eef2ff', text: '#3730a3' },
    { id: 'green', label: 'Green', accent: '#16a34a', soft: '#f0fdf4', text: '#166534' },
    { id: 'rose', label: 'Rose', accent: '#e11d48', soft: '#fff1f2', text: '#9f1239' }
  ];

  var refs = {
    projectTitle: document.getElementById('overlay-project-title'),
    stageFrame: document.querySelector('.overlay-stage-frame'),
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
    tableRows: document.getElementById('overlay-table-rows'),
    tableCols: document.getElementById('overlay-table-cols'),
    imageInput: document.getElementById('overlay-image-input'),
    importInput: document.getElementById('overlay-import-input'),
    save: document.getElementById('overlay-save-draft'),
    export: document.getElementById('overlay-export-json'),
    import: document.getElementById('overlay-import-json'),
    reset: document.getElementById('overlay-reset'),
    preview: document.getElementById('overlay-preview'),
    stopPreview: document.getElementById('overlay-stop-preview')
  };

  var project = loadProject();
  var activeSlideId = project.activeSlideId || (project.slides[0] && project.slides[0].id);
  var selectedItemId = '';
  var previewTimers = [];
  var persistTimer = null;
  var imageTargetItemId = '';
  var isPreviewing = false;
  var dynamicCssRuleCount = 0;
  var dynamicStyleSheet = null;

  function uid(prefix) {
    return String(prefix || 'id') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function sampleProject() {
    var table = utils.createTableData(4, 3);
    table.cells[0] = ['Signal', 'Meaning', 'Action'];
    table.cells[1] = ['Red flag', 'Possible serious pathology', 'Refer'];
    table.cells[2] = ['Normal course', 'Expected recovery', 'Advice'];
    table.cells[3] = ['Delayed course', 'Extra support needed', 'Plan'];
    return {
      version: 1,
      title: 'KNGF Video Overlay',
      activeSlideId: 'slide-intro',
      slides: [
        {
          id: 'slide-intro',
          title: 'Intro',
          duration: 12,
          items: [
            {
              id: 'item-heading',
              type: 'text',
              title: 'KNGF Richtlijn Nekpijn',
              body: 'Clear chapter cards, tables, and flow steps for lecture video overlays.',
              x: 7,
              y: 11,
              w: 42,
              h: 25,
              delay: 0.2,
              duration: 0.55,
              animation: 'rise',
              color: 'orange'
            },
            {
              id: 'item-table',
              type: 'table',
              title: 'Clinical Signals',
              table: table,
              x: 53,
              y: 15,
              w: 39,
              h: 34,
              delay: 1.1,
              duration: 0.45,
              animation: 'wipe',
              color: 'teal'
            },
            {
              id: 'item-flow',
              type: 'flow',
              title: 'Decision Flow',
              steps: ['Screen', 'Classify', 'Treat', 'Evaluate'],
              x: 12,
              y: 57,
              w: 74,
              h: 20,
              delay: 2,
              duration: 0.55,
              animation: 'scale',
              color: 'indigo'
            }
          ]
        },
        {
          id: 'slide-summary',
          title: 'Summary',
          duration: 10,
          items: [
            {
              id: 'item-summary',
              type: 'text',
              title: 'Treatment Focus',
              body: 'Education, reassurance, movement, graded activity, and reassessment.',
              x: 22,
              y: 20,
              w: 56,
              h: 30,
              delay: 0,
              duration: 0.5,
              animation: 'fade',
              color: 'green'
            }
          ]
        }
      ]
    };
  }

  function normalizeProject(rawProject) {
    var source = rawProject && typeof rawProject === 'object' ? rawProject : sampleProject();
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
    if (!normalizedSlides.length) normalizedSlides = sampleProject().slides;
    return {
      version: 1,
      title: String(source.title || 'Video Overlay Builder').trim() || 'Video Overlay Builder',
      activeSlideId: String(source.activeSlideId || normalizedSlides[0].id),
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
      result.fit = result.fit === 'cover' ? 'cover' : 'contain';
    }
    return result;
  }

  function loadProject() {
    try {
      var saved = window.localStorage ? window.localStorage.getItem(STORAGE_KEY) : '';
      if (saved) return normalizeProject(JSON.parse(saved));
    } catch (_error) {
      // Fall through to the starter project.
    }
    return normalizeProject(sampleProject());
  }

  function saveProject() {
    try {
      project.activeSlideId = activeSlideId;
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
      setStatus('Draft saved.', 'success');
    } catch (_error) {
      setStatus('Draft is too large to save locally. Export JSON instead.', 'error');
    }
  }

  function queuePersist() {
    if (persistTimer) window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(saveProject, 350);
  }

  function setStatus(message, type) {
    if (!refs.status) return;
    refs.status.textContent = String(message || '');
    refs.status.className = type ? ('status ' + type) : 'status';
  }

  function getActiveSlide() {
    var slide = project.slides.find(function (entry) { return entry.id === activeSlideId; });
    if (slide) return slide;
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

  function setProjectTitle(value) {
    project.title = String(value || '').trim() || 'Video Overlay Builder';
    renderStageLabel();
    queuePersist();
  }

  function render() {
    renderProjectHeader();
    renderSlides();
    renderStage();
    renderItems();
    renderInspector();
  }

  function renderProjectHeader() {
    if (refs.projectTitle && refs.projectTitle.value !== project.title) refs.projectTitle.value = project.title;
  }

  function renderStageLabel() {
    var slide = getActiveSlide();
    if (refs.stageLabel) refs.stageLabel.textContent = project.title + ' / ' + slide.title;
  }

  function renderSlides() {
    var fragment = document.createDocumentFragment();
    project.slides.forEach(function (slide, index) {
      var item = document.createElement('li');
      item.className = 'overlay-slide-row' + (slide.id === activeSlideId ? ' active' : '');
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'overlay-slide-main';
      button.dataset.slideId = slide.id;
      button.setAttribute('aria-current', slide.id === activeSlideId ? 'true' : 'false');
      button.innerHTML = '<span class="overlay-slide-number"></span><span class="overlay-slide-copy"><strong></strong><span></span></span>';
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
  }

  function createStageItem(item, index) {
    var color = getColor(item.color);
    var node = document.createElement('article');
    node.className = [
      'overlay-stage-item',
      'overlay-type-' + item.type,
      'overlay-color-' + color.id,
      item.type === 'image' ? 'overlay-image-fit-' + (item.fit || 'contain') : '',
      item.id === selectedItemId ? 'is-selected' : ''
    ].filter(Boolean).join(' ');
    node.dataset.itemId = item.id;
    node.dataset.stageIndex = String(index);
    node.dataset.animation = item.animation;
    node.appendChild(createStageItemBody(item));

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

    var actions = document.createElement('div');
    actions.className = 'overlay-action-row';
    actions.innerHTML = '<button type="button" class="secondary-btn" data-duplicate-item>Duplicate</button><button type="button" class="ghost-btn danger-text" data-delete-selected>Delete</button>';
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
      '</div>',
      '<label class="overlay-field"><span>Animation</span><select data-item-field="animation"><option value="rise">Rise</option><option value="fade">Fade</option><option value="scale">Scale</option><option value="wipe">Wipe</option><option value="none">None</option></select></label>',
      '<label class="overlay-field"><span>Color</span><select data-item-field="color"></select></label>'
    ].join('');
    wrap.querySelector('.overlay-inspector-head span').textContent = utils.summarizeItem(item);
    var colorSelect = wrap.querySelector('[data-item-field="color"]');
    COLORS.forEach(function (color) {
      var option = document.createElement('option');
      option.value = color.id;
      option.textContent = color.label;
      colorSelect.appendChild(option);
    });
    ['title', 'x', 'y', 'w', 'h', 'delay', 'duration', 'animation', 'color'].forEach(function (field) {
      var input = wrap.querySelector('[data-item-field="' + field + '"]');
      input.value = item[field];
      input.addEventListener('input', function () {
        setItemField(item, field, input.value);
      });
      input.addEventListener('change', function () {
        setItemField(item, field, input.value);
      });
    });
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
      '<button type="button" class="secondary-btn" data-table-apply>Apply size</button>',
      '<button type="button" class="ghost-btn" data-table-add-row>Add row</button>',
      '<button type="button" class="ghost-btn" data-table-add-col>Add column</button>',
      '<button type="button" class="ghost-btn" data-table-remove-row>Remove row</button>',
      '<button type="button" class="ghost-btn" data-table-remove-col>Remove column</button>',
      '</div>'
    ].join('');
    wrap.querySelector('.overlay-inspector-head span').textContent = tableData.rowCount + ' x ' + tableData.colCount;
    wrap.querySelector('[data-table-rows]').value = tableData.rowCount;
    wrap.querySelector('[data-table-cols]').value = tableData.colCount;
    wrap.querySelector('[data-table-apply]').addEventListener('click', function () {
      resizeSelectedTable(item, wrap.querySelector('[data-table-rows]').value, wrap.querySelector('[data-table-cols]').value);
    });
    wrap.querySelector('[data-table-add-row]').addEventListener('click', function () {
      resizeSelectedTable(item, tableData.rowCount + 1, tableData.colCount);
    });
    wrap.querySelector('[data-table-add-col]').addEventListener('click', function () {
      resizeSelectedTable(item, tableData.rowCount, tableData.colCount + 1);
    });
    wrap.querySelector('[data-table-remove-row]').addEventListener('click', function () {
      resizeSelectedTable(item, tableData.rowCount - 1, tableData.colCount);
    });
    wrap.querySelector('[data-table-remove-col]').addEventListener('click', function () {
      resizeSelectedTable(item, tableData.rowCount, tableData.colCount - 1);
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
      '<label class="overlay-field"><span>Fit</span><select data-image-fit><option value="contain">Contain</option><option value="cover">Cover</option></select></label>',
      '<button type="button" class="secondary-btn" data-replace-image>Replace image</button>'
    ].join('');
    wrap.querySelector('.overlay-inspector-head span').textContent = item.src ? 'Image selected' : 'No image selected';
    wrap.querySelector('[data-image-alt]').value = item.alt || '';
    wrap.querySelector('[data-image-fit]').value = item.fit || 'contain';
    bindInput(wrap, '[data-image-alt]', function (value) {
      item.alt = value;
      queuePersist();
    });
    bindInput(wrap, '[data-image-fit]', function (value) {
      item.fit = value === 'cover' ? 'cover' : 'contain';
      renderStage();
      queuePersist();
    });
    wrap.querySelector('[data-replace-image]').addEventListener('click', function () {
      imageTargetItemId = item.id;
      refs.imageInput.click();
    });
    return wrap;
  }

  function bindInput(root, selector, handler) {
    var input = root.querySelector(selector);
    if (!input) return;
    input.addEventListener('input', function () { handler(input.value); });
    input.addEventListener('change', function () { handler(input.value); });
  }

  function setItemField(item, field, value) {
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
    } else {
      item[field] = String(value || '').trim() || item[field];
    }
    renderStage();
    renderItems();
    queuePersist();
  }

  function resizeSelectedTable(item, rows, cols) {
    item.table = utils.resizeTableData(item.table, rows, cols);
    renderStage();
    renderItems();
    renderInspector();
    queuePersist();
  }

  function roundToHalf(value) {
    return Math.round(Number(value || 0) * 2) / 2;
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
    item.w = roundToHalf(utils.clampNumber(item.w, 8, 96, 42));
    item.h = roundToHalf(utils.clampNumber(item.h, 8, 92, item.type === 'table' ? 28 : 24));
    item.x = roundToHalf(utils.clampNumber(item.x, 0, Math.max(0, 100 - item.w), 8));
    item.y = roundToHalf(utils.clampNumber(item.y, 0, Math.max(0, 100 - item.h), 10));
    item.w = roundToHalf(utils.clampNumber(item.w, 8, Math.max(8, 100 - item.x), item.w));
    item.h = roundToHalf(utils.clampNumber(item.h, 8, Math.max(8, 100 - item.y), item.h));
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
    slide.items.forEach(function (item, index) {
      insertDynamicRule(sheet, [
        '.overlay-stage-item[data-stage-index="' + String(index) + '"]{',
        'left:' + cssPercent(item.x, 0, 96, 8) + ';',
        'top:' + cssPercent(item.y, 0, 92, 10) + ';',
        'width:' + cssPercent(item.w, 8, 96, 42) + ';',
        'height:' + cssPercent(item.h, 8, 92, 24) + ';',
        '--motion-duration:' + cssSeconds(item.duration, 0.1, 10, 0.55) + ';',
        '}'
      ].join(''));
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

  function addItem(type, data) {
    var slide = getActiveSlide();
    var base = {
      id: uid('item'),
      type: type,
      title: type === 'table' ? 'Table' : (type === 'flow' ? 'Flow' : (type === 'image' ? 'Image' : 'Text card')),
      x: 10 + Math.min(18, slide.items.length * 3),
      y: 12 + Math.min(18, slide.items.length * 3),
      w: type === 'table' ? 44 : 38,
      h: type === 'flow' ? 18 : (type === 'table' ? 30 : 24),
      delay: 0,
      duration: 0.55,
      animation: 'rise',
      color: type === 'table' ? 'teal' : (type === 'flow' ? 'indigo' : 'orange')
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
    if (refs.previewProgress) {
      refs.previewProgress.offsetWidth;
    }
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
      setStatus('Preview complete.', 'success');
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
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = escapeName(project.title) + '.json';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
    setStatus('JSON export started.', 'success');
  }

  function importJsonFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        project = normalizeProject(JSON.parse(String(reader.result || '{}')));
        activeSlideId = project.activeSlideId;
        selectedItemId = '';
        render();
        queuePersist();
        setStatus('Project imported.', 'success');
      } catch (_error) {
        setStatus('Could not import this JSON file.', 'error');
      }
    };
    reader.readAsText(file);
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
      var imageData = {
        src: String(reader.result || ''),
        alt: String(file.name || 'Overlay image'),
        fit: 'contain'
      };
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
    reader.readAsDataURL(file);
  }

  function resetProject() {
    if (!window.confirm('Reset this overlay builder draft?')) return;
    project = normalizeProject(sampleProject());
    activeSlideId = project.activeSlideId;
    selectedItemId = '';
    render();
    saveProject();
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
    if (itemNode && itemNode.setPointerCapture) {
      try { itemNode.setPointerCapture(pointerId); } catch (_error) {}
    }

    function onMove(moveEvent) {
      var dx = ((moveEvent.clientX - startX) / stageRect.width) * 100;
      var dy = ((moveEvent.clientY - startY) / stageRect.height) * 100;
      if (mode === 'resize') {
        item.w = roundToHalf(utils.clampNumber(start.w + dx, 8, 96 - item.x, start.w));
        item.h = roundToHalf(utils.clampNumber(start.h + dy, 8, 92 - item.y, start.h));
      } else {
        item.x = roundToHalf(utils.clampNumber(start.x + dx, 0, 100 - item.w, start.x));
        item.y = roundToHalf(utils.clampNumber(start.y + dy, 0, 100 - item.h, start.y));
      }
      var node = findStageItemNode(item.id);
      if (node) {
        syncDynamicRules(getActiveSlide());
      }
    }

    function onUp() {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      renderInspector();
      queuePersist();
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  function iconSvg(name) {
    var icons = {
      copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><rect x="4" y="4" width="11" height="11" rx="2"></rect></svg>',
      trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M6 6l1 15h10l1-15"></path></svg>',
      corner: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 20h6v-6"></path><path d="M20 20l-7-7"></path></svg>',
      image: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><path d="M21 15l-5-5L5 21"></path></svg>',
      'arrow-right': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"></path><path d="M13 6l6 6-6 6"></path></svg>'
    };
    return icons[name] || '';
  }

  function wireEvents() {
    refs.projectTitle.addEventListener('input', function () { setProjectTitle(refs.projectTitle.value); });
    refs.addSlide.addEventListener('click', addSlide);
    refs.addText.addEventListener('click', function () {
      addItem('text', { body: 'Edit this overlay text.' });
    });
    refs.addTable.addEventListener('click', function () {
      var table = utils.createTableData(refs.tableRows.value, refs.tableCols.value);
      addItem('table', { table: table });
    });
    refs.addFlow.addEventListener('click', function () {
      addItem('flow', { steps: ['Start', 'Decision', 'Next step'] });
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

    refs.slideList.addEventListener('click', function (event) {
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
  }

  wireEvents();
  if (getActiveSlide().items.length) selectedItemId = getActiveSlide().items[0].id;
  render();
  refs.stopPreview.disabled = true;
})();
