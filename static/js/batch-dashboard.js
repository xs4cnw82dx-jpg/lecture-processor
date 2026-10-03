(function () {
  'use strict';
  var bootstrap = window.LectureProcessorBootstrap || {}, util = window.LectureProcessorBatchStatus;
  var auth = bootstrap.getAuth ? bootstrap.getAuth() : null;
  var authUtils = window.LectureProcessorAuth || {};
  var client = auth && authUtils.createAuthClient ? authUtils.createAuthClient(auth, { notSignedInMessage: 'Please sign in' }) : null;
  var page = document.querySelector('.batch-dashboard-page'), id = page.dataset.batchId;
  var content = document.getElementById('batch-dashboard-content'), gate = document.getElementById('batch-dashboard-auth-gate');
  var rowsNode = document.getElementById('batch-dashboard-rows'), errorNode = document.getElementById('batch-dashboard-error');
  var modeFilter = document.getElementById('batch-dashboard-mode-filter'), strategyFilter = document.getElementById('batch-dashboard-strategy-filter');
  var ux = window.LectureProcessorUx || {};
  var filterControls = [];
  function syncFilters() { filterControls.forEach(function (control) { control.sync(); }); }
  var batches = [], loaded = false, revision = 0, timer = null, running = null, view = 'all', lastList = '';
  function fetcher(path, options) { return client ? client.authFetch(path, options, { retryOn401: true }) : Promise.reject(new Error('Please sign in')); }
  function uid() { return auth && auth.currentUser ? auth.currentUser.uid : ''; }
  var detail = id ? util.renderer({ element: document.getElementById('batch-detail'), fetch: fetcher, uid: uid }) : null;
  function inView(b, v) {
    if (v === 'archived') return !!b.archived;
    if (b.archived) return false;
    if (v === 'active') return !util.terminal(b.status);
    if (v === 'completed') return b.status === 'complete';
    if (v === 'attention') return b.status === 'partial' || b.status === 'error';
    return true;
  }
  function readFilters() {
    var params = new URLSearchParams(location.search);
    view = ['all', 'active', 'completed', 'attention', 'archived'].indexOf(params.get('view')) >= 0 ? params.get('view') : 'all';
    modeFilter.value = params.get('mode') || ''; strategyFilter.value = params.get('strategy') || '';
    document.getElementById('batch-filters').open = !!(modeFilter.value || strategyFilter.value);
    syncFilters();
  }
  function saveFilters() {
    var params = new URLSearchParams();
    if (view !== 'all') params.set('view', view);
    if (modeFilter.value) params.set('mode', modeFilter.value);
    if (strategyFilter.value) params.set('strategy', strategyFilter.value);
    history.replaceState(null, '', '/batch_status' + (params.size ? '?' + params.toString() : ''));
  }
  function render() {
    if (id) return;
    var filtered = batches.filter(function (b) { return (!modeFilter.value || b.mode === modeFilter.value) && (!strategyFilter.value || (b.processing_strategy || 'batch') === strategyFilter.value); });
    document.querySelectorAll('[data-view]').forEach(function (tab) {
      tab.setAttribute('aria-current', tab.dataset.view === view ? 'page' : 'false');
      tab.querySelector('[data-count]').textContent = filtered.filter(function (b) { return inView(b, tab.dataset.view); }).length;
    });
    var visible = filtered.filter(function (b) { return inView(b, view); }).sort(function (a, b) { return Number(util.terminal(a.status)) - Number(util.terminal(b.status)) || Number(b.created_at || 0) - Number(a.created_at || 0); });
    document.getElementById('batch-list-limit').textContent = batches.length >= 200 ? 'Latest 200 batches · counts refer to loaded batches' : batches.length + (batches.length === 1 ? ' batch in your workspace' : ' batches in your workspace');
    var html = '';
    if (!visible.length) {
      var empty = !batches.length && !modeFilter.value && !strategyFilter.value && view === 'all';
      html = '<div class="bs-empty">' + util.icon(empty ? 'file' : 'check') + '<h2>' + (empty ? 'No batches yet' : 'No matches') + '</h2><p>' + (empty ? 'Your batches will appear here after you start one.' : 'Try another view or clear your filters.') + '</p>' + (empty ? '<a class="bs-button bs-primary" href="/batch_mode">Start a batch</a>' : '<button type="button" class="bs-button" data-dashboard-action="clear">Clear filters</button>') + '</div>';
    } else visible.forEach(function (b) {
      var batchId = util.escape(b.batch_id), href = util.detailUrl(b.batch_id) + '?return=' + encodeURIComponent(location.pathname + location.search);
      html += '<article class="bs-list-row" role="row" data-id="' + batchId + '"><div role="cell"><a class="bs-batch-title" href="' + util.escape(href) + '">' + util.escape(b.batch_title || b.batch_id) + '</a><p class="bs-muted">' + util.escape(util.mode(b)) + '</p></div><div role="cell">' + util.pill(b.status) + '</div><div role="cell" class="bs-list-progress">' + util.escape(util.progress(b)) + util.progressBar(b) + '</div><div role="cell" class="bs-date">' + util.escape(util.date(b.created_at)) + '</div><div role="cell" class="bs-actions"><a class="bs-button" href="' + util.escape(href) + '">View details</a>' + (b.can_download_zip ? '<button class="bs-button" type="button" data-dashboard-action="zip">Download ZIP</button>' : '') + (util.terminal(b.status) ? '<details class="bs-overflow" data-app-menu><summary aria-label="More actions for ' + util.escape(b.batch_title || b.batch_id) + '">•••</summary><div class="app-menu-panel"><button class="bs-button" type="button" data-dashboard-action="archive">' + (b.archived ? 'Restore' : 'Archive') + '</button></div></details>' : '') + '</div></article>';
    });
    if (html !== lastList) {
      var focus = document.activeElement, action = focus.dataset && focus.dataset.dashboardAction;
      var focusRow = focus.closest && focus.closest('[data-id]');
      var focusId = focusRow && focusRow.dataset.id;
      var openIds = Array.from(rowsNode.querySelectorAll('details[open]')).map(function (d) { return d.closest('[data-id]').dataset.id; });
      lastList = html; rowsNode.innerHTML = html;
      rowsNode.querySelectorAll('[data-id]').forEach(function (row) {
        var menu = row.querySelector('details'); if (menu) menu.open = openIds.indexOf(row.dataset.id) >= 0;
        if (row.dataset.id === focusId) {
          var next = Array.from(row.querySelectorAll('[data-dashboard-action]')).find(function (b) { return b.dataset.dashboardAction === action; });
          if (next) next.focus({ preventScroll: true });
        }
      });
    }
  }
  function schedule() { clearTimeout(timer); if (!id && uid()) timer = setTimeout(load, document.visibilityState === 'hidden' ? 60000 : 20000); }
  function load() {
    if (!uid()) return Promise.resolve();
    if (running) return running;
    clearTimeout(timer); var r = revision;
    running = util.json(fetcher, '/api/batch/jobs?limit=200').then(function (payload) {
      if (r !== revision) return;
      batches = Array.isArray(payload.batches) ? payload.batches : []; loaded = true;
      errorNode.hidden = true; render();
    }).catch(function (e) {
      if (r !== revision) return;
      errorNode.hidden = false; errorNode.textContent = 'Couldn’t refresh. ' + e.message;
      var retry = document.createElement('button'); retry.className = 'bs-button'; retry.textContent = 'Retry'; retry.onclick = load; errorNode.appendChild(retry);
      if (!loaded) { rowsNode.innerHTML = '<div class="bs-empty">' + util.icon('alert') + '<h2>Your batches couldn’t be loaded</h2><p>Your saved batches are unchanged. Restore your connection, then try again.</p></div>'; lastList = ''; }
    }).finally(function () { if (r === revision) { running = null; schedule(); } });
    return running;
  }
  document.getElementById('batch-dashboard-signin-btn').onclick = function () { location.href = authUtils.buildSignInUrl ? authUtils.buildSignInUrl() : '/lecture-notes?auth=signin'; };
  if (id) {
    var back = new URLSearchParams(location.search).get('return');
    if (back && /^\/batch_status(?:\?[^#]*)?$/.test(back)) document.getElementById('batch-back-link').href = back;
  } else {
    readFilters();
    if (ux.enhanceNativeSelect) filterControls = [modeFilter, strategyFilter].map(function (select) { return ux.enhanceNativeSelect(select); }).filter(Boolean);
    document.getElementById('batch-dashboard-refresh-btn').onclick = load;
    [modeFilter, strategyFilter].forEach(function (filter) { filter.onchange = function () { saveFilters(); render(); }; });
    page.addEventListener('click', async function (event) {
      var tab = event.target.closest('[data-view]'); if (tab) { view = tab.dataset.view; saveFilters(); render(); return; }
      var button = event.target.closest('[data-dashboard-action]'); if (!button) return;
      var action = button.dataset.dashboardAction;
      if (action === 'clear') { view = 'all'; modeFilter.value = ''; strategyFilter.value = ''; syncFilters(); saveFilters(); render(); return; }
      var row = button.closest('[data-id]'), b = row && batches.find(function (item) { return item.batch_id === row.dataset.id; }); if (!b) return;
      var r = revision;
      if (action === 'zip') { await util.download(fetcher, util.api(b) + '/download.zip', 'batch-' + b.batch_id + '.zip', button, function () { return revision === r; }); return; }
      button.disabled = true;
      try {
        var result = await util.visibility(fetcher, b.batch_id, !b.archived);
        if (r !== revision) return;
        // Invalidate an earlier list response before changing local visibility.
        revision++; running = null; r = revision;
        var previous = !!b.archived; batches = batches.map(function (item) { return item.batch_id === b.batch_id ? Object.assign({}, item, result) : item; }); render();
        document.querySelector('[data-view="' + view + '"]').focus({ preventScroll: true });
        schedule();
        util.notice(result.archived ? 'Batch archived. Results are still available.' : 'Batch restored.', 'Undo', async function () {
          if (r !== revision) return;
          var restored = await util.visibility(fetcher, b.batch_id, previous);
          if (r !== revision) return;
          revision++; running = null; batches = batches.map(function (item) { return item.batch_id === b.batch_id ? Object.assign({}, item, restored) : item; }); render(); schedule();
        });
      } catch (e) { if (r === revision) util.notice(e.message); }
      finally { button.disabled = false; }
    });
    window.addEventListener('popstate', function () { readFilters(); render(); });
    document.addEventListener('visibilitychange', schedule);
  }
  function accountChanged() {
    revision++; clearTimeout(timer); running = null; batches = []; loaded = false; lastList = '';
    var toast = document.getElementById('batch-notice'); if (toast) toast.hidden = true;
    if (rowsNode) rowsNode.replaceChildren();
    if (errorNode) { errorNode.hidden = true; errorNode.textContent = ''; }
    if (detail) detail.clear();
    gate.hidden = !!uid(); content.hidden = !uid();
    if (!uid()) return;
    if (detail) detail.start({ batch_id: id, status: 'queued', batch_title: 'Loading batch…' });
    else { rowsNode.innerHTML = util.loading(); load(); }
  }
  if (auth) bootstrap.onAuthStateReady(auth, accountChanged); else accountChanged();
})();
