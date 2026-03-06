const bootstrap = window.LectureProcessorBootstrap || {};
const auth = bootstrap.getAuth ? bootstrap.getAuth() : firebase.auth();
const authUtils = window.LectureProcessorAuth || {};
const authClient = authUtils.createAuthClient ? authUtils.createAuthClient(auth, { notSignedInMessage: 'Not signed in' }) : null;
const downloadUtils = window.LectureProcessorDownload || {};
const uxUtils = window.LectureProcessorUx || {};

const signedInMeta = document.getElementById('signed-in-meta');
const stateArea = document.getElementById('state-area');
const dashboard = document.getElementById('dashboard');
const authBtn = document.getElementById('auth-btn');
const refreshBtn = document.getElementById('refresh-btn');
const backBtn = document.getElementById('back-btn');
const exportJobsBtn = document.getElementById('export-jobs-btn');
const exportPurchasesBtn = document.getElementById('export-purchases-btn');
const exportFunnelBtn = document.getElementById('export-funnel-btn');
const exportFunnelDailyBtn = document.getElementById('export-funnel-daily-btn');
const adminTabButtons = Array.from(document.querySelectorAll('[data-admin-tab]'));
const adminOverviewContent = document.getElementById('admin-tab-overview-content');
const adminBatchContent = document.getElementById('admin-tab-batch-content');
const adminBatchRefreshBtn = document.getElementById('admin-batch-refresh-btn');
const adminBatchMode = document.getElementById('admin-batch-mode');
const adminBatchStatus = document.getElementById('admin-batch-status');
const adminBatchJobsBody = document.getElementById('admin-batch-jobs-body');

let currentWindow = '7d';
let currentModeView = 'total';
let latestModeBreakdown = {};
let activeAdminTab = 'overview';
let adminToastTimer = null;

const adminToast = document.createElement('div');
adminToast.className = 'admin-toast';
document.body.appendChild(adminToast);

function authFetch(path, options) {
    if (authClient && typeof authClient.authFetch === 'function') {
        return authClient.authFetch(path, options, { retryOn401: true });
    }
    if (!auth.currentUser) {
        return Promise.reject(new Error('Not signed in'));
    }
    return auth.currentUser.getIdToken().then((token) => {
        const opts = options || {};
        const headers = Object.assign({}, opts.headers || {}, { 'Authorization': `Bearer ${token}` });
        return fetch(path, Object.assign({}, opts, { headers }));
    });
}

function formatMoney(cents) {
    return `€${((cents || 0) / 100).toFixed(2)}`;
}

function formatDate(timestampSeconds) {
    if (!timestampSeconds) return '-';
    if (uxUtils.formatDateTime) {
        return uxUtils.formatDateTime(timestampSeconds, { unit: 'seconds' });
    }
    const dt = new Date(timestampSeconds * 1000);
    return dt.toLocaleString(navigator.language || 'en-US', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
}

function formatRateLimitLabel(limitName) {
    const labels = {
        'upload': 'Upload',
        'checkout': 'Checkout',
        'analytics': 'Analytics',
        'tools': 'Tools',
    };
    return labels[limitName] || limitName;
}

function formatTokenCount(count) {
    if (!count || count === 0) return '-';
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
    if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
    return String(count);
}

function showAdminToast(message, type) {
    if (!message) return;
    adminToast.textContent = String(message);
    adminToast.classList.remove('success', 'error', 'visible');
    if (type === 'success') adminToast.classList.add('success');
    if (type === 'error') adminToast.classList.add('error');
    adminToast.classList.add('visible');
    if (adminToastTimer) window.clearTimeout(adminToastTimer);
    adminToastTimer = window.setTimeout(() => {
        adminToast.classList.remove('visible');
    }, 2400);
}

function setAdminTab(tabKey) {
    const next = tabKey === 'batch-jobs' ? 'batch-jobs' : 'overview';
    activeAdminTab = next;
    adminTabButtons.forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.adminTab === next);
    });
    if (adminOverviewContent) adminOverviewContent.style.display = next === 'overview' ? '' : 'none';
    if (adminBatchContent) adminBatchContent.style.display = next === 'batch-jobs' ? '' : 'none';
}

function renderAdminBatchJobs(rows) {
    if (!adminBatchJobsBody) return;
    adminBatchJobsBody.innerHTML = '';
    const batches = Array.isArray(rows) ? rows : [];
    if (!batches.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 9;
        td.className = 'empty';
        td.textContent = 'No batch jobs found for this filter.';
        tr.appendChild(td);
        adminBatchJobsBody.appendChild(tr);
        return;
    }
    batches.forEach((batch) => {
        const tr = document.createElement('tr');
        const status = String(batch.status || 'queued');
        const statusClass = status === 'complete' ? 'complete' : (status === 'error' ? 'error' : (status === 'partial' ? 'partial' : (status === 'processing' ? 'processing' : 'queued')));
        const rowSummary = `${Number(batch.completed_rows || 0)}/${Number(batch.total_rows || 0)} complete · ${Number(batch.failed_rows || 0)} failed`;
        const stageSummary = [batch.current_stage || '-', batch.current_stage_state || '-', batch.provider_state || '-'].join(' · ');
        const refundSummary = `${Number(batch.credits_refunded || 0)} refunded · ${Number(batch.credits_refund_pending || 0)} pending`;
        tr.innerHTML = `
            <td>${formatDate(batch.created_at)}</td>
            <td>${(batch.email || '').slice(0, 64) || '-'}</td>
            <td>${batch.batch_title || batch.batch_id || '-'}</td>
            <td>${batch.mode || '-'}</td>
            <td><span class="status ${statusClass}">${status}</span></td>
            <td>${stageSummary}</td>
            <td>${rowSummary}</td>
            <td>${batch.completion_email_status || 'pending'}</td>
            <td>${refundSummary}</td>
        `;
        adminBatchJobsBody.appendChild(tr);
    });
}

