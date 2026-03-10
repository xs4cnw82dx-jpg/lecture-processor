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

        [
            formatDate(batch.created_at),
            (batch.email || '').slice(0, 64) || '-',
            batch.batch_title || batch.batch_id || '-',
            batch.mode || '-',
        ].forEach((value) => {
            const td = document.createElement('td');
            td.textContent = String(value || '-');
            tr.appendChild(td);
        });

        const statusCell = document.createElement('td');
        const statusBadge = document.createElement('span');
        statusBadge.className = `status ${statusClass}`;
        statusBadge.textContent = status;
        statusCell.appendChild(statusBadge);
        tr.appendChild(statusCell);

        [stageSummary, rowSummary, batch.completion_email_status || 'pending', refundSummary].forEach((value) => {
            const td = document.createElement('td');
            td.textContent = String(value || '-');
            tr.appendChild(td);
        });
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

async function parseAdminErrorResponse(res, fallbackMessage) {
    const payload = await res.json().catch(() => ({}));
    const backendMessage = String(payload.error || payload.message || '').trim();
    if (res.status === 401) {
        return {
            type: 'blocked',
            message: backendMessage || 'Your admin session expired. Please sign in again.',
        };
    }
    if (res.status === 403) {
        return {
            type: 'blocked',
            message: backendMessage || 'Your account is signed in but is not configured as an admin on the server.',
        };
    }
    if (res.status >= 500) {
        return {
            type: 'error',
            message: backendMessage || fallbackMessage || 'The server could not load admin data right now.',
        };
    }
    return {
        type: 'error',
        message: backendMessage || fallbackMessage || 'Request failed.',
    };
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

function renderEmptyChart(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return null;
    clearChildren(container);
    const empty = document.createElement('div');
    empty.className = 'chart-empty';
    empty.textContent = 'No data for selected window.';
    container.appendChild(empty);
    return container;
}

function svgNode(tagName, attrs = {}) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tagName);
    Object.entries(attrs).forEach(([key, value]) => {
        if (value === null || value === undefined) return;
        node.setAttribute(key, String(value));
    });
    return node;
}

function formatStatusValue(value, key = '') {
    if (value === null || value === undefined || value === '') return '-';
    if (key === 'host_matches_render') {
        return value ? 'Matches' : 'Mismatch';
    }
    if (key === 'host_status') {
        const labels = {
            'custom-domain': 'Custom domain',
            'configured-public-host': 'Configured host',
            'render-default': 'Render default',
            'mismatch': 'Mismatch',
            'unknown': 'Unknown',
        };
        return labels[String(value || '')] || String(value);
    }
    if (typeof value === 'boolean') return value ? 'Ready' : 'Not ready';
    if (key === 'app_uptime_seconds') {
        const totalSeconds = Math.max(0, Number(value || 0));
        if (!Number.isFinite(totalSeconds)) return '-';
        if (totalSeconds < 60) return `${Math.round(totalSeconds)}s`;
        if (totalSeconds < 3600) return `${Math.floor(totalSeconds / 60)}m`;
        return `${Math.floor(totalSeconds / 3600)}h ${Math.floor((totalSeconds % 3600) / 60)}m`;
    }
    return String(value);
}

function renderStatusPairs(containerId, rows) {
    const container = document.getElementById(containerId);
    if (!container) return;
    clearChildren(container);
    rows.forEach((entry) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'status-row';
        const dt = document.createElement('dt');
        dt.textContent = entry.label;
        const dd = document.createElement('dd');
        dd.textContent = formatStatusValue(entry.value, entry.key);
        wrapper.appendChild(dt);
        wrapper.appendChild(dd);
        container.appendChild(wrapper);
    });
}

