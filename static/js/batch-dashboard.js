(function () {
  'use strict';

  var bootstrap = window.LectureProcessorBootstrap || {};
  var auth = bootstrap.getAuth ? bootstrap.getAuth() : (window.firebase ? window.firebase.auth() : null);
  var authUtils = window.LectureProcessorAuth || {};
  var authClient = auth && authUtils.createAuthClient ? authUtils.createAuthClient(auth, { notSignedInMessage: 'Please sign in' }) : null;

  var refreshBtn = document.getElementById('batch-dashboard-refresh-btn');
  var modeFilter = document.getElementById('batch-dashboard-mode-filter');
  var statusFilter = document.getElementById('batch-dashboard-status-filter');
  var activeBody = document.getElementById('batch-dashboard-active-body');
  var recentBody = document.getElementById('batch-dashboard-recent-body');
  var pollTimer = null;

  function showShellToast(message, variant) {
    var shell = window.LectureProcessorShell || {};
    if (shell && typeof shell.showToast === 'function') {
      shell.showToast(message, variant || '');
    }
  }

  function authFetch(path, options) {
    if (authClient && typeof authClient.authFetch === 'function') {
      return authClient.authFetch(path, options, { retryOn401: true });
    }
    if (!auth || !auth.currentUser) {
      return Promise.reject(new Error('Please sign in'));
    }
    return auth.currentUser.getIdToken().then(function (token) {
      var opts = options || {};
      var headers = Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + token });
      return fetch(path, Object.assign({}, opts, { headers: headers }));
    });
  }

  function formatDate(secondsValue) {
    var safe = Number(secondsValue || 0);
    if (!safe) return '-';
    var date = new Date(safe * 1000);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleString(navigator.language || 'en-US', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function modeLabel(mode) {
    var key = String(mode || '').trim();
    if (key === 'lecture-notes') return 'Lectures';
    if (key === 'slides-only') return 'Slides';
    if (key === 'interview') return 'Interviews';
    return key || '-';
  }

  function modePath(mode) {
    if (mode === 'slides-only') return '/batch_mode_slides_extraction';
    if (mode === 'interview') return '/batch_mode_interview_transcription';
    return '/batch_mode';
  }

  function stageText(batch) {
    var stage = String(batch.stage_label || batch.current_stage || '').trim();
    var stageState = String(batch.current_stage_state || '').trim();
    var provider = String(batch.provider_label || batch.provider_state || '').trim();
    if (!stage && !stageState && !provider) return '-';
    return [stage || '-', stageState || '-', provider || '-'].join(' · ');
  }

  function statusPill(status) {
    var safe = String(status || 'queued').trim().toLowerCase();
    return '<span class="batch-status-pill ' + safe + '">' + safe + '</span>';
  }

  function emptyRow(colspan, text) {
    var tr = document.createElement('tr');
    var td = document.createElement('td');
    td.colSpan = colspan;
    td.className = 'table-empty';
    td.textContent = text;
    tr.appendChild(td);
    return tr;
  }

  function batchTitleCell(batch) {
    var title = String(batch.batch_title || batch.batch_id || '-');
    var detail = String(batch.error_message || batch.status_message || '').trim();
    if (!detail) return escapeHtml(title);
    return '<div class="batch-title-cell"><strong>' + escapeHtml(title) + '</strong><span>' + escapeHtml(detail) + '</span></div>';
  }

  function renderTable(body, rows, isActiveTable) {
    if (!body) return;
    body.innerHTML = '';
    if (!rows.length) {
      body.appendChild(emptyRow(8, isActiveTable ? 'No active batches.' : 'No recent batches.'));
      return;
    }

    rows.forEach(function (batch) {
      var batchId = String(batch.batch_id || '');
      var created = formatDate(batch.created_at);
      var updated = formatDate(batch.updated_at || batch.last_heartbeat_at || 0);
      var rowsText = String(Number(batch.completed_rows || 0)) + '/' + String(Number(batch.total_rows || 0)) + ' complete · ' + String(Number(batch.failed_rows || 0)) + ' failed';
      var actions = [];
      var viewHref = modePath(batch.mode) + '?batch_id=' + encodeURIComponent(batchId);
      actions.push('<a class="btn-link" href="' + viewHref + '">View</a>');
      if (batch.next_action_label && batch.next_action_href && batch.next_action_href !== viewHref) {
        if (String(batch.next_action_href).indexOf('/api/batch/jobs/') === 0) {
          actions.push('<button type="button" class="btn-link" data-action="open-href" data-href="' + escapeHtml(String(batch.next_action_href)) + '">' + escapeHtml(String(batch.next_action_label)) + '</button>');
        } else {
          actions.push('<a class="btn-link" href="' + escapeHtml(String(batch.next_action_href)) + '">' + escapeHtml(String(batch.next_action_label)) + '</a>');
        }
      }
      if (batch.can_download_zip) {
        actions.push('<button type="button" class="btn-link" data-action="download-zip" data-batch-id="' + batchId + '">Download ZIP</button>');
      }
      var tr = document.createElement('tr');
      if (isActiveTable) {
        tr.innerHTML =
          '<td>' + batchTitleCell(batch) + '</td>' +
          '<td>' + modeLabel(batch.mode) + '</td>' +
          '<td>' + created + '</td>' +
          '<td>' + stageText(batch) + '</td>' +
          '<td>' + rowsText + '</td>' +
          '<td>' + updated + '</td>' +
          '<td>' + escapeHtml(String(batch.email_status_label || batch.completion_email_status || 'pending')) + '</td>' +
          '<td><div class="table-actions">' + actions.join('') + '</div></td>';
      } else {
        tr.innerHTML =
          '<td>' + batchTitleCell(batch) + '</td>' +
          '<td>' + modeLabel(batch.mode) + '</td>' +
          '<td>' + statusPill(batch.status) + '</td>' +
          '<td>' + created + '</td>' +
          '<td>' + rowsText + '</td>' +
          '<td>' + updated + '</td>' +
          '<td>' + escapeHtml(String(batch.email_status_label || batch.completion_email_status || 'pending')) + '</td>' +
          '<td><div class="table-actions">' + actions.join('') + '</div></td>';
      }
      body.appendChild(tr);
    });
  }

  function attachTableActions() {
    Array.prototype.slice.call(document.querySelectorAll('[data-action="download-zip"]')).forEach(function (button) {
      button.addEventListener('click', function () {
        var batchId = String(button.getAttribute('data-batch-id') || '').trim();
        if (!batchId) return;
        window.open('/api/batch/jobs/' + encodeURIComponent(batchId) + '/download.zip', '_blank');
      });
    });
    Array.prototype.slice.call(document.querySelectorAll('[data-action="open-href"]')).forEach(function (button) {
      button.addEventListener('click', function () {
        var href = String(button.getAttribute('data-href') || '').trim();
        if (!href) return;
        window.open(href, '_blank');
      });
    });
  }

  function activeRows(rows) {
    return rows.filter(function (batch) {
      var status = String(batch.status || '').trim();
      return status === 'queued' || status === 'processing';
    });
  }

  function recentRows(rows) {
    return rows.filter(function (batch) {
      var status = String(batch.status || '').trim();
      return status !== 'queued' && status !== 'processing';
    });
  }

  function listPath() {
    var params = new URLSearchParams();
    var mode = String((modeFilter && modeFilter.value) || '').trim();
    var status = String((statusFilter && statusFilter.value) || '').trim();
    if (mode) params.set('mode', mode);
    if (status) params.set('status', status);
    params.set('limit', '200');
    return '/api/batch/jobs?' + params.toString();
  }

  function loadBatches(showRefreshToast) {
    if (!auth || !auth.currentUser) {
      renderTable(activeBody, [], true);
      renderTable(recentBody, [], false);
      return Promise.resolve();
    }
    return authFetch(listPath())
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (payload) {
          return { response: response, payload: payload };
        });
      })
      .then(function (result) {
        if (!result.response.ok) {
          throw new Error(String(result.payload.error || 'Could not load batch list.'));
        }
        var rows = Array.isArray(result.payload.batches) ? result.payload.batches : [];
        renderTable(activeBody, activeRows(rows), true);
        renderTable(recentBody, recentRows(rows), false);
        attachTableActions();
        if (showRefreshToast) {
          showShellToast('Batch dashboard refreshed.', 'success');
        }
      })
      .catch(function (error) {
        console.error('Could not load batch dashboard:', error);
        showShellToast(String((error && error.message) || 'Could not load batch dashboard.'), 'error');
      });
  }

  function schedulePolling() {
    if (pollTimer) {
      window.clearTimeout(pollTimer);
      pollTimer = null;
    }
    var delay = document.visibilityState === 'hidden' ? 60000 : 20000;
    pollTimer = window.setTimeout(function () {
      loadBatches(false).finally(schedulePolling);
    }, delay);
  }

  function wireEvents() {
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        loadBatches(true);
      });
    }
    if (modeFilter) {
      modeFilter.addEventListener('change', function () {
        loadBatches(false);
      });
    }
    if (statusFilter) {
      statusFilter.addEventListener('change', function () {
        loadBatches(false);
      });
    }
    document.addEventListener('visibilitychange', function () {
      schedulePolling();
    });
  }

  function boot() {
    wireEvents();
    if (auth) {
      auth.onAuthStateChanged(function () {
        loadBatches(false);
      });
    } else {
      loadBatches(false);
    }
    schedulePolling();
  }

  boot();
})();