async function loadAdminBatchJobs(showToastOnSuccess = false) {
    if (!auth.currentUser) {
        renderAdminBatchJobs([]);
        return;
    }
    const params = new URLSearchParams();
    params.set('limit', '300');
    if (adminBatchMode && adminBatchMode.value) params.set('mode', adminBatchMode.value);
    if (adminBatchStatus && adminBatchStatus.value) params.set('status', adminBatchStatus.value);
    try {
        const res = await authFetch(`/api/admin/batch-jobs?${params.toString()}`);
        if (!res.ok) {
            const payload = await res.json().catch(() => ({}));
            throw new Error(payload.error || 'Could not load batch jobs.');
        }
        const payload = await res.json();
        renderAdminBatchJobs(payload.batches || []);
        if (showToastOnSuccess) {
            showAdminToast('Batch jobs refreshed.', 'success');
        }
    } catch (error) {
        console.error(error);
        showAdminToast(error.message || 'Could not load batch jobs.', 'error');
    }
}

function formatPromptSummary(job) {
    const templateKey = String(job.prompt_template_key || '').trim();
    const customPrompt = String(job.custom_prompt || '').trim();
    const source = String(job.prompt_source || '').trim();
    const parts = [];
    if (templateKey) {
        parts.push(`Template: ${templateKey}`);
    } else if (source === 'default') {
        parts.push('Default prompt');
    }
    if (customPrompt) {
        const compact = customPrompt.replace(/\s+/g, ' ').trim();
        parts.push(compact.length > 90 ? `${compact.slice(0, 87)}...` : compact);
    }
    return parts.join(' · ') || 'Default prompt';
}

function setState(message, type = 'loading') {
    stateArea.textContent = message;
    stateArea.className = type;
    stateArea.style.display = 'block';
    dashboard.style.display = 'none';
}

function clearChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
}

function renderRows(tbodyId, rows, emptyText, colspan = 8) {
    const tbody = document.getElementById(tbodyId);
    clearChildren(tbody);
    if (!rows.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = colspan;
        td.className = 'empty';
        td.textContent = emptyText;
        tr.appendChild(td);
        tbody.appendChild(tr);
        return;
    }
    rows.forEach((row) => {
        if (!(row instanceof Node)) {
            console.warn('renderRows skipped non-Node row for', tbodyId, row);
            return;
        }
        tbody.appendChild(row);
    });
}

function renderBars(containerId, labels, values, type) {
    const container = document.getElementById(containerId);
    clearChildren(container);
    if (!labels.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No data for selected window.';
        container.appendChild(empty);
        return;
    }
    const maxValue = Math.max(...values, 1);
    labels.forEach((label, idx) => {
        const value = values[idx] || 0;
        const heightPercent = (value / maxValue) * 100;
        const col = document.createElement('div');
        col.className = 'bar-col';
        col.title = `${label}: ${type === 'success' ? value + '%' : formatMoney(value)}`;
        const bar = document.createElement('div');
        bar.className = `bar ${type}`;
        bar.style.height = `${Math.max(heightPercent, 1)}%`;
        const labelEl = document.createElement('div');
        labelEl.className = 'bar-label';
        labelEl.textContent = label;
        col.appendChild(bar);
        if (labels.length <= 12 || idx % Math.ceil(labels.length / 10) === 0 || idx === labels.length - 1) {
            col.appendChild(labelEl);
        }
        container.appendChild(col);
    });
}

function renderModeBreakdown() {
    const container = document.getElementById('mode-breakdown-bars');
    clearChildren(container);
    const entries = Object.values(latestModeBreakdown || {}).filter((item) => item && item.label);
    if (!entries.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No mode data for selected window.';
        container.appendChild(empty);
        return;
    }
    const maxValue = Math.max(...entries.map((entry) => entry[currentModeView] || 0), 1);
    entries.forEach((entry) => {
        const value = entry[currentModeView] || 0;
        const width = Math.max((value / maxValue) * 100, value > 0 ? 2 : 0);
        const row = document.createElement('div');
        row.className = 'mode-row';
        const label = document.createElement('div');
        label.className = 'mode-label';
        label.textContent = String(entry.label || '-');
        const track = document.createElement('div');
        track.className = 'mode-track';
        const fill = document.createElement('div');
        fill.className = 'mode-fill';
        fill.style.width = `${width}%`;
        track.appendChild(fill);
        const valueEl = document.createElement('div');
        valueEl.className = 'mode-value';
        valueEl.textContent = String(value);
        row.appendChild(label);
        row.appendChild(track);
        row.appendChild(valueEl);
        container.appendChild(row);
    });
}

function renderFunnel(funnel) {
    const list = document.getElementById('funnel-list');
    const meta = document.getElementById('funnel-meta');
    const steps = (funnel && Array.isArray(funnel.steps)) ? funnel.steps : [];
    clearChildren(list);
    if (!steps.length) {
        meta.textContent = 'No funnel events captured in the selected window.';
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No conversion data yet.';
        list.appendChild(empty);
        return;
    }
    meta.textContent = 'Counts are unique users/sessions that reached each stage.';
    const maxCount = Math.max(...steps.map((step) => Number(step.count || 0)), 1);
    steps.forEach((step, idx) => {
        const count = Number(step.count || 0);
        const width = Math.max((count / maxCount) * 100, count > 0 ? 2 : 0);
        const conversion = Number(step.conversion_from_prev || 0);
        const conversionLabel = idx === 0 ? 'Start' : `${conversion}% from previous`;
        const row = document.createElement('div');
        row.className = 'funnel-row';
        const label = document.createElement('div');
        label.className = 'funnel-label';
        label.textContent = String(step.label || step.event || '-');
        const track = document.createElement('div');
        track.className = 'funnel-track';
        const fill = document.createElement('div');
        fill.className = 'funnel-fill';
        fill.style.width = `${width}%`;
        track.appendChild(fill);
        const countEl = document.createElement('div');
        countEl.className = 'funnel-count';
        countEl.textContent = String(count);
        const conversionEl = document.createElement('div');
        conversionEl.className = 'funnel-conversion';
        conversionEl.textContent = conversionLabel;
        row.appendChild(label);
        row.appendChild(track);
        row.appendChild(countEl);
        row.appendChild(conversionEl);
        list.appendChild(row);
    });
}

