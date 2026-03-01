        const firebaseConfig = {
            apiKey: "AIzaSyBAAeEUCPNvP5qnqpP3M6HnFZ6vaaijUvM",
            authDomain: "lecture-processor-cdff6.firebaseapp.com",
            projectId: "lecture-processor-cdff6",
            storageBucket: "lecture-processor-cdff6.firebasestorage.app",
            messagingSenderId: "374793454161",
            appId: "1:374793454161:web:c68b21590e9a1fafa32e70"
        };
        firebase.initializeApp(firebaseConfig);
        const auth = firebase.auth();
        const authUtils = window.LectureProcessorAuth || {};
        const authClient = authUtils.createAuthClient ? authUtils.createAuthClient(auth, { notSignedInMessage: 'Not signed in' }) : null;
        const downloadUtils = window.LectureProcessorDownload || {};

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

        let currentWindow = '7d';
        let currentModeView = 'total';
        let latestModeBreakdown = {};

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
            const dt = new Date(timestampSeconds * 1000);
            return dt.toLocaleString('en-GB', {
                day: '2-digit', month: 'short', year: 'numeric',
                hour: '2-digit', minute: '2-digit'
            });
        }

        function formatRateLimitLabel(limitName) {
            const key = String(limitName || '').trim().toLowerCase();
            if (key === 'upload') return 'Upload';
            if (key === 'checkout') return 'Checkout';
            if (key === 'analytics') return 'Analytics';
            return 'Other';
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
            rows.forEach((row) => tbody.appendChild(row));
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
                const tdStatus = document.createElement('td');
                const statusBadge = document.createElement('span');
                statusBadge.className = `status ${statusClass}`;
                statusBadge.textContent = status;
                tdStatus.appendChild(statusBadge);
                const tdDuration = document.createElement('td');
                tdDuration.textContent = `${job.duration_seconds || 0}s`;
                const tdRefund = document.createElement('td');
                tdRefund.textContent = job.credit_refunded ? 'Yes' : 'No';
                tr.appendChild(tdTime);
                tr.appendChild(tdEmail);
                tr.appendChild(tdMode);
                tr.appendChild(tdStatus);
                tr.appendChild(tdDuration);
                tr.appendChild(tdRefund);
                return tr;
            });
            renderRows('jobs-body', jobRows, 'No jobs found in selected window.', 6);

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

            const rateLimitRows = (data.recent_rate_limits || []).map((entry) => `
                <tr>
                    <td>${formatDate(entry.created_at)}</td>
                    <td>${formatRateLimitLabel(entry.limit_name)}</td>
                    <td>${entry.retry_after_seconds || 0}s</td>
                </tr>
            `);
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
                    try { authClient.setToken(await user.getIdToken()); } catch (_) {}
                }
                signedInMeta.textContent = `Signed in as ${user.email}`;
                authBtn.textContent = 'Sign out';
                await loadAdminOverview(user);
            } else {
                if (authClient && typeof authClient.clearToken === 'function') authClient.clearToken();
                signedInMeta.textContent = 'Not signed in';
                authBtn.textContent = 'Sign in';
                setState('Please sign in with your admin account.', 'blocked');
            }
        });

        authBtn.addEventListener('click', async () => {
            if (auth.currentUser) {
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
            await loadAdminOverview(auth.currentUser);
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

        setActiveFilterButton();
        setActiveModeViewButton();
