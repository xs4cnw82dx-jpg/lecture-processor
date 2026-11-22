(function () {
  'use strict';

  var Model = window.XpedElearningModel;
  var Icons = window.XpedElearningIcons;
  var grid = document.getElementById('el-dash-grid');
  var statusEl = document.getElementById('el-dash-status');
  var createDialog = document.getElementById('el-create-dialog');
  var titleInput = document.getElementById('el-new-title');
  var deleteDialog = document.getElementById('el-delete-dialog');
  var pendingDeleteExp = null;
  var actionsEl = document.getElementById('el-author-actions');
  var retry = document.getElementById('el-retry');
  var signIn = document.getElementById('el-signin');
  var auth;
  try { auth = window.LectureProcessorBootstrap.getAuth(); } catch (_) { /* SDK unavailable */ }
  var client = window.LectureProcessorAuth.createAuthClient(auth);
  var listRequest = 0;

  function toast(message, type) {
    window.LectureProcessorUx.toast(message, { type: type });
  }

  async function api(url, options) {
    var response = await client.authFetch(url, options, { ensureJsonContentType: true });
    var data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not complete this request.');
    return data;
  }

  function actionLink(label, url, primary) {
    var link = document.createElement('a');
    link.className = primary ? 'btn small' : 'el-action-link';
    link.href = url;
    link.textContent = label;
    return link;
  }

  function renderExpeditions(items) {
    grid.textContent = '';
    if (!items.length) {
      statusEl.textContent = '';
      var empty = document.createElement('div');
      empty.className = 'el-dash-empty';
      var body = document.createElement('div');
      var h2 = document.createElement('h2');
      h2.textContent = 'Create your first expedition';
      var p = document.createElement('p');
      p.textContent = 'Use New expedition to start with a blank station or explore an interactive example.';
      body.append(h2, p);
      empty.appendChild(body);
      grid.appendChild(empty);
      return;
    }
    statusEl.textContent = items.length + (items.length === 1 ? ' expedition' : ' expeditions');
    items.forEach(function (exp) {
      var card = document.createElement('article');
      card.className = 'el-exp-row';
      var editUrl = '/physio/elearning/' + encodeURIComponent(exp.id) + '/edit';
      var detail = document.createElement('div');
      var top = document.createElement('div');
      top.className = 'el-exp-card-top';
      var h2 = document.createElement('h2');
      var title = document.createElement(exp.deletionPending ? 'span' : 'a');
      if (!exp.deletionPending) title.href = editUrl;
      title.textContent = exp.title || 'Untitled Expedition';
      title.setAttribute('translate', 'no');
      h2.appendChild(title);
      var badge = document.createElement('span');
      badge.className = 'el-status-inline ' + (exp.shareEnabled ? 'is-live' : '');
      badge.textContent = exp.deletionPending ? 'Removal pending' : (exp.shareEnabled ? 'Test link live' : 'Draft');
      top.append(h2, badge);
      var meta = document.createElement('p');
      meta.className = 'el-exp-meta';
      var role = exp.role === 'owner' ? 'Owner' : (exp.role === 'translate' ? 'Translator' : 'Co-Editor');
      var languages = (exp.enabledLanguages || ['nl']).map(function (l) { return l.toUpperCase(); });
      [role, exp.moduleCount + (exp.moduleCount === 1 ? ' station' : ' stations'),
        exp.stepCount + (exp.stepCount === 1 ? ' step' : ' steps'), languages.join(' / ')].forEach(function (value, i) {
        if (i) meta.append(' · ');
        var item = document.createElement('span');
        item.textContent = value;
        meta.appendChild(item);
      });
      detail.append(top, meta);
      var actions = document.createElement('div');
      actions.className = 'el-exp-card-actions';
      var menuItems = [];
      if (!exp.deletionPending) actions.appendChild(actionLink(exp.role === 'translate' ? 'Open Translator' : 'Open Builder', editUrl, true));
      if (!exp.deletionPending && exp.role !== 'translate') {
        actions.appendChild(actionLink('Responses', '/physio/elearning/' + encodeURIComponent(exp.id) + '/responses'));
        if (exp.shareEnabled && exp.shareToken) {
          menuItems.push({ label: 'Open test link', icon: 'external', href: '/elearning/p/' + encodeURIComponent(exp.shareToken) });
        }
        menuItems.push({ label: 'Duplicate', icon: 'copy', onClick: async function () {
          try {
            await api('/api/elearning/expeditions/' + encodeURIComponent(exp.id) + '/duplicate', { method: 'POST', body: '{}' });
            toast('Expedition duplicated.', 'success');
            loadList();
          } catch (err) { if (err.code !== 'auth/session-changed') toast(err.message, 'error'); }
        } });
      }
      if (exp.role !== 'translate') {
        if (exp.role === 'owner') {
          menuItems.push({ label: 'Delete', icon: 'trash', danger: true, onClick: function () {
            pendingDeleteExp = exp;
            document.getElementById('el-delete-dialog-msg').textContent = exp.title;
            document.getElementById('el-delete-error').hidden = true;
            deleteDialog.showModal();
            document.getElementById('el-delete-cancel').focus();
          } });
        }
        var menu = Icons.createDropdown({ ariaLabel: 'More actions', leadingIcon: 'more', align: 'right', fixedLabel: '', showChevron: false, items: menuItems });
        actions.appendChild(menu.el);
      }
      card.append(detail, actions);
      grid.appendChild(card);
    });
  }

  async function loadList() {
    var request = ++listRequest;
    retry.hidden = true;
    try {
      var data = await api('/api/elearning/expeditions');
      if (request !== listRequest) return;
      renderExpeditions(data.expeditions || []);
    } catch (err) {
      if (request !== listRequest || err.code === 'auth/session-changed') return;
      retry.hidden = false;
      statusEl.textContent = err.message;
    }
  }

  document.getElementById('el-new-expedition-btn').addEventListener('click', function () {
    document.getElementById('el-create-error').hidden = true;
    titleInput.value = '';
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
      var confirm = document.getElementById('el-delete-confirm');
      confirm.disabled = true;
      try {
        await api('/api/elearning/expeditions/' + encodeURIComponent(target.id), { method: 'DELETE' });
        if (Icons) Icons.closeDialogAnimated(deleteDialog);
        else deleteDialog.close();
        toast('Expedition deleted.', 'success');
        loadList();
      } catch (err) {
        if (pendingDeleteExp === target) dialogError('delete', err);
      } finally { confirm.disabled = false; }
    });
    deleteDialog.addEventListener('close', function () { deleteDialog.returnValue = ''; });
  }
  if (Icons) Icons.wireAnimatedDialogs();

  function dialogError(name, err) {
    if (err.code === 'auth/session-changed') return;
    var error = document.getElementById('el-' + name + '-error');
    error.textContent = err.message;
    error.hidden = false;
  }

  document.getElementById('el-create-form').addEventListener('submit', async function (event) {
    event.preventDefault();
    titleInput.value = titleInput.value.trim();
    if (!titleInput.reportValidity()) return;
    var lang = document.getElementById('el-new-lang').value;
    var preset = document.getElementById('el-new-template').value;
    var confirm = document.getElementById('el-create-confirm');
    confirm.disabled = true;
    var payload = Model.createExpeditionPreset(preset, titleInput.value, lang);
    try {
      var res = await api('/api/elearning/expeditions', { method: 'POST', body: JSON.stringify(payload) });
      createDialog.close();
      window.location.href = '/physio/elearning/' + encodeURIComponent(res.expedition.id) + '/edit';
    } catch (err) {
      dialogError('create', err);
    } finally { confirm.disabled = false; }
  });

  var importInput = document.getElementById('el-import-json-input');
  document.getElementById('el-import-json-btn').addEventListener('click', function () { importInput.click(); });
  importInput.addEventListener('change', async function () {
    var file = importInput.files && importInput.files[0];
    if (!file) return;
    var session = client.captureSession();
    try {
      var text = await file.text();
      session.assertCurrent();
      var parsed = JSON.parse(text);
      var res = await api('/api/elearning/expeditions', { method: 'POST', body: JSON.stringify(parsed) });
      toast('Imported expedition!', 'success');
      window.location.href = '/physio/elearning/' + encodeURIComponent(res.expedition.id) + '/edit';
    } catch (err) {
      if (err.code !== 'auth/session-changed') toast('Could not import JSON: ' + err.message, 'error');
    } finally {
      importInput.value = '';
    }
  });

  Model.enableDialogLightDismissFallback();

  retry.addEventListener('click', loadList);

  function accountChanged(user) {
    ++listRequest;
    pendingDeleteExp = null;
    if (deleteDialog.open) deleteDialog.close();
    if (createDialog.open) createDialog.close();
    grid.replaceChildren();
    document.getElementById('el-delete-dialog-msg').textContent = '';
    titleInput.value = '';
    actionsEl.hidden = !user;
    signIn.hidden = !!user;
    retry.hidden = true;
    statusEl.textContent = user ? 'Loading your expeditions…' : 'Sign in to view your expeditions.';
    if (user) loadList();
  }
  if (auth) auth.onAuthStateChanged(accountChanged);
  else accountChanged(null);
})();