function renderDashboard(data) {
    const m = data.metrics || {};
    const t = data.trends || {};
    const successRate = m.job_count > 0 ? Math.round((m.success_jobs / m.job_count) * 100) : 0;

    document.getElementById('m-users').textContent = m.total_users || 0;
    document.getElementById('m-users-sub').textContent = `${m.new_users || 0} new in window`;
    document.getElementById('m-jobs').textContent = m.job_count || 0;
    document.getElementById('m-success-rate').textContent = `${successRate}%`;
    document.getElementById('m-revenue').textContent = formatMoney(m.total_revenue_cents || 0);
    document.getElementById('m-purchases').textContent = m.purchase_count || 0;
    document.getElementById('m-processed').textContent = m.total_processed || 0;
    document.getElementById('m-refunds').textContent = m.refunded_jobs || 0;
    document.getElementById('m-duration').textContent = `${m.avg_duration_seconds || 0}s`;
    document.getElementById('m-success-jobs').textContent = m.success_jobs || 0;
    document.getElementById('m-failed-jobs').textContent = m.failed_jobs || 0;
    document.getElementById('m-rate-limit-total').textContent = m.rate_limit_429_total || 0;
    document.getElementById('m-rate-limit-sub').textContent = `U: ${m.rate_limit_upload_429 || 0} · C: ${m.rate_limit_checkout_429 || 0} · A: ${m.rate_limit_analytics_429 || 0}`;

    const labels = t.labels || [];
    const successTrend = t.success_rate || [];
    const revenueTrend = t.revenue_cents || [];
    latestModeBreakdown = data.mode_breakdown || {};

    renderBars('success-chart', labels, successTrend, 'success');
    renderBars('revenue-chart', labels, revenueTrend, 'revenue');
    renderModeBreakdown();
    renderFunnel(data.funnel || {});

    document.getElementById('success-granularity').textContent = `Granularity: ${t.granularity || 'day'}`;
    document.getElementById('revenue-granularity').textContent = `Granularity: ${t.granularity || 'day'}`;
    document.getElementById('success-latest').textContent = `Latest: ${successTrend.length ? successTrend[successTrend.length - 1] : 0}%`;
    const revenueTotal = revenueTrend.reduce((acc, value) => acc + (value || 0), 0);
    document.getElementById('revenue-total').textContent = `Window total: ${formatMoney(revenueTotal)}`;

    const jobRows = (data.recent_jobs || []).map((job) => {
        const status = job.status || 'unknown';
        const statusClass = status === 'complete' ? 'complete' : (status === 'error' ? 'error' : 'other');
        const tr = document.createElement('tr');
        const tdTime = document.createElement('td');
        tdTime.textContent = formatDate(job.finished_at);
        const tdEmail = document.createElement('td');
        tdEmail.textContent = (job.email || '').slice(0, 32) || '-';
        const tdMode = document.createElement('td');
        tdMode.textContent = job.mode || '-';
        const tdPrompt = document.createElement('td');
        tdPrompt.className = 'prompt-cell';
        tdPrompt.textContent = formatPromptSummary(job);
        const tdStatus = document.createElement('td');
        const statusBadge = document.createElement('span');
        statusBadge.className = `status ${statusClass}`;
        statusBadge.textContent = status;
        tdStatus.appendChild(statusBadge);
        const tdDuration = document.createElement('td');
        tdDuration.textContent = `${job.duration_seconds || 0}s`;
        const tdRefund = document.createElement('td');
        tdRefund.textContent = job.credit_refunded ? 'Yes' : 'No';
        const tdTokenIn = document.createElement('td');
        tdTokenIn.textContent = formatTokenCount(job.token_input_total);
        const tdTokenOut = document.createElement('td');
        tdTokenOut.textContent = formatTokenCount(job.token_output_total);
        const tdTokenTotal = document.createElement('td');
        tdTokenTotal.textContent = formatTokenCount(job.token_total);
        tr.appendChild(tdTime);
        tr.appendChild(tdEmail);
        tr.appendChild(tdMode);
        tr.appendChild(tdPrompt);
        tr.appendChild(tdStatus);
        tr.appendChild(tdDuration);
        tr.appendChild(tdRefund);
        tr.appendChild(tdTokenIn);
        tr.appendChild(tdTokenOut);
        tr.appendChild(tdTokenTotal);
        return tr;
    });
    renderRows('jobs-body', jobRows, 'No jobs found in selected window.', 10);

    const purchaseRows = (data.recent_purchases || []).map((purchase) => {
        const tr = document.createElement('tr');
        const tdTime = document.createElement('td');
        tdTime.textContent = formatDate(purchase.created_at);
        const tdBundle = document.createElement('td');
        tdBundle.textContent = purchase.bundle_name || '-';
        const tdAmount = document.createElement('td');
        tdAmount.textContent = formatMoney(purchase.price_cents || 0);
        tr.appendChild(tdTime);
        tr.appendChild(tdBundle);
        tr.appendChild(tdAmount);
        return tr;
    });
    renderRows('purchases-body', purchaseRows, 'No purchases found in selected window.', 3);

    const rateLimitRows = (data.recent_rate_limits || []).map((entry) => {
        const tr = document.createElement('tr');
        const tdTime = document.createElement('td');
        tdTime.textContent = formatDate(entry.created_at);
        const tdLimiter = document.createElement('td');
        tdLimiter.textContent = formatRateLimitLabel(entry.limit_name);
        const tdRetry = document.createElement('td');
        tdRetry.textContent = `${entry.retry_after_seconds || 0}s`;
        tr.appendChild(tdTime);
        tr.appendChild(tdLimiter);
        tr.appendChild(tdRetry);
        return tr;
    });
    renderRows('rate-limit-body', rateLimitRows, 'No rate-limit hits found in selected window.', 3);

    stateArea.style.display = 'none';
    dashboard.style.display = 'block';
}