function renderDataWarnings(warnings) {
    const list = document.getElementById('admin-data-warnings');
    const banner = document.getElementById('admin-partial-banner');
    if (!list || !banner) return;
    clearChildren(list);
    const items = Array.isArray(warnings) ? warnings : [];
    banner.hidden = items.length === 0;
    if (!items.length) {
        const li = document.createElement('li');
        li.className = 'ok';
        li.textContent = 'No data warnings in the selected window.';
        list.appendChild(li);
        return;
    }
    items.forEach((warning) => {
        const li = document.createElement('li');
        li.textContent = String(warning || '').replace(/_/g, ' ');
        list.appendChild(li);
    });
}

function tickIndices(length, maxLabels = 6) {
    if (length <= maxLabels) return Array.from({ length }, (_, idx) => idx);
    const step = Math.ceil((length - 1) / (maxLabels - 1));
    const indices = [];
    for (let idx = 0; idx < length; idx += step) indices.push(idx);
    if (indices[indices.length - 1] !== length - 1) indices.push(length - 1);
    return indices;
}

function niceCeiling(value) {
    const numeric = Math.max(0, Number(value || 0));
    if (!numeric) return 100;
    const magnitude = Math.pow(10, Math.max(0, Math.floor(Math.log10(numeric)) - 1));
    return Math.ceil(numeric / magnitude) * magnitude;
}

function renderSuccessChart(containerId, labels, values) {
    const container = document.getElementById(containerId);
    if (!container) return;
    clearChildren(container);
    if (!labels.length) {
        renderEmptyChart(containerId);
        return;
    }
    const width = 720;
    const height = 260;
    const pad = { top: 14, right: 16, bottom: 34, left: 46 };
    const innerWidth = width - pad.left - pad.right;
    const innerHeight = height - pad.top - pad.bottom;
    const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, class: 'admin-chart-svg', role: 'img', 'aria-label': 'Success rate trend chart' });
    const xForIndex = (idx) => (labels.length === 1 ? pad.left + (innerWidth / 2) : pad.left + ((innerWidth / Math.max(labels.length - 1, 1)) * idx));
    const yForValue = (value) => pad.top + innerHeight - ((Math.max(0, Math.min(100, Number(value || 0))) / 100) * innerHeight);

    [0, 25, 50, 75, 100].forEach((tick) => {
        const y = yForValue(tick);
        svg.appendChild(svgNode('line', { x1: pad.left, y1: y, x2: width - pad.right, y2: y, class: 'chart-grid-line' }));
        const label = svgNode('text', { x: pad.left - 8, y: y + 4, class: 'chart-axis-label y' });
        label.textContent = `${tick}%`;
        svg.appendChild(label);
    });

    const shownX = new Set(tickIndices(labels.length, labels.length > 14 ? 5 : 7));
    labels.forEach((label, idx) => {
        if (!shownX.has(idx)) return;
        const x = xForIndex(idx);
        const text = svgNode('text', { x, y: height - 8, class: 'chart-axis-label x' });
        text.textContent = label;
        svg.appendChild(text);
    });

    const points = values.map((value, idx) => [xForIndex(idx), yForValue(value)]);
    const linePath = points.map((point, idx) => `${idx === 0 ? 'M' : 'L'} ${point[0]} ${point[1]}`).join(' ');
    const areaPath = `${linePath} L ${points[points.length - 1][0]} ${pad.top + innerHeight} L ${points[0][0]} ${pad.top + innerHeight} Z`;
    svg.appendChild(svgNode('path', { d: areaPath, fill: 'rgba(16, 185, 129, 0.14)' }));
    svg.appendChild(svgNode('path', { d: linePath, fill: 'none', stroke: '#10B981', 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));

    points.forEach((point, idx) => {
        const circle = svgNode('circle', { cx: point[0], cy: point[1], r: 4, fill: '#ffffff', stroke: '#10B981', 'stroke-width': 2 });
        const title = svgNode('title');
        title.textContent = `${labels[idx]}: ${Number(values[idx] || 0).toFixed(1)}%`;
        circle.appendChild(title);
        svg.appendChild(circle);
    });

    container.appendChild(svg);
}

