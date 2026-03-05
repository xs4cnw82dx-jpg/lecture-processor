(function () {
  'use strict';

  const bootstrap = window.LectureProcessorBootstrap || {};
  const auth = bootstrap.getAuth ? bootstrap.getAuth() : (window.firebase ? window.firebase.auth() : null);
  const authUtils = window.LectureProcessorAuth || {};
  const authClient = auth && authUtils.createAuthClient ? authUtils.createAuthClient(auth, { notSignedInMessage: 'Please sign in' }) : null;

  const body = document.body;
  const forcedMode = String((body && body.dataset && body.dataset.forcedMode) || 'lecture-notes').trim();
  const mode = ['lecture-notes', 'slides-only', 'interview'].includes(forcedMode) ? forcedMode : 'lecture-notes';

  const form = document.getElementById('batch-form');
  const rowsWrap = document.getElementById('rows-wrap');
  const addRowBtn = document.getElementById('add-row-btn');
  const submitBtn = document.getElementById('submit-batch-btn');
  const statusPanel = document.getElementById('batch-status-panel');
  const refreshStatusBtn = document.getElementById('refresh-status-btn');
  const downloadZipBtn = document.getElementById('download-zip-btn');
  const summaryEl = document.getElementById('batch-summary');
  const rowsBody = document.getElementById('batch-rows-body');
  const studyFeaturesWrap = document.getElementById('study-features-wrap');
  const flashcardWrap = document.getElementById('flashcard-wrap');
  const questionWrap = document.getElementById('question-wrap');

  let currentBatchId = '';
  let pollTimer = null;

  function authFetch(path, options) {
    if (authClient && typeof authClient.authFetch === 'function') {
      return authClient.authFetch(path, options, { retryOn401: true });
    }
    if (!auth || !auth.currentUser) {
      return Promise.reject(new Error('Please sign in'));
    }
    return auth.currentUser.getIdToken().then((token) => {
      const opts = options || {};
      const headers = Object.assign({}, opts.headers || {}, { Authorization: `Bearer ${token}` });
      return fetch(path, Object.assign({}, opts, { headers }));
    });
  }

  function rowCount() {
    return rowsWrap ? rowsWrap.querySelectorAll('.batch-row').length : 0;
  }

  function formatDate(secondsValue) {
    const safe = Number(secondsValue || 0);
    if (!safe) return '-';
    const date = new Date(safe * 1000);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleString(navigator.language || 'en-US', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function formatTokens(value) {
    const safe = Number(value || 0);
    if (!Number.isFinite(safe)) return '0';
    return Math.round(safe).toLocaleString();
  }

  function makeRowId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return `row-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function updateTopControls() {
    if (!studyFeaturesWrap || !flashcardWrap || !questionWrap) return;
    const showStudy = mode !== 'interview';
    studyFeaturesWrap.style.display = showStudy ? '' : 'none';
    flashcardWrap.style.display = showStudy ? '' : 'none';
    questionWrap.style.display = showStudy ? '' : 'none';
  }

  function buildInterviewFeatureCheckbox(label, value, checked) {
    const wrapper = document.createElement('label');
    wrapper.className = 'row-inline-checkbox';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = value;
    input.checked = !!checked;
    input.dataset.interviewFeature = value;
    wrapper.appendChild(input);
    const span = document.createElement('span');
    span.textContent = label;
    wrapper.appendChild(span);
    return wrapper;
  }

  function createRow() {
    const ordinal = rowCount() + 1;
    const rowId = makeRowId();
    const card = document.createElement('article');
    card.className = 'batch-row';
    card.dataset.rowId = rowId;

    const heading = document.createElement('div');
    heading.className = 'batch-row-head';
    heading.innerHTML = `<h3>Row ${ordinal}</h3>`;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => {
      if (rowCount() <= 2) {
        alert('Batch mode requires at least 2 rows.');
        return;
      }
      card.remove();
      Array.from(rowsWrap.querySelectorAll('.batch-row h3')).forEach((titleEl, idx) => {
        titleEl.textContent = `Row ${idx + 1}`;
      });
    });
    heading.appendChild(removeBtn);

    const fields = document.createElement('div');
    fields.className = 'batch-row-fields';

    if (mode === 'lecture-notes' || mode === 'slides-only') {
      const slidesLabel = document.createElement('label');
      slidesLabel.className = 'row-field';
      slidesLabel.innerHTML = '<span>Slides (PDF/PPTX)</span>';
      const slidesInput = document.createElement('input');
      slidesInput.type = 'file';
      slidesInput.accept = '.pdf,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation';
      slidesInput.required = true;
      slidesInput.dataset.field = 'slides';
      slidesLabel.appendChild(slidesInput);
      fields.appendChild(slidesLabel);
    }

    if (mode === 'lecture-notes' || mode === 'interview') {
      const audioLabel = document.createElement('label');
      audioLabel.className = 'row-field';
      audioLabel.innerHTML = '<span>Audio file (optional if m3u8 URL is filled)</span>';
      const audioInput = document.createElement('input');
      audioInput.type = 'file';
      audioInput.accept = '.mp3,.m4a,.wav,.aac,.ogg,.flac,audio/*';
      audioInput.dataset.field = 'audio';
      audioLabel.appendChild(audioInput);
      fields.appendChild(audioLabel);

      const m3u8Label = document.createElement('label');
      m3u8Label.className = 'row-field';
      m3u8Label.innerHTML = '<span>M3U8 / media URL (optional)</span>';
      const m3u8Input = document.createElement('input');
      m3u8Input.type = 'url';
      m3u8Input.placeholder = 'https://...';
      m3u8Input.dataset.field = 'm3u8';
      m3u8Label.appendChild(m3u8Input);
      fields.appendChild(m3u8Label);
    }

    if (mode === 'interview') {
      const featuresWrap = document.createElement('div');
      featuresWrap.className = 'row-field';
      const title = document.createElement('span');
      title.textContent = 'Interview extras';
      featuresWrap.appendChild(title);
      const group = document.createElement('div');
      group.className = 'row-inline-group';
      group.appendChild(buildInterviewFeatureCheckbox('Summary', 'summary', true));
      group.appendChild(buildInterviewFeatureCheckbox('Sections', 'sections', true));
      featuresWrap.appendChild(group);
      fields.appendChild(featuresWrap);
    }

    if (mode !== 'interview') {
      const overrideWrap = document.createElement('div');
      overrideWrap.className = 'row-field';
      const overrideLabel = document.createElement('label');
      overrideLabel.className = 'row-inline-checkbox';
      const enabled = document.createElement('input');
      enabled.type = 'checkbox';
      enabled.dataset.field = 'override-enabled';
      overrideLabel.appendChild(enabled);
      const overrideText = document.createElement('span');
      overrideText.textContent = 'Row study override';
      overrideLabel.appendChild(overrideText);
      overrideWrap.appendChild(overrideLabel);

      const grid = document.createElement('div');
      grid.className = 'row-inline-grid';
      grid.innerHTML = `
        <label><span>Study tools</span>
          <select data-field="override-study">
            <option value="none">No study tools</option>
            <option value="flashcards">Flashcards only</option>
            <option value="test">Practice test only</option>
            <option value="both" selected>Flashcards + test</option>
          </select>
        </label>
        <label><span>Flashcards</span>
          <select data-field="override-flashcards">
            <option value="10">10</option>
            <option value="20" selected>20</option>
            <option value="30">30</option>
            <option value="auto">Auto</option>
          </select>
        </label>
        <label><span>Questions</span>
          <select data-field="override-questions">
            <option value="5">5</option>
            <option value="10" selected>10</option>
            <option value="15">15</option>
            <option value="auto">Auto</option>
          </select>
        </label>
      `;
      grid.style.display = 'none';
      enabled.addEventListener('change', () => {
        grid.style.display = enabled.checked ? 'grid' : 'none';
      });
      overrideWrap.appendChild(grid);
      fields.appendChild(overrideWrap);
    }

    card.appendChild(heading);
    card.appendChild(fields);
    rowsWrap.appendChild(card);
  }

  function ensureMinimumRows() {
    if (!rowsWrap) return;
    while (rowCount() < 2) {
      createRow();
    }
  }

  function collectRowsAndFormData() {
    const formData = new FormData(form);
    formData.append('mode', mode);

    const rowNodes = Array.from(rowsWrap.querySelectorAll('.batch-row'));
    const rows = [];

    rowNodes.forEach((rowNode, idx) => {
      const rowId = String(rowNode.dataset.rowId || makeRowId());
      const rowOrdinal = idx + 1;
      const row = { row_id: rowId, ordinal: rowOrdinal };

      if (mode === 'lecture-notes' || mode === 'slides-only') {
        const slidesInput = rowNode.querySelector('input[data-field="slides"]');
        const slidesFile = slidesInput && slidesInput.files ? slidesInput.files[0] : null;
        if (!slidesFile) {
          throw new Error(`Row ${rowOrdinal}: slides file is required.`);
        }
        const slidesField = `row_${rowOrdinal}_slides`;
        row.slides_file_field = slidesField;
        formData.append(slidesField, slidesFile);
      }

      if (mode === 'lecture-notes' || mode === 'interview') {
        const audioInput = rowNode.querySelector('input[data-field="audio"]');
        const audioFile = audioInput && audioInput.files ? audioInput.files[0] : null;
        const m3u8Input = rowNode.querySelector('input[data-field="m3u8"]');
        const m3u8Url = m3u8Input ? String(m3u8Input.value || '').trim() : '';

        if (!audioFile && !m3u8Url) {
          throw new Error(`Row ${rowOrdinal}: provide an audio file or m3u8/media URL.`);
        }

        if (audioFile) {
          const audioField = `row_${rowOrdinal}_audio`;
          row.audio_file_field = audioField;
          formData.append(audioField, audioFile);
        }
        if (m3u8Url) {
          row.audio_m3u8_url = m3u8Url;
        }
      }

      if (mode === 'interview') {
        const selected = Array.from(rowNode.querySelectorAll('input[data-interview-feature]:checked')).map((el) => el.value);
        row.interview_features = selected;
      } else {
        const overrideEnabled = rowNode.querySelector('input[data-field="override-enabled"]');
        if (overrideEnabled && overrideEnabled.checked) {
          row.study_override = {
            study_features: String((rowNode.querySelector('select[data-field="override-study"]') || {}).value || 'both'),
            flashcard_amount: String((rowNode.querySelector('select[data-field="override-flashcards"]') || {}).value || '20'),
            question_amount: String((rowNode.querySelector('select[data-field="override-questions"]') || {}).value || '10'),
          };
        }
      }

      rows.push(row);
    });

    if (rows.length < 2) {
      throw new Error('Batch mode requires at least 2 rows.');
    }

    formData.append('rows', JSON.stringify(rows));
    return formData;
  }

  async function startBatch() {
    if (!auth || !auth.currentUser) {
      alert('Please sign in first.');
      return;
    }
    if (!submitBtn) return;

    submitBtn.disabled = true;
    submitBtn.textContent = 'Starting…';
    try {
      const formData = collectRowsAndFormData();
      const response = await authFetch('/api/batch/jobs', {
        method: 'POST',
        body: formData,
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(String(payload.error || 'Could not create batch.'));
      }
      currentBatchId = String(payload.batch_id || '');
      if (!currentBatchId) {
        throw new Error('No batch id returned.');
      }
      if (statusPanel) statusPanel.style.display = 'block';
      await refreshBatchStatus();
      if (pollTimer) window.clearInterval(pollTimer);
      pollTimer = window.setInterval(refreshBatchStatus, 5000);
    } catch (error) {
      alert(String(error && error.message ? error.message : error));
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Start batch';
    }
  }

  function renderStatus(statusPayload) {
    if (!summaryEl || !rowsBody) return;
    const summary = statusPayload || {};
    const status = String(summary.status || 'queued');
    const totalRows = Number(summary.total_rows || 0);
    const completedRows = Number(summary.completed_rows || 0);
    const failedRows = Number(summary.failed_rows || 0);

    summaryEl.innerHTML = `
      <div><strong>Batch:</strong> ${String(summary.batch_title || summary.batch_id || '-')}</div>
      <div><strong>Status:</strong> ${status}</div>
      <div><strong>Rows:</strong> ${completedRows}/${totalRows} complete, ${failedRows} failed</div>
      <div><strong>Tokens:</strong> in ${formatTokens(summary.token_input_total)} · out ${formatTokens(summary.token_output_total)} · total ${formatTokens(summary.token_total)}</div>
      <div><strong>Updated:</strong> ${formatDate(summary.updated_at)}</div>
    `;

    rowsBody.innerHTML = '';
    const rows = Array.isArray(summary.rows) ? summary.rows : [];
    rows.forEach((row) => {
      const rowId = String(row.row_id || '');
      const rowStatus = String(row.status || 'queued');
      const tr = document.createElement('tr');
      const canDownload = rowStatus === 'complete';
      tr.innerHTML = `
        <td>${Number(row.ordinal || 0)}</td>
        <td>${rowStatus}${row.failed_stage ? ` (${String(row.failed_stage)})` : ''}</td>
        <td>${formatTokens(row.token_input_total)}</td>
        <td>${formatTokens(row.token_output_total)}</td>
        <td>${formatTokens(row.token_total)}</td>
        <td></td>
      `;
      const actionsCell = tr.lastElementChild;
      if (canDownload && currentBatchId) {
        const docxBtn = document.createElement('button');
        docxBtn.type = 'button';
        docxBtn.className = 'btn tiny';
        docxBtn.textContent = 'DOCX';
        docxBtn.addEventListener('click', () => {
          window.open(`/api/batch/jobs/${encodeURIComponent(currentBatchId)}/rows/${encodeURIComponent(rowId)}/download-docx`, '_blank');
        });

        const cardsBtn = document.createElement('button');
        cardsBtn.type = 'button';
        cardsBtn.className = 'btn tiny';
        cardsBtn.textContent = 'Flashcards CSV';
        cardsBtn.addEventListener('click', () => {
          window.open(`/api/batch/jobs/${encodeURIComponent(currentBatchId)}/rows/${encodeURIComponent(rowId)}/download-flashcards-csv?type=flashcards`, '_blank');
        });

        const testBtn = document.createElement('button');
        testBtn.type = 'button';
        testBtn.className = 'btn tiny';
        testBtn.textContent = 'Test CSV';
        testBtn.addEventListener('click', () => {
          window.open(`/api/batch/jobs/${encodeURIComponent(currentBatchId)}/rows/${encodeURIComponent(rowId)}/download-flashcards-csv?type=test`, '_blank');
        });

        actionsCell.appendChild(docxBtn);
        actionsCell.appendChild(cardsBtn);
        actionsCell.appendChild(testBtn);
      } else {
        actionsCell.textContent = '-';
      }
      rowsBody.appendChild(tr);
    });

    if (status === 'complete' || status === 'error' || status === 'partial') {
      if (pollTimer) {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
    }
  }

  async function refreshBatchStatus() {
    if (!currentBatchId) return;
    try {
      const response = await authFetch(`/api/batch/jobs/${encodeURIComponent(currentBatchId)}`);
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(String(payload.error || 'Could not read batch status.'));
      }
      renderStatus(payload);
    } catch (error) {
      console.error('Batch status polling failed:', error);
    }
  }

  function wireEvents() {
    if (addRowBtn) {
      addRowBtn.addEventListener('click', createRow);
    }
    if (form) {
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        startBatch();
      });
    }
    if (refreshStatusBtn) {
      refreshStatusBtn.addEventListener('click', refreshBatchStatus);
    }
    if (downloadZipBtn) {
      downloadZipBtn.addEventListener('click', () => {
        if (!currentBatchId) return;
        window.open(`/api/batch/jobs/${encodeURIComponent(currentBatchId)}/download.zip`, '_blank');
      });
    }
  }

  function boot() {
    updateTopControls();
    ensureMinimumRows();
    wireEvents();

    if (auth) {
      auth.onAuthStateChanged((user) => {
        if (!user) {
          currentBatchId = '';
          if (pollTimer) {
            window.clearInterval(pollTimer);
            pollTimer = null;
          }
        }
      });
    }
  }

  boot();
})();