async function loadAdminOverview(user) {
    if (!user) {
        setState('Please sign in to continue.', 'blocked');
        return;
    }
    setState('Loading admin dashboard...', 'loading');
    try {
        const res = await authFetch(`/api/admin/overview?window=${encodeURIComponent(currentWindow)}`);

        if (res.status === 403) {
            setState('Your account is signed in but not configured as admin. Set ADMIN_EMAILS or ADMIN_UIDS on the server.', 'blocked');
            return;
        }
        if (!res.ok) {
            setState('Could not load dashboard data. Please refresh.', 'error');
            return;
        }

        const data = await res.json();
        renderDashboard(data);
    } catch (error) {
        console.error(error);
        setState('Network error while loading dashboard.', 'error');
    }
}

async function exportCsv(type) {
    if (!auth.currentUser) {
        setState('Please sign in to export CSV.', 'blocked');
        return;
    }
    try {
        const res = await authFetch(`/api/admin/export?type=${encodeURIComponent(type)}&window=${encodeURIComponent(currentWindow)}`);
        if (!res.ok) {
            setState('Could not export CSV right now.', 'error');
            return;
        }
        if (downloadUtils.downloadResponseBlob) {
            await downloadUtils.downloadResponseBlob(res, `admin-${type}-${currentWindow}.csv`);
            return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `admin-${type}-${currentWindow}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (error) {
        console.error(error);
        setState('Network error while exporting CSV.', 'error');
    }
}

function setActiveFilterButton() {
    document.querySelectorAll('.filter').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.window === currentWindow);
    });
}

function setActiveModeViewButton() {
    document.querySelectorAll('.mode-view').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.modeView === currentModeView);
    });
}

auth.onAuthStateChanged(async (user) => {
    if (user) {
        if (authClient && typeof authClient.setToken === 'function') {
            try { authClient.setToken(await user.getIdToken()); } catch (_) { }
        }
        signedInMeta.textContent = `Signed in as ${user.email}`;
        authBtn.textContent = 'Sign out';
        await loadAdminOverview(user);
        await initCostCalculator();
        await runActualCostAnalysis(false);
        await loadAdminBatchJobs(false);
    } else {
        if (authClient && typeof authClient.clearToken === 'function') authClient.clearToken();
        signedInMeta.textContent = 'Not signed in';
        authBtn.textContent = 'Sign in';
        setAdminTab('overview');
        renderAdminBatchJobs([]);
        setState('Please sign in with your admin account.', 'blocked');
    }
});

authBtn.addEventListener('click', async () => {
    if (auth.currentUser) {
        try {
            await fetch('/api/session/logout', { method: 'POST', credentials: 'include' });
        } catch (_) { }
        await auth.signOut();
        return;
    }
    window.location.href = '/';
});

refreshBtn.addEventListener('click', async () => {
    if (!auth.currentUser) {
        setState('Please sign in to refresh.', 'blocked');
        return;
    }
    if (activeAdminTab === 'batch-jobs') {
        await loadAdminBatchJobs(true);
        return;
    }
    await loadAdminOverview(auth.currentUser);
    await initCostCalculator();
    await runActualCostAnalysis(false);
});

backBtn.addEventListener('click', () => {
    window.location.href = '/';
});

exportJobsBtn.addEventListener('click', async () => {
    await exportCsv('jobs');
});

exportPurchasesBtn.addEventListener('click', async () => {
    await exportCsv('purchases');
});

exportFunnelBtn.addEventListener('click', async () => {
    await exportCsv('funnel');
});

exportFunnelDailyBtn.addEventListener('click', async () => {
    await exportCsv('funnel-daily');
});

document.querySelectorAll('.filter').forEach((btn) => {
    btn.addEventListener('click', async () => {
        currentWindow = btn.dataset.window;
        setActiveFilterButton();
        if (auth.currentUser) {
            await loadAdminOverview(auth.currentUser);
        }
    });
});

document.querySelectorAll('.mode-view').forEach((btn) => {
    btn.addEventListener('click', () => {
        currentModeView = btn.dataset.modeView;
        setActiveModeViewButton();
        renderModeBreakdown();
    });
});

adminTabButtons.forEach((btn) => {
    btn.addEventListener('click', async () => {
        const tabKey = btn.dataset.adminTab || 'overview';
        setAdminTab(tabKey);
        if (tabKey === 'batch-jobs' && auth.currentUser) {
            await loadAdminBatchJobs(false);
        }
    });
});

if (adminBatchRefreshBtn) {
    adminBatchRefreshBtn.addEventListener('click', async () => {
        await loadAdminBatchJobs(true);
    });
}

if (adminBatchMode) {
    adminBatchMode.addEventListener('change', async () => {
        await loadAdminBatchJobs(false);
    });
}

if (adminBatchStatus) {
    adminBatchStatus.addEventListener('change', async () => {
        await loadAdminBatchJobs(false);
    });
}

const loadPromptsBtn = document.getElementById('load-prompts-btn');
const promptsOutput = document.getElementById('prompts-output');
if (loadPromptsBtn && promptsOutput) {
    loadPromptsBtn.addEventListener('click', async () => {
        loadPromptsBtn.disabled = true;
        loadPromptsBtn.textContent = 'Loading…';
        try {
            const res = await authFetch('/api/admin/prompts?format=markdown');
            if (!res.ok) { promptsOutput.textContent = 'Error loading prompts.'; }
            else {
                const data = await res.json();
                promptsOutput.textContent = data.markdown || JSON.stringify(data, null, 2);
            }
            promptsOutput.style.display = 'block';
        } catch (e) {
            promptsOutput.textContent = 'Network error loading prompts.';
            promptsOutput.style.display = 'block';
        }
        loadPromptsBtn.textContent = 'Reload prompts';
        loadPromptsBtn.disabled = false;
    });
}

setActiveFilterButton();
setActiveModeViewButton();
setAdminTab('overview');

/* ── Cost Calculator ── */
const calcScenario = document.getElementById('calc-scenario');
const calcScenarioPicker = document.getElementById('calc-scenario-picker');
const calcScenarioButton = document.getElementById('calc-scenario-button');
const calcScenarioMenu = document.getElementById('calc-scenario-menu');
const calcScenarioLabel = document.getElementById('calc-scenario-label');
const calcBody = document.getElementById('calc-body');
const calcBundlePrice = document.getElementById('calc-bundle-price');
const calcEurUsd = document.getElementById('calc-eur-usd');
const calcPricingVersion = document.getElementById('calc-pricing-version');
const calcRevenueUsd = document.getElementById('calc-revenue-usd');
const calcMargin = document.getElementById('calc-margin');
const calcMarginPct = document.getElementById('calc-margin-pct');
const calcBreakEven = document.getElementById('calc-break-even');
let calculatorConfig = null;
let calculatorBound = false;

function setCalcScenarioMenuVisible(visible) {
    if (!calcScenarioMenu || !calcScenarioButton) return;
    const show = Boolean(visible);
    calcScenarioMenu.classList.toggle('visible', show);
    calcScenarioButton.classList.toggle('open', show);
    calcScenarioButton.setAttribute('aria-expanded', show ? 'true' : 'false');
}

function syncCalcScenarioLabel(value) {
    if (!calcScenarioLabel || !calcScenarioMenu || !calcScenario) return;
    const selectedValue = String(value || calcScenario.value || '');
    let activeText = '';
    Array.from(calcScenario.options || []).forEach((opt) => {
        if (String(opt.value) === selectedValue) {
            activeText = String(opt.textContent || '').trim();
        }
    });
    calcScenarioLabel.textContent = activeText || 'Select scenario';
    calcScenarioMenu.querySelectorAll('.calculator-select-item').forEach((btn) => {
        const isActive = btn.dataset.value === selectedValue;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
}

function rebuildCalcScenarioMenu() {
    if (!calcScenarioMenu || !calcScenario) return;
    clearChildren(calcScenarioMenu);
    Array.from(calcScenario.options || []).forEach((opt) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'calculator-select-item';
        btn.dataset.value = String(opt.value);
        btn.setAttribute('role', 'option');
        btn.textContent = String(opt.textContent || opt.value || '-');
        btn.addEventListener('click', () => {
            calcScenario.value = btn.dataset.value || '';
            syncCalcScenarioLabel(calcScenario.value);
            setCalcScenarioMenuVisible(false);
            loadCalculatorScenario(calcScenario.value);
        });
        calcScenarioMenu.appendChild(btn);
    });
    syncCalcScenarioLabel(calcScenario.value);
}

function numberOrZero(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function formatUsd(value) {
    return `$${numberOrZero(value).toFixed(4)}`;
}

function formatPercent(value) {
    return `${numberOrZero(value).toFixed(1)}%`;
}

function formatEur(value) {
    return `€${numberOrZero(value).toFixed(4)}`;
}

function resolveStageModelId(baseModelId, inputTokens) {
    if (baseModelId === 'gemini-2.5-pro' && Number(inputTokens || 0) > 200000) {
        return 'gemini-2.5-pro-200k';
    }
    return baseModelId;
}

function getCalculatorModels() {
    return (calculatorConfig && calculatorConfig.models && typeof calculatorConfig.models === 'object')
        ? calculatorConfig.models
        : {};
}

function getCalculatorScenarios() {
    return (calculatorConfig && calculatorConfig.scenarios && typeof calculatorConfig.scenarios === 'object')
        ? calculatorConfig.scenarios
        : {};
}

function recalcCalculatorCosts() {
    if (!calcBody) return;
    const models = getCalculatorModels();
    const rows = calcBody.querySelectorAll('tr[data-stage]');
    let totalInputCost = 0;
    let totalOutputCost = 0;
    let totalCost = 0;

    rows.forEach((row) => {
        const baseModel = String(row.dataset.model || '');
        const stageName = String(row.dataset.stage || '');
        const isAudio = row.dataset.audio === 'true';
        const inputTokens = Math.max(0, Math.round(numberOrZero((row.querySelector('.calc-in') || {}).value)));
        const outputTokens = Math.max(0, Math.round(numberOrZero((row.querySelector('.calc-out') || {}).value)));
        const effectiveModel = resolveStageModelId(baseModel, inputTokens);
        const pricing = models[effectiveModel] || models[baseModel] || {};
        const inputTextRate = numberOrZero(pricing.input_text_per_M);
        const inputAudioRate = pricing.input_audio_per_M === null ? NaN : numberOrZero(pricing.input_audio_per_M);
        const outputRate = numberOrZero(pricing.output_per_M);
        const inputRate = isAudio && Number.isFinite(inputAudioRate) ? inputAudioRate : inputTextRate;
        const inputCost = (inputTokens / 1_000_000) * inputRate;
        const outputCost = (outputTokens / 1_000_000) * outputRate;
        const stageCost = inputCost + outputCost;

        const modelCell = row.querySelector('.calc-model-cell');
        if (modelCell) {
            const label = String(pricing.label || baseModel || '-');
            modelCell.innerHTML = `<div>${effectiveModel || baseModel || '-'}</div><div class=\"empty\">${label}</div>`;
        }
        const modalityCell = row.querySelector('.calc-modality');
        if (modalityCell) {
            modalityCell.textContent = isAudio ? 'Audio input' : 'Text / vision input';
        }
        const inCostCell = row.querySelector('.cost-in');
        const outCostCell = row.querySelector('.cost-out');
        const stageCostCell = row.querySelector('.cost-stage');
        if (inCostCell) inCostCell.textContent = formatUsd(inputCost);
        if (outCostCell) outCostCell.textContent = formatUsd(outputCost);
        if (stageCostCell) stageCostCell.textContent = formatUsd(stageCost);

        totalInputCost += inputCost;
        totalOutputCost += outputCost;
        totalCost += stageCost;
        row.dataset.modelEffective = effectiveModel;
        row.dataset.inputTokens = String(inputTokens);
        row.dataset.outputTokens = String(outputTokens);
        row.dataset.stageName = stageName;
    });

    const totalInputEl = document.getElementById('calc-total-input');
    const totalOutputEl = document.getElementById('calc-total-output');
    const totalEl = document.getElementById('calc-total');
    if (totalInputEl) totalInputEl.textContent = formatUsd(totalInputCost);
    if (totalOutputEl) totalOutputEl.textContent = formatUsd(totalOutputCost);
    if (totalEl) totalEl.textContent = formatUsd(totalCost);

    const bundleEur = Math.max(0, numberOrZero(calcBundlePrice ? calcBundlePrice.value : 0));
    const eurUsdRate = Math.max(0.1, numberOrZero(calcEurUsd ? calcEurUsd.value : 1.08));
    const revenueUsd = bundleEur * eurUsdRate;
    const marginValue = revenueUsd - totalCost;
    const marginPercent = revenueUsd > 0 ? (marginValue / revenueUsd) * 100 : 0;
    const breakEvenEur = eurUsdRate > 0 ? (totalCost / eurUsdRate) : 0;

    if (calcRevenueUsd) calcRevenueUsd.textContent = formatUsd(revenueUsd);
    if (calcMargin) {
        calcMargin.textContent = formatUsd(marginValue);
        calcMargin.style.color = marginValue >= 0 ? '#10B981' : '#EF4444';
    }
    if (calcMarginPct) {
        calcMarginPct.textContent = formatPercent(marginPercent);
        calcMarginPct.style.color = marginPercent >= 0 ? '#10B981' : '#EF4444';
    }
    if (calcBreakEven) calcBreakEven.textContent = formatEur(breakEvenEur);
}