function renderRevenueChart(containerId, labels, values) {
    const container = document.getElementById(containerId);
    if (!container) return;
    clearChildren(container);
    if (!labels.length) {
        renderEmptyChart(containerId);
        return;
    }
    const width = 720;
    const height = 260;
    const pad = { top: 14, right: 16, bottom: 34, left: 58 };
    const innerWidth = width - pad.left - pad.right;
    const innerHeight = height - pad.top - pad.bottom;
    const maxValue = niceCeiling(Math.max(...values, 0));
    const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, class: 'admin-chart-svg', role: 'img', 'aria-label': 'Revenue trend chart' });
    const stepWidth = innerWidth / Math.max(labels.length, 1);
    const barWidth = Math.max(10, Math.min(34, stepWidth * 0.55));
    const yForValue = (value) => pad.top + innerHeight - ((Math.max(0, Number(value || 0)) / maxValue) * innerHeight);

    for (let tick = 0; tick <= 4; tick += 1) {
        const value = (maxValue / 4) * tick;
        const y = yForValue(value);
        svg.appendChild(svgNode('line', { x1: pad.left, y1: y, x2: width - pad.right, y2: y, class: 'chart-grid-line' }));
        const label = svgNode('text', { x: pad.left - 8, y: y + 4, class: 'chart-axis-label y' });
        label.textContent = formatMoney(Math.round(value));
        svg.appendChild(label);
    }

    const shownX = new Set(tickIndices(labels.length, labels.length > 14 ? 5 : 7));
    labels.forEach((label, idx) => {
        const centerX = pad.left + (stepWidth * idx) + (stepWidth / 2);
        if (shownX.has(idx)) {
            const text = svgNode('text', { x: centerX, y: height - 8, class: 'chart-axis-label x' });
            text.textContent = label;
            svg.appendChild(text);
        }
        const value = Math.max(0, Number(values[idx] || 0));
        const y = yForValue(value);
        const rectHeight = Math.max(0, pad.top + innerHeight - y);
        const rect = svgNode('rect', {
            x: centerX - (barWidth / 2),
            y,
            width: barWidth,
            height: rectHeight,
            rx: 8,
            fill: 'url(#revenueGradient)'
        });
        const title = svgNode('title');
        title.textContent = `${label}: ${formatMoney(value)}`;
        rect.appendChild(title);
        svg.appendChild(rect);
        if (value > 0) {
            const amount = svgNode('text', { x: centerX, y: Math.max(18, y - 6), class: 'chart-column-label' });
            amount.textContent = formatMoney(value);
            svg.appendChild(amount);
        }
    });

    const defs = svgNode('defs');
    const gradient = svgNode('linearGradient', { id: 'revenueGradient', x1: '0', y1: '0', x2: '0', y2: '1' });
    gradient.appendChild(svgNode('stop', { offset: '0%', 'stop-color': '#60A5FA' }));
    gradient.appendChild(svgNode('stop', { offset: '100%', 'stop-color': '#0EA5E9' }));
    defs.appendChild(gradient);
    svg.insertBefore(defs, svg.firstChild);
    container.appendChild(svg);
}

