const firebaseConfig = {
  apiKey: 'AIzaSyBAAeEUCPNvP5qnqpP3M6HnFZ6vaaijUvM',
  authDomain: 'lecture-processor-cdff6.firebaseapp.com',
  projectId: 'lecture-processor-cdff6',
  storageBucket: 'lecture-processor-cdff6.firebasestorage.app',
  messagingSenderId: '374793454161',
  appId: '1:374793454161:web:c68b21590e9a1fafa32e70',
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const authUtils = window.LectureProcessorAuth || {};
const authClient = authUtils.createAuthClient
  ? authUtils.createAuthClient(auth, { notSignedInMessage: 'Please sign in' })
  : null;
const markdownUtils = window.LectureProcessorMarkdown || {};

let currentUser = null;
let idToken = null;
let selectedFile = null;
let selectedSourceType = 'document';
let extractionBusy = false;
let resultMarkdown = '';
let textExtractionCredits = null;
let selectedPromptTemplateKey = '';

const promptTemplates = {
  qa: 'Answer these 5 questions from this file: 1) Main topic? 2) Most important facts? 3) Common pitfalls? 4) Likely exam questions? 5) Final quick recap.',
};

const toolsUserMeta = document.getElementById('tools-user-meta');
const authRequiredPanel = document.getElementById('tools-auth-required');
const toolsApp = document.getElementById('tools-app');
const signinBtn = document.getElementById('tools-signin-btn');
const openDashboardBtn = document.getElementById('tools-open-dashboard-btn');
const openLibraryBtn = document.getElementById('tools-open-library-btn');
const sourceButtons = document.querySelectorAll('.source-btn[data-source-type]');
const promptInput = document.getElementById('tools-custom-prompt');
const promptTemplateButtons = document.querySelectorAll('.prompt-template-btn[data-template]');
const urlLabel = document.getElementById('tools-url-label');
const urlInput = document.getElementById('tools-url-input');
const urlHelp = document.getElementById('tools-url-help');
const dropzone = document.getElementById('tools-dropzone');
const dropzoneSub = document.getElementById('tools-dropzone-sub');
const fileInput = document.getElementById('tools-file-input');
const fileSelected = document.getElementById('tools-file-selected');
const fileNameEl = document.getElementById('tools-file-name');
const fileMetaEl = document.getElementById('tools-file-meta');
const fileRemoveBtn = document.getElementById('tools-file-remove-btn');
const runBtn = document.getElementById('tools-run-btn');
const creditText = document.getElementById('tools-credit-text');
const statusEl = document.getElementById('tools-status');
const billingEl = document.getElementById('tools-billing');
const resultCard = document.getElementById('tools-result-card');
const resultPreview = document.getElementById('tools-result-preview');
const viewRenderedBtn = document.getElementById('tools-view-rendered-btn');
const copyBtn = document.getElementById('tools-copy-btn');
const downloadDocxBtn = document.getElementById('tools-download-docx-btn');

function formatFileSize(bytes) {
  const value = Math.max(0, Number(bytes || 0));
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function setStatus(message, type) {
  statusEl.textContent = String(message || '');
  statusEl.className = type ? `status ${type}` : 'status';
}

function getAllowedExtensionsForSource(sourceType) {
  if (sourceType === 'image') {
    return ['.png', '.jpg', '.jpeg', '.webp', '.heic', '.heif'];
  }
  if (sourceType === 'document') {
    return ['.pdf', '.pptx', '.docx'];
  }
  return [];
}

function getMaxBytesForSource(sourceType) {
  if (sourceType === 'image') return 20 * 1024 * 1024;
  if (sourceType === 'document') return 50 * 1024 * 1024;
  return 0;
}

function updateBillingReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') {
    billingEl.style.display = 'none';
    billingEl.textContent = '';
    return;
  }
  const charged = receipt.charged || {};
  const refunded = receipt.refunded || {};
  const chargedCount = Number(charged.slides_credits || 0);
  const refundedCount = Number(refunded.slides_credits || 0);
  if (chargedCount <= 0 && refundedCount <= 0) {
    billingEl.style.display = 'none';
    billingEl.textContent = '';
    return;
  }

  let text = '';
  if (chargedCount > 0) {
    text += `Charged ${chargedCount} text extraction credit${chargedCount === 1 ? '' : 's'}.`;
  }
  if (refundedCount > 0) {
    text += ` Refunded ${refundedCount} text extraction credit${refundedCount === 1 ? '' : 's'}.`;
  }
  billingEl.textContent = text.trim();
  billingEl.style.display = '';
}