function loadCalculatorScenario(scenarioKey) {
    const scenarios = getCalculatorScenarios();
    const scenario = scenarios[scenarioKey];
    if (!scenario || !Array.isArray(scenario.stages) || !calcBody) return;
    clearChildren(calcBody);
    scenario.stages.forEach((stage) => {
        const tr = document.createElement('tr');
        tr.dataset.stage = String(stage.stage || '');
        tr.dataset.model = String(stage.model || '');
        tr.dataset.audio = String(Boolean(stage.audio));
        tr.innerHTML = `
            <td>${String(stage.stage || '-')}</td>
            <td class=\"calc-model-cell\">${String(stage.model || '-')}</td>
            <td class=\"calc-modality\">-</td>
            <td><input class=\"calc-in calculator-input\" type=\"number\" min=\"0\" step=\"1000\" value=\"${Math.max(0, Math.round(numberOrZero(stage.input_tokens)))}\"></td>
            <td><input class=\"calc-out calculator-input\" type=\"number\" min=\"0\" step=\"1000\" value=\"${Math.max(0, Math.round(numberOrZero(stage.output_tokens)))}\"></td>
            <td class=\"cost-in\">$0.0000</td>
            <td class=\"cost-out\">$0.0000</td>
            <td class=\"cost-stage\">$0.0000</td>
        `;
        calcBody.appendChild(tr);
    });
    calcBody.querySelectorAll('input').forEach((input) => {
        input.addEventListener('input', recalcCalculatorCosts);
    });
    recalcCalculatorCosts();
}