function renderAdminSystemStatus(data) {
    renderDataWarnings(data.data_warnings || []);
    renderStatusPairs('admin-deployment', [
        { key: 'runtime', label: 'Runtime', value: data.deployment && data.deployment.runtime },
        { key: 'request_host', label: 'Request host', value: data.deployment && data.deployment.request_host },
        { key: 'configured_public_hostname', label: 'Public host', value: data.deployment && data.deployment.configured_public_hostname },
        { key: 'render_external_hostname', label: 'Render host', value: data.deployment && data.deployment.render_external_hostname },
        { key: 'host_status', label: 'Host routing', value: data.deployment && data.deployment.host_status },
        { key: 'service_name', label: 'Service', value: data.deployment && data.deployment.service_name },
        { key: 'git_branch', label: 'Git branch', value: data.deployment && data.deployment.git_branch },
        { key: 'git_commit_short', label: 'Git commit', value: data.deployment && data.deployment.git_commit_short },
        { key: 'app_uptime_seconds', label: 'App uptime', value: data.deployment && data.deployment.app_uptime_seconds },
    ]);
    renderStatusPairs('admin-runtime-checks', [
        { key: 'firebase_ready', label: 'Firebase', value: data.runtime_checks && data.runtime_checks.firebase_ready },
        { key: 'gemini_ready', label: 'Gemini', value: data.runtime_checks && data.runtime_checks.gemini_ready },
        { key: 'stripe_secret_mode', label: 'Stripe secret key', value: data.runtime_checks && data.runtime_checks.stripe_secret_mode },
        { key: 'stripe_publishable_mode', label: 'Stripe publishable key', value: data.runtime_checks && data.runtime_checks.stripe_publishable_mode },
        { key: 'stripe_keys_match', label: 'Stripe keys aligned', value: data.runtime_checks && data.runtime_checks.stripe_keys_match },
        { key: 'stripe_webhook_configured', label: 'Stripe webhook', value: data.runtime_checks && data.runtime_checks.stripe_webhook_configured },
        { key: 'pptx_conversion_available', label: 'PPTX conversion', value: data.runtime_checks && data.runtime_checks.pptx_conversion_available },
        { key: 'video_import_available', label: 'LMS video import', value: data.runtime_checks && data.runtime_checks.video_import_available },
        { key: 'ffmpeg_available', label: 'FFmpeg', value: data.runtime_checks && data.runtime_checks.ffmpeg_available },
        { key: 'yt_dlp_available', label: 'yt-dlp', value: data.runtime_checks && data.runtime_checks.yt_dlp_available },
    ]);
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

    renderSuccessChart('success-chart', labels, successTrend);
    renderRevenueChart('revenue-chart', labels, revenueTrend);
    renderAdminSystemStatus(data);
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
        if (!res.ok) {
            const parsed = await parseAdminErrorResponse(res, 'Could not load dashboard data.');
            setState(parsed.message, parsed.type);
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
            const parsed = await parseAdminErrorResponse(res, 'Could not export CSV right now.');
            setState(parsed.message, parsed.type);
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
    window.location.href = '/dashboard';
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
const enhancedAdminSelects = [];

function closeAdminSelectMenus(exceptionMenu) {
    enhancedAdminSelects.forEach((instance) => {
        if (!instance || !instance.menu || instance.menu === exceptionMenu) return;
        instance.setOpen(false);
    });
}

function enhanceAdminSelect(selectEl, onChange) {
    if (!selectEl || selectEl.dataset.enhanced === 'true') return null;
    const parent = selectEl.parentElement;
    if (!parent) return null;
    selectEl.dataset.enhanced = 'true';
    selectEl.classList.add('calculator-native-select');

    const wrapper = document.createElement('div');
    wrapper.className = 'app-select calculator-select calculator-select-upgraded';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'app-select-button calculator-select-button';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');

    const label = document.createElement('span');
    label.className = 'app-select-label';
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '2');
    icon.setAttribute('stroke-linecap', 'round');
    icon.setAttribute('stroke-linejoin', 'round');
    const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    polyline.setAttribute('points', '6 9 12 15 18 9');
    icon.appendChild(polyline);
    button.appendChild(label);
    button.appendChild(icon);

    const menu = document.createElement('div');
    menu.className = 'app-select-menu calculator-select-menu';
    menu.setAttribute('role', 'listbox');
    wrapper.appendChild(button);
    wrapper.appendChild(menu);
    selectEl.insertAdjacentElement('afterend', wrapper);

    function getItems() {
        return Array.from(menu.querySelectorAll('.app-select-item[data-value]')).filter((item) => !item.disabled);
    }

    function focusItem(direction) {
        const items = getItems();
        if (!items.length) return;
        const currentIndex = items.indexOf(document.activeElement);
        const activeIndex = Math.max(0, items.findIndex((item) => item.classList.contains('active')));
        let nextIndex = activeIndex;
        if (direction === 'first') nextIndex = 0;
        if (direction === 'last') nextIndex = items.length - 1;
        if (direction === 'next') nextIndex = currentIndex >= 0 ? (currentIndex + 1) % items.length : activeIndex;
        if (direction === 'prev') nextIndex = currentIndex >= 0 ? (currentIndex - 1 + items.length) % items.length : activeIndex;
        items.forEach((item) => { item.tabIndex = -1; });
        items[nextIndex].tabIndex = 0;
        items[nextIndex].focus();
    }

    function setOpen(open, focusTarget) {
        const shouldOpen = !!open;
        if (shouldOpen) closeAdminSelectMenus(menu);
        menu.classList.toggle('visible', shouldOpen);
        button.classList.toggle('open', shouldOpen);
        button.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
        if (shouldOpen) {
            focusItem(focusTarget || 'first');
        }
    }

    function sync() {
        let activeText = '';
        getItems().forEach((item) => {
            const active = item.dataset.value === String(selectEl.value || '');
            item.classList.toggle('active', active);
            item.setAttribute('aria-selected', active ? 'true' : 'false');
            item.tabIndex = -1;
            if (active) activeText = item.textContent;
        });
        label.textContent = activeText || (selectEl.options[selectEl.selectedIndex] ? selectEl.options[selectEl.selectedIndex].textContent : 'Select');
    }

    function rebuild() {
        clearChildren(menu);
        Array.from(selectEl.options || []).forEach((option) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'app-select-item calculator-select-item';
            item.dataset.value = String(option.value);
            item.textContent = String(option.textContent || option.value || '-');
            item.setAttribute('role', 'option');
            item.disabled = !!option.disabled;
            item.addEventListener('click', () => {
                if (selectEl.value !== option.value) {
                    selectEl.value = option.value;
                    selectEl.dispatchEvent(new Event('change', { bubbles: true }));
                    if (typeof onChange === 'function') onChange(option.value);
                }
                sync();
                setOpen(false);
                button.focus();
            });
            menu.appendChild(item);
        });
        sync();
    }

    button.addEventListener('click', (event) => {
        event.preventDefault();
        setOpen(!menu.classList.contains('visible'));
    });

    button.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true, 'first');
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true, 'last');
        } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setOpen(!menu.classList.contains('visible'));
        } else if (event.key === 'Escape') {
            event.preventDefault();
            setOpen(false);
        }
    });

    menu.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            focusItem('next');
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            focusItem('prev');
        } else if (event.key === 'Home') {
            event.preventDefault();
            focusItem('first');
        } else if (event.key === 'End') {
            event.preventDefault();
            focusItem('last');
        } else if (event.key === 'Escape') {
            event.preventDefault();
            setOpen(false);
            button.focus();
        } else if (event.key === 'Enter' || event.key === ' ') {
            const item = document.activeElement && document.activeElement.closest('.app-select-item[data-value]');
            if (!item) return;
            event.preventDefault();
            item.click();
        }
    });

    selectEl.addEventListener('change', sync);

    const instance = { menu, setOpen, rebuild, sync, button };
    enhancedAdminSelects.push(instance);
    rebuild();
    return instance;
}