function updateCreditsText() {
  if (textExtractionCredits === null || textExtractionCredits === undefined) {
    creditText.textContent = 'Text extraction credits: -';
    return;
  }
  creditText.textContent = `Text extraction credits: ${textExtractionCredits}`;
}

function getPlainTextFromMarkdown(markdownText) {
  const markdown = String(markdownText || '');
  if (!markdown) return '';

  let html = '';
  if (markdownUtils && typeof markdownUtils.parseMarkdownToSafeHtml === 'function') {
    html = markdownUtils.parseMarkdownToSafeHtml(markdown);
  } else if (window.marked && window.DOMPurify) {
    const parsed = window.marked.parse(markdown || '');
    html = window.DOMPurify.sanitize(parsed, {});
  }

  if (!html) {
    return markdown
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^#{1,6}\s*/gm, '')
      .replace(/^[-*]\s+/gm, '')
      .replace(/^\d+\.\s+/gm, '')
      .trim();
  }

  const temp = document.createElement('div');
  temp.innerHTML = html;
  return String(temp.textContent || temp.innerText || '').trim();
}

function updateRunButton() {
  const hasInput = selectedSourceType === 'url'
    ? Boolean(urlInput && String(urlInput.value || '').trim())
    : Boolean(selectedFile);
  runBtn.disabled = extractionBusy || !currentUser || !hasInput;
  runBtn.textContent = extractionBusy ? 'Extracting...' : 'Extract';
}

function renderResult(markdownText) {
  const text = String(markdownText || '');
  resultMarkdown = text;

  if (markdownUtils && typeof markdownUtils.parseMarkdownToSafeHtml === 'function') {
    resultPreview.innerHTML = markdownUtils.parseMarkdownToSafeHtml(text);
  } else if (window.marked && window.DOMPurify) {
    const parsed = window.marked.parse(text || '');
    resultPreview.innerHTML = window.DOMPurify.sanitize(parsed, {});
  } else {
    resultPreview.textContent = text;
  }
}

function clearSelectedFile() {
  selectedFile = null;
  fileInput.value = '';
  fileSelected.style.display = 'none';
  fileNameEl.textContent = '';
  fileMetaEl.textContent = '';
  updateRunButton();
}

function validateAndSetSelectedFile(file) {
  if (!file || selectedSourceType === 'url') return;

  const allowed = getAllowedExtensionsForSource(selectedSourceType);
  const lowerName = String(file.name || '').toLowerCase();
  const hasAllowedExt = allowed.some((ext) => lowerName.endsWith(ext));
  if (!hasAllowedExt) {
    setStatus(`Invalid file type. Allowed: ${allowed.join(', ')}`, 'error');
    clearSelectedFile();
    return;
  }

  const maxBytes = getMaxBytesForSource(selectedSourceType);
  if (Number(file.size || 0) <= 0 || Number(file.size || 0) > maxBytes) {
    setStatus(`File must be under ${Math.round(maxBytes / (1024 * 1024))} MB.`, 'error');
    clearSelectedFile();
    return;
  }

  selectedFile = file;
  fileNameEl.textContent = file.name;
  fileMetaEl.textContent = `${formatFileSize(file.size)} · ${selectedSourceType === 'image' ? 'Image Reader' : 'Document Reader'}`;
  fileSelected.style.display = 'flex';
  setStatus('', '');
  updateRunButton();
}