async function initCostCalculator() {
    if (!calcScenario || !calcBody) return;
    try {
        const response = await authFetch('/api/admin/model-pricing');
        if (!response.ok) return;
        const payload = await response.json();
        if (!payload || typeof payload !== 'object') return;
        calculatorConfig = payload;
        if (calcPricingVersion) {
            calcPricingVersion.textContent = `Pricing version: ${String(payload.version || '-')}`;
        }
        clearChildren(calcScenario);
        const scenarios = getCalculatorScenarios();
        Object.entries(scenarios).forEach(([key, scenario]) => {
            const opt = document.createElement('option');
            opt.value = key;
            opt.textContent = String((scenario && scenario.label) || key);
            calcScenario.appendChild(opt);
        });

        const firstScenario = calcScenario.options.length ? calcScenario.options[0].value : '';
        if (firstScenario) {
            calcScenario.value = firstScenario;
            rebuildCalcScenarioMenu();
            loadCalculatorScenario(firstScenario);
        } else {
            rebuildCalcScenarioMenu();
        }
        if (!calculatorBound) {
            calcScenario.addEventListener('change', () => {
                syncCalcScenarioLabel(calcScenario.value);
                loadCalculatorScenario(calcScenario.value);
            });
            if (calcScenarioButton && calcScenarioMenu) {
                calcScenarioButton.addEventListener('click', (event) => {
                    event.preventDefault();
                    const nextVisible = !calcScenarioMenu.classList.contains('visible');
                    setCalcScenarioMenuVisible(nextVisible);
                });
                calcScenarioButton.addEventListener('keydown', (event) => {
                    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setCalcScenarioMenuVisible(true);
                        const first = calcScenarioMenu.querySelector('.calculator-select-item');
                        if (first) first.focus();
                    }
                });
                calcScenarioMenu.addEventListener('keydown', (event) => {
                    const items = Array.from(calcScenarioMenu.querySelectorAll('.calculator-select-item'));
                    if (!items.length) return;
                    const currentIndex = items.indexOf(document.activeElement);
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        setCalcScenarioMenuVisible(false);
                        calcScenarioButton.focus();
                        return;
                    }
                    if (event.key === 'ArrowDown') {
                        event.preventDefault();
                        const next = items[(currentIndex + 1 + items.length) % items.length];
                        if (next) next.focus();
                        return;
                    }
                    if (event.key === 'ArrowUp') {
                        event.preventDefault();
                        const prev = items[(currentIndex - 1 + items.length) % items.length];
                        if (prev) prev.focus();
                    }
                });
                document.addEventListener('click', (event) => {
                    if (calcScenarioPicker && !calcScenarioPicker.contains(event.target)) {
                        setCalcScenarioMenuVisible(false);
                    }
                });
            }
            if (calcBundlePrice) calcBundlePrice.addEventListener('input', recalcCalculatorCosts);
            if (calcEurUsd) calcEurUsd.addEventListener('input', recalcCalculatorCosts);
            calculatorBound = true;
        }
    } catch (error) {
        console.error('Could not initialize cost calculator:', error);
    }
}

