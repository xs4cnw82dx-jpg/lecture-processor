// File, microphone and URL inputs for the processing page.
/* global audioZone, authenticatedFetch, captureClientError, currentMode, currentUser,
   downloadLocalPreviewFile, downloadUtils, formatFileSize, formatRetryDelay, getRetryAfterSeconds,
   modeConfig, otherAudioOpen:writable, otherAudioToggle, setHidden, showAuthModal, showToast,
   syncProcessingLayout, updateProcessButton */
/* exported audioDownload, audioFile, audioImportInFlight, audioInput, audioRemove, audioUrlStatus,
   bindAudioImportControls, bindRecordingControls, clearImportedAudioLocalState,
   clearSelectedAudioFile, currentAudioBytes, discardActiveRecording, downloadSelectedAudio,
   getReadyImportedAudioToken, handleAudioFile, hasReadyImportedAudioToken, recordingState,
   releaseImportedAudioToken, removeSelectedAudio, stopAudioRecording, syncAudioInfoUI,
   syncRecorderUI, warnBeforeLeavingRecording */

const audioImportUtils = window.LectureProcessorLectureAudioImportUtils || {};

let audioFile = null;
let audioFileOrigin = 'upload';
let recordedAudioNeedsDownload = false;

let importedAudioToken = '';
let importedAudioSizeBytes = 0;
let importedAudioName = '';
let importedAudioSourceUrl = '';
let pendingAutoImportUrl = '';
let audioImportInFlight = false;
let audioImportRequestUrl = '';
let recordingState = 'idle';
let recordingStream = null;
let mediaRecorder = null;
let recordingChunks = [];
let recordingMimeType = '';
let recordingExtension = '';
let recordingStartedAtMs = 0;
let recordingElapsedMs = 0;
let recordingTimer = null;
let recorderStatusMessage = '';
let recorderStatusTone = 'info';
let discardNextRecordingResult = false;

const audioInput = document.getElementById('audio-input');

const audioInfo = document.getElementById('audio-info');

const audioName = document.getElementById('audio-name');
const audioSize = document.getElementById('audio-size');

const audioDownload = document.getElementById('audio-download');

const audioRemove = document.getElementById('audio-remove');

const audioUrlAdvanced = document.getElementById('audio-url-advanced');
const audioUrlAdvancedToggle = document.getElementById('audio-url-advanced-toggle');
const audioUrlAdvancedPanel = document.getElementById('audio-url-advanced-panel');

const audioUrlInput = document.getElementById('audio-url-input');
const audioUrlFetchBtn = document.getElementById('audio-url-fetch-btn');
const audioUrlStatus = document.getElementById('audio-url-status');
const audioRecorderPanel = document.getElementById('audio-recorder-panel');
const audioRecordStartBtn = document.getElementById('audio-record-start');
const audioRecordPauseBtn = document.getElementById('audio-record-pause');
const audioRecordStopBtn = document.getElementById('audio-record-stop');
const audioRecorderTimer = document.getElementById('audio-recorder-timer');
const audioRecordingStatus = document.getElementById('audio-recording-status');
const audioRecordingWarning = document.getElementById('audio-recording-warning');

function normalizeAudioImportUrl(value) {
    if (typeof audioImportUtils.normalizeAudioImportUrl === 'function') {
        return audioImportUtils.normalizeAudioImportUrl(value);
    }
    return String(value || '').trim();
}

function describeAudioImportRequest(options) {
    if (typeof audioImportUtils.describeAudioImportRequest === 'function') {
        return audioImportUtils.describeAudioImportRequest(options);
    }
    const settings = options && typeof options === 'object' ? options : {};
    const mode = String(settings.mode || '').trim();
    const url = normalizeAudioImportUrl(settings.url);
    const hasLocalAudioFile = Boolean(settings.hasLocalAudioFile);
    const importedToken = String(settings.importedAudioToken || '').trim();
    const importedSourceUrl = normalizeAudioImportUrl(settings.importedAudioSourceUrl);
    if (mode !== 'lecture-notes' && mode !== 'interview') return { shouldImport: false, reason: 'unsupported-mode' };
    if (!url) return { shouldImport: false, reason: 'empty-url' };
    if (hasLocalAudioFile) return { shouldImport: false, reason: 'local-audio-selected' };
    if (importedToken && importedSourceUrl === url) return { shouldImport: false, reason: 'already-imported' };
    if (importedToken && importedSourceUrl && importedSourceUrl !== url) {
        return { shouldImport: true, reason: 'replace-imported-audio' };
    }
    return { shouldImport: true, reason: 'import' };
}

