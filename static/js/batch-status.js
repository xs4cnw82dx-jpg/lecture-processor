(function (root) {
  'use strict';
  var labels = { queued: 'Queued', preparing: 'Queued', processing: 'Processing', complete: 'Completed', partial: 'Completed with issues', error: 'Failed' };
  var modes = { 'lecture-notes': 'Lectures', 'slides-only': 'Slides', interview: 'Interviews', 'audio-transcription': 'Audio transcriptions', 'text-combine': 'Combine text' };
  function escape(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function count(n) { return Math.max(0, Number(n) || 0); }
  function terminal(s) { return ['complete', 'partial', 'error'].indexOf(s) >= 0; }
  function needsPolling(b) { return !terminal(b.status) || count(b.credits_refund_pending) > 0 || ['pending', 'sending', 'queued'].indexOf(b.completion_email_status) >= 0; }
  function status(s) { return labels[s] || 'Status unavailable'; }
  function pill(s) { return '<span class="bs-pill bs-' + (labels[s] ? escape(s) : 'queued') + '">' + status(s) + '</span>'; }
  function mode(b) { return (modes[b.mode] || 'Batch') + ' · ' + (b.processing_strategy === 'instant' ? 'Instant' : 'Standard'); }
  function date(value) { return value ? new Date(Number(value) * 1000).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Not available'; }
  function progress(b) { return count(b.completed_rows) + ' of ' + count(b.total_rows) + ' completed' + (count(b.failed_rows) ? ' · ' + count(b.failed_rows) + ' failed' : ''); }
  function credits(b) {
    var charged = count(b.credits_charged), refunded = count(b.credits_refunded), pending = count(b.credits_refund_pending);
    var heading = pending ? pending + (pending === 1 ? ' credit refund pending' : ' credit refunds pending') :
      charged > 0 && refunded === charged ? 'All ' + refunded + (refunded === 1 ? ' credit refunded' : ' credits refunded') :
      refunded > 0 ? refunded + (refunded === 1 ? ' credit refunded' : ' credits refunded') :
      charged + (charged === 1 ? ' credit charged' : ' credits charged');
    return { heading: heading, breakdown: charged + ' charged · ' + refunded + ' refunded' + (pending ? ' · ' + pending + ' pending' : '') };
  }
  function friendlyError(message) {
    var text = String(message || '');
    if (/503|unavailable/i.test(text)) return 'Google Gemini was temporarily unavailable while this batch was running.';
    if (/timeout|timed out/i.test(text)) return 'Processing timed out before this batch could finish.';
    if (/traceback|exception|\{.*[":']|\bat \w+\./i.test(text)) return 'Processing could not be completed. Open Technical details for the diagnostic information.';
    return text;
  }
  function detailUrl(id) { return '/batch_status/' + encodeURIComponent(id); }
  function newBatchUrl(b) {
    var suffix = { 'slides-only': '_slides_extraction', interview: '_interview_transcription', 'audio-transcription': '_audio_transcription', 'text-combine': '_text_combine' };
    return (b.processing_strategy === 'instant' ? '/instant_batch_mode' : '/batch_mode') + (suffix[b.mode] || '');
  }
  function api(b) { return (b.processing_strategy === 'instant' ? '/api/instant-batch/jobs/' : '/api/batch/jobs/') + encodeURIComponent(b.batch_id); }
  async function json(fetcher, path, options) {
    var response = await fetcher(path, options);
    var body = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(body.error || 'This request could not be completed. Try again.');
    return body;
  }
  function visibility(fetcher, id, archived) {
    return json(fetcher, '/api/batch/jobs/' + encodeURIComponent(id) + '/visibility', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: archived }) });
  }
  function notice(message, action, callback) {
    var node = document.getElementById('batch-notice');
    if (!node) { node = document.createElement('div'); node.id = 'batch-notice'; node.className = 'bs-toast'; node.setAttribute('role', 'status'); document.body.appendChild(node); }
    node.replaceChildren(); node.hidden = false;
    var text = document.createElement('span'); text.textContent = message; node.appendChild(text);
    if (action) { var button = document.createElement('button'); button.className = 'bs-button'; button.textContent = action; button.onclick = async function () { button.disabled = true; try { await callback(); node.hidden = true; } catch (e) { text.textContent = e.message; button.disabled = false; } }; node.appendChild(button); }
    var close = document.createElement('button'); close.className = 'bs-button'; close.textContent = 'Dismiss'; close.onclick = function () { node.hidden = true; }; node.appendChild(close);
  }
  async function download(fetcher, path, name, button, isCurrent) {
    if (button && button.disabled) return;
    var original = button && button.textContent;
    if (button) { button.disabled = true; button.textContent = 'Downloading…'; }
    try {
      var response = await fetcher(path);
      if (isCurrent && !isCurrent()) return;
      if (!response.ok) { var problem = await response.json().catch(function () { return {}; }); throw new Error(problem.error || 'Could not download this file.'); }
      // Buffer before starting the save so account changes cannot expose an old response.
      var blob = await response.blob();
      if (isCurrent && !isCurrent()) return;
      var wrapped = new Response(blob, { headers: response.headers });
      if (root.LectureProcessorDownload) await root.LectureProcessorDownload.downloadResponseBlob(wrapped, name);
      else { var url = URL.createObjectURL(blob); var link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000); }
    } catch (e) { if (!isCurrent || isCurrent()) notice(e.message); }
    finally { if (button) { button.disabled = false; button.textContent = original; } }
  }
  function button(action, text, extra) { return '<button type="button" class="bs-button" data-bs-action="' + action + '" ' + (extra || '') + '>' + escape(text) + '</button>'; }
  function itemName(b, row) {
    var names = { 'lecture-notes': 'Lecture', 'slides-only': 'Slide set', interview: 'Interview', 'audio-transcription': 'Audio recording', 'text-combine': 'Text set' };
    return (names[b.mode] || 'Item') + ' ' + count(row.ordinal);
  }
  function icon(name) {
    var paths = { check: '<path d="m6 12 4 4 8-8"/>', clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>', file: '<path d="M14 3H6v18h12V7zM14 3v5h4M9 12h6M9 16h6"/>', alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16h.01"/>', shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6"/>' };
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (paths[name] || paths.file) + '</svg>';
  }
  function outcome(b) {
    if (b.status === 'error') return { title: 'This batch couldn’t finish', copy: 'You can start a new batch when you’re ready.', icon: 'alert' };
    if (b.status === 'partial') return { title: 'Some results are ready', copy: 'Download the completed items. Start a new batch for the items that failed.', icon: 'alert' };
    if (b.status === 'complete') return { title: 'Your results are ready', copy: 'Download everything together, or choose individual results below.', icon: 'check' };
    if (b.status === 'processing') return { title: 'Your batch is in progress', copy: 'You can leave this page. Your results will be here when processing finishes.', icon: 'clock' };
    if (!labels[b.status]) return { title: 'Checking your batch status', copy: 'Refresh to get the latest update. Your saved batch stays available here.', icon: 'clock' };
    return { title: 'Your batch is in the queue', copy: 'Processing will begin automatically. You can check back here at any time.', icon: 'clock' };
  }
  function progressBar(b) {
    var total = count(b.total_rows), completed = Math.min(total, count(b.completed_rows)), failed = Math.min(total - completed, count(b.failed_rows));
    var readyWidth = total ? completed / total * 100 : 0, failedWidth = total ? failed / total * 100 : 0;
    return '<svg class="bs-progress-track" viewBox="0 0 100 1" preserveAspectRatio="none" role="img" aria-label="' + escape(progress(b)) + '"><rect class="bs-progress-ready" width="' + readyWidth + '" height="1"></rect><rect class="bs-progress-failed" x="' + readyWidth + '" width="' + failedWidth + '" height="1"></rect></svg>';
  }
  function loading() { return '<div class="bs-loading" role="status"><span class="bs-skeleton"></span><span class="bs-skeleton"></span><p>Loading your batch…</p></div>'; }
  function renderer(options) {
    var element = options.element, batch = null, generation = 0, timer = null, running = null, lastMarkup = '', dismissal = '';
    var dismissed = new Set();
    var announcement = document.createElement('p'); announcement.className = 'bs-sr-only'; announcement.setAttribute('role', 'status'); announcement.setAttribute('aria-live', 'polite');
    element.insertAdjacentElement('afterend', announcement);
    function valid(g) { return g === generation; }
    function stop() { generation++; clearTimeout(timer); timer = null; running = null; }
    function clear() { stop(); batch = null; lastMarkup = ''; element.replaceChildren(); announcement.textContent = ''; }
    function dismissKey(b) { return 'batch-message:' + options.uid() + ':' + b.batch_id + ':' + b.status + ':' + (b.error_message || b.status_message || ''); }
    function isDismissed(key) { try { return dismissed.has(key) || sessionStorage.getItem(key) === '1'; } catch (_) { return dismissed.has(key); } }
    function render(b) {
      batch = b;
      var credit = credits(b), id = b.batch_id, compact = options.compact;
      var spoken = status(b.status) + '. ' + progress(b) + '. ' + credit.heading;
      if (announcement.textContent !== spoken) announcement.textContent = spoken;
      var error = friendlyError(b.error_message || (['partial', 'error'].indexOf(b.status) >= 0 ? b.status_message : ''));
      dismissal = dismissKey(b);
      var state = outcome(b), warning = ['partial', 'error'].indexOf(b.status) >= 0;
      var actions = compact ? '<a class="bs-button bs-primary" href="' + detailUrl(id) + '">View details</a>' : '';
      if (b.can_download_zip) actions += button('zip', 'Download ZIP', compact ? '' : 'data-primary="true"');
      if (!compact && warning) actions += '<a class="bs-button ' + (b.can_download_zip ? '' : 'bs-primary') + '" href="' + newBatchUrl(b) + '">Start a new batch</a>';
      var utilities = (terminal(b.status) ? button('archive', b.archived ? 'Restore batch' : 'Archive batch') : '') + button('refresh', 'Refresh');
      var html = '<div class="bs-heading"><div><p class="bs-eyebrow">' + escape(mode(b)) + (b.archived ? ' · Archived' : '') + '</p><h' + (compact ? '2' : '1') + '>' + escape(b.batch_title || id) + '</h' + (compact ? '2' : '1') + '><p class="bs-submitted">Submitted ' + escape(date(b.created_at)) + '</p></div><div class="bs-utilities">' + utilities + '</div></div>' +
        '<div class="bs-overview"><section class="bs-summary bs-state-' + escape(labels[b.status] ? b.status : 'queued') + '"><div class="bs-summary-top"><span class="bs-status-icon">' + icon(state.icon) + '</span>' + pill(b.status) + '</div><h2>' + escape(state.title) + '</h2><p class="bs-summary-copy">' + escape(state.copy) + '</p>' +
        '<div class="bs-progress"><div class="bs-progress-label"><strong>' + escape(progress(b)) + '</strong><span>' + count(b.total_rows) + ' items</span></div>' + progressBar(b) + (!terminal(b.status) ? '<p class="bs-stage">' + escape(b.stage_label || b.status_message || (b.status === 'processing' ? 'Processing your items. This page updates automatically.' : 'Waiting for processing to begin')) + '</p>' : '') + '</div>' +
        (error && !isDismissed(dismissal) ? '<div class="bs-message"><span>' + escape(error) + '</span>' + button('dismiss', 'Dismiss message') + '</div>' : '') +
        '<div class="bs-actions bs-main-actions">' + actions + '</div>' + (!compact && warning ? '<p class="bs-recovery">Select your files again to submit a new batch.</p>' : '') + '</section>' +
        '<aside class="bs-credit-card' + (count(b.credits_refund_pending) ? ' bs-credit-pending' : '') + '"><span class="bs-credit-icon">' + icon('shield') + '</span><p class="bs-kicker">CREDIT SUMMARY</p><h3>' + escape(credit.heading) + '</h3><p class="bs-credit-breakdown">' + escape(credit.breakdown) + '</p><p class="bs-credit-note">' + (count(b.credits_refund_pending) ? 'Refunds are still being applied. This status updates automatically.' : count(b.credits_charged) > 0 && count(b.credits_refunded) === count(b.credits_charged) ? 'The credits used for this batch have been returned to your balance.' : count(b.credits_refunded) ? 'Refunded credits are back in your balance.' : 'Credit usage stays attached to this batch for your records.') + '</p>' + (b.archived ? '<p class="bs-archived-note">Find this batch again in the Archived view.</p>' : '') + '</aside></div><p class="bs-refresh-error" role="status" hidden></p>';
      if (compact && b.can_download_zip && ['lecture-notes', 'interview', 'audio-transcription'].indexOf(b.mode) >= 0) html += '<p class="bs-retention">ZIP files exclude original audio. Save important audio from your <a href="/study">Study Library</a> before temporary audio is deleted.</p>';
      if (!compact) {
        html += '<section class="bs-results"><div class="bs-section-head"><div><p class="bs-kicker">INDIVIDUAL OUTPUTS</p><h2>Results <span>' + count(b.total_rows) + '</span></h2></div><p>' + (count(b.completed_rows) ? count(b.completed_rows) + ' ready to download' : warning ? 'Review the items in this batch' : 'Results appear as processing finishes') + '</p></div><div class="bs-result-list">';
        (b.rows || []).forEach(function (row) {
          var rowId = escape(row.row_id), name = itemName(b, row);
          html += '<article class="bs-result"><div class="bs-result-identity"><span class="bs-item-icon">' + icon(row.status === 'complete' ? 'check' : 'file') + '</span><div><h3>' + escape(name) + '</h3>' + pill(row.status) + '</div></div><div class="bs-result-content">';
          if (row.status === 'error') {
            var rowError = friendlyError(row.error);
            html += '<p class="bs-row-summary">No output was generated.</p><details class="bs-failure" data-key="failure-' + rowId + '"><summary>Failure details</summary><div class="bs-disclosure-body"><p>' + escape(rowError && rowError !== error ? rowError : 'This item was affected by the batch processing issue. Select its files again in a new batch to try again.') + '</p><details class="bs-raw" data-key="raw-' + rowId + '"><summary>Technical details</summary><div class="bs-disclosure-body"><pre>' + escape(row.error || row.status_message || 'No additional diagnostics available.') + '</pre><p>Stage: ' + escape(row.failed_stage || row.current_stage_label || 'Unavailable') + '</p></div></details></div></details>';
          } else if (row.status !== 'complete') html += '<p class="bs-row-summary">' + escape(row.current_stage_label || row.current_stage_detail || 'Waiting to start') + '</p>';
          else html += '<p class="bs-row-summary">Ready to download</p><p class="bs-row-help">Choose the format you need.</p>';
          html += '</div><div class="bs-actions bs-result-actions">';
          if (row.status === 'complete') {
            html += button('docx', 'Word document', 'data-row="' + rowId + '"');
            if (['lecture-notes', 'slides-only'].indexOf(b.mode) >= 0) html += button('flashcards', 'Flashcards CSV', 'data-row="' + rowId + '"') + button('test', 'Test CSV', 'data-row="' + rowId + '"');
          }
          html += '</div></article>';
        });
        if (!(b.rows || []).length) html += '<div class="bs-empty bs-empty-results">' + icon('clock') + '<h3>Waiting for item details</h3><p>Individual results will appear here when available.</p></div>';
        html += '</div>';
        if (b.rows_limited) html += '<div class="bs-more"><p>Showing ' + count(b.rows_returned) + ' of ' + count(b.total_rows) + ' items. Counts above cover the whole batch.</p>' + (count(b.rows_returned) < 500 ? button('more', 'Show more items') : '') + '</div>';
        if (b.can_download_zip && ['lecture-notes', 'interview', 'audio-transcription'].indexOf(b.mode) >= 0) html += '<p class="bs-retention">ZIP downloads contain generated results, not original audio. Save important audio from your <a href="/study">Study Library</a> before temporary audio is deleted.</p>';
        html += '</section><div class="bs-support-details"><details class="bs-details" data-key="additional"><summary>Additional details <span>Dates, delivery and exports</span></summary><div class="bs-disclosure-body"><dl class="bs-metadata"><div><dt>Submitted</dt><dd>' + escape(date(b.created_at)) + '</dd></div><div><dt>Last updated</dt><dd>' + escape(date(b.updated_at)) + '</dd></div><div><dt>Completion email</dt><dd>' + escape(b.email_status_label || b.completion_email_status || 'Not available') + '</dd></div><div><dt>ZIP contents</dt><dd>Individual results' + (b.export_options && b.export_options.include_combined_docx ? ' and a combined Word document' : '') + '</dd></div></dl></div></details>' +
          '<details class="bs-details" data-key="technical"><summary>Technical details <span>Diagnostics for troubleshooting</span></summary><div class="bs-disclosure-body"><dl class="bs-metadata"><div><dt>Batch ID</dt><dd>' + escape(id) + '</dd></div><div><dt>Provider</dt><dd>' + escape(b.provider_label || b.provider_state || 'Not available') + '</dd></div><div><dt>Tokens</dt><dd>' + count(b.token_input_total) + ' input · ' + count(b.token_output_total) + ' output · ' + count(b.token_total) + ' total</dd></div></dl>' + (b.error_summary || b.error_message ? '<pre>' + escape(b.error_summary || b.error_message) + '</pre>' : '') + (b.rows || []).map(function (r) { return '<p class="bs-row-help">' + escape(itemName(b, r)) + ': ' + count(r.token_input_total) + ' input · ' + count(r.token_output_total) + ' output · ' + count(r.token_total) + ' total tokens</p>'; }).join('') + (b.completion_email_error ? '<pre>' + escape(b.completion_email_error) + '</pre>' : '') + '</div></details></div>';
      }
      if (lastMarkup === html) return;
      var open = Array.from(element.querySelectorAll('details[open]')).map(function (el) { return el.dataset.key; });
      var active = document.activeElement, focusAction = element.contains(active) && active.dataset.bsAction, focusRow = active && active.dataset.row;
      var focusDetail = element.contains(active) && active.tagName === 'SUMMARY' && active.parentElement.dataset.key;
      lastMarkup = html; element.innerHTML = html;
      element.querySelectorAll('details').forEach(function (el) { el.open = open.indexOf(el.dataset.key) >= 0; if (el.dataset.key === focusDetail) el.querySelector('summary').focus({ preventScroll: true }); });
      if (focusAction) Array.from(element.querySelectorAll('[data-bs-action]')).some(function (el) { if (el.dataset.bsAction === focusAction && el.dataset.row === focusRow) { el.focus({ preventScroll: true }); return true; } return false; });
    }
    var rowsLimit = 100;
    function schedule() { clearTimeout(timer); if (batch && needsPolling(batch)) timer = setTimeout(function () { refresh(); }, document.visibilityState === 'hidden' ? 60000 : 20000); }
    function refresh() {
      if (!batch) return Promise.resolve();
      if (running) return running;
      clearTimeout(timer);
      var g = generation, id = batch.batch_id;
      running = json(options.fetch, '/api/batch/jobs/' + encodeURIComponent(id) + '?rows_limit=' + rowsLimit).then(function (b) {
        if (!valid(g)) return;
        b.batch_id = id; render(b);
        var alert = element.querySelector('.bs-refresh-error'); if (alert) alert.hidden = true;
        if (options.onData) options.onData(b);
      }).catch(function (e) {
        if (!valid(g)) return;
        var alert = element.querySelector('.bs-refresh-error');
        if (!alert) { element.innerHTML = '<p class="bs-refresh-error" role="status"></p>' + button('refresh', 'Retry'); alert = element.querySelector('.bs-refresh-error'); }
        alert.hidden = false; alert.textContent = 'Couldn’t refresh. ' + e.message;
      }).finally(function () { if (valid(g)) { running = null; schedule(); } });
      return running;
    }
    function start(b) { stop(); rowsLimit = 100; batch = b; lastMarkup = ''; if (b.total_rows != null) render(b); else element.innerHTML = loading(); return refresh(); }
    element.addEventListener('click', async function (event) {
      var target = event.target.closest('[data-bs-action]'); if (!target || !batch) return;
      var action = target.dataset.bsAction, b = batch, g = generation;
      if (action === 'refresh') { await refresh(); return; }
      if (action === 'more') { rowsLimit = 500; await refresh(); return; }
      if (action === 'dismiss') { dismissed.add(dismissal); try { sessionStorage.setItem(dismissal, '1'); } catch (_) { /* Storage may be unavailable. */ } render(b); var next = element.querySelector('[data-bs-action="refresh"]'); if (next) next.focus(); return; }
      if (action === 'archive') {
        stop(); g = generation;
        target.disabled = true;
        try {
          var result = await visibility(options.fetch, b.batch_id, !b.archived);
          if (!valid(g)) return;
          stop(); g = generation;
          render(Object.assign({}, b, result));
          if (options.onArchive) options.onArchive(result);
          var undoGeneration = generation;
          schedule();
          notice(result.archived ? 'Batch archived. Results are still available.' : 'Batch restored.', 'Undo', async function () {
            if (!valid(undoGeneration)) return;
            var restored = await visibility(options.fetch, b.batch_id, !!b.archived);
            if (!valid(undoGeneration)) return;
            if (options.onUndo) options.onUndo(Object.assign({}, b, restored));
            else { stop(); render(Object.assign({}, b, restored)); schedule(); }
          });
        } catch (e) { if (valid(g)) notice(e.message); }
        finally { target.disabled = false; if (valid(g)) schedule(); }
        return;
      }
      var path = api(b), row = encodeURIComponent(target.dataset.row || '');
      if (action === 'zip') path += '/download.zip';
      else if (action === 'docx') path += '/rows/' + row + '/download-docx';
      else if (action === 'flashcards' || action === 'test') path += '/rows/' + row + '/download-flashcards-csv?type=' + action;
      else return;
      await download(options.fetch, path, 'batch-' + b.batch_id + (action === 'zip' ? '.zip' : action === 'docx' ? '.docx' : '.csv'), target, function () { return valid(g); });
    });
    document.addEventListener('visibilitychange', schedule);
    return { start: start, refresh: refresh, stop: stop, clear: clear, render: render };
  }
  var exported = { escape: escape, terminal: terminal, friendlyError: friendlyError, needsPolling: needsPolling, status: status, pill: pill, mode: mode, date: date, progress: progress, credits: credits, detailUrl: detailUrl, newBatchUrl: newBatchUrl, api: api, json: json, visibility: visibility, notice: notice, download: download, renderer: renderer, icon: icon, outcome: outcome, progressBar: progressBar, loading: loading };
  root.LectureProcessorBatchStatus = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})(typeof window !== 'undefined' ? window : globalThis);