/* ── Actual Cost Analyzer ── */
const analyzerRunBtn = document.getElementById('analyzer-run-btn');
const analyzerExportBtn = document.getElementById('analyzer-export-btn');
const analyzerSelectAllBtn = document.getElementById('analyzer-select-all-btn');
const analyzerClearBtn = document.getElementById('analyzer-clear-btn');
const analyzerPeriod = document.getElementById('analyzer-period');
const analyzerUid = document.getElementById('analyzer-uid');
const analyzerEmail = document.getElementById('analyzer-email');
const analyzerMode = document.getElementById('analyzer-mode');
const analyzerStatus = document.getElementById('analyzer-status');
const analyzerUsdEur = document.getElementById('analyzer-usd-eur');
const analyzerJobsBody = document.getElementById('analyzer-jobs-body');
const analyzerSelectionMeta = document.getElementById('analyzer-selection-meta');
const analyzerJobsSelected = document.getElementById('analyzer-jobs-selected');
const analyzerInputTotal = document.getElementById('analyzer-input-total');
const analyzerOutputTotal = document.getElementById('analyzer-output-total');
const analyzerTokenTotal = document.getElementById('analyzer-token-total');
const analyzerCostUsd = document.getElementById('analyzer-cost-usd');
const analyzerCostEur = document.getElementById('analyzer-cost-eur');

let analyzerPayload = null;
let analyzerSelectedIds = new Set();

function analyzerFiltersPayload() {
    return {
        period: analyzerPeriod ? String(analyzerPeriod.value || 'monthly') : 'monthly',
        uid: analyzerUid ? String(analyzerUid.value || '').trim() : '',
        email: analyzerEmail ? String(analyzerEmail.value || '').trim() : '',
        mode: analyzerMode ? String(analyzerMode.value || '').trim() : '',
        status: analyzerStatus ? String(analyzerStatus.value || '').trim() : '',
        usd_to_eur: analyzerUsdEur ? Number(analyzerUsdEur.value || 0.93) : 0.93,
        selection: 'all',
    };
}

function formatInteger(value) {
    const num = Number(value || 0);
    if (!Number.isFinite(num)) return '0';
    return Math.round(num).toLocaleString();
}

function recomputeAnalyzerSummary() {
    const payload = analyzerPayload || {};
    const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
    let selectedRows = jobs;
    if (analyzerSelectedIds.size > 0) {
        selectedRows = jobs.filter((job) => analyzerSelectedIds.has(String(job.job_id || '')));
    }
    const totals = selectedRows.reduce((acc, job) => {
        acc.input += Number(job.token_input_total || 0);
        acc.output += Number(job.token_output_total || 0);
        acc.total += Number(job.token_total || 0);
        acc.usd += Number(job.cost_usd || 0);
        acc.eur += Number(job.cost_eur || 0);
        return acc;
    }, { input: 0, output: 0, total: 0, usd: 0, eur: 0 });

    if (analyzerJobsSelected) analyzerJobsSelected.textContent = String(selectedRows.length);
    if (analyzerInputTotal) analyzerInputTotal.textContent = formatInteger(totals.input);
    if (analyzerOutputTotal) analyzerOutputTotal.textContent = formatInteger(totals.output);
    if (analyzerTokenTotal) analyzerTokenTotal.textContent = formatInteger(totals.total);
    if (analyzerCostUsd) analyzerCostUsd.textContent = formatUsd(totals.usd);
    if (analyzerCostEur) analyzerCostEur.textContent = formatEur(totals.eur);
    if (analyzerSelectionMeta) {
        const scopeLabel = analyzerSelectedIds.size > 0 ? 'selected manually' : 'all filtered jobs';
        analyzerSelectionMeta.textContent = `${selectedRows.length} selected (${scopeLabel})`;
    }
}