document.addEventListener('click', (event) => {
    if (event.target && event.target.closest('.calculator-select-upgraded')) return;
    closeAdminSelectMenus();
});

document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeAdminSelectMenus();
});

const calcScenario = document.getElementById('calc-scenario');
const calcScenarioPicker = document.getElementById('calc-scenario-picker');
const calcScenarioButton = document.getElementById('calc-scenario-button');
const calcScenarioMenu = document.getElementById('calc-scenario-menu');
const calcScenarioLabel = document.getElementById('calc-scenario-label');
const calcStageGrid = document.getElementById('calc-stage-grid');
const calcBundlePrice = document.getElementById('calc-bundle-price');
const calcEurUsd = document.getElementById('calc-eur-usd');
const calcPricingVersion = document.getElementById('calc-pricing-version');
const calcRevenueUsd = document.getElementById('calc-revenue-usd');
const calcMargin = document.getElementById('calc-margin');
const calcMarginPct = document.getElementById('calc-margin-pct');
const calcBreakEven = document.getElementById('calc-break-even');
const calcScenarioHeading = document.getElementById('calc-scenario-heading');
const calcScenarioCopy = document.getElementById('calc-scenario-copy');
const calcScenarioPoints = document.getElementById('calc-scenario-points');
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

function summarizeScenarioUsage(scenario) {
    const stages = Array.isArray(scenario && scenario.stages) ? scenario.stages : [];
    return stages.reduce((acc, stage) => {
        acc.stageCount += 1;
        acc.totalInput += Math.max(0, Math.round(numberOrZero(stage.input_tokens)));
        acc.totalOutput += Math.max(0, Math.round(numberOrZero(stage.output_tokens)));
        if (stage.audio) acc.audioStages += 1;
        return acc;
    }, { stageCount: 0, totalInput: 0, totalOutput: 0, audioStages: 0 });
}

