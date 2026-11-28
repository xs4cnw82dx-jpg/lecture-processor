(function () {
  'use strict';
  var uiText = typeof window !== 'undefined' && window.Xped && window.Xped.i18n ? window.Xped.i18n.t : function (message) { return message; };
  var platformUx = window.Xped ? window.Xped.ux : window.LectureProcessorUx;
  var platformBootstrap = window.Xped ? window.Xped.bootstrap : window.LectureProcessorBootstrap;
  var platformAuth = window.Xped ? window.Xped.auth : window.LectureProcessorAuth;

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
  var academy = !!document.querySelector('meta[name="academy-signin"]');
  var canCreate = !academy;
  var requestedAction = academy ? new URLSearchParams(location.search).get('actie') : '';
  var retry = document.getElementById('el-retry');
  var signIn = document.getElementById('el-signin');
  var auth;
  try { auth = platformBootstrap.getAuth(); } catch (_) { /* SDK unavailable */ }
  if (!auth && academy) {
    statusEl.textContent = uiText('Sign-in is temporarily unavailable. Reload this page to try again.');
    return;
  }
  var client = platformAuth.createAuthClient(auth);
  var admin = academy ? null : window.XpedStudioAdmin.create(api, loadList);
  var teamLink = document.getElementById('el-team-link');
  var folders = academy && window.XpedAcademyFolders(api, loadList, function () { renderExpeditions(allExpeditions); });
  var listRequest = 0;
  var importAttempt = 0;
  var coverCache = new Map();
  var coverObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      coverObserver.unobserve(entry.target);
      loadCover(entry.target);
    });
  });

  async function loadCover(thumb) {
    var url = thumb.dataset.cover;
    if (!coverCache.has(url)) {
      var session = client.captureSession();
      var pending = client.authFetch(url).then(async function (response) {
        if (!response.ok) throw new Error('Cover unavailable');
        var blob = await response.blob();
        session.assertCurrent();
        return URL.createObjectURL(blob);
      });
      coverCache.set(url, pending);
    }
    var cover = coverCache.get(url);
    try {
      var objectUrl = await cover;
      if (!thumb.isConnected || coverCache.get(url) !== cover) return;
      var image = new Image();
      image.alt = '';
      image.src = objectUrl;
      thumb.replaceChildren(image);
    } catch (_) {
      if (coverCache.get(url) === cover) coverCache.delete(url);
    }
  }

  function toast(message, type) {
    platformUx.toast(message, { type: type });
  }

  function formatRelativeTime(epochSec) {
    if (!epochSec) return { rel: '', exact: '' };
    var d = new Date(epochSec * 1000);
    const i18n = window.Xped && window.Xped.i18n;
    if (i18n) {
      return { rel: i18n.relative(epochSec), exact: i18n.date(d, { dateStyle: 'medium', timeStyle: 'short' }) };
    }
    var exact = d.toLocaleString(document.documentElement.lang || undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    var diffSec = Math.max(0, Math.floor(Date.now() / 1000 - epochSec));
    var rel;
    if (diffSec < 60) rel = uiText('Updated just now');
    else if (diffSec < 3600) rel = uiText('Updated ') + Math.floor(diffSec / 60) + uiText('m ago');
    else if (diffSec < 86400) rel = uiText('Updated ') + Math.floor(diffSec / 3600) + uiText('h ago');
    else if (diffSec < 86400 * 7) rel = uiText('Updated ') + Math.floor(diffSec / 86400) + uiText('d ago');
    else rel = uiText('Updated ') + d.toLocaleDateString(document.documentElement.lang || undefined, { month: 'short', day: 'numeric' });
    return { rel: rel, exact: exact };
  }

  function renderTemplatePreview() {
    if (!templatePreviewEl || !templateSelect) return;
    var tpl = (Model.EXPEDITION_TEMPLATES && Model.EXPEDITION_TEMPLATES[templateSelect.value]) || null;
    templatePreviewEl.textContent = '';
    if (!tpl) return;
    var top = document.createElement('strong');
    top.textContent = tpl.stations + (tpl.stations === 1 ? uiText(' station') : uiText(' stations')) + ' · ' + tpl.steps + (tpl.steps === 1 ? uiText(' step') : uiText(' steps')) + ' · ~' + tpl.minutes + uiText(' min');
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
    if (!canCreate) return;
    document.getElementById('el-create-error').hidden = true;
    titleInput.value = '';
    document.getElementById('el-create-progress').textContent = '';
    renderTemplatePreview();
    createDialog.showModal();
    titleInput.focus();
  }

  async function api(url, options) {
    var response = await client.authFetch(url, options, { ensureJsonContentType: true });
    var data = await response.json();
    if (!response.ok) throw new Error(uiText(data.error) || uiText('Could not complete this request.'));
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
    if (folders && folders.selected()) items = items.filter(folders.matches);
    var q = searchInput ? searchInput.value.trim().toLowerCase() : '';
    if (searchInput) searchInput.hidden = items.length < 2 && !q;
    coverObserver.disconnect();
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
      if (folders && folders.selected()) {
        h2.textContent = uiText('No expeditions in this folder');
        body.appendChild(h2);
        empty.appendChild(body);
        grid.appendChild(empty);
        return;
      }
      h2.textContent = canCreate ? uiText('Create your first expedition') : uiText('Author access is by invitation');
      var p = document.createElement('p');
      p.textContent = canCreate
        ? uiText('Start with a blank station, a three-station BPS skeleton, or explore an interactive example.')
        : uiText('To create expeditions, ask the Studio administrator to add your verified email address. To take an expedition, open the learner link you received.');
      body.append(h2, p);
      if (canCreate) {
        var cta = document.createElement('button');
        cta.type = 'button';
        cta.className = 'btn primary';
        cta.textContent = uiText('Create expedition');
        cta.addEventListener('click', openCreateDialog);
        body.appendChild(cta);
      }
      empty.appendChild(body);
      grid.appendChild(empty);
      return;
    }
    if (!visible.length) {
      statusEl.textContent = uiText('0 matching expeditions');
      var noMatch = document.createElement('div');
      noMatch.className = 'el-dash-empty';
      var nh = document.createElement('h2');
      nh.textContent = uiText('No expeditions match "') + searchInput.value.trim() + '"';
      var clr = document.createElement('button');
      clr.type = 'button';
      clr.className = 'btn small';
      clr.textContent = uiText('Clear search');
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
      ? (uiText('Showing ') + visible.length + uiText(' of ') + items.length + uiText(' expeditions'))
      : (items.length + (items.length === 1 ? uiText(' expedition') : uiText(' expeditions')));

    var focusDuplicateLink = null;
    visible.forEach(function (exp) {
      var card = document.createElement('article');
      card.className = 'el-exp-row' + (justDuplicatedId && exp.id === justDuplicatedId ? ' is-just-duplicated' : '');
      var editUrl = Model.coursePaths(exp.id).edit;

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
      if (cm && cm.kind === 'asset' && cm.assetId && !exp.deletionPending) {
        thumb.dataset.cover = '/api/elearning/expeditions/' + encodeURIComponent(exp.id) + '/assets/' + encodeURIComponent(cm.assetId);
        coverObserver.observe(thumb);
      }
      mainWrap.appendChild(thumb);

      var detail = document.createElement('div');
      detail.className = 'el-exp-row-copy';
      var top = document.createElement('div');
      top.className = 'el-exp-card-top';
      var h2 = document.createElement('h2');
      var title = document.createElement(exp.deletionPending ? 'span' : 'a');
      if (!exp.deletionPending) title.href = Model.coursePaths(exp.id).overview;
      title.textContent = exp.title || uiText('Untitled Expedition');
      title.setAttribute('translate', 'no');
      h2.appendChild(title);
      var badge = document.createElement('span');
      badge.className = 'el-status-inline ' + (exp.shareEnabled ? 'is-live' : '');
      badge.textContent = exp.deletionPending ? uiText('Removal pending') : (exp.shareEnabled ? (exp.collectResponses ? uiText('Pilot link active') : uiText('Learner link active')) : uiText('Private draft'));
      top.append(h2, badge);

      var meta = document.createElement('p');
      meta.className = 'el-exp-meta';
      var role = exp.role === 'owner' ? uiText('Owner') : (exp.role === 'translate' ? uiText('Translator') : uiText('Co-Editor'));
      var metaParts = [
        role,
        exp.moduleCount + (exp.moduleCount === 1 ? uiText(' station') : uiText(' stations')),
        exp.stepCount + (exp.stepCount === 1 ? uiText(' step') : uiText(' steps')),
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
        tNode.tabIndex = 0;
        tNode.setAttribute('aria-label', rec.rel + ', ' + rec.exact);
        tNode.textContent = rec.rel;
        meta.appendChild(tNode);
      }

      detail.append(top, meta);

      // UX-010: Per-locale translation coverage readiness badges
      var cov = exp.languageCoverage || null;
      var langs = (exp.enabledLanguages || ['nl']).filter(code => !academy || code === 'nl' || code === 'de');
      var covRow = document.createElement('div');
      covRow.className = 'el-lang-cov-row';
      var coverageDetail = document.createElement('p');
      coverageDetail.className = 'el-exp-meta el-coverage-detail';
      coverageDetail.hidden = true;
      coverageDetail.id = 'coverage-' + exp.id;
      langs.forEach(function (code) {
        var stat = cov && cov[code];
        var pill = document.createElement(stat && stat.total > 0 ? 'button' : 'span');
        if (stat && stat.total > 0 && Number.isFinite(Number(stat.translated))) {
          var pct = Math.round((Number(stat.translated) / Number(stat.total)) * 100);
          pill.type = 'button';
          pill.setAttribute('aria-controls', coverageDetail.id);
          pill.setAttribute('aria-expanded', 'false');
          pill.addEventListener('click', function () {
            var open = pill.getAttribute('aria-expanded') !== 'true';
            covRow.querySelectorAll('button').forEach(function (other) { other.setAttribute('aria-expanded', 'false'); });
            pill.setAttribute('aria-expanded', String(open));
            coverageDetail.textContent = code.toUpperCase() + ' · ' + stat.translated + uiText(' of ') + stat.total + uiText(' fields translated') + (stat.needsReview ? ' · ' + stat.needsReview + uiText(' need review') : '');
            coverageDetail.hidden = !open;
          });
          pill.className = 'el-lang-cov' + (pct === 100 && !stat.needsReview ? ' is-done' : (stat.needsReview ? ' is-warn' : ''));
          pill.textContent = code.toUpperCase() + ' ' + pct + '%' + (stat.needsReview ? uiText(' · review') : '');
        } else {
          pill.className = 'el-lang-cov';
          pill.textContent = code.toUpperCase();
        }
        covRow.appendChild(pill);
      });
      detail.append(covRow, coverageDetail);
      mainWrap.appendChild(detail);

      var actions = document.createElement('div');
      actions.className = 'el-exp-card-actions';
      var menuItems = [];
      if (!exp.deletionPending) {
        var isCopy = justDuplicatedId === exp.id;
        var open = actionLink(isCopy ? uiText('Open copy') : exp.role === 'translate' ? uiText('Open Translator') : uiText('Open Builder'), editUrl, true);
        if (isCopy) focusDuplicateLink = open;
        actions.appendChild(open);
      }
      if (!exp.deletionPending && exp.role !== 'translate') {
        actions.appendChild(actionLink(uiText('Responses'), Model.coursePaths(exp.id).report));
        if (academy) menuItems.push({ label: document.documentElement.lang === 'de' ? 'Freigabe und Zugriff' : 'Delen en toegang', icon: 'share', href: Model.coursePaths(exp.id).overview + '#delen' });
        if (exp.shareEnabled && exp.shareToken) {
          menuItems.push({ label: uiText('Open learner link'), icon: 'external', href: Model.learnerPath(exp.shareToken) });
        }
      }
      if (canCreate && !exp.deletionPending && exp.role !== 'translate') {
        menuItems.push({ label: uiText('Duplicate'), icon: 'copy', onClick: async function () {
          try {
            var dupRes = await api('/api/elearning/expeditions/' + encodeURIComponent(exp.id) + '/duplicate', { method: 'POST', body: '{}' });
            justDuplicatedId = (dupRes && dupRes.expedition && dupRes.expedition.id) || '';
            toast(uiText('Expedition duplicated. Highlighted in list.'), 'success');
            await loadList();
          } catch (err) { if (err.code !== 'auth/session-changed') toast(err.message, 'error'); }
        } });
      }
      if (exp.role !== 'translate') {
        if (exp.role === 'owner') {
          if (folders && canCreate && !exp.deletionPending) {
            menuItems.push({ label: uiText('Move to folder'), onClick: function () { folders.move(exp); } });
          }
          if (menuItems.length) menuItems.push({ divider: true });
          menuItems.push({ label: uiText('Delete'), icon: 'trash', danger: true, onClick: function () {
            pendingDeleteExp = exp;
            document.getElementById('el-delete-dialog-msg').textContent = exp.title;
            document.getElementById('el-delete-error').hidden = true;
            deleteDialog.showModal();
            document.getElementById('el-delete-cancel').focus();
          } });
        }
        if (menuItems.length) {
          var menu = Icons.createDropdown({ ariaLabel: uiText('More actions for ') + exp.title, leadingIcon: 'more', align: 'right', fixedLabel: '', showChevron: false, items: menuItems });
          actions.appendChild(menu.el);
        }
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

  async function loadList(folderSelection) {
    var request = ++listRequest;
    retry.hidden = true;
    try {
      var data = await api('/api/elearning/expeditions');
      if (request !== listRequest) return;
      allExpeditions = data.expeditions || [];
      canCreate = !academy || data.canCreate === true;
      if (folders) folders.update(data.folders, canCreate, typeof folderSelection === 'string' ? folderSelection : undefined);
      actionsEl.hidden = !canCreate && !data.studioAdmin;
      document.getElementById('el-new-expedition-btn').hidden = !canCreate;
      document.getElementById('el-import-json-btn').hidden = !canCreate;
      if (admin) admin.setCourses(data.studioAdmin === true, allExpeditions);
      if (teamLink) teamLink.hidden = !data.studioAdmin;
      renderExpeditions(allExpeditions);
      if (canCreate && ['nieuw', 'importeren'].includes(requestedAction)) {
        var action = requestedAction;
        requestedAction = '';
        var url = new URL(location.href);
        url.searchParams.delete('actie');
        history.replaceState(history.state, '', url);
        if (action === 'nieuw') openCreateDialog();
        else document.getElementById('el-import-json-btn').focus();
      }
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

  function lockDialog(dialog, saving) {
    dialog.setAttribute('closedby', saving ? 'none' : 'any');
    dialog.querySelector('form[method="dialog"] button').disabled = saving;
    dialog.querySelector('[id$="-cancel"]').disabled = saving;
    dialog.toggleAttribute('data-saving', saving);
  }
  [createDialog, importDialog].forEach(function (dialog) {
    dialog.addEventListener('cancel', function (event) {
      if (dialog.hasAttribute('data-saving')) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  });

  function dialogError(name, err) {
    if (err.code === 'auth/session-changed') return;
    var error = document.getElementById('el-' + name + '-error');
    error.textContent = err.message;
    error.hidden = false;
  }

  document.getElementById('el-create-form').addEventListener('submit', async function (event) {
    event.preventDefault();
    var confirm = document.getElementById('el-create-confirm');
    if (confirm.disabled) return;
    titleInput.value = titleInput.value.trim();
    if (!titleInput.reportValidity()) return;
    var lang = document.getElementById('el-new-lang').value;
    var preset = document.getElementById('el-new-template').value;
    var origText = confirm.textContent;
    var progress = document.getElementById('el-create-progress');
    progress.textContent = uiText('Creating expedition…');
    confirm.disabled = true;
    lockDialog(createDialog, true);
    confirm.textContent = uiText('Creating expedition…');
    var payload = Model.createExpeditionPreset(preset, titleInput.value, lang, { academy: academy });
    if (academy) payload.enabledLanguages = ['nl', 'de'];
    try {
      var res = await api('/api/elearning/expeditions', { method: 'POST', body: JSON.stringify(payload) });
      createDialog.close();
      window.location.href = Model.coursePaths(res.expedition.id).edit;
    } catch (err) {
      if (err.code === 'auth/session-changed') return;
      lockDialog(createDialog, false);
      dialogError('create', err);
      progress.textContent = '';
      confirm.textContent = origText;
      confirm.disabled = false;
    }
  });

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
      if (btn.disabled) return;
      btn.disabled = true;
      lockDialog(importDialog, true);
      btn.textContent = uiText('Importing…');
      try {
        var res = await api('/api/elearning/expeditions', { method: 'POST', body: JSON.stringify(pendingImportPayload) });
        pendingImportPayload = null;
        importDialog.close();
        toast('Imported expedition!', 'success');
        window.location.href = Model.coursePaths(res.expedition.id).edit;
      } catch (err) {
        if (err.code === 'auth/session-changed') return;
        lockDialog(importDialog, false);
        dialogError('import', err);
        btn.disabled = false;
        btn.textContent = uiText('Import & Open Builder');
      }
    });
    importDialog.addEventListener('close', function () {
      ++importAttempt;
      pendingImportPayload = null;
      importDialog.returnValue = '';
    });
  }
  importInput.addEventListener('change', async function () {
    var file = importInput.files && importInput.files[0];
    if (!file) return;
    var session = client.captureSession();
    var attempt = ++importAttempt;
    var summary = document.getElementById('el-import-summary');
    var confirm = document.getElementById('el-import-confirm');
    pendingImportPayload = null;
    confirm.disabled = true;
    confirm.textContent = uiText('Import & Open Builder');
    summary.textContent = uiText('Checking expedition…');
    document.getElementById('el-import-error').hidden = true;
    importDialog.showModal();
    try {
      var parsed = JSON.parse(await file.text());
      session.assertCurrent();
      if (attempt !== importAttempt) return;
      var checked = await api('/api/elearning/import-preview', { method: 'POST', body: JSON.stringify(parsed) });
      session.assertCurrent();
      if (attempt !== importAttempt) return;
      pendingImportPayload = parsed;
      var title = document.createElement('strong');
      title.textContent = checked.title;
      title.setAttribute('translate', 'no');
      var info = document.createElement('p');
      info.className = 'el-exp-meta';
      info.textContent = checked.stationCount + (checked.stationCount === 1 ? uiText(' station') : uiText(' stations')) + ' · ' +
        checked.stepCount + (checked.stepCount === 1 ? uiText(' step') : uiText(' steps')) + ' · ' +
        checked.enabledLanguages.join(', ').toUpperCase() + uiText(' · Private draft');
      summary.replaceChildren(title, info);
      confirm.disabled = false;
    } catch (err) {
      if (attempt === importAttempt && err.code !== 'auth/session-changed') {
        summary.textContent = file.name;
        dialogError('import', err instanceof SyntaxError ? new Error('This file is not valid JSON.') : err);
      }
    } finally {
      importInput.value = '';
    }
  });

  Model.enableDialogLightDismissFallback();

  retry.addEventListener('click', loadList);

  function accountChanged(user) {
    if (admin) admin.reset();
    if (teamLink) teamLink.hidden = true;
    if (folders) folders.reset();
    ++listRequest;
    ++importAttempt;
    pendingImportPayload = null;
    lockDialog(createDialog, false);
    lockDialog(importDialog, false);
    if (importDialog.open) importDialog.close();
    allExpeditions = [];
    justDuplicatedId = '';
    searchInput.value = '';
    searchInput.hidden = true;
    coverObserver.disconnect();
    coverCache.forEach(function (pending) { pending.then(URL.revokeObjectURL).catch(function () {}); });
    coverCache.clear();
    document.getElementById('el-create-progress').textContent = '';
    var createButton = document.getElementById('el-create-confirm');
    createButton.disabled = false;
    createButton.textContent = uiText('Create & Open Builder');
    pendingDeleteExp = null;
    if (deleteDialog.open) deleteDialog.close();
    if (createDialog.open) createDialog.close();
    grid.replaceChildren();
    document.getElementById('el-delete-dialog-msg').textContent = '';
    titleInput.value = '';
    canCreate = !academy;
    actionsEl.hidden = !user || !canCreate;
    signIn.hidden = !!user;
    retry.hidden = true;
    statusEl.textContent = user ? uiText('Loading your expeditions…') : uiText('Sign in to view your expeditions.');
    if (user) loadList();
  }
  if (auth) auth.onAuthStateChanged(accountChanged);
  else accountChanged(null);
})();