function renderActualCostJobs() {
    if (!analyzerJobsBody) return;
    clearChildren(analyzerJobsBody);
    const payload = analyzerPayload || {};
    const rows = Array.isArray(payload.jobs) ? payload.jobs : [];
    if (!rows.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 11;
        td.className = 'empty';
        td.textContent = 'No jobs found for the selected filters.';
        tr.appendChild(td);
        analyzerJobsBody.appendChild(tr);
        recomputeAnalyzerSummary();
        return;
    }

    rows.forEach((job) => {
        const jobId = String(job.job_id || '');
        const tr = document.createElement('tr');
        const selectTd = document.createElement('td');
        selectTd.className = 'analyzer-checkbox-cell';
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = analyzerSelectedIds.has(jobId);
        check.addEventListener('change', () => {
            if (check.checked) analyzerSelectedIds.add(jobId);
            else analyzerSelectedIds.delete(jobId);
            recomputeAnalyzerSummary();
        });
        selectTd.appendChild(check);

        const idTd = document.createElement('td');
        idTd.className = 'analyzer-job-id';
        idTd.title = jobId;
        idTd.textContent = jobId || '-';
        const userTd = document.createElement('td');
        userTd.textContent = String(job.email || job.uid || '-');
        const modeTd = document.createElement('td');
        modeTd.textContent = String(job.mode || '-');
        const statusTd = document.createElement('td');
        statusTd.textContent = String(job.status || '-');
        const finishedTd = document.createElement('td');
        finishedTd.textContent = formatDate(Number(job.finished_at || 0));
        const inTd = document.createElement('td');
        inTd.textContent = formatInteger(job.token_input_total || 0);
        const outTd = document.createElement('td');
        outTd.textContent = formatInteger(job.token_output_total || 0);
        const totalTd = document.createElement('td');
        totalTd.textContent = formatInteger(job.token_total || 0);
        const usdTd = document.createElement('td');
        usdTd.textContent = formatUsd(Number(job.cost_usd || 0));
        const eurTd = document.createElement('td');
        eurTd.textContent = formatEur(Number(job.cost_eur || 0));
        tr.appendChild(selectTd);
        tr.appendChild(idTd);
        tr.appendChild(userTd);
        tr.appendChild(modeTd);
        tr.appendChild(statusTd);
        tr.appendChild(finishedTd);
        tr.appendChild(inTd);
        tr.appendChild(outTd);
        tr.appendChild(totalTd);
        tr.appendChild(usdTd);
        tr.appendChild(eurTd);
        analyzerJobsBody.appendChild(tr);
    });

    recomputeAnalyzerSummary();
}

async function runActualCostAnalysis(preserveSelection = true) {
    if (!auth.currentUser || !analyzerRunBtn) return;
    analyzerRunBtn.disabled = true;
    analyzerRunBtn.textContent = 'Running…';
    try {
        const payload = analyzerFiltersPayload();
        const response = await authFetch('/api/admin/cost-analysis', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!response.ok) {
            setState('Could not run cost analysis.', 'error');
            return;
        }
        const data = await response.json();
        if (!preserveSelection) {
            analyzerSelectedIds = new Set();
        } else {
            const available = new Set((Array.isArray(data.jobs) ? data.jobs : []).map((job) => String(job.job_id || '')));
            analyzerSelectedIds = new Set(Array.from(analyzerSelectedIds).filter((jobId) => available.has(jobId)));
        }
        analyzerPayload = data;
        renderActualCostJobs();
    } catch (error) {
        console.error(error);
    } finally {
        analyzerRunBtn.disabled = false;
        analyzerRunBtn.textContent = 'Run analysis';
    }
}

async function exportActualCostAnalysis() {
    if (!auth.currentUser || !analyzerExportBtn) return;
    analyzerExportBtn.disabled = true;
    analyzerExportBtn.textContent = 'Exporting…';
    try {
        const payload = analyzerFiltersPayload();
        payload.job_ids = Array.from(analyzerSelectedIds);
        const response = await authFetch('/api/admin/cost-analysis/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!response.ok) {
            setState('Could not export XLSX right now.', 'error');
            return;
        }
        if (downloadUtils.downloadResponseBlob) {
            await downloadUtils.downloadResponseBlob(response, 'admin-cost-analysis.xlsx');
            return;
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'admin-cost-analysis.xlsx';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    } catch (error) {
        console.error(error);
    } finally {
        analyzerExportBtn.disabled = false;
        analyzerExportBtn.textContent = 'Export XLSX';
    }
}

if (analyzerRunBtn) {
    analyzerRunBtn.addEventListener('click', async () => {
        await runActualCostAnalysis(false);
    });
}
if (analyzerExportBtn) {
    analyzerExportBtn.addEventListener('click', async () => {
        await exportActualCostAnalysis();
    });
}
if (analyzerSelectAllBtn) {
    analyzerSelectAllBtn.addEventListener('click', () => {
        const rows = (analyzerPayload && Array.isArray(analyzerPayload.jobs)) ? analyzerPayload.jobs : [];
        analyzerSelectedIds = new Set(rows.map((job) => String(job.job_id || '')));
        renderActualCostJobs();
    });
}
if (analyzerClearBtn) {
    analyzerClearBtn.addEventListener('click', () => {
        analyzerSelectedIds = new Set();
        renderActualCostJobs();
    });
}