function renderCalculatorStory(scenarioKey) {
    const scenario = getCalculatorScenarios()[scenarioKey] || null;
    const summary = summarizeScenarioUsage(scenario);
    if (calcScenarioHeading) {
        calcScenarioHeading.textContent = scenario && scenario.label ? String(scenario.label) : 'Choose a scenario';
    }
    if (calcScenarioCopy) {
        if (!scenario) {
            calcScenarioCopy.textContent = 'Pick a scenario to see the default token assumptions, stage costs, and bundle margin.';
        } else if (summary.audioStages > 0) {
            calcScenarioCopy.textContent = 'Use this when you want to understand the full lecture or interview pipeline. Audio usually drives the largest portion of the cost.';
        } else {
            calcScenarioCopy.textContent = 'Use this when you want a clean read on slide extraction plus study-tool generation without transcription costs.';
        }
    }
    if (!calcScenarioPoints) return;
    clearChildren(calcScenarioPoints);
    if (!scenario) return;
    [
        summary.stageCount + ' stage' + (summary.stageCount === 1 ? '' : 's') + ' included',
        formatInteger(summary.totalInput) + ' input tokens modeled',
        formatInteger(summary.totalOutput) + ' output tokens modeled',
        summary.audioStages ? (summary.audioStages + ' audio stage' + (summary.audioStages === 1 ? '' : 's')) : 'No audio stage'
    ].forEach((text) => {
        const item = document.createElement('span');
        item.className = 'calculator-story-point';
        item.textContent = text;
        calcScenarioPoints.appendChild(item);
    });
}

function recalcCalculatorCosts() {
    if (!calcStageGrid) return;
    const models = getCalculatorModels();
    const rows = calcStageGrid.querySelectorAll('.calc-stage-card[data-stage]');
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

        const modelCell = row.querySelector('.calc-stage-model');
        if (modelCell) {
            const label = String(pricing.label || baseModel || '-');
            modelCell.innerHTML = `<div class="calc-stage-model-id">${effectiveModel || baseModel || '-'}</div><div class="calc-stage-model-label">${label}</div>`;
        }
        const modalityCell = row.querySelector('.calc-stage-badge');
        if (modalityCell) {
            modalityCell.textContent = isAudio ? 'Audio input' : 'Text / vision';
        }
        const inCostCell = row.querySelector('.cost-in');
        const outCostCell = row.querySelector('.cost-out');
        const stageCostCell = row.querySelector('.cost-stage');
        const shareCell = row.querySelector('.cost-share');
        if (inCostCell) inCostCell.textContent = formatUsd(inputCost);
        if (outCostCell) outCostCell.textContent = formatUsd(outputCost);
        if (stageCostCell) stageCostCell.textContent = formatUsd(stageCost);
        if (shareCell) shareCell.textContent = '0.0%';

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
        calcMargin.style.color = marginValue >= 0 ? '#166534' : '#EF4444';
    }
    if (calcMarginPct) {
        calcMarginPct.textContent = formatPercent(marginPercent);
        calcMarginPct.style.color = marginPercent >= 0 ? '#166534' : '#EF4444';
    }
    if (calcBreakEven) calcBreakEven.textContent = formatEur(breakEvenEur);

    rows.forEach((row) => {
        const stageCostText = row.querySelector('.cost-stage');
        const shareCell = row.querySelector('.cost-share');
        if (!stageCostText || !shareCell) return;
        const numeric = numberOrZero(String(stageCostText.textContent || '').replace(/[^0-9.-]/g, ''));
        shareCell.textContent = totalCost > 0 ? formatPercent((numeric / totalCost) * 100) : '0.0%';
    });
}