function updateSourceType(sourceType) {
  selectedSourceType = sourceType === 'image' ? 'image' : sourceType === 'url' ? 'url' : 'document';

  sourceButtons.forEach((btn) => {
    const isActive = btn.dataset.sourceType === selectedSourceType;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  const urlMode = selectedSourceType === 'url';
  if (urlLabel) urlLabel.style.display = urlMode ? '' : 'none';
  if (urlInput) urlInput.style.display = urlMode ? '' : 'none';
  if (urlHelp) urlHelp.style.display = urlMode ? '' : 'none';
  if (dropzone) dropzone.style.display = urlMode ? 'none' : '';
  if (fileSelected) fileSelected.style.display = (!urlMode && selectedFile) ? 'flex' : 'none';

  if (urlMode) {
    setStatus('', '');
    updateRunButton();
    return;
  }

  if (selectedSourceType === 'image') {
    fileInput.accept = '.png,.jpg,.jpeg,.webp,.heic,.heif';
    dropzoneSub.textContent = 'PNG, JPG, JPEG, WEBP, HEIC, HEIF up to 20 MB';
  } else {
    fileInput.accept = '.pdf,.pptx,.docx';
    dropzoneSub.textContent = 'PDF/PPTX/DOCX up to 50 MB';
  }

  if (selectedFile) {
    validateAndSetSelectedFile(selectedFile);
  }
  updateRunButton();
}

async function authenticatedFetch(path, options = {}, allowRefresh = true) {
  if (!currentUser) {
    throw new Error('Please sign in to continue');
  }
  if (authClient && typeof authClient.authFetch === 'function') {
    const response = await authClient.authFetch(path, options, { retryOn401: allowRefresh !== false });
    if (typeof authClient.getToken === 'function') {
      const latestToken = authClient.getToken();
      if (latestToken) idToken = latestToken;
    }
    return response;
  }

  if (!idToken) idToken = await currentUser.getIdToken();
  const headers = Object.assign({}, options.headers || {}, { Authorization: `Bearer ${idToken}` });
  const response = await fetch(path, Object.assign({}, options, { headers }));
  if (response.status === 401 && allowRefresh) {
    idToken = await currentUser.getIdToken(true);
    return fetch(path, Object.assign({}, options, {
      headers: Object.assign({}, options.headers || {}, { Authorization: `Bearer ${idToken}` }),
    }));
  }
  return response;
}

async function refreshUserCredits() {
  if (!currentUser) {
    textExtractionCredits = null;
    updateCreditsText();
    return;
  }

  try {
    const response = await authenticatedFetch('/api/auth/user');
    if (!response.ok) return;
    const payload = await response.json();
    if (payload && payload.credits) {
      textExtractionCredits = Number(payload.credits.slides || 0);
      updateCreditsText();
    }
  } catch (_) {
    updateCreditsText();
  }
}

function inferResultTitle() {
  if (selectedSourceType === 'url' && urlInput) {
    const raw = String(urlInput.value || '').trim();
    if (!raw) return 'Tools URL Extract';
    try {
      const parsed = new URL(raw);
      const host = String(parsed.hostname || 'url').replace(/^www\./i, '');
      return `Tools URL Extract - ${host}`;
    } catch (_) {
      return 'Tools URL Extract';
    }
  }
  return selectedFile ? selectedFile.name.replace(/\.[^.]+$/, '') : 'Tools Extract';
}

async function runExtraction() {
  if (!currentUser) {
    setStatus('Please sign in to use Tools.', 'error');
    return;
  }

  const sourceUrl = urlInput ? String(urlInput.value || '').trim() : '';
  if (selectedSourceType === 'url') {
    if (!sourceUrl) {
      setStatus('Enter a valid URL before extraction.', 'error');
      return;
    }
  } else if (!selectedFile) {
    setStatus('Select a file first.', 'error');
    return;
  }

  extractionBusy = true;
  updateRunButton();
  setStatus('Uploading and extracting...', '');
  updateBillingReceipt(null);

  const formData = new FormData();
  formData.append('source_type', selectedSourceType);
  if (selectedSourceType === 'url') {
    formData.append('source_url', sourceUrl);
  } else {
    formData.append('file', selectedFile);
  }

  const customPrompt = promptInput ? String(promptInput.value || '').trim() : '';
  if (customPrompt) {
    formData.append('custom_prompt', customPrompt);
  }
  if (selectedPromptTemplateKey) {
    formData.append('prompt_template_key', selectedPromptTemplateKey);
  }

  try {
    const response = await authenticatedFetch('/api/tools/extract', {
      method: 'POST',
      body: formData,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errorMessage = String(payload.error || 'Extraction failed.');
      setStatus(errorMessage, 'error');
      updateBillingReceipt(payload.billing_receipt || null);
      await refreshUserCredits();
      return;
    }

    const markdown = String(payload.content_markdown || '');
    if (!markdown.trim()) {
      setStatus('Extraction returned empty output.', 'error');
      updateBillingReceipt(payload.billing_receipt || null);
      await refreshUserCredits();
      return;
    }

    renderResult(markdown);
    setStatus('Extraction complete.', 'success');
    updateBillingReceipt(payload.billing_receipt || null);
    await refreshUserCredits();
  } catch (error) {
    setStatus(error && error.message ? error.message : 'Extraction failed. Please try again.', 'error');
  } finally {
    extractionBusy = false;
    updateRunButton();
  }
}

sourceButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    updateSourceType(btn.dataset.sourceType || 'document');
  });
});

promptTemplateButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const key = String(btn.dataset.template || '').trim();
    const templateText = promptTemplates[key] || '';
    if (!promptInput || !templateText) return;
    promptInput.value = templateText;
    selectedPromptTemplateKey = key;
    promptInput.focus();
    setStatus('Template inserted. You can edit it before extraction.', 'success');
  });
});

if (promptInput) {
  promptInput.addEventListener('input', () => {
    selectedPromptTemplateKey = '';
  });
}

if (urlInput) {
  urlInput.addEventListener('input', () => {
    setStatus('', '');
    updateRunButton();
  });
}

fileInput.addEventListener('change', (event) => {
  if (selectedSourceType === 'url') return;
  if (event.target.files && event.target.files.length) {
    validateAndSetSelectedFile(event.target.files[0]);
  }
});

fileRemoveBtn.addEventListener('click', () => {
  clearSelectedFile();
  setStatus('', '');
});

runBtn.addEventListener('click', runExtraction);

copyBtn.addEventListener('click', async () => {
  if (!resultMarkdown) return;
  const plainText = getPlainTextFromMarkdown(resultMarkdown);
  try {
    await navigator.clipboard.writeText(plainText);
    setStatus('Copied plain text to clipboard.', 'success');
  } catch (_) {
    setStatus('Could not copy to clipboard.', 'error');
  }
});

downloadDocxBtn.addEventListener('click', async () => {
  if (!resultMarkdown) return;
  try {
    const response = await authenticatedFetch('/api/tools/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        format: 'docx',
        content_markdown: resultMarkdown,
        title: inferResultTitle(),
      }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(String(payload.error || 'Could not export .docx.'));
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `tools-extract-${new Date().toISOString().slice(0, 10)}.docx`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    setStatus('Word download started.', 'success');
  } catch (error) {
    setStatus(error && error.message ? error.message : 'Could not export .docx.', 'error');
  }
});

if (viewRenderedBtn) {
  viewRenderedBtn.addEventListener('click', () => {
    viewRenderedBtn.classList.add('active');
  });
}

openDashboardBtn.addEventListener('click', () => {
  window.location.href = '/dashboard';
});

openLibraryBtn.addEventListener('click', () => {
  window.location.href = '/study';
});

signinBtn.addEventListener('click', () => {
  window.location.href = '/dashboard';
});

if (dropzone) {
  dropzone.addEventListener('dragover', (event) => {
    if (selectedSourceType === 'url') return;
    event.preventDefault();
    dropzone.classList.add('drag');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('drag');
  });

  dropzone.addEventListener('drop', (event) => {
    if (selectedSourceType === 'url') return;
    event.preventDefault();
    dropzone.classList.remove('drag');
    if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length) {
      validateAndSetSelectedFile(event.dataTransfer.files[0]);
    }
  });
}

auth.onAuthStateChanged(async (user) => {
  currentUser = user || null;
  if (!user) {
    idToken = null;
    if (authClient && typeof authClient.clearToken === 'function') {
      authClient.clearToken();
    }
    toolsUserMeta.textContent = 'Not signed in';
    authRequiredPanel.style.display = '';
    toolsApp.style.display = 'none';
    textExtractionCredits = null;
    updateCreditsText();
    updateRunButton();
    return;
  }

  if (authClient && typeof authClient.setToken === 'function') {
    try {
      const tokenValue = await user.getIdToken();
      idToken = tokenValue;
      authClient.setToken(tokenValue);
    } catch (_) {
      idToken = null;
    }
  }

  toolsUserMeta.textContent = `Signed in as ${user.email || 'user'}`;
  authRequiredPanel.style.display = 'none';
  toolsApp.style.display = '';
  await refreshUserCredits();
  updateRunButton();
});

resultCard.style.display = '';
updateSourceType('document');
updateRunButton();