function setAudioUrlAdvancedOpen(visible) {
    if (!audioUrlAdvanced || !audioUrlAdvancedToggle || !audioUrlAdvancedPanel) return;
    const open = Boolean(visible);
    audioUrlAdvanced.classList.toggle('is-open', open);
    audioUrlAdvancedToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    audioUrlAdvancedPanel.setAttribute('aria-hidden', open ? 'false' : 'true');
}

function getCurrentAudioImportUrl() {
    return normalizeAudioImportUrl(audioUrlInput ? audioUrlInput.value : '');
}
function hasReadyImportedAudioToken(urlValue) {
    const safeUrl = normalizeAudioImportUrl(urlValue == null ? getCurrentAudioImportUrl() : urlValue);
    if (typeof audioImportUtils.hasReadyImportedAudioToken === 'function') {
        return audioImportUtils.hasReadyImportedAudioToken({
            url: safeUrl,
            importedAudioToken,
            importedAudioSourceUrl,
        });
    }
    return Boolean(importedAudioToken) && (!safeUrl || normalizeAudioImportUrl(importedAudioSourceUrl) === safeUrl);
}
function getReadyImportedAudioToken(urlValue) {
    return hasReadyImportedAudioToken(urlValue) ? String(importedAudioToken || '').trim() : '';
}
function currentAudioBytes() {
    if (audioFile) return Number(audioFile.size || 0);
    return hasReadyImportedAudioToken() ? Number(importedAudioSizeBytes || 0) : 0;
}
function setAudioImportStatus(message = '', isError = false) {
    if (!audioUrlStatus) return;
    const text = String(message || '').trim();
    audioUrlStatus.textContent = text;
    audioUrlStatus.classList.toggle('error', Boolean(isError && text));
    syncProcessingLayout();
}
function setAudioImportPending(inFlight) {
    if (!audioUrlFetchBtn) return;
    if (!audioUrlFetchBtn.dataset.defaultLabel) {
        audioUrlFetchBtn.dataset.defaultLabel = audioUrlFetchBtn.textContent || 'Import Audio';
    }
    audioUrlFetchBtn.disabled = Boolean(inFlight);
    audioUrlFetchBtn.textContent = inFlight ? 'Importing...' : (audioUrlFetchBtn.dataset.defaultLabel || 'Import Audio');
    syncProcessingLayout();
}
function setRecorderStatus(message = '', tone = 'info') {
    recorderStatusMessage = String(message || '').trim();
    recorderStatusTone = String(tone || 'info').trim() || 'info';
    if (!audioRecordingStatus) return;
    audioRecordingStatus.textContent = recorderStatusMessage;
    audioRecordingStatus.dataset.tone = recorderStatusTone;
}
function formatRecordingElapsed(ms) {
    const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
    const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    return `${minutes}:${seconds}`;
}
function stopRecordingTimer() {
    if (recordingTimer) {
        window.clearInterval(recordingTimer);
        recordingTimer = null;
    }
}
function currentRecordingElapsedMs() {
    if (recordingState === 'recording' && recordingStartedAtMs > 0) {
        return recordingElapsedMs + Math.max(0, Date.now() - recordingStartedAtMs);
    }
    return recordingElapsedMs;
}
function updateRecordingTimer() {
    if (!audioRecorderTimer) return;
    audioRecorderTimer.textContent = formatRecordingElapsed(currentRecordingElapsedMs());
}
function cleanupRecordingStream() {
    if (!recordingStream) return;
    try {
        recordingStream.getTracks().forEach((track) => track.stop());
    } catch (_) { }
    recordingStream = null;
}
async function getMicrophonePermissionState() {
    if (!navigator.permissions || typeof navigator.permissions.query !== 'function') {
        return 'unknown';
    }
    try {
        const status = await navigator.permissions.query({ name: 'microphone' });
        return String(status && status.state || 'unknown').trim().toLowerCase() || 'unknown';
    } catch (_) {
        return 'unknown';
    }
}
function getPreferredRecordingConfig() {
    if (!window.MediaRecorder || !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        return null;
    }
    const candidates = [
        { mimeType: 'audio/ogg;codecs=opus', extension: 'ogg' },
        { mimeType: 'audio/ogg', extension: 'ogg' },
        { mimeType: 'audio/webm;codecs=opus', extension: 'webm' },
        { mimeType: 'audio/webm', extension: 'webm' },
        { mimeType: 'audio/mp4;codecs=mp4a.40.2', extension: 'm4a' },
        { mimeType: 'audio/mp4', extension: 'm4a' },
    ];
    const canCheck = typeof window.MediaRecorder.isTypeSupported === 'function';
    for (const candidate of candidates) {
        if (!canCheck || window.MediaRecorder.isTypeSupported(candidate.mimeType)) {
            return candidate;
        }
    }
    return null;
}
function syncRecorderUI() {
    const visible = Boolean((modeConfig[currentMode] || {}).needsAudio);
    const supportedConfig = getPreferredRecordingConfig();
    setHidden(audioRecorderPanel, !visible);
    if (!visible) return;
    if (audioRecordStartBtn) {
        audioRecordStartBtn.disabled = recordingState !== 'idle' || !supportedConfig;
    }
    if (audioRecordPauseBtn) {
        audioRecordPauseBtn.disabled = !(
            (recordingState === 'recording' && mediaRecorder && typeof mediaRecorder.pause === 'function') ||
            (recordingState === 'paused' && mediaRecorder && typeof mediaRecorder.resume === 'function')
        );
        audioRecordPauseBtn.textContent = recordingState === 'paused' ? 'Resume' : 'Pause';
    }
    if (audioRecordStopBtn) {
        audioRecordStopBtn.disabled = !(recordingState === 'recording' || recordingState === 'paused');
    }
    updateRecordingTimer();
    if (recordingState === 'recording') {
        setRecorderStatus('Recording in progress. Stop to attach it to this lecture.', 'recording');
        return;
    }
    if (recordingState === 'paused') {
        setRecorderStatus('Recording paused. Resume or stop to attach it to this lecture.', 'info');
        return;
    }
    if (recordingState === 'stopping') {
        setRecorderStatus('Saving recording...', 'info');
        return;
    }
    if (!supportedConfig) {
        setRecorderStatus('Browser recording is not available here. Upload or import audio instead.', 'error');
        return;
    }
    if (!recorderStatusMessage) {
        setRecorderStatus('Record directly here if you do not have an audio file yet.', 'info');
    } else {
        setRecorderStatus(recorderStatusMessage, recorderStatusTone);
    }
}
function syncAudioInfoUI() {
    if (audioFile) {
        audioName.textContent = audioFile.name;
        audioSize.textContent = audioFileOrigin === 'recording'
            ? `${formatFileSize(audioFile.size)} · Recorded in browser`
            : formatFileSize(audioFile.size);
        setHidden(audioInfo, false);
        audioZone.classList.add('has-file');
    } else if (importedAudioToken) {
        audioName.textContent = importedAudioName || 'Imported audio';
        audioSize.textContent = importedAudioSizeBytes > 0
            ? `${formatFileSize(importedAudioSizeBytes)} · Imported from URL`
            : 'Imported from URL';
        setHidden(audioInfo, false);
        audioZone.classList.add('has-file');
    } else {
        setHidden(audioInfo, true);
        audioZone.classList.remove('has-file');
    }
    if (audioRecordingWarning) {
        if (audioFile && audioFileOrigin === 'recording') {
            setHidden(audioRecordingWarning, false);
            audioRecordingWarning.textContent = recordedAudioNeedsDownload
                ? 'This recording only exists in this browser tab. Download it now if you want to keep it, or it will be lost forever when you leave this page.'
                : 'This recording was downloaded. Keep the saved file somewhere safe, because the in-browser copy still disappears when you leave this page.';
        } else {
            setHidden(audioRecordingWarning, true);
            audioRecordingWarning.textContent = '';
        }
    }
    syncRecorderUI();
    syncProcessingLayout();
}
function clearImportedAudioLocalState() {
    importedAudioToken = '';
    importedAudioSizeBytes = 0;
    importedAudioName = '';
    importedAudioSourceUrl = '';
}
function buildRecordedAudioFileName(extension) {
    const now = new Date();
    const stamp = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
    ].join('') + '-' + [
        String(now.getHours()).padStart(2, '0'),
        String(now.getMinutes()).padStart(2, '0'),
        String(now.getSeconds()).padStart(2, '0'),
    ].join('');
    return `lecture-recording-${stamp}.${String(extension || 'ogg').trim() || 'ogg'}`;
}
function finalizeRecordedAudio(blob) {
    cleanupRecordingStream();
    stopRecordingTimer();
    recordingState = 'idle';
    recordingStartedAtMs = 0;
    const safeBlob = blob instanceof Blob ? blob : null;
    if (!safeBlob || !safeBlob.size) {
        recordingChunks = [];
        recordingMimeType = '';
        recordingExtension = '';
        setRecorderStatus('No audio was captured. Please try again.', 'error');
        showToast('No audio was captured. Please try again.', 'error');
        syncRecorderUI();
        return;
    }
    const mimeType = String(recordingMimeType || safeBlob.type || 'audio/ogg').trim() || 'audio/ogg';
    const fileName = buildRecordedAudioFileName(recordingExtension || (mimeType.indexOf('mp4') >= 0 ? 'm4a' : 'ogg'));
    const recordedFile = new File([safeBlob], fileName, { type: mimeType, lastModified: Date.now() });
    recordingChunks = [];
    recordingMimeType = '';
    recordingExtension = '';
    if (discardNextRecordingResult) {
        discardNextRecordingResult = false;
        setRecorderStatus('Recording discarded.', 'info');
        syncRecorderUI();
        return;
    }
    handleAudioFile(recordedFile, { origin: 'recording' });
    setRecorderStatus('Recording attached. Download it from the audio card now if you want to keep it.', 'success');
    showToast('Recording attached as your audio file. Download it now if you want to keep it.', 'success', 4200);
    syncRecorderUI();
}
async function startAudioRecording() {
    if (currentMode !== 'lecture-notes') {
        setRecorderStatus('Recording is only available in Lecture Notes mode.', 'error');
        return;
    }
    if (recordingState !== 'idle') return;
    const config = getPreferredRecordingConfig();
    if (!config) {
        setRecorderStatus('Browser recording is not available here. Upload or import audio instead.', 'error');
        return;
    }
    try {
        const permissionState = await getMicrophonePermissionState();
        if (permissionState === 'denied') {
            const blockedMessage = 'Microphone access is blocked in your browser. Allow microphone access in the site settings, then try again.';
            setRecorderStatus(blockedMessage, 'error');
            showToast(blockedMessage, 'error', 4200);
            syncRecorderUI();
            return;
        }
        cleanupRecordingStream();
        recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        recordingChunks = [];
        recordingMimeType = config.mimeType;
        recordingExtension = config.extension;
        mediaRecorder = new window.MediaRecorder(recordingStream, { mimeType: config.mimeType });
        mediaRecorder.addEventListener('dataavailable', (event) => {
            if (event.data && event.data.size > 0) {
                recordingChunks.push(event.data);
            }
        });
        mediaRecorder.addEventListener('stop', () => {
            const blob = new Blob(recordingChunks, { type: recordingMimeType || (mediaRecorder && mediaRecorder.mimeType) || config.mimeType });
            mediaRecorder = null;
            finalizeRecordedAudio(blob);
        });
        mediaRecorder.addEventListener('error', () => {
            mediaRecorder = null;
            cleanupRecordingStream();
            stopRecordingTimer();
            recordingState = 'idle';
            recordingChunks = [];
            recordingMimeType = '';
            recordingExtension = '';
            setRecorderStatus('Recording failed. Please try again.', 'error');
            showToast('Recording failed. Please try again.', 'error');
            syncRecorderUI();
        });
        recordingElapsedMs = 0;
        recordingStartedAtMs = Date.now();
        recordingState = 'recording';
        recorderStatusMessage = '';
        mediaRecorder.start();
        updateRecordingTimer();
        recordingTimer = window.setInterval(updateRecordingTimer, 500);
        syncRecorderUI();
    } catch (error) {
        cleanupRecordingStream();
        stopRecordingTimer();
        recordingState = 'idle';
        recordingChunks = [];
        recordingMimeType = '';
        recordingExtension = '';
        const message = error && error.name === 'NotAllowedError'
            ? 'Microphone access was blocked. Allow microphone access in your browser and try again.'
            : 'Could not start recording in this browser.';
        setRecorderStatus(message, 'error');
        showToast(message, 'error', 3600);
        syncRecorderUI();
    }
}
function toggleAudioRecordingPause() {
    if (!mediaRecorder) return;
    if (recordingState === 'recording' && typeof mediaRecorder.pause === 'function') {
        try {
            recordingElapsedMs = currentRecordingElapsedMs();
            recordingStartedAtMs = 0;
            mediaRecorder.pause();
            stopRecordingTimer();
            recordingState = 'paused';
            syncRecorderUI();
        } catch (_) { }
        return;
    }
    if (recordingState === 'paused' && typeof mediaRecorder.resume === 'function') {
        try {
            recordingStartedAtMs = Date.now();
            mediaRecorder.resume();
            recordingState = 'recording';
            updateRecordingTimer();
            recordingTimer = window.setInterval(updateRecordingTimer, 500);
            syncRecorderUI();
        } catch (_) { }
    }
}
function stopAudioRecording() {
    if (!mediaRecorder || !(recordingState === 'recording' || recordingState === 'paused')) return;
    recordingElapsedMs = currentRecordingElapsedMs();
    recordingStartedAtMs = 0;
    recordingState = 'stopping';
    stopRecordingTimer();
    syncRecorderUI();
    try {
        mediaRecorder.stop();
    } catch (_) {
        mediaRecorder = null;
        cleanupRecordingStream();
        recordingState = 'idle';
        recordingChunks = [];
        recordingMimeType = '';
        recordingExtension = '';
        setRecorderStatus('Recording could not be saved. Please try again.', 'error');
        syncRecorderUI();
    }
}
async function releaseImportedAudioToken(options = {}) {
    const token = String(importedAudioToken || '').trim();
    const shouldClearStatus = options.clearStatus !== false;
    if (options.resetPendingUrl !== false) {
        pendingAutoImportUrl = '';
    }
    if (!token) {
        if (shouldClearStatus) setAudioImportStatus('');
        return;
    }
    clearImportedAudioLocalState();
    if (!audioFile) syncAudioInfoUI();
    if (shouldClearStatus) setAudioImportStatus('');
    if (!currentUser) return;
    try {
        await authenticatedFetch('/api/import-audio-url/release', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audio_import_token: token }),
        });
    } catch (_) { }
}
async function applyImportedAudio(payload, previousToken = '', sourceUrl = '') {
    const token = String(payload && payload.audio_import_token ? payload.audio_import_token : '').trim();
    if (!token) return false;
    if (audioFile) {
        if (currentUser) {
            try {
                await authenticatedFetch('/api/import-audio-url/release', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ audio_import_token: token }),
                });
            } catch (_) { }
        }
        return false;
    }
    importedAudioToken = token;
    importedAudioName = String(payload.file_name || 'Imported audio.mp3').trim();
    importedAudioSizeBytes = Math.max(0, Number(payload.size_bytes || 0));
    importedAudioSourceUrl = normalizeAudioImportUrl(sourceUrl);
    syncAudioInfoUI();
    updateProcessButton();
    const ttlSeconds = Math.max(0, Number(payload.expires_in_seconds || 0));
    if (ttlSeconds > 0) {
        const minutes = Math.max(1, Math.round(ttlSeconds / 60));
        setAudioImportStatus(`Imported ${importedAudioName}. Token expires in about ${minutes} minute${minutes === 1 ? '' : 's'}.`);
    } else {
        setAudioImportStatus(`Imported ${importedAudioName}.`);
    }
    if (previousToken && previousToken !== token && currentUser) {
        try {
            await authenticatedFetch('/api/import-audio-url/release', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ audio_import_token: previousToken }),
            });
        } catch (_) { }
    }
    return true;
}
function waitForAudioImport(ms) {
    return new Promise(resolve => window.setTimeout(resolve, Math.max(250, Number(ms || 1000))));
}
async function pollAudioImportJob(jobId) {
    const safeJobId = String(jobId || '').trim();
    if (!safeJobId) throw new Error('Audio import did not return a job id.');
    const deadlineMs = Date.now() + 16 * 60 * 1000;
    let attempt = 0;
    while (Date.now() < deadlineMs) {
        const response = await authenticatedFetch(`/api/import-audio-url/${encodeURIComponent(safeJobId)}`);
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(String(payload.error || 'Could not read audio import status.'));
        }
        const status = String(payload.status || '').trim().toLowerCase();
        if (status === 'complete' && payload.audio_import_token) {
            return payload;
        }
        if (status === 'error') {
            throw new Error(String(payload.error || 'Audio import failed.'));
        }
        setAudioImportStatus(String(payload.step_description || 'Importing audio from URL...'));
        attempt += 1;
        await waitForAudioImport(Math.min(5000, 1000 + attempt * 500));
    }
    throw new Error('Audio import is taking longer than expected. Please try again.');
}
function syncAudioImportStatusForUrlChange() {
    if (!((modeConfig[currentMode] || {}).needsAudio) || audioFile || audioImportInFlight) {
        updateProcessButton();
        return;
    }
    const currentUrl = getCurrentAudioImportUrl();
    if (!currentUrl) {
        setAudioImportStatus(importedAudioToken ? `Imported ${importedAudioName || 'audio'}.` : '');
        updateProcessButton();
        return;
    }
    const importedSourceUrl = normalizeAudioImportUrl(importedAudioSourceUrl);
    if (importedAudioToken && importedSourceUrl !== currentUrl) {
        setAudioImportStatus('URL changed. Paste again, press Enter, or click Import Audio to use this source.');
    } else if (importedAudioToken && importedSourceUrl === currentUrl) {
        setAudioImportStatus(`Imported ${importedAudioName || 'audio'} from this URL.`);
    } else {
        setAudioImportStatus('');
    }
    updateProcessButton();
}
async function importAudioFromUrl(options = {}) {
    const importOptions = options && typeof options === 'object' ? options : {};
    const importReason = String(importOptions.reason || 'manual').trim() || 'manual';
    const url = normalizeAudioImportUrl(importOptions.url == null ? getCurrentAudioImportUrl() : importOptions.url);
    if (!currentUser) {
        if (importReason === 'manual') {
            showAuthModal('signin');
        } else {
            setAudioImportStatus('Sign in to import audio from a lecture video URL.', true);
        }
        updateProcessButton();
        return false;
    }
    if (!((modeConfig[currentMode] || {}).needsAudio)) {
        setAudioImportStatus('URL import is only available when this mode accepts audio.', true);
        updateProcessButton();
        return false;
    }
    if (!url) {
        setAudioImportStatus('Paste the index.m3u8 playlist URL copied from DevTools → Network.', true);
        updateProcessButton();
        return false;
    }
    if (audioImportInFlight) {
        if (!audioFile && url && url !== audioImportRequestUrl) {
            pendingAutoImportUrl = url;
            setAudioImportStatus('Import in progress. The latest pasted lecture video URL will import next.');
        } else if (importReason === 'manual') {
            setAudioImportStatus('Import already in progress. Please wait.');
        }
        updateProcessButton();
        return false;
    }
    const request = describeAudioImportRequest({
        mode: currentMode,
        url,
        hasLocalAudioFile: Boolean(audioFile),
        importedAudioToken,
        importedAudioSourceUrl,
    });
    if (!request.shouldImport) {
        if (request.reason === 'already-imported' && importReason === 'manual') {
            setAudioImportStatus(`Imported ${importedAudioName || 'audio'} from this URL.`);
        } else if (request.reason === 'local-audio-selected' && importReason === 'manual') {
            setAudioImportStatus('Using your uploaded audio file. Remove it to import from LMS URL.');
        }
        updateProcessButton();
        return request.reason === 'already-imported';
    }
    audioImportInFlight = true;
    audioImportRequestUrl = url;
    setAudioImportPending(true);
    updateProcessButton();
    setAudioImportStatus(importReason === 'paste' ? 'Importing audio from the pasted lecture video URL...' : 'Importing audio from URL...');
    const previousToken = String(importedAudioToken || '').trim();
    try {
        const response = await authenticatedFetch('/api/import-audio-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const retryAfter = getRetryAfterSeconds(response, data);
            const errorText = String(data.error || 'Could not import audio from URL.');
            if (response.status === 429 && retryAfter > 0) {
                setAudioImportStatus(`${errorText} Try again in ${formatRetryDelay(retryAfter)}.`, true);
            } else {
                setAudioImportStatus(errorText, true);
            }
            return false;
        }
        const readyPayload = data.audio_import_token ? data : await pollAudioImportJob(data.job_id);
        const applied = await applyImportedAudio(readyPayload, previousToken, url);
        const queuedUrl = normalizeAudioImportUrl(pendingAutoImportUrl);
        if (applied) {
            if (queuedUrl && queuedUrl !== url) {
                setAudioImportStatus('Newest pasted lecture video URL detected. Importing latest audio...');
            } else {
                showToast('Audio imported from URL.', 'success');
            }
        } else if (audioFile) {
            setAudioImportStatus('Using your uploaded audio file. LMS import was ignored.');
        }
        return applied;
    } catch (e) {
        captureClientError(e, 'import_audio_url');
        setAudioImportStatus('Could not import audio from URL. Please try again.', true);
        return false;
    } finally {
        audioImportInFlight = false;
        audioImportRequestUrl = '';
        setAudioImportPending(false);
        updateProcessButton();
        const nextUrl = normalizeAudioImportUrl(pendingAutoImportUrl);
        pendingAutoImportUrl = '';
        if (!audioFile && nextUrl) {
            const nextRequest = describeAudioImportRequest({
                mode: currentMode,
                url: nextUrl,
                hasLocalAudioFile: Boolean(audioFile),
                importedAudioToken,
                importedAudioSourceUrl,
            });
            if (nextRequest.shouldImport) {
                window.setTimeout(() => {
                    importAudioFromUrl({ url: nextUrl, reason: 'queued-auto' });
                }, 0);
            }
        }
    }
}

