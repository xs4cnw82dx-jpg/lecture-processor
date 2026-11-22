(function () {
  'use strict';

  var Model = window.XpedElearningModel;
  var Icons = window.XpedElearningIcons;
  var grid = document.getElementById('el-dash-grid');
  var statusEl = document.getElementById('el-dash-status');
  var createDialog = document.getElementById('el-create-dialog');
  var deleteDialog = document.getElementById('el-delete-dialog');
  var pendingDeleteExp = null;
  var toastEl = document.getElementById('el-toast');
  var currentToken = '';

  function showToast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(function () { toastEl.hidden = true; }, 3200);
  }

  async function authHeaders() {
    var headers = { 'Content-Type': 'application/json' };
    if (window.firebase && firebase.auth && firebase.auth().currentUser) {
      currentToken = await firebase.auth().currentUser.getIdToken();
    }
    if (currentToken) headers.Authorization = 'Bearer ' + currentToken;
    return headers;
  }

  async function api(url, opts) {
    var options = Object.assign({ method: 'GET' }, opts || {});
    options.headers = Object.assign(await authHeaders(), options.headers || {});
    var resp = await fetch(url, options);
    var data = await resp.json().catch(function () { return {}; });
    if (!resp.ok) throw new Error(data.error || ('Request failed (' + resp.status + ')'));
    return data;
  }

  function renderExpeditions(items) {
    grid.textContent = '';
    if (!items.length) {
      statusEl.textContent = '';
      var empty = document.createElement('div');
      empty.className = 'el-dash-empty';
      var img = document.createElement('img');
      img.src = '/static/images/xped/xped-wandelaar-met-kaart.png';
      img.alt = '';
      var body = document.createElement('div');
      var h2 = document.createElement('h2');
      h2.textContent = 'Start your first xPEDitie Pijn module';
      var p = document.createElement('p');
      p.textContent = 'Begin with a blank shell ready for your thesis partner, or launch the interactive showcase to explore Myth/Fact, Draagkracht Balance Scale, and multilingual DE translation.';
      var row = document.createElement('div');
      row.className = 'el-dash-actions';
      var b1 = document.createElement('button');
      b1.type = 'button';
      b1.className = 'xped-btn xped-btn-sun';
      b1.textContent = '+ Create Expedition';
      b1.addEventListener('click', function () { createDialog.showModal(); });
      row.appendChild(b1);
      body.appendChild(h2);
      body.appendChild(p);
      body.appendChild(row);
      empty.appendChild(img);
      empty.appendChild(body);
      grid.appendChild(empty);
      return;
    }
    statusEl.textContent = items.length + (items.length === 1 ? ' expedition' : ' expeditions');
    items.forEach(function (exp) {
      var card = document.createElement('article');
      card.className = 'el-exp-card';

      var top = document.createElement('div');
      top.className = 'el-exp-card-top';
      var h2 = document.createElement('h2');
      h2.textContent = exp.title || 'Untitled Expedition';
      var badge = document.createElement('span');
      badge.className = 'el-status-inline ' + (exp.shareEnabled ? 'is-live' : '');
      badge.textContent = exp.shareEnabled ? 'Test link live' : 'Draft';
      top.appendChild(h2);
      top.appendChild(badge);
      card.appendChild(top);

      var meta = document.createElement('div');
      meta.className = 'el-exp-meta';
      var roleTxt = exp.role === 'owner' ? 'Owner' : (exp.role === 'translate' ? 'Translator' : 'Co-Editor');
      meta.textContent = roleTxt + ' · ' + exp.moduleCount + ' stations · ' + exp.stepCount + ' steps · ' + (exp.enabledLanguages || ['nl']).map(function (l) { return l.toUpperCase(); }).join('/');
      card.appendChild(meta);

      var actions = document.createElement('div');
      actions.className = 'el-exp-card-actions';

      var openBtn = document.createElement('a');
      openBtn.href = '/physio/elearning/' + encodeURIComponent(exp.id) + '/edit';
      openBtn.className = 'el-btn el-btn-primary el-btn-sm';
      openBtn.textContent = exp.role === 'translate' ? 'Open Translator' : 'Open Builder';
      actions.appendChild(openBtn);

      if (exp.role !== 'translate') {
        var respBtn = document.createElement('a');
        respBtn.href = '/physio/elearning/' + encodeURIComponent(exp.id) + '/responses';
        respBtn.className = 'el-btn el-btn-sm';
        respBtn.textContent = 'Responses';
        actions.appendChild(respBtn);

        if (exp.shareToken) {
          var playBtn = document.createElement('a');
          playBtn.href = '/elearning/p/' + encodeURIComponent(exp.shareToken);
          playBtn.target = '_blank';
          playBtn.rel = 'noopener';
          playBtn.className = 'el-btn el-btn-sm';
          playBtn.textContent = 'Test Link ↗';
          actions.appendChild(playBtn);
        }

        var dupBtn = document.createElement('button');
        dupBtn.type = 'button';
        dupBtn.className = 'el-btn el-btn-sm';
        dupBtn.textContent = 'Duplicate';
        dupBtn.addEventListener('click', async function () {
          try {
            await api('/api/elearning/expeditions/' + encodeURIComponent(exp.id) + '/duplicate', { method: 'POST', body: '{}' });
            showToast('Expedition duplicated.');
            loadList();
          } catch (err) {
            showToast(err.message);
          }
        });
        actions.appendChild(dupBtn);
      }

      if (exp.role === 'owner') {
        var delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'el-btn el-btn-danger el-btn-sm';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', function () {
          pendingDeleteExp = exp;
          document.getElementById('el-delete-dialog-msg').textContent = 'Delete "' + exp.title + '"? This removes the expedition and deactivates its public share link.';
          deleteDialog.showModal();
        });
        actions.appendChild(delBtn);
      }

      card.appendChild(actions);
      grid.appendChild(card);
    });
  }

  async function loadList() {
    try {
      var data = await api('/api/elearning/expeditions');
      renderExpeditions(data.expeditions || []);
    } catch (err) {
      statusEl.textContent = err.message;
    }
  }

  document.getElementById('el-new-expedition-btn').addEventListener('click', function () {
    createDialog.showModal();
  });
  document.getElementById('el-create-cancel').addEventListener('click', function () {
    if (Icons) Icons.closeDialogAnimated(createDialog);
    else createDialog.close();
  });
  createDialog.addEventListener('close', function () { createDialog.returnValue = ''; });

  if (deleteDialog) {
    document.getElementById('el-delete-cancel').addEventListener('click', function () {
      if (Icons) Icons.closeDialogAnimated(deleteDialog);
      else deleteDialog.close();
    });
    document.getElementById('el-delete-confirm').addEventListener('click', async function () {
      if (!pendingDeleteExp) return;
      var target = pendingDeleteExp;
      pendingDeleteExp = null;
      try {
        await api('/api/elearning/expeditions/' + encodeURIComponent(target.id), { method: 'DELETE' });
        if (Icons) Icons.closeDialogAnimated(deleteDialog);
        else deleteDialog.close();
        showToast('Expedition deleted.');
        loadList();
      } catch (err) {
        showToast(err.message);
      }
    });
    deleteDialog.addEventListener('close', function () { deleteDialog.returnValue = ''; });
  }
  if (Icons) Icons.wireAnimatedDialogs();

  var selectedNewLang = 'nl';
  var selectedNewTemplate = 'blank';
  var NEW_LANG_ITEMS = [
    { value: 'nl', label: 'Nederlands (NL)' },
    { value: 'en', label: 'English (EN)' },
    { value: 'de', label: 'Deutsch (DE)' },
  ];
  var NEW_TPL_ITEMS = [
    { value: 'blank', label: 'Blank Expedition (1 empty station)' },
    { value: 'bps-skeleton', label: 'Biopsychosocial 3-Station Skeleton' },
    { value: 'showcase', label: 'Interactive Block Showcase (demo)' },
  ];
  if (Icons) {
    var langDD = Icons.createDropdown({
      className: 'is-full',
      triggerClass: 'el-dd-trigger is-full',
      ariaLabel: 'Primary Authoring Language',
      items: NEW_LANG_ITEMS,
      value: selectedNewLang,
      onChange: function (v) { selectedNewLang = v; langDD.setItems(NEW_LANG_ITEMS, v); },
    });
    var langHost = document.getElementById('el-new-lang-host');
    if (langHost) langHost.appendChild(langDD.el);

    var tplDD = Icons.createDropdown({
      className: 'is-full',
      triggerClass: 'el-dd-trigger is-full',
      ariaLabel: 'Starting Structure',
      items: NEW_TPL_ITEMS,
      value: selectedNewTemplate,
      onChange: function (v) { selectedNewTemplate = v; tplDD.setItems(NEW_TPL_ITEMS, v); },
    });
    var tplHost = document.getElementById('el-new-template-host');
    if (tplHost) tplHost.appendChild(tplDD.el);
  }

  document.getElementById('el-create-confirm').addEventListener('click', async function () {
    var title = document.getElementById('el-new-title').value.trim() || 'xPEDitie Pijn — Pilot v1';
    var lang = selectedNewLang || 'nl';
    var preset = selectedNewTemplate || 'blank';
    var payload = Model.createExpeditionPreset(preset, title, lang);
    try {
      var res = await api('/api/elearning/expeditions', { method: 'POST', body: JSON.stringify(payload) });
      createDialog.close();
      window.location.href = '/physio/elearning/' + encodeURIComponent(res.expedition.id) + '/edit';
    } catch (err) {
      showToast(err.message);
    }
  });

  var importInput = document.getElementById('el-import-json-input');
  document.getElementById('el-import-json-btn').addEventListener('click', function () { importInput.click(); });
  importInput.addEventListener('change', async function () {
    var file = importInput.files && importInput.files[0];
    if (!file) return;
    try {
      var text = await file.text();
      var parsed = JSON.parse(text);
      var res = await api('/api/elearning/expeditions', { method: 'POST', body: JSON.stringify(parsed) });
      showToast('Imported expedition!');
      window.location.href = '/physio/elearning/' + encodeURIComponent(res.expedition.id) + '/edit';
    } catch (err) {
      showToast('Could not import JSON: ' + err.message);
    } finally {
      importInput.value = '';
    }
  });

  Model.enableDialogLightDismissFallback();

  if (window.firebase && firebase.auth) {
    firebase.auth().onAuthStateChanged(function (user) {
      if (user) {
        loadList();
      } else {
        statusEl.textContent = 'Sign in to Lecture Processor to create and manage xPEDitie Pijn expeditions.';
        grid.textContent = '';
      }
    });
  } else {
    loadList();
  }
})();