function loadCalculatorScenario(scenarioKey) {
    const scenarios = getCalculatorScenarios();
    const scenario = scenarios[scenarioKey];
    if (!scenario || !Array.isArray(scenario.stages) || !calcStageGrid) return;
    clearChildren(calcStageGrid);
    renderCalculatorStory(scenarioKey);
    scenario.stages.forEach((stage) => {
        const card = document.createElement('article');
        card.className = 'calc-stage-card';
        card.dataset.stage = String(stage.stage || '');
        card.dataset.model = String(stage.model || '');
        card.dataset.audio = String(Boolean(stage.audio));
        card.innerHTML = `
            <div class="calc-stage-head">
              <div>
                <div class="calc-stage-name">${String(stage.stage || '-')}</div>
                <div class="calc-stage-model"></div>
              </div>
              <span class="calc-stage-badge">-</span>
            </div>
            <div class="calc-stage-inputs">
              <label class="calc-stage-field">
                <span>Input tokens</span>
                <input class="calc-in calculator-input" type="number" min="0" step="1000" value="${Math.max(0, Math.round(numberOrZero(stage.input_tokens)))}">
              </label>
              <label class="calc-stage-field">
                <span>Output tokens</span>
                <input class="calc-out calculator-input" type="number" min="0" step="1000" value="${Math.max(0, Math.round(numberOrZero(stage.output_tokens)))}">
              </label>
            </div>
            <div class="calc-stage-costs">
              <div class="calc-stage-cost"><span>Input cost</span><strong class="cost-in">$0.0000</strong></div>
              <div class="calc-stage-cost"><span>Output cost</span><strong class="cost-out">$0.0000</strong></div>
              <div class="calc-stage-cost calc-stage-cost-total"><span>Stage cost</span><strong class="cost-stage">$0.0000</strong></div>
              <div class="calc-stage-cost"><span>Share of total</span><strong class="cost-share">0.0%</strong></div>
            </div>
        `;
        calcStageGrid.appendChild(card);
    });
    calcStageGrid.querySelectorAll('input').forEach((input) => {
        input.addEventListener('input', recalcCalculatorCosts);
    });
    recalcCalculatorCosts();
}

async function initCostCalculator() {
    if (!calcScenario || !calcStageGrid) return;
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
            [analyzerPeriod, analyzerMode, analyzerStatus, adminBatchMode, adminBatchStatus].forEach((selectEl) => {
                enhanceAdminSelect(selectEl);
            });
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
const analyzerJobsFiltered = document.getElementById('analyzer-jobs-filtered');
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

    if (analyzerJobsFiltered) analyzerJobsFiltered.textContent = String(jobs.length);
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
            const errorPayload = await response.json().catch(() => ({}));
            throw new Error(errorPayload.error || 'Could not run cost analysis.');
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
        showAdminToast('Cost analysis updated.', 'success');
    } catch (error) {
        console.error(error);
        showAdminToast((error && error.message) || 'Could not run cost analysis.', 'error');
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
            const errorPayload = await response.json().catch(() => ({}));
            throw new Error(errorPayload.error || 'Could not export XLSX right now.');
        }
        if (downloadUtils.downloadResponseBlob) {
            await downloadUtils.downloadResponseBlob(response, 'admin-cost-analysis.xlsx');
            showAdminToast('XLSX export started.', 'success');
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
        showAdminToast('XLSX export started.', 'success');
    } catch (error) {
        console.error(error);
        showAdminToast((error && error.message) || 'Could not export XLSX right now.', 'error');
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