function handleAudioFile(file, options = {}) {
    if (!file) return;
    const valid = ['.mp3', '.m4a', '.wav', '.aac', '.ogg', '.flac', '.webm'];
    if (!valid.some(ext => file.name.toLowerCase().endsWith(ext))) { showToast('Please select a valid audio file', 'error'); return; }
    if (file.size > 500 * 1024 * 1024) { showToast('Audio file must be under 500 MB', 'error'); return; }
    pendingAutoImportUrl = '';
    if (importedAudioToken) {
        releaseImportedAudioToken({ clearStatus: true });
    }
    audioFile = file;
    audioFileOrigin = options.origin === 'recording' ? 'recording' : 'upload';
    recordedAudioNeedsDownload = audioFileOrigin === 'recording';
    if (audioFileOrigin !== 'recording') {
        recorderStatusMessage = '';
        recorderStatusTone = 'info';
    }
    syncAudioInfoUI();
    updateProcessButton();
}

function downloadImportedAudioPreview() {
    const tokenValue = String(importedAudioToken || '').trim();
    if (!tokenValue) return Promise.reject(new Error('No imported audio is ready to download.'));
    const fallbackName = String(importedAudioName || 'imported-audio.mp3').trim() || 'imported-audio.mp3';
    return authenticatedFetch('/api/import-audio-url/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            audio_import_token: tokenValue,
            file_name: fallbackName,
        }),
    }).then((response) => {
        if (!response.ok) {
            return response.json().catch(() => ({})).then((payload) => {
                throw new Error(payload.error || 'Could not download imported audio.');
            });
        }
        if (downloadUtils.downloadResponseBlob) {
            return downloadUtils.downloadResponseBlob(response, fallbackName);
        }
        return response.blob().then((blob) => {
            if (downloadUtils.saveBlobAsFile) {
                downloadUtils.saveBlobAsFile(blob, fallbackName);
                return fallbackName;
            }
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = fallbackName;
            document.body.appendChild(anchor);
            anchor.click();
            document.body.removeChild(anchor);
            URL.revokeObjectURL(url);
            return fallbackName;
        });
    });
}

