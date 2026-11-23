(function () {
  'use strict';

  var Model = window.XpedElearningModel;
  var Icons = window.XpedElearningIcons;
  var grid = document.getElementById('el-dash-grid');
  var statusEl = document.getElementById('el-dash-status');
  var createDialog = document.getElementById('el-create-dialog');
  var titleInput = document.getElementById('el-new-title');
  var templateSelect = document.getElementById('el-new-template');
  var templatePreviewEl = document.getElementById('el-template-preview');
  var deleteDialog = document.getElementById('el-delete-dialog');
  var importDialog = document.getElementById('el-import-dialog');
  var searchInput = document.getElementById('el-dash-search');
  var pendingDeleteExp = null;
  var pendingImportPayload = null;
  var allExpeditions = [];
  var justDuplicatedId = '';
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

  function formatRelativeTime(epochSec) {
    if (!epochSec) return { rel: '', exact: '' };
    var d = new Date(epochSec * 1000);
    var exact = d.toLocaleString(document.documentElement.lang || undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    var diffSec = Math.max(0, Math.floor(Date.now() / 1000 - epochSec));
    var rel;
    if (diffSec < 60) rel = 'Updated just now';
    else if (diffSec < 3600) rel = 'Updated ' + Math.floor(diffSec / 60) + 'm ago';
    else if (diffSec < 86400) rel = 'Updated ' + Math.floor(diffSec / 3600) + 'h ago';
    else if (diffSec < 86400 * 7) rel = 'Updated ' + Math.floor(diffSec / 86400) + 'd ago';
    else rel = 'Updated ' + d.toLocaleDateString(document.documentElement.lang || undefined, { month: 'short', day: 'numeric' });
    return { rel: rel, exact: exact };
  }

  function renderTemplatePreview() {
    if (!templatePreviewEl || !templateSelect) return;
    var tpl = (Model.EXPEDITION_TEMPLATES && Model.EXPEDITION_TEMPLATES[templateSelect.value]) || null;
    templatePreviewEl.textContent = '';
    if (!tpl) return;
    var top = document.createElement('strong');
    top.textContent = tpl.stations + (tpl.stations === 1 ? ' station' : ' stations') + ' · ' + tpl.steps + (tpl.steps === 1 ? ' step' : ' steps') + ' · ~' + tpl.minutes + ' min';
    var sum = document.createElement('p');
    sum.className = 'el-exp-meta';
    sum.textContent = tpl.summary;
    var ul = document.createElement('ul');
    (tpl.outline || []).forEach(function (line) {
      var li = document.createElement('li');
      li.textContent = line;
      ul.appendChild(li);
    });
    templatePreviewEl.append(top, sum, ul);
  }
  if (templateSelect) {
    templateSelect.addEventListener('change', renderTemplatePreview);
    renderTemplatePreview();
  }

  function openCreateDialog() {
    document.getElementById('el-create-error').hidden = true;
    titleInput.value = '';
    renderTemplatePreview();
    createDialog.showModal();
    titleInput.focus();
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
    var q = searchInput ? searchInput.value.trim().toLowerCase() : '';
    if (searchInput) searchInput.hidden = !items.length;
    var visible = q
      ? items.filter(function (exp) { return String(exp.title || '').toLowerCase().indexOf(q) >= 0; })
      : items;

    grid.textContent = '';
    if (!items.length) {
      statusEl.textContent = '';
      var empty = document.createElement('div');
      empty.className = 'el-dash-empty';
      var body = document.createElement('div');
      var h2 = document.createElement('h2');
      h2.textContent = 'Create your first expedition';
      var p = document.createElement('p');
      p.textContent = 'Start with a blank station, a three-station BPS skeleton, or explore an interactive example.';
      // UX-001: Direct primary CTA inside empty state
      var cta = document.createElement('button');
      cta.type = 'button';
      cta.className = 'btn primary';
      cta.style.marginTop = '14px';
      cta.textContent = 'Create expedition';
      cta.addEventListener('click', openCreateDialog);
      body.append(h2, p, cta);
      empty.appendChild(body);
      grid.appendChild(empty);
      return;
    }
    if (!visible.length) {
      statusEl.textContent = '0 matching expeditions';
      var noMatch = document.createElement('div');
      noMatch.className = 'el-dash-empty';
      var nh = document.createElement('h2');
      nh.textContent = 'No expeditions match "' + searchInput.value.trim() + '"';
      var clr = document.createElement('button');
      clr.type = 'button';
      clr.className = 'btn small';
      clr.style.marginTop = '10px';
      clr.textContent = 'Clear search';
      clr.addEventListener('click', function () {
        searchInput.value = '';
        renderExpeditions(allExpeditions);
        searchInput.focus();
      });
      noMatch.append(nh, clr);
      grid.appendChild(noMatch);
      return;
    }
    statusEl.textContent = q
      ? ('Showing ' + visible.length + ' of ' + items.length + ' expeditions')
      : (items.length + (items.length === 1 ? ' expedition' : ' expeditions'));

    var focusDuplicateLink = null;
    visible.forEach(function (exp) {
      var card = document.createElement('article');
      card.className = 'el-exp-row' + (justDuplicatedId && exp.id === justDuplicatedId ? ' is-just-duplicated' : '');
      var editUrl = '/physio/elearning/' + encodeURIComponent(exp.id) + '/edit';

      var mainWrap = document.createElement('div');
      mainWrap.className = 'el-exp-row-main';

      // UX-002: Reserved cover thumbnail slot per expedition row
      var thumb = document.createElement('div');
      thumb.className = 'el-exp-thumb';
      thumb.setAttribute('aria-hidden', 'true');
      var cm = exp.coverMedia;
      if (cm && cm.kind === 'xped' && cm.staticPath) {
        var tImg = document.createElement('img');
        tImg.src = cm.staticPath;
        tImg.alt = '';
        tImg.loading = 'lazy';
        tImg.className = 'is-xped-art';
        thumb.appendChild(tImg);
      } else if (Icons) {
        thumb.appendChild(Icons.icon('compass', 22));
      }
      mainWrap.appendChild(thumb);

      var detail = document.createElement('div');
      detail.className = 'el-exp-row-copy';
      var top = document.createElement('div');
      top.className = 'el-exp-card-top';
      var h2 = document.createElement('h2');
      var title = document.createElement(exp.deletionPending ? 'span' : 'a');
      if (!exp.deletionPending) title.href = editUrl;
      title.textContent = exp.title || 'Untitled Expedition';
      title.setAttribute('translate', 'no');
      if (justDuplicatedId && exp.id === justDuplicatedId) focusDuplicateLink = title;
      h2.appendChild(title);
      var badge = document.createElement('span');
      badge.className = 'el-status-inline ' + (exp.shareEnabled ? 'is-live' : '');
      badge.textContent = exp.deletionPending ? 'Removal pending' : (exp.shareEnabled ? 'Test link live' : 'Private draft');
      top.append(h2, badge);

      var meta = document.createElement('p');
      meta.className = 'el-exp-meta';
      var role = exp.role === 'owner' ? 'Owner' : (exp.role === 'translate' ? 'Translator' : 'Co-Editor');
      var metaParts = [
        role,
        exp.moduleCount + (exp.moduleCount === 1 ? ' station' : ' stations'),
        exp.stepCount + (exp.stepCount === 1 ? ' step' : ' steps'),
      ];
      metaParts.forEach(function (value, i) {
        if (i) meta.append(' · ');
        var item = document.createElement('span');
        item.textContent = value;
        meta.appendChild(item);
      });
      // UX-003: Relative recency with exact timestamp tooltip
      var rec = formatRelativeTime(exp.updatedAt);
      if (rec.rel) {
        meta.append(' · ');
        var tNode = document.createElement('time');
        tNode.dateTime = new Date(exp.updatedAt * 1000).toISOString();
        tNode.title = rec.exact;
        tNode.textContent = rec.rel;
        meta.appendChild(tNode);
      }

      detail.append(top, meta);

      // UX-010: Per-locale translation coverage readiness badges
      var cov = exp.languageCoverage || null;
      var langs = exp.enabledLanguages || ['nl'];
      var covRow = document.createElement('div');
      covRow.className = 'el-lang-cov-row';
      langs.forEach(function (code) {
        var pill = document.createElement('span');
        var stat = cov && cov[code];
        if (stat && stat.total > 0 && Number.isFinite(Number(stat.translated))) {
          var pct = Math.round((Number(stat.translated) / Number(stat.total)) * 100);
          pill.className = 'el-lang-cov' + (pct === 100 && !stat.needsReview ? ' is-done' : (stat.needsReview ? ' is-warn' : ''));
          pill.textContent = code.toUpperCase() + ' ' + pct + '%' + (stat.needsReview ? ' · review' : '');
        } else {
          pill.className = 'el-lang-cov';
          pill.textContent = code.toUpperCase();
        }
        covRow.appendChild(pill);
      });
      detail.appendChild(covRow);
      mainWrap.appendChild(detail);

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
            var dupRes = await api('/api/elearning/expeditions/' + encodeURIComponent(exp.id) + '/duplicate', { method: 'POST', body: '{}' });
            justDuplicatedId = (dupRes && dupRes.expedition && dupRes.expedition.id) || '';
            toast('Expedition duplicated. Highlighted in list.', 'success');
            await loadList();
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
      card.append(mainWrap, actions);
      grid.appendChild(card);
    });

    // UX-005: Focus newly duplicated copy row
    if (focusDuplicateLink) {
      justDuplicatedId = '';
      focusDuplicateLink.focus();
    }
  }

  async function loadList() {
    var request = ++listRequest;
    retry.hidden = true;
    try {
      var data = await api('/api/elearning/expeditions');
      if (request !== listRequest) return;
      allExpeditions = data.expeditions || [];
      renderExpeditions(allExpeditions);
    } catch (err) {
      if (request !== listRequest || err.code === 'auth/session-changed') return;
      retry.hidden = false;
      statusEl.textContent = err.message;
    }
  }

  if (searchInput) {
    searchInput.addEventListener('input', function () { renderExpeditions(allExpeditions); });
  }

  document.getElementById('el-new-expedition-btn').addEventListener('click', openCreateDialog);
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
    var origText = confirm.textContent;
    confirm.style.minWidth = confirm.offsetWidth + 'px';
    confirm.disabled = true;
    confirm.textContent = 'Creating expedition…';
    var payload = Model.createExpeditionPreset(preset, titleInput.value, lang);
    try {
      var res = await api('/api/elearning/expeditions', { method: 'POST', body: JSON.stringify(payload) });
      createDialog.close();
      window.location.href = '/physio/elearning/' + encodeURIComponent(res.expedition.id) + '/edit';
    } catch (err) {
      dialogError('create', err);
      confirm.textContent = origText;
      confirm.disabled = false;
    }
  });

  // UX-006: JSON Import Preview Dialog before committing
  var importInput = document.getElementById('el-import-json-input');
  document.getElementById('el-import-json-btn').addEventListener('click', function () { importInput.click(); });
  if (importDialog) {
    document.getElementById('el-import-cancel').addEventListener('click', function () {
      pendingImportPayload = null;
      if (Icons) Icons.closeDialogAnimated(importDialog);
      else importDialog.close();
    });
    document.getElementById('el-import-confirm').addEventListener('click', async function () {
      if (!pendingImportPayload) return;
      var btn = document.getElementById('el-import-confirm');
      btn.disabled = true;
      btn.textContent = 'Importing…';
      try {
        var res = await api('/api/elearning/expeditions', { method: 'POST', body: JSON.stringify(pendingImportPayload) });
        pendingImportPayload = null;
        importDialog.close();
        toast('Imported expedition!', 'success');
        window.location.href = '/physio/elearning/' + encodeURIComponent(res.expedition.id) + '/edit';
      } catch (err) {
        dialogError('import', err);
        btn.disabled = false;
        btn.textContent = 'Import & Open Builder';
      }
    });
    importDialog.addEventListener('close', function () { importDialog.returnValue = ''; });
  }
  importInput.addEventListener('change', async function () {
    var file = importInput.files && importInput.files[0];
    if (!file) return;
    var session = client.captureSession();
    try {
      var text = await file.text();
      session.assertCurrent();
      var parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('JSON file must contain an expedition object.');
      }
      pendingImportPayload = parsed;
      var mods = Array.isArray(parsed.modules) ? parsed.modules : [];
      var stepsTotal = mods.reduce(function (acc, m) { return acc + (Array.isArray(m.steps) ? m.steps.length : 0); }, 0);
      var langs = Array.isArray(parsed.enabledLanguages) ? parsed.enabledLanguages.map(function (l) { return String(l).toUpperCase(); }).join(', ') : 'NL';
      var sumEl = document.getElementById('el-import-summary');
      sumEl.textContent = '';
      var tStrong = document.createElement('strong');
      tStrong.textContent = (parsed.title || 'Untitled Expedition');
      var mMeta = document.createElement('p');
      mMeta.className = 'el-exp-meta';
      mMeta.textContent = mods.length + ' station(s) · ' + stepsTotal + ' step(s) · Languages: ' + langs + ' · Imported as a private draft.';
      sumEl.append(tStrong, mMeta);
      document.getElementById('el-import-error').hidden = true;
      var cBtn = document.getElementById('el-import-confirm');
      cBtn.disabled = false;
      cBtn.textContent = 'Import & Open Builder';
      importDialog.showModal();
    } catch (err) {
      if (err.code !== 'auth/session-changed') toast('Could not read JSON: ' + err.message, 'error');
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