const downloadSelectedAudio = () => {
    if (downloadLocalPreviewFile(audioFile)) {
        if (audioFileOrigin === 'recording') {
            recordedAudioNeedsDownload = false;
            syncAudioInfoUI();
            showToast('Recording download started. Keep that file safe because the in-browser copy will disappear when you leave this page.', 'success', 4200);
        } else {
            showToast('Audio file download started.', 'success', 1600);
        }
        return;
    }
    if (importedAudioToken) {
        showToast('Imported audio download started. Keep the saved file as your backup.', 'success', 3600);
        downloadImportedAudioPreview().catch((error) => {
            showToast(error && error.message ? error.message : 'Could not download imported audio.', 'error');
        });
    }
};

function bindRecordingControls() {
    if (audioRecordStartBtn) {
        audioRecordStartBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            startAudioRecording();
        });
    }
    if (audioRecordPauseBtn) {
        audioRecordPauseBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleAudioRecordingPause();
        });
    }
    if (audioRecordStopBtn) {
        audioRecordStopBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            stopAudioRecording();
        });
    }
}

function bindAudioImportControls() {
    if (audioUrlFetchBtn) {
        audioUrlFetchBtn.addEventListener('click', importAudioFromUrl);
    }
    if (otherAudioToggle) {
        otherAudioToggle.addEventListener('click', () => {
            otherAudioOpen = !otherAudioOpen;
            syncProcessingLayout();
        });
    }
    if (audioUrlAdvancedToggle) {
        audioUrlAdvancedToggle.addEventListener('click', () => {
            setAudioUrlAdvancedOpen(!(audioUrlAdvanced && audioUrlAdvanced.classList.contains('is-open')));
        });
    }
    if (audioUrlInput) {
        audioUrlInput.addEventListener('input', () => {
            syncAudioImportStatusForUrlChange();
        });
        audioUrlInput.addEventListener('paste', () => {
            window.setTimeout(() => {
                importAudioFromUrl({ url: getCurrentAudioImportUrl(), reason: 'paste' });
            }, 0);
        });
        audioUrlInput.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            importAudioFromUrl({ reason: 'manual' });
        });
    }
}

function clearSelectedAudioFile() {
    audioFile = null;
    audioFileOrigin = 'upload';
    recordedAudioNeedsDownload = false;
    recorderStatusMessage = '';
    recorderStatusTone = 'info';
}

function discardActiveRecording() {
    if (recordingState === 'recording' || recordingState === 'paused') {
        discardNextRecordingResult = true;
        stopAudioRecording();
    }
}

function removeSelectedAudio(e) {
    e.stopPropagation();
    clearSelectedAudioFile();
    audioInput.value = '';
    pendingAutoImportUrl = '';
    if (importedAudioToken) {
        releaseImportedAudioToken({ clearStatus: true });
    }
    syncAudioInfoUI();
    updateProcessButton();
}

function warnBeforeLeavingRecording(e) {
    if ((audioFile && audioFileOrigin === 'recording' && recordedAudioNeedsDownload) || recordingState === 'recording' || recordingState === 'paused') {
        e.preventDefault();
        e.returnValue = '';
    }
}
