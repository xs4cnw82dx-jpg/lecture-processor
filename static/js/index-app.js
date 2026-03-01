        const runtimeConfig = window.LectureProcessorRuntime || {};
        const sentryFrontendDsn = runtimeConfig.sentryFrontendDsn || '';
        const sentryEnvironment = runtimeConfig.sentryEnvironment || '';
        const sentryRelease = runtimeConfig.sentryRelease || '';

        if (window.Sentry && sentryFrontendDsn) {
            window.Sentry.init({
                dsn: sentryFrontendDsn,
                environment: sentryEnvironment || 'production',
                release: sentryRelease || undefined,
                tracesSampleRate: 0.0,
            });
        }

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
        const authClient = authUtils.createAuthClient ? authUtils.createAuthClient(auth, { notSignedInMessage: 'Please sign in' }) : null;
        const markdownUtils = window.LectureProcessorMarkdown || {};
        const uxUtils = window.LectureProcessorUx || {};
        const downloadUtils = window.LectureProcessorDownload || {};
        const topbarUtils = window.LectureProcessorTopbar || {};

        let currentUser = null;
        let userCredits = null;
        let idToken = null;
        let currentUserIsAdmin = false;
        let pdfFile = null;
        let audioFile = null;
        let currentJobId = null;
        let pollInterval = null;
        let pollFailures = 0;
        let pollStartedAt = 0;
        let currentMode = 'lecture-notes';
        let resultMarkdown = '';
        let slideText = '';
        let transcript = '';
        let flashcards = [];
        let testQuestions = [];
        let activeResultsTab = 'notes';
        let flashcardIndex = 0;
        let flashcardFlipped = false;
        let quizIndex = 0;
        let quizScore = 0;
        let quizAnswered = false;
        let studyGenerationError = null;
        let currentStudyPackId = null;
        let resultsLocked = false;
        let selectedStudyFeatures = 'both';
        let selectedFlashcardAmount = '20';
        let selectedQuestionAmount = '10';
        let selectedInterviewFeatures = [];
        let importedAudioToken = '';
        let importedAudioSizeBytes = 0;
        let importedAudioName = '';
        let languageOnboardingOpen = false;
        let languageOnboardingSaving = false;
        let userPreferences = null;
        let languagePreferenceSaveTimer = null;
        let suppressLanguagePreferencePersist = false;
        let interviewSummaryText = '';
        let interviewSectionsText = '';
        let interviewCombinedText = '';
        let currentBillingReceipt = null;
        let exportCsvType = 'flashcards';
        let progressSummaryCache = null;
        let userTotalProcessed = 0;
        let trackedTerminalJobId = '';
        const analyticsEndpoint = '/api/lp-event';
        const POLL_BASE_MS = 2000;
        const POLL_MAX_MS = 30000;
        const POLL_MAX_RUNTIME_MS = 30 * 60 * 1000;
        const DOWNLOAD_LABELS = Object.freeze({
            lectureNotes: 'Lecture Notes',
            slideExtract: 'Slide Extract',
            lectureTranscript: 'Lecture Transcript',
            interviewTranscript: 'Interview Transcript',
        });
        const OUTPUT_LANGUAGE_LABELS = Object.freeze({
            dutch: '🇳🇱 Dutch',
            english: '🇬🇧 English',
            spanish: '🇪🇸 Spanish',
            french: '🇫🇷 French',
            german: '🇩🇪 German',
            chinese: '🇨🇳 Chinese',
            other: '🌐 Other',
        });

        function createAnalyticsSessionId() {
            try {
                if (window.crypto && typeof window.crypto.randomUUID === 'function') {
                    return window.crypto.randomUUID().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
                }
            } catch (_) {}
            return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
        }

        const analyticsSessionId = (() => {
            const key = 'lp_analytics_session_id';
            try {
                const existing = localStorage.getItem(key);
                if (existing && /^[A-Za-z0-9_-]{6,80}$/.test(existing)) return existing;
                const created = createAnalyticsSessionId();
                localStorage.setItem(key, created);
                return created;
            } catch (_) {
                return createAnalyticsSessionId();
            }
        })();

        function captureClientError(error, context = '') {
            if (!window.Sentry || !error) return;
            if (context) {
                window.Sentry.withScope((scope) => {
                    scope.setTag('context', context);
                    window.Sentry.captureException(error);
                });
                return;
            }
            window.Sentry.captureException(error);
        }

        function trackEvent(eventName, properties = {}, options = {}) {
            const name = String(eventName || '').trim().toLowerCase();
            if (!name) return Promise.resolve(false);
            const payload = {
                event: name,
                session_id: analyticsSessionId,
                page: 'dashboard',
                path: window.location.pathname,
                properties: Object.assign({}, properties || {}, { mode: currentMode }),
            };
            const body = JSON.stringify(payload);
            if (options.preferBeacon && navigator.sendBeacon) {
                try {
                    const blob = new Blob([body], { type: 'application/json' });
                    return Promise.resolve(navigator.sendBeacon(analyticsEndpoint, blob));
                } catch (_) {}
            }
            const headers = { 'Content-Type': 'application/json' };
            if (idToken) headers.Authorization = `Bearer ${idToken}`;
            return fetch(analyticsEndpoint, {
                method: 'POST',
                headers,
                body,
                keepalive: true,
            }).then((response) => response.ok).catch(() => false);
        }

        const modeConfig = {
            'lecture-notes': {
                description: 'Upload lecture slides (PDF or PPTX) and audio recording to generate complete, integrated study notes.',
                creditCost: 'Uses <strong>1 lecture credit</strong>',
                creditType: 'lecture',
                needsPdf: true,
                needsAudio: true,
                audioTitle: 'Lecture Recording',
                buttonText: 'Process Lecture',
                resultTitle: 'Study Dashboard',
                steps: [{ num: 1, label: 'Extract Slides' }, { num: 2, label: 'Transcribe Audio' }, { num: 3, label: 'Merge Notes' }, { num: 4, label: 'Build Study Tools' }]
            },
            'slides-only': {
                description: 'Upload lecture slides (PDF or PPTX) to run slide extraction and generate clean text notes.',
                creditCost: 'Uses <strong>1 slides credit</strong>',
                creditType: 'slides',
                needsPdf: true,
                needsAudio: false,
                audioTitle: 'Lecture Recording',
                buttonText: 'Extract Slides',
                resultTitle: 'Study Dashboard',
                steps: [{ num: 1, label: 'Extract Text' }, { num: 2, label: 'Build Study Tools' }]
            },
            'interview': {
                description: 'Upload an interview recording to generate a timestamped transcript with speaker identification. Optional extras run through the slide-processing pipeline.',
                creditCost: 'Uses <strong>1 interview credit</strong> (+ <strong>1 slides credit</strong> per selected extra)',
                creditType: 'interview',
                needsPdf: false,
                needsAudio: true,
                audioTitle: 'Interview Recording',
                buttonText: 'Transcribe Interview',
                resultTitle: 'Interview Transcript',
                steps: [{ num: 1, label: 'Transcribe' }]
            }
        };

        const allowedSlideExtensions = ['.pdf', '.pptx'];
        const allowedSlideMimeTypes = [
            'application/pdf',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'application/vnd.ms-powerpoint',
            'application/octet-stream',
            '',
        ];

        const headerSignInBtn = document.getElementById('header-sign-in-btn');
        const headerStudyLibraryBtn = document.getElementById('header-study-library-btn');
        const progressMenu = document.getElementById('progress-menu');
        const progressButton = document.getElementById('progress-button');
        const progressDropdown = document.getElementById('progress-dropdown');
        const progressStreakCount = document.getElementById('progress-streak-count');
        const progressDueCount = document.getElementById('progress-due-count');
        const progressGoalText = document.getElementById('progress-goal-text');
        const progressSetGoalBtn = document.getElementById('progress-set-goal-btn');
        const progressOpenPlanBtn = document.getElementById('progress-open-plan-btn');
        const goalModalOverlay = document.getElementById('goal-modal-overlay');
        const goalModalInput = document.getElementById('goal-modal-input');
        const goalModalError = document.getElementById('goal-modal-error');
        const goalModalCancelBtn = document.getElementById('goal-modal-cancel-btn');
        const goalModalSaveBtn = document.getElementById('goal-modal-save-btn');
        const creditsDisplay = document.getElementById('credits-display');
        const creditsCount = document.getElementById('credits-count');
        const creditsTooltip = document.getElementById('credits-tooltip');
        const userMenu = document.getElementById('user-menu');
        const userButton = document.getElementById('user-button');
        const userDropdown = document.getElementById('user-dropdown');
        const userAvatar = document.getElementById('user-avatar');
        const userName = document.getElementById('user-name');
        const userEmail = document.getElementById('user-email');
        const dropdownLectureCredits = document.getElementById('dropdown-lecture-credits');
        const dropdownSlidesCredits = document.getElementById('dropdown-slides-credits');
        const dropdownInterviewCredits = document.getElementById('dropdown-interview-credits');
        const buyCreditsBtn = document.getElementById('buy-credits-btn');
        const featuresPageBtn = document.getElementById('features-page-btn');
        const plannerPageBtn = document.getElementById('planner-page-btn');
        const purchaseHistoryBtn = document.getElementById('purchase-history-btn');
        const exportDataBtn = document.getElementById('export-data-btn');
        const adminDashboardBtn = document.getElementById('admin-dashboard-btn');
        const deleteAccountBtn = document.getElementById('delete-account-btn');
        const signOutBtn = document.getElementById('sign-out-btn');

        const authOverlay = document.getElementById('auth-overlay');
        const authModalClose = document.getElementById('auth-modal-close');
        const signinView = document.getElementById('signin-view');
        const signupView = document.getElementById('signup-view');
        const resetView = document.getElementById('reset-view');
        const signinForm = document.getElementById('signin-form');
        const signupForm = document.getElementById('signup-form');
        const resetForm = document.getElementById('reset-form');
        const signinEmail = document.getElementById('signin-email');
        const signinPassword = document.getElementById('signin-password');
        const signupEmail = document.getElementById('signup-email');
        const signupPassword = document.getElementById('signup-password');
        const signupPasswordConfirm = document.getElementById('signup-password-confirm');
        const resetEmail = document.getElementById('reset-email');
        const signinError = document.getElementById('signin-error');
        const signupError = document.getElementById('signup-error');
        const resetError = document.getElementById('reset-error');
        const resetSuccess = document.getElementById('reset-success');
        const googleSignInBtn = document.getElementById('google-sign-in-btn');
        const googleSignUpBtn = document.getElementById('google-sign-up-btn');
        const switchToSignup = document.getElementById('switch-to-signup');
        const switchToSignin = document.getElementById('switch-to-signin');
        const forgotPasswordLink = document.getElementById('forgot-password-link');
        const backToSignin = document.getElementById('back-to-signin');

        const signInRequired = document.getElementById('sign-in-required');
        const signInToProcessBtn = document.getElementById('sign-in-to-process-btn');
        const modeTabs = document.querySelectorAll('.mode-tab');
        const modeDescriptionText = document.getElementById('mode-description-text');
        const modeCreditCost = document.getElementById('mode-credit-cost');
        const modeCostSummary = document.getElementById('mode-cost-summary');
        const uploadEstimate = document.getElementById('upload-estimate');
        const uploadEstimateTime = document.getElementById('upload-estimate-time');
        const uploadEstimateMeta = document.getElementById('upload-estimate-meta');
        const uploadSection = document.getElementById('upload-section');
        const buttonSection = document.getElementById('button-section');
        const generationControls = document.getElementById('generation-controls');
        const interviewControls = document.getElementById('interview-controls');
        const languageControls = document.getElementById('language-controls');
        const quickstartCard = document.getElementById('quickstart-card');
        const quickstartApplyBtn = document.getElementById('quickstart-apply-btn');
        const quickstartDismissBtn = document.getElementById('quickstart-dismiss-btn');
        const advancedSettingsToggle = document.getElementById('advanced-settings-toggle');
        const advancedSettingsBody = document.getElementById('advanced-settings-body');
        const studyToolsToggle = document.getElementById('study-tools-toggle');
        const studyToolsToggleText = document.getElementById('study-tools-toggle-text');
        const studyToolsPanel = document.getElementById('study-tools-panel');
        const studyToolsNote = document.getElementById('study-tools-note');
        const flashcardAmountControl = document.getElementById('flashcard-amount-control');
        const questionAmountControl = document.getElementById('question-amount-control');
        const studyToolChips = document.querySelectorAll('.tool-chip[data-study-features]');
        const flashcardAmountChips = document.querySelectorAll('#flashcard-amount-chips .amount-chip');
        const questionAmountChips = document.querySelectorAll('#question-amount-chips .amount-chip');
        const interviewOptionButtons = document.querySelectorAll('.interview-option[data-feature]');
        const interviewExtraNote = document.getElementById('interview-extra-note');
        const outputLanguageSelect = document.getElementById('output-language-select');
        const outputLanguagePicker = document.getElementById('output-language-picker');
        const outputLanguageButton = document.getElementById('output-language-button');
        const outputLanguageLabel = document.getElementById('output-language-label');
        const outputLanguageMenu = document.getElementById('output-language-menu');
        const outputLanguageItems = document.querySelectorAll('#output-language-menu .app-select-item');
        const outputLanguageCustom = document.getElementById('output-language-custom');

        const pdfZone = document.getElementById('pdf-zone');
        const audioZone = document.getElementById('audio-zone');
        const audioZoneTitle = document.getElementById('audio-zone-title');
        const pdfInput = document.getElementById('pdf-input');
        const audioInput = document.getElementById('audio-input');
        const pdfInfo = document.getElementById('pdf-info');
        const audioInfo = document.getElementById('audio-info');
        const pdfName = document.getElementById('pdf-name');
        const pdfSize = document.getElementById('pdf-size');
        const audioName = document.getElementById('audio-name');
        const audioSize = document.getElementById('audio-size');
        const pdfRemove = document.getElementById('pdf-remove');
        const audioRemove = document.getElementById('audio-remove');
        const audioUrlImport = document.getElementById('audio-url-import');
        const audioUrlInput = document.getElementById('audio-url-input');
        const audioUrlFetchBtn = document.getElementById('audio-url-fetch-btn');
        const audioUrlStatus = document.getElementById('audio-url-status');
        const languageOnboardingOverlay = document.getElementById('language-onboarding-overlay');
        const languageOnboardingGrid = document.getElementById('language-onboarding-grid');
        const languageOnboardingButtons = document.querySelectorAll('#language-onboarding-grid .onboarding-language-btn');
        const languageOnboardingCustom = document.getElementById('language-onboarding-custom');
        const languageOnboardingError = document.getElementById('language-onboarding-error');
        const languageOnboardingSaveBtn = document.getElementById('language-onboarding-save-btn');

        const processButton = document.getElementById('process-button');
        const noCreditsWarning = document.getElementById('no-credits-warning');
        const buyCreditsLink = document.getElementById('buy-credits-link');
        const progressSection = document.getElementById('progress-section');
        const progressSteps = document.getElementById('progress-steps');
        const progressStatus = document.getElementById('progress-status');
        const statusText = document.getElementById('status-text');
        const progressRetry = document.getElementById('progress-retry');
        const progressRetryBtn = document.getElementById('progress-retry-btn');
        const resultsSection = document.getElementById('results-section');
        const resultsTitleText = document.getElementById('results-title-text');
        const resultsContent = document.getElementById('results-content');
        const studyWarning = document.getElementById('study-warning');
        const billingReceiptPanel = document.getElementById('billing-receipt');
        const copyButton = document.getElementById('copy-button');
        const copyButtonText = document.getElementById('copy-button-text');
        const downloadButton = document.getElementById('download-button');
        const downloadDropdown = document.getElementById('download-dropdown');
        const downloadDropdownContent = document.getElementById('download-dropdown-content');
        const moreActionsDropdown = document.getElementById('more-actions-dropdown');
        const moreActionsButton = document.getElementById('more-actions-button');
        const moreActionsContent = document.getElementById('more-actions-content');
        const exportStudyCsvBtn = document.getElementById('export-study-csv-btn');
        const exportStudyCsvText = document.getElementById('export-study-csv-text');
        const studyNowBtn = document.getElementById('study-now-btn');
        const studyLibraryBtn = document.getElementById('study-library-btn');
        const newLectureButton = document.getElementById('new-lecture-button');

        const tabButtons = document.querySelectorAll('.focus-tab');
        const paneNotes = document.getElementById('pane-notes');
        const paneFlashcards = document.getElementById('pane-flashcards');
        const paneTest = document.getElementById('pane-test');
        const flashcardCountBadge = document.getElementById('flashcard-count-badge');
        const testCountBadge = document.getElementById('test-count-badge');
        const flashcardCard = document.getElementById('flashcard-card');
        const flashcardInner = document.getElementById('flashcard-inner');
        const flashcardFrontText = document.getElementById('flashcard-front-text');
        const flashcardBackText = document.getElementById('flashcard-back-text');
        const flashcardPrevBtn = document.getElementById('flashcard-prev-btn');
        const flashcardFlipBtn = document.getElementById('flashcard-flip-btn');
        const flashcardNextBtn = document.getElementById('flashcard-next-btn');
        const flashcardProgress = document.getElementById('flashcard-progress');
        const flashcardEmpty = document.getElementById('flashcard-empty');
        const quizProgress = document.getElementById('quiz-progress');
        const quizScoreEl = document.getElementById('quiz-score');
        const quizQuestionText = document.getElementById('quiz-question-text');
        const quizOptions = document.getElementById('quiz-options');
        const quizExplanation = document.getElementById('quiz-explanation');
        const quizNextBtn = document.getElementById('quiz-next-btn');
        const quizEmpty = document.getElementById('quiz-empty');

        const pricingOverlay = document.getElementById('pricing-overlay');
        const pricingModalClose = document.getElementById('pricing-modal-close');
        const historyOverlay = document.getElementById('history-overlay');
        const historyModalClose = document.getElementById('history-modal-close');
        const historyList = document.getElementById('history-list');
        const toast = document.getElementById('toast');
        const toastIcon = document.getElementById('toast-icon');
        const toastText = document.getElementById('toast-text');

        function localDateString(ts) {
            const d = ts ? new Date(ts) : new Date();
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${y}-${m}-${day}`;
        }
        const htmlUtils = window.LectureProcessorHtml || {};
        const escapeHtml = htmlUtils.escapeHtml || function (value) {
            return String(value ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        };
        const setSanitizedHtml = htmlUtils.setSanitizedHtml || function (element, rawHtml, options = null) {
            if (!element) return;
            const html = String(rawHtml ?? '');
            if (window.DOMPurify && typeof window.DOMPurify.sanitize === 'function') {
                element.innerHTML = window.DOMPurify.sanitize(html, options || {});
                return;
            }
            element.textContent = html;
        };
        function formatCreditTypeLabel(creditType) {
            const value = String(creditType || '').trim();
            const map = {
                lecture_credits_standard: 'lecture credit',
                lecture_credits_extended: 'lecture extended credit',
                slides_credits: 'slides credit',
                interview_credits_short: 'interview short credit',
                interview_credits_medium: 'interview medium credit',
                interview_credits_long: 'interview long credit',
            };
            return map[value] || value.replace(/_/g, ' ');
        }
        function formatCreditLedger(ledger) {
            if (!ledger || typeof ledger !== 'object') return '';
            const entries = Object.entries(ledger)
                .map(([creditType, amount]) => [formatCreditTypeLabel(creditType), Number(amount || 0)])
                .filter(([, amount]) => Number.isFinite(amount) && amount > 0)
                .map(([label, amount]) => `${amount} ${label}${amount === 1 ? '' : 's'}`);
            return entries.join(' + ');
        }
        function buildBillingReceiptText(receipt) {
            if (!receipt || typeof receipt !== 'object') return '';
            const chargedText = formatCreditLedger(receipt.charged || {});
            const refundedText = formatCreditLedger(receipt.refunded || {});
            if (!chargedText && !refundedText) return '';
            if (chargedText && refundedText) {
                return `Billing receipt: Charged ${chargedText}. Refunded ${refundedText}.`;
            }
            if (chargedText) {
                return `Billing receipt: Charged ${chargedText}.`;
            }
            return `Billing receipt: Refunded ${refundedText}.`;
        }
        function renderBillingReceipt(receipt) {
            currentBillingReceipt = receipt && typeof receipt === 'object' ? receipt : null;
            if (!billingReceiptPanel) return;
            const text = buildBillingReceiptText(currentBillingReceipt);
            if (!text) {
                billingReceiptPanel.textContent = '';
                billingReceiptPanel.classList.remove('visible');
                billingReceiptPanel.style.display = 'none';
                return;
            }
            billingReceiptPanel.textContent = text;
            billingReceiptPanel.style.display = 'block';
            billingReceiptPanel.classList.add('visible');
        }
        function getDailyGoalStorage(uid) {
            const parsed = parseInt(localStorage.getItem(`daily_goal_${uid}`) || '20', 10);
            return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 500) : 20;
        }
        function getProgressSummaryForHeader(uid) {
            const summary = (progressSummaryCache && typeof progressSummaryCache === 'object') ? progressSummaryCache : {};
            const goal = Number(summary.daily_goal || getDailyGoalStorage(uid) || 20);
            return {
                current_streak: Number(summary.current_streak || 0),
                due_today: Number(summary.due_today || 0),
                today_progress: Number(summary.today_progress || 0),
                daily_goal: Number.isFinite(goal) && goal > 0 ? goal : 20,
            };
        }
        function refreshStudyHeaderMetrics() {
            if (!currentUser) {
                progressMenu.style.display = 'none';
                return;
            }
            const uid = currentUser.uid;
            const summary = getProgressSummaryForHeader(uid);
            const streak = summary.current_streak;
            const due = summary.due_today;
            const goal = summary.daily_goal;
            const todayProgress = summary.today_progress;
            progressStreakCount.textContent = String(streak);
            progressDueCount.textContent = String(due);
            progressGoalText.textContent = `${Math.min(todayProgress, goal)} / ${goal}`;
            progressButton.title = `Streak ${streak} days · ${due} due today · Goal ${Math.min(todayProgress, goal)}/${goal}`;
            progressMenu.style.display = 'block';
        }
        async function fetchStudyProgressSummary() {
            if (!currentUser) return;
            try {
                const response = await authenticatedFetch('/api/study-progress');
                if (!response.ok) return;
                const payload = await response.json();
                const summary = (payload && payload.summary && typeof payload.summary === 'object') ? payload.summary : null;
                if (!summary) return;
                progressSummaryCache = summary;
                if (typeof summary.daily_goal === 'number' && summary.daily_goal > 0) {
                    try {
                        localStorage.setItem(`daily_goal_${currentUser.uid}`, String(summary.daily_goal));
                    } catch (_) {}
                }
                refreshStudyHeaderMetrics();
            } catch (e) {
                console.warn('Could not fetch study progress summary:', e);
            }
        }

        let activeModalOverlay = null;
        let modalStateStack = [];
        let accountActionInFlight = false;
        let checkoutCooldownUntilMs = 0;
        let checkoutCooldownTimer = null;
        let checkoutRequestInFlight = false;
        let uploadCooldownUntilMs = 0;
        let uploadCooldownTimer = null;
        function getModalContainer(overlay) {
            if (uxUtils.getModalContainer) return uxUtils.getModalContainer(overlay);
            if (!overlay) return null;
            return overlay.querySelector('[role="dialog"]') || overlay.firstElementChild || overlay;
        }
        function getFocusableElements(overlay) {
            if (uxUtils.getFocusableElements) return uxUtils.getFocusableElements(overlay);
            const container = getModalContainer(overlay);
            if (!container) return [];
            const selector = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';
            return Array.from(container.querySelectorAll(selector)).filter((el) => el.offsetParent !== null || el === document.activeElement);
        }
        function openOverlay(overlay) {
            if (!overlay) return;
            modalStateStack.push({ overlay, restore: document.activeElement });
            overlay.classList.add('visible');
            overlay.setAttribute('aria-hidden', 'false');
            activeModalOverlay = overlay;
            const focusables = getFocusableElements(overlay);
            if (focusables.length) {
                setTimeout(() => focusables[0].focus(), 30);
            }
        }
        function closeOverlay(overlay) {
            if (!overlay) return;
            overlay.classList.remove('visible');
            overlay.setAttribute('aria-hidden', 'true');
            let restoreTarget = null;
            for (let i = modalStateStack.length - 1; i >= 0; i -= 1) {
                if (modalStateStack[i].overlay === overlay) {
                    restoreTarget = modalStateStack[i].restore || null;
                    modalStateStack.splice(i, 1);
                    break;
                }
            }
            activeModalOverlay = modalStateStack.length ? modalStateStack[modalStateStack.length - 1].overlay : null;
            if (restoreTarget && typeof restoreTarget.focus === 'function') {
                try { restoreTarget.focus(); } catch (_) {}
            }
        }
        function getVisibleMenuItems(menu, selector = 'button:not([disabled])') {
            if (uxUtils.getVisibleMenuItems) return uxUtils.getVisibleMenuItems(menu, selector);
            if (!menu) return [];
            return Array.from(menu.querySelectorAll(selector)).filter((item) => (item.offsetParent !== null || item === document.activeElement) && !item.disabled);
        }
        function focusMenuItem(menu, selector, mode = 'first') {
            if (uxUtils.focusMenuItem) {
                uxUtils.focusMenuItem(menu, selector, mode);
                return;
            }
            const items = getVisibleMenuItems(menu, selector);
            if (!items.length) return;
            if (mode === 'last') {
                items[items.length - 1].focus();
                return;
            }
            const activeIndex = items.indexOf(document.activeElement);
            if (mode === 'next') {
                items[(activeIndex + 1 + items.length) % items.length].focus();
                return;
            }
            if (mode === 'prev') {
                items[(activeIndex - 1 + items.length) % items.length].focus();
                return;
            }
            if (mode === 'active') {
                const selected = items.find((item) => item.classList.contains('active') || item.getAttribute('aria-selected') === 'true');
                (selected || items[0]).focus();
                return;
            }
            items[0].focus();
        }
        function setUserDropdownVisible(visible) {
            userDropdown.classList.toggle('visible', visible);
            userButton.setAttribute('aria-expanded', visible ? 'true' : 'false');
        }
        function setProgressDropdownVisible(visible) {
            progressDropdown.classList.toggle('visible', visible);
            progressButton.classList.toggle('open', visible);
            progressButton.setAttribute('aria-expanded', visible ? 'true' : 'false');
        }
        function setDownloadDropdownVisible(visible) {
            downloadDropdownContent.classList.toggle('visible', visible);
            downloadButton.setAttribute('aria-expanded', visible ? 'true' : 'false');
        }
        function setMoreActionsDropdownVisible(visible) {
            moreActionsContent.classList.toggle('visible', visible);
            moreActionsButton.setAttribute('aria-expanded', visible ? 'true' : 'false');
        }
        function setAdvancedSettingsVisible(visible) {
            advancedSettingsBody.classList.toggle('visible', visible);
            advancedSettingsToggle.classList.toggle('open', visible);
            advancedSettingsToggle.setAttribute('aria-expanded', visible ? 'true' : 'false');
        }
        function setOutputLanguageMenuVisible(visible) {
            outputLanguageMenu.classList.toggle('visible', visible);
            outputLanguageButton.classList.toggle('open', visible);
            outputLanguageButton.setAttribute('aria-expanded', visible ? 'true' : 'false');
        }
        function closeHeaderDropdowns(except) {
            if (except !== 'user') setUserDropdownVisible(false);
            if (except !== 'progress') setProgressDropdownVisible(false);
            if (except !== 'download') setDownloadDropdownVisible(false);
            if (except !== 'more-actions') setMoreActionsDropdownVisible(false);
            if (except !== 'language') setOutputLanguageMenuVisible(false);
        }
        function showAuthModal(view = 'signin') {
            openOverlay(authOverlay);
            showAuthView(view);
            clearAuthErrors();
            trackEvent('auth_modal_opened', { view: view || 'signin' });
        }
        function hideAuthModal() {
            closeOverlay(authOverlay);
            clearAuthErrors();
            signinForm.reset();
            signupForm.reset();
            resetForm.reset();
        }
        function showAuthView(view) {
            signinView.classList.remove('active');
            signupView.classList.remove('active');
            resetView.classList.remove('active');
            clearAuthErrors();
            if (view === 'signin') signinView.classList.add('active');
            if (view === 'signup') signupView.classList.add('active');
            if (view === 'reset') resetView.classList.add('active');
        }
        function clearAuthErrors() {
            [signinError, signupError, resetError, resetSuccess].forEach(el => {
                el.classList.remove('visible');
                el.textContent = '';
            });
        }
        function showAuthError(el, msg) {
            el.textContent = msg;
            el.classList.add('visible');
        }
        function getFirebaseErrorMessage(e) {
            const m = {
                'auth/email-already-in-use': 'This email is already registered. Please sign in instead.',
                'auth/invalid-email': 'Please enter a valid email address.',
                'auth/weak-password': 'Password should be at least 6 characters.',
                'auth/user-not-found': 'No account found with this email.',
                'auth/wrong-password': 'Incorrect password. Please try again.',
                'auth/invalid-credential': 'Invalid email or password. Please try again.',
                'auth/too-many-requests': 'Too many failed attempts. Please try again later.',
                'auth/network-request-failed': 'Network error. Please check your connection.'
            };
            return m[e.code] || e.message || 'An error occurred. Please try again.';
        }
        async function checkEmailAllowed(email) {
            try {
                const r = await fetch('/api/verify-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
                return await r.json();
            } catch (e) {
                return { allowed: false, message: 'Could not verify email. Please try again.' };
            }
        }
        async function signInWithEmail(email, password) {
            try {
                const check = await checkEmailAllowed(email);
                if (!check.allowed) {
                    trackEvent('auth_failed', { method: 'email', reason: 'disallowed_email' });
                    showAuthError(signinError, check.message);
                    return;
                }
                await auth.signInWithEmailAndPassword(email, password);
                hideAuthModal();
                showToast('Signed in successfully!', 'success');
                trackEvent('auth_success', { method: 'email' });
            } catch (e) {
                trackEvent('auth_failed', { method: 'email', reason: e.code || 'unknown' });
                captureClientError(e, 'signin_email');
                showAuthError(signinError, getFirebaseErrorMessage(e));
            }
        }
        async function signUpWithEmail(email, password) {
            try {
                const check = await checkEmailAllowed(email);
                if (!check.allowed) {
                    trackEvent('auth_failed', { method: 'signup_email', reason: 'disallowed_email' });
                    showAuthError(signupError, check.message);
                    return;
                }
                await auth.createUserWithEmailAndPassword(email, password);
                hideAuthModal();
                showToast('Account created successfully!', 'success');
                trackEvent('auth_success', { method: 'signup_email' });
            } catch (e) {
                trackEvent('auth_failed', { method: 'signup_email', reason: e.code || 'unknown' });
                captureClientError(e, 'signup_email');
                showAuthError(signupError, getFirebaseErrorMessage(e));
            }
        }
        async function signInWithGoogle() {
            const provider = new firebase.auth.GoogleAuthProvider();
            try {
                const result = await auth.signInWithPopup(provider);
                const email = result.user.email || '';
                const check = await checkEmailAllowed(email);
                if (!check.allowed) {
                    try {
                        await result.user.delete();
                    } catch (deleteErr) {
                        console.warn('Could not delete disallowed Google user immediately:', deleteErr);
                    }
                    await auth.signOut();
                    trackEvent('auth_failed', { method: 'google', reason: 'disallowed_email' });
                    showAuthError(signinView.classList.contains('active') ? signinError : signupError, check.message);
                    return;
                }
                hideAuthModal();
                showToast('Signed in successfully!', 'success');
                trackEvent('auth_success', { method: 'google' });
            } catch (e) {
                trackEvent('auth_failed', { method: 'google', reason: e.code || 'unknown' });
                captureClientError(e, 'signin_google');
                showAuthError(signinView.classList.contains('active') ? signinError : signupError, getFirebaseErrorMessage(e));
            }
        }
        async function sendPasswordReset(email) {
            try {
                await auth.sendPasswordResetEmail(email);
                resetSuccess.textContent = 'Password reset email sent! Check your inbox.';
                resetSuccess.classList.add('visible');
            } catch (e) {
                showAuthError(resetError, getFirebaseErrorMessage(e));
            }
        }
        async function signOut() {
            try {
                await releaseImportedAudioToken({ clearStatus: true });
                await auth.signOut();
                showToast('Signed out', 'success');
            } catch (e) {
                console.error(e);
                captureClientError(e, 'fetch_user_data');
            }
        }
        async function fetchUserData() {
            if (!currentUser) return;
            try {
                const r = await authenticatedFetch('/api/auth/user');
                if (!r.ok) {
                    if (r.status === 401 || r.status === 403) {
                        currentUserIsAdmin = false;
                        userPreferences = null;
                        closeLanguageOnboarding();
                        adminDashboardBtn.style.display = 'none';
                    }
                    return;
                }
                const d = await r.json();
                userCredits = d.credits;
                userTotalProcessed = Number(d.total_processed || 0);
                currentUserIsAdmin = Boolean(d.is_admin);
                userPreferences = (d.preferences && typeof d.preferences === 'object') ? d.preferences : null;
                adminDashboardBtn.style.display = currentUserIsAdmin ? 'flex' : 'none';
                if (userPreferences) {
                    applyPreferencesToOutputLanguage(userPreferences, { forceOnboardingOpen: true });
                }
                updateCreditsDisplay();
                await fetchStudyProgressSummary();
                refreshStudyHeaderMetrics();
                updateQuickstartVisibility();
            } catch (e) {
                console.error(e);
            }
        }
        function updateCreditsDisplay() {
            if (!userCredits) return;
            const lecture = userCredits.lecture_standard + userCredits.lecture_extended;
            const interview = userCredits.interview_short + userCredits.interview_medium + userCredits.interview_long;
            const total = lecture + userCredits.slides + interview;
            const tooltipText = `Lecture: ${lecture}\nSlides: ${userCredits.slides}\nInterview: ${interview}\nTotal: ${total}`;
            creditsCount.textContent = total;
            creditsDisplay.setAttribute('data-tooltip', tooltipText);
            if (creditsTooltip) creditsTooltip.textContent = tooltipText;
            dropdownLectureCredits.textContent = lecture;
            dropdownSlidesCredits.textContent = userCredits.slides;
            dropdownInterviewCredits.textContent = interview;
            updateInterviewOptionAvailability();
            updateModeCostSummary();
            updateProcessButton();
            refreshStudyHeaderMetrics();
        }
        function getTotalInterviewCredits() {
            if (!userCredits) return 0;
            return userCredits.interview_short + userCredits.interview_medium + userCredits.interview_long;
        }
        function getInterviewExtraCost() {
            return currentMode === 'interview' ? selectedInterviewFeatures.length : 0;
        }
        function getInterviewFeaturesValue() {
            if (!selectedInterviewFeatures.length) return 'none';
            if (selectedInterviewFeatures.length === 2) return 'both';
            return selectedInterviewFeatures[0];
        }
        function updateModeCostSummary() {
            if (!modeCostSummary) return;
            if (!userCredits) {
                modeCostSummary.textContent = 'Sign in to view run cost and available credits.';
                return;
            }
            const lectureCredits = userCredits.lecture_standard + userCredits.lecture_extended;
            const slidesCredits = userCredits.slides;
            const interviewCredits = getTotalInterviewCredits();
            if (currentMode === 'lecture-notes') {
                modeCostSummary.textContent = `This run costs 1 lecture credit. You have ${lectureCredits} lecture credits.`;
                return;
            }
            if (currentMode === 'slides-only') {
                modeCostSummary.textContent = `This run costs 1 slides credit. You have ${slidesCredits} slides credits.`;
                return;
            }
            const extras = getInterviewExtraCost();
            if (extras > 0) {
                modeCostSummary.textContent = `This run costs 1 interview credit + ${extras} slides credits for slide-pipeline extras. You have ${interviewCredits} interview credits and ${slidesCredits} slides credits.`;
            } else {
                modeCostSummary.textContent = `This run costs 1 interview credit. Optional extras use slides credits (slide pipeline). You have ${interviewCredits} interview credits and ${slidesCredits} slides credits.`;
            }
        }
        function updateInterviewOptionAvailability() {
            const slidesCredits = userCredits ? Number(userCredits.slides || 0) : Number.POSITIVE_INFINITY;
            const selectedCount = selectedInterviewFeatures.length;
            interviewOptionButtons.forEach(btn => {
                const feature = btn.dataset.feature;
                const selected = selectedInterviewFeatures.includes(feature);
                const nextCost = selected ? Math.max(0, selectedCount - 1) : (selectedCount + 1);
                const canEnable = slidesCredits >= nextCost;
                btn.disabled = !canEnable && !selected;
                btn.classList.toggle('disabled', btn.disabled);
                btn.title = btn.disabled ? 'Not enough slides credits for this extra.' : '';
                btn.setAttribute('aria-disabled', btn.disabled ? 'true' : 'false');
            });
        }
        function updateModeCreditDisplay() {
            if (currentMode !== 'interview') {
                setSanitizedHtml(modeCreditCost, modeConfig[currentMode].creditCost);
                updateModeCostSummary();
                return;
            }
            const extraCost = getInterviewExtraCost();
            if (!extraCost) {
                setSanitizedHtml(modeCreditCost, 'Uses <strong>1 interview credit</strong>. Optional extras cost <strong>1 slides credit</strong> each.');
            } else {
                setSanitizedHtml(modeCreditCost, `Uses <strong>1 interview credit</strong> + <strong>${extraCost} slides credits</strong> for selected extras.`);
            }
            updateModeCostSummary();
        }
        function setStudyFeature(value) {
            selectedStudyFeatures = ['none', 'flashcards', 'test', 'both'].includes(value) ? value : 'none';
            const labels = {
                none: 'No study tools',
                flashcards: 'Flashcards only',
                test: 'Practice test only',
                both: 'Flashcards + test',
            };
            studyToolsToggleText.textContent = labels[selectedStudyFeatures];
            studyToolChips.forEach(chip => {
                chip.classList.toggle('active', chip.dataset.studyFeatures === selectedStudyFeatures);
            });
            if (selectedStudyFeatures === 'none') {
                studyToolsNote.textContent = 'Notes-only output. No flashcards or test questions will be generated.';
            } else if (selectedStudyFeatures === 'flashcards') {
                studyToolsNote.textContent = 'Only flashcards will be generated.';
            } else if (selectedStudyFeatures === 'test') {
                studyToolsNote.textContent = 'Only practice test questions will be generated.';
            } else {
                studyToolsNote.textContent = 'Recommended for first runs: both flashcards and practice test questions will be generated.';
            }
            if (currentUser && currentUser.uid) {
                try {
                    localStorage.setItem(`study_tools_pref_${currentUser.uid}`, selectedStudyFeatures);
                } catch (_) {}
            }
            const disableFlashcards = currentMode === 'interview' || selectedStudyFeatures === 'none' || selectedStudyFeatures === 'test';
            const disableQuestions = currentMode === 'interview' || selectedStudyFeatures === 'none' || selectedStudyFeatures === 'flashcards';
            flashcardAmountChips.forEach(chip => { chip.disabled = disableFlashcards; });
            questionAmountChips.forEach(chip => { chip.disabled = disableQuestions; });
            flashcardAmountControl.style.display = disableFlashcards ? 'none' : '';
            questionAmountControl.style.display = disableQuestions ? 'none' : '';
            updateProcessButton();
        }
        function setAmountSelection(kind, value) {
            if (kind === 'flashcards') {
                selectedFlashcardAmount = value;
                flashcardAmountChips.forEach(chip => chip.classList.toggle('active', chip.dataset.value === value));
            } else {
                selectedQuestionAmount = value;
                questionAmountChips.forEach(chip => chip.classList.toggle('active', chip.dataset.value === value));
            }
        }
        function updateInterviewOptionsUI() {
            if (userCredits) {
                const maxAffordable = Math.max(0, Number(userCredits.slides || 0));
                if (selectedInterviewFeatures.length > maxAffordable) {
                    selectedInterviewFeatures = selectedInterviewFeatures.slice(0, maxAffordable);
                }
            }
            updateInterviewOptionAvailability();
            interviewOptionButtons.forEach(btn => {
                btn.classList.toggle('active', selectedInterviewFeatures.includes(btn.dataset.feature));
            });
            const slidesCredits = userCredits ? Number(userCredits.slides || 0) : 0;
            if (!selectedInterviewFeatures.length && userCredits && slidesCredits <= 0) {
                interviewExtraNote.textContent = 'No extras selected. You currently have 0 slides credits, so slide-pipeline extras are disabled.';
            } else if (!selectedInterviewFeatures.length) {
                interviewExtraNote.textContent = 'No extras selected. Select one or both options (1 slides credit per option via the slide-processing pipeline).';
            } else if (selectedInterviewFeatures.length === 1) {
                interviewExtraNote.textContent = 'Selected 1 extra option. This adds 1 slides credit (slide-processing pipeline).';
            } else {
                interviewExtraNote.textContent = 'Selected both extra options. This adds 2 slides credits (slide-processing pipeline).';
            }
            updateModeCreditDisplay();
            updateProcessButton();
        }
        function updateOutputLanguageInput() {
            const isOther = outputLanguageSelect.value === 'other';
            outputLanguageCustom.style.display = isOther ? 'block' : 'none';
            if (!isOther) outputLanguageCustom.value = '';
        }
        function getLanguageLabel(value, customValue = '') {
            const key = String(value || 'english').trim().toLowerCase();
            if (key === 'other') {
                const custom = String(customValue || '').trim();
                return custom ? `🌐 ${custom}` : OUTPUT_LANGUAGE_LABELS.other;
            }
            return OUTPUT_LANGUAGE_LABELS[key] || OUTPUT_LANGUAGE_LABELS.english;
        }
        function setOutputLanguage(value, label) {
            const safeValue = Object.prototype.hasOwnProperty.call(OUTPUT_LANGUAGE_LABELS, value) ? value : 'english';
            outputLanguageSelect.value = safeValue;
            outputLanguageLabel.textContent = label || getLanguageLabel(safeValue, outputLanguageCustom.value);
            outputLanguageItems.forEach(item => {
                const isActive = item.dataset.value === safeValue;
                item.classList.toggle('active', isActive);
                item.setAttribute('aria-selected', isActive ? 'true' : 'false');
            });
            updateOutputLanguageInput();
        }
        function clearLanguagePreferenceSaveTimer() {
            if (!languagePreferenceSaveTimer) return;
            clearTimeout(languagePreferenceSaveTimer);
            languagePreferenceSaveTimer = null;
        }
        async function saveUserPreferences(payload) {
            if (!currentUser) return { ok: false, error: 'Please sign in' };
            try {
                const response = await authenticatedFetch('/api/user-preferences', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload || {}),
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) {
                    return { ok: false, error: data.error || 'Could not save preferences.' };
                }
                if (data.preferences && typeof data.preferences === 'object') {
                    userPreferences = data.preferences;
                }
                return { ok: true, preferences: userPreferences };
            } catch (e) {
                captureClientError(e, 'save_user_preferences');
                return { ok: false, error: 'Could not save preferences.' };
            }
        }
        function setOnboardingError(message) {
            if (!languageOnboardingError) return;
            const text = String(message || '').trim();
            languageOnboardingError.textContent = text;
            languageOnboardingError.classList.toggle('visible', Boolean(text));
        }
        function setOnboardingLanguageSelection(value) {
            const target = String(value || 'english').trim().toLowerCase();
            languageOnboardingButtons.forEach((btn) => {
                btn.classList.toggle('active', btn.dataset.value === target);
            });
            const showCustom = target === 'other';
            languageOnboardingCustom.style.display = showCustom ? 'block' : 'none';
            if (!showCustom) languageOnboardingCustom.value = '';
        }
        function getOnboardingLanguageSelection() {
            const active = Array.from(languageOnboardingButtons).find((btn) => btn.classList.contains('active'));
            const value = active ? String(active.dataset.value || 'english').trim().toLowerCase() : 'english';
            return {
                value,
                custom: value === 'other' ? String(languageOnboardingCustom.value || '').trim() : '',
            };
        }
        function closeLanguageOnboarding() {
            if (!languageOnboardingOpen) return;
            languageOnboardingOpen = false;
            setOnboardingError('');
            closeOverlay(languageOnboardingOverlay);
        }
        function openLanguageOnboarding(preferences = null) {
            if (!currentUser || languageOnboardingOpen) return;
            const prefs = preferences && typeof preferences === 'object' ? preferences : (userPreferences || {});
            const key = String(prefs.output_language || outputLanguageSelect.value || 'english').trim().toLowerCase();
            const custom = String(prefs.output_language_custom || outputLanguageCustom.value || '').trim();
            setOnboardingLanguageSelection(key);
            languageOnboardingCustom.value = custom;
            if (key === 'other') languageOnboardingCustom.style.display = 'block';
            languageOnboardingSaveBtn.disabled = false;
            setOnboardingError('');
            languageOnboardingOpen = true;
            openOverlay(languageOnboardingOverlay);
        }
        async function saveLanguageOnboardingPreference() {
            if (!currentUser || languageOnboardingSaving) return;
            const selection = getOnboardingLanguageSelection();
            if (selection.value === 'other' && !selection.custom) {
                setOnboardingError('Please enter a custom language.');
                return;
            }
            languageOnboardingSaving = true;
            languageOnboardingSaveBtn.disabled = true;
            setOnboardingError('');
            const result = await saveUserPreferences({
                output_language: selection.value,
                output_language_custom: selection.custom,
                onboarding_completed: true,
            });
            languageOnboardingSaving = false;
            languageOnboardingSaveBtn.disabled = false;
            if (!result.ok) {
                setOnboardingError(result.error || 'Could not save preference.');
                return;
            }
            suppressLanguagePreferencePersist = true;
            setOutputLanguage(selection.value, getLanguageLabel(selection.value, selection.custom));
            if (selection.value === 'other') outputLanguageCustom.value = selection.custom;
            suppressLanguagePreferencePersist = false;
            closeLanguageOnboarding();
            showToast('Default language saved.', 'success');
        }
        async function persistCurrentOutputLanguage(options = {}) {
            if (!currentUser || suppressLanguagePreferencePersist) return;
            const value = String(outputLanguageSelect.value || 'english').trim().toLowerCase();
            const custom = value === 'other' ? String(outputLanguageCustom.value || '').trim() : '';
            if (value === 'other' && !custom) {
                if (options.strict) showToast('Please enter a custom language before saving.', 'info');
                return;
            }
            const payload = {
                output_language: value,
                output_language_custom: custom,
            };
            if (Object.prototype.hasOwnProperty.call(options, 'onboarding_completed')) {
                payload.onboarding_completed = Boolean(options.onboarding_completed);
            }
            const result = await saveUserPreferences(payload);
            if (!result.ok && options.showErrorToast) {
                showToast(result.error || 'Could not save language preference.', 'error');
            }
        }
        function scheduleLanguagePreferenceSave() {
            if (!currentUser || suppressLanguagePreferencePersist || languageOnboardingOpen) return;
            clearLanguagePreferenceSaveTimer();
            languagePreferenceSaveTimer = setTimeout(() => {
                persistCurrentOutputLanguage({ showErrorToast: true });
            }, 500);
        }
        function applyPreferencesToOutputLanguage(preferences, options = {}) {
            const prefs = preferences && typeof preferences === 'object' ? preferences : {};
            const keyRaw = String(prefs.output_language || 'english').trim().toLowerCase();
            const key = ['dutch', 'english', 'spanish', 'french', 'german', 'chinese', 'other'].includes(keyRaw) ? keyRaw : 'english';
            const custom = String(prefs.output_language_custom || '').trim();
            suppressLanguagePreferencePersist = true;
            setOutputLanguage(key, getLanguageLabel(key, custom));
            if (key === 'other') outputLanguageCustom.value = custom;
            suppressLanguagePreferencePersist = false;
            if (options.forceOnboardingOpen) {
                if (!Boolean(prefs.onboarding_completed)) openLanguageOnboarding(prefs);
                else closeLanguageOnboarding();
            }
        }
        function setQuickstartVisible(visible) {
            if (!quickstartCard) return;
            quickstartCard.style.display = visible ? '' : 'none';
        }
        function applyStoredStudyFeaturePreference(user) {
            if (!user || !user.uid) return;
            let stored = '';
            try {
                stored = localStorage.getItem(`study_tools_pref_${user.uid}`) || '';
            } catch (_) {}
            const next = ['none', 'flashcards', 'test', 'both'].includes(stored) ? stored : 'both';
            setStudyFeature(next);
        }
        function applyRecommendedSetup() {
            switchMode('lecture-notes');
            setStudyFeature('both');
            setAdvancedSettingsVisible(true);
            showToast('Recommended setup applied: Lecture Notes + Flashcards + Test.', 'success');
            try {
                uploadSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
            } catch (_) {}
        }
        function updateQuickstartVisibility() {
            if (!currentUser || !quickstartCard) {
                setQuickstartVisible(false);
                return;
            }
            const isNewUser = Number(userTotalProcessed || 0) <= 0;
            let dismissed = false;
            try {
                dismissed = localStorage.getItem(`quickstart_dismissed_${currentUser.uid}`) === '1';
            } catch (_) {}
            setQuickstartVisible(isNewUser && !dismissed && !resultsLocked);
        }
        function updateUIForAuthState(user) {
            if (user) {
                closeHeaderDropdowns('');
                headerSignInBtn.style.display = 'none';
                creditsDisplay.style.display = 'flex';
                headerStudyLibraryBtn.style.display = 'inline-flex';
                progressMenu.style.display = 'block';
                userMenu.style.display = 'block';
                adminDashboardBtn.style.display = 'none';
                signInRequired.classList.remove('visible');
                uploadSection.style.display = 'grid';
                uploadEstimate.style.display = '';
                buttonSection.style.display = 'block';
                languageControls.style.display = 'grid';
                setAdvancedSettingsVisible(false);
                applyStoredStudyFeaturePreference(user);
                const displayName = user.displayName || user.email.split('@')[0];
                const initial = displayName.charAt(0).toUpperCase();
                userAvatar.innerHTML = '';
                if (user.photoURL) {
                    const img = document.createElement('img');
                    img.src = user.photoURL;
                    img.alt = displayName;
                    userAvatar.appendChild(img);
                } else {
                    const span = document.createElement('span');
                    span.textContent = initial;
                    userAvatar.appendChild(span);
                }
                userName.textContent = displayName;
                if (topbarUtils.applyAuthState) {
                    topbarUtils.applyAuthState({
                        user: user,
                        userTextEl: userEmail,
                        signedInText: function(activeUser) { return activeUser && activeUser.email ? activeUser.email : ''; },
                    });
                } else {
                    userEmail.textContent = user.email;
                }
                switchMode(currentMode);
                updateModeCostSummary();
                refreshStudyHeaderMetrics();
                updateQuickstartVisibility();
            } else {
                closeHeaderDropdowns('');
                headerSignInBtn.style.display = 'flex';
                creditsDisplay.style.display = 'none';
                headerStudyLibraryBtn.style.display = 'none';
                progressMenu.style.display = 'none';
                userMenu.style.display = 'none';
                signInRequired.classList.add('visible');
                uploadSection.style.display = 'none';
                uploadEstimate.style.display = 'none';
                buttonSection.style.display = 'none';
                generationControls.classList.add('hidden');
                generationControls.style.display = 'none';
                interviewControls.classList.add('hidden');
                languageControls.style.display = 'none';
                setAdvancedSettingsVisible(false);
                releaseImportedAudioToken({ clearStatus: true });
                currentUser = null;
                userCredits = null;
                idToken = null;
                if (authClient && typeof authClient.clearToken === 'function') authClient.clearToken();
                progressSummaryCache = null;
                userTotalProcessed = 0;
                currentUserIsAdmin = false;
                userPreferences = null;
                clearLanguagePreferenceSaveTimer();
                closeLanguageOnboarding();
                uploadCooldownUntilMs = 0;
                clearUploadCooldownTimer();
                modalStateStack = [];
                activeModalOverlay = null;
                adminDashboardBtn.style.display = 'none';
                updateInterviewOptionAvailability();
                updateModeCostSummary();
                setQuickstartVisible(false);
            }
        }
        let handlingDisallowedAuthState = false;
        auth.onAuthStateChanged(async (user) => {
            if (handlingDisallowedAuthState) return;
            currentUser = user;
            if (user) {
                const check = await checkEmailAllowed(user.email || '');
                if (!check.allowed) {
                    handlingDisallowedAuthState = true;
                    try {
                        await auth.signOut();
                    } catch (e) {
                        console.error(e);
                        captureClientError(e, 'disallowed_signout');
                    } finally {
                        handlingDisallowedAuthState = false;
                    }
                    updateUIForAuthState(null);
                    const preferredView = signupView.classList.contains('active') ? 'signup' : 'signin';
                    showAuthModal(preferredView);
                    showAuthError(preferredView === 'signup' ? signupError : signinError, check.message || 'This email is not allowed.');
                    return;
                }
                idToken = await user.getIdToken();
                if (authClient && typeof authClient.setToken === 'function') authClient.setToken(idToken);
                updateUIForAuthState(user);
                await fetchUserData();
                await checkPaymentResult();
            } else {
                updateUIForAuthState(null);
            }
        });
        setInterval(async () => {
            if (!currentUser) return;
            idToken = await currentUser.getIdToken(true);
            if (authClient && typeof authClient.setToken === 'function') authClient.setToken(idToken);
        }, 10 * 60 * 1000);

        function formatFileSize(bytes) {
            if (!bytes) return '0 Bytes';
            const k = 1024;
            const sizes = ['Bytes', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
        }
        function currentAudioBytes() {
            if (audioFile) return Number(audioFile.size || 0);
            if (currentMode !== 'lecture-notes') return 0;
            return Number(importedAudioSizeBytes || 0);
        }
        function setAudioImportStatus(message = '', isError = false) {
            if (!audioUrlStatus) return;
            const text = String(message || '').trim();
            audioUrlStatus.textContent = text;
            audioUrlStatus.classList.toggle('error', Boolean(isError && text));
        }
        function setAudioImportPending(inFlight) {
            if (!audioUrlFetchBtn) return;
            if (!audioUrlFetchBtn.dataset.defaultLabel) {
                audioUrlFetchBtn.dataset.defaultLabel = audioUrlFetchBtn.textContent || 'Import Audio';
            }
            audioUrlFetchBtn.disabled = Boolean(inFlight);
            audioUrlFetchBtn.textContent = inFlight ? 'Importing...' : (audioUrlFetchBtn.dataset.defaultLabel || 'Import Audio');
        }
        function syncAudioInfoUI() {
            if (audioFile) {
                audioName.textContent = audioFile.name;
                audioSize.textContent = formatFileSize(audioFile.size);
                audioInfo.style.display = 'flex';
                audioZone.classList.add('has-file');
                return;
            }
            if (importedAudioToken) {
                audioName.textContent = importedAudioName || 'Imported audio';
                audioSize.textContent = importedAudioSizeBytes > 0
                    ? `${formatFileSize(importedAudioSizeBytes)} · Imported from URL`
                    : 'Imported from URL';
                audioInfo.style.display = 'flex';
                audioZone.classList.add('has-file');
                return;
            }
            audioInfo.style.display = 'none';
            audioZone.classList.remove('has-file');
        }
        function clearImportedAudioLocalState() {
            importedAudioToken = '';
            importedAudioSizeBytes = 0;
            importedAudioName = '';
        }
        async function releaseImportedAudioToken(options = {}) {
            const token = String(importedAudioToken || '').trim();
            const shouldClearStatus = options.clearStatus !== false;
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
            } catch (_) {}
        }
        async function applyImportedAudio(payload, previousToken = '') {
            const token = String(payload && payload.audio_import_token ? payload.audio_import_token : '').trim();
            if (!token) return false;
            importedAudioToken = token;
            importedAudioName = String(payload.file_name || 'Imported audio.mp3').trim();
            importedAudioSizeBytes = Math.max(0, Number(payload.size_bytes || 0));
            if (audioFile) {
                audioFile = null;
                audioInput.value = '';
            }
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
                } catch (_) {}
            }
            return true;
        }
        async function importAudioFromUrl() {
            if (!currentUser) {
                showAuthModal('signin');
                return;
            }
            if (currentMode !== 'lecture-notes') {
                setAudioImportStatus('URL import is only available in Lecture Notes mode.', true);
                return;
            }
            const url = String(audioUrlInput.value || '').trim();
            if (!url) {
                setAudioImportStatus('Paste the Brightspace/Kaltura m3u8 URL first.', true);
                return;
            }
            setAudioImportPending(true);
            setAudioImportStatus('Importing audio from URL...');
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
                    return;
                }
                const applied = await applyImportedAudio(data, previousToken);
                if (applied) showToast('Audio imported from URL.', 'success');
            } catch (e) {
                captureClientError(e, 'import_audio_url');
                setAudioImportStatus('Could not import audio from URL. Please try again.', true);
            } finally {
                setAudioImportPending(false);
            }
        }
        function renderToastIcon(type) {
            while (toastIcon.firstChild) toastIcon.removeChild(toastIcon.firstChild);
            const ns = 'http://www.w3.org/2000/svg';
            const add = (name, attrs) => {
                const node = document.createElementNS(ns, name);
                Object.entries(attrs || {}).forEach(([k, v]) => node.setAttribute(k, String(v)));
                toastIcon.appendChild(node);
            };
            if (type === 'success') {
                add('polyline', { points: '20 6 9 17 4 12' });
                return;
            }
            if (type === 'error') {
                add('circle', { cx: '12', cy: '12', r: '10' });
                add('line', { x1: '15', y1: '9', x2: '9', y2: '15' });
                add('line', { x1: '9', y1: '9', x2: '15', y2: '15' });
                return;
            }
            add('circle', { cx: '12', cy: '12', r: '10' });
            add('line', { x1: '12', y1: '16', x2: '12', y2: '12' });
            add('line', { x1: '12', y1: '8', x2: '12.01', y2: '8' });
        }
        function showToast(message, type = 'success', duration = 3000) {
            toastText.textContent = message;
            toast.className = `toast visible ${type}`;
            renderToastIcon(type);
            setTimeout(() => toast.classList.remove('visible'), duration);
        }
        function getRetryAfterSeconds(response, data) {
            const bodyValue = Number((data && data.retry_after_seconds) || 0);
            if (Number.isFinite(bodyValue) && bodyValue > 0) return Math.ceil(bodyValue);
            const headerValue = Number((response && response.headers && response.headers.get('Retry-After')) || 0);
            if (Number.isFinite(headerValue) && headerValue > 0) return Math.ceil(headerValue);
            return 0;
        }
        function formatRetryDelay(seconds) {
            const total = Math.max(0, Number(seconds) || 0);
            if (!total) return '';
            if (total < 60) return `${total}s`;
            const minutes = Math.floor(total / 60);
            const rem = total % 60;
            return rem ? `${minutes}m ${rem}s` : `${minutes}m`;
        }
        function ensureBundleButtonDefaults() {
            document.querySelectorAll('.bundle-buy-btn').forEach((btn) => {
                if (!btn.dataset.defaultLabel) btn.dataset.defaultLabel = btn.textContent || 'Buy now';
            });
        }
        function getCheckoutCooldownSeconds() {
            if (!checkoutCooldownUntilMs) return 0;
            return Math.max(0, Math.ceil((checkoutCooldownUntilMs - Date.now()) / 1000));
        }
        function clearCheckoutCooldownTimer() {
            if (!checkoutCooldownTimer) return;
            clearInterval(checkoutCooldownTimer);
            checkoutCooldownTimer = null;
        }
        function applyCheckoutButtonsState() {
            ensureBundleButtonDefaults();
            const allBtns = document.querySelectorAll('.bundle-buy-btn');
            const remaining = getCheckoutCooldownSeconds();
            if (remaining > 0) {
                const label = `Try again in ${formatRetryDelay(remaining)}`;
                allBtns.forEach((btn) => {
                    btn.disabled = true;
                    btn.textContent = label;
                });
                return;
            }
            if (checkoutRequestInFlight) {
                allBtns.forEach((btn) => { btn.disabled = true; });
                return;
            }
            allBtns.forEach((btn) => {
                btn.disabled = false;
                btn.textContent = btn.dataset.defaultLabel || 'Buy now';
            });
        }
        function startCheckoutCooldown(seconds) {
            const safeSeconds = Math.max(1, Math.ceil(Number(seconds) || 0));
            checkoutCooldownUntilMs = Date.now() + (safeSeconds * 1000);
            clearCheckoutCooldownTimer();
            applyCheckoutButtonsState();
            checkoutCooldownTimer = setInterval(() => {
                if (getCheckoutCooldownSeconds() <= 0) {
                    checkoutCooldownUntilMs = 0;
                    clearCheckoutCooldownTimer();
                }
                applyCheckoutButtonsState();
            }, 1000);
        }
        function getUploadCooldownSeconds() {
            if (!uploadCooldownUntilMs) return 0;
            return Math.max(0, Math.ceil((uploadCooldownUntilMs - Date.now()) / 1000));
        }
        function clearUploadCooldownTimer() {
            if (!uploadCooldownTimer) return;
            clearInterval(uploadCooldownTimer);
            uploadCooldownTimer = null;
        }
        function startUploadCooldown(seconds) {
            const safeSeconds = Math.max(1, Math.ceil(Number(seconds) || 0));
            uploadCooldownUntilMs = Date.now() + (safeSeconds * 1000);
            clearUploadCooldownTimer();
            updateProcessButton();
            uploadCooldownTimer = setInterval(() => {
                if (getUploadCooldownSeconds() <= 0) {
                    uploadCooldownUntilMs = 0;
                    clearUploadCooldownTimer();
                }
                updateProcessButton();
            }, 1000);
        }
        function hasEnoughCredits() {
            if (!userCredits) return false;
            const config = modeConfig[currentMode];
            if (config.creditType === 'lecture') return (userCredits.lecture_standard + userCredits.lecture_extended) > 0;
            if (config.creditType === 'slides') return userCredits.slides > 0;
            if (config.creditType === 'interview') {
                const extraCost = getInterviewExtraCost();
                return getTotalInterviewCredits() > 0 && userCredits.slides >= extraCost;
            }
            return false;
        }
        function formatEstimateDuration(seconds) {
            const safe = Math.max(20, Math.round(Number(seconds) || 0));
            if (safe < 60) return `${safe}s`;
            const mins = Math.round(safe / 60);
            return `${mins} min`;
        }
        function calculateProcessingEstimateSeconds() {
            const pdfMb = pdfFile ? (pdfFile.size / (1024 * 1024)) : 0;
            const audioMb = currentAudioBytes() / (1024 * 1024);
            if (currentMode === 'lecture-notes') {
                return 55 + (pdfMb * 0.6) + (audioMb * 1.0);
            }
            if (currentMode === 'slides-only') {
                return 20 + (pdfMb * 0.55);
            }
            const extrasCost = getInterviewExtraCost();
            return 35 + (audioMb * 1.15) + (extrasCost * 18);
        }
        function updateUploadEstimatePanel() {
            if (!uploadEstimate || !uploadEstimateTime || !uploadEstimateMeta) return;
            if (!currentUser || resultsLocked) {
                uploadEstimate.style.display = 'none';
                return;
            }
            uploadEstimate.style.display = '';
            const config = modeConfig[currentMode];
            const pdfReady = !config.needsPdf || Boolean(pdfFile);
            const audioReady = !config.needsAudio || Boolean(audioFile || (currentMode === 'lecture-notes' && importedAudioToken));
            const estimateSeconds = calculateProcessingEstimateSeconds();
            const low = Math.max(20, Math.round(estimateSeconds * 0.7));
            const high = Math.max(low + 10, Math.round(estimateSeconds * 1.35));
            const readyText = (pdfReady && audioReady)
                ? `Estimated processing time: ${formatEstimateDuration(low)} - ${formatEstimateDuration(high)}`
                : 'Upload required files to get a better estimate.';
            uploadEstimateTime.textContent = readyText;

            const totalBytes = (pdfFile ? Number(pdfFile.size || 0) : 0) + currentAudioBytes();
            const totalMb = totalBytes / (1024 * 1024);
            if (currentMode === 'lecture-notes') {
                uploadEstimateMeta.textContent = `Requires PDF or PPTX (max 50 MB) + audio (max 500 MB). Current upload: ${totalMb.toFixed(1)} MB.`;
            } else if (currentMode === 'slides-only') {
                uploadEstimateMeta.textContent = `Requires PDF or PPTX (max 50 MB). Current upload: ${totalMb.toFixed(1)} MB.`;
            } else {
                const extras = getInterviewExtraCost();
                uploadEstimateMeta.textContent = `Requires audio only (max 500 MB). Selected extras: ${extras} (${extras} slides credits). Current upload: ${totalMb.toFixed(1)} MB.`;
            }
        }
        function updateProcessButton() {
            const config = modeConfig[currentMode];
            const pdfReady = !config.needsPdf || pdfFile;
            const audioReady = !config.needsAudio || audioFile || (currentMode === 'lecture-notes' && importedAudioToken);
            const hasCredits = hasEnoughCredits();
            const uploadCooldown = getUploadCooldownSeconds();
            updateUploadEstimatePanel();
            if (uploadCooldown > 0) {
                processButton.disabled = true;
                processButton.querySelector('span').textContent = `Try again in ${formatRetryDelay(uploadCooldown)}`;
                noCreditsWarning.classList.remove('visible');
                return;
            }
            processButton.disabled = !(pdfReady && audioReady && hasCredits) || resultsLocked;
            processButton.querySelector('span').textContent = config.buttonText;
            if (currentUser && !hasCredits && !resultsLocked) {
                if (currentMode === 'interview' && getTotalInterviewCredits() > 0 && userCredits.slides < getInterviewExtraCost()) {
                    setSanitizedHtml(noCreditsWarning, "You don't have enough slides credits for the selected interview extras (slide-processing pipeline). <a href=\"#\" id=\"buy-credits-link-inline\">Buy more credits</a>");
                } else {
                    setSanitizedHtml(noCreditsWarning, "You don't have enough credits. <a href=\"#\" id=\"buy-credits-link-inline\">Buy more credits</a>");
                }
                noCreditsWarning.classList.add('visible');
                const inlineLink = document.getElementById('buy-credits-link-inline');
                if (inlineLink) {
                    inlineLink.addEventListener('click', (e) => {
                        e.preventDefault();
                        showPricingModal();
                    });
                }
            } else {
                noCreditsWarning.classList.remove('visible');
            }
        }
        function switchMode(mode) {
            currentMode = mode;
            const config = modeConfig[mode];
            modeTabs.forEach(tab => {
                const isActive = tab.dataset.mode === mode;
                tab.classList.toggle('active', isActive);
                tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
                tab.tabIndex = isActive ? 0 : -1;
            });
            modeDescriptionText.textContent = config.description;
            audioZoneTitle.textContent = config.audioTitle;
            generationControls.classList.toggle('hidden', mode === 'interview');
            generationControls.style.display = mode === 'interview' ? 'none' : 'grid';
            interviewControls.classList.toggle('hidden', mode !== 'interview');
            if (mode === 'interview') {
                studyToolsPanel.classList.remove('visible');
                studyToolsToggle.classList.remove('open');
            }
            updateModeCreditDisplay();
            if (config.needsPdf && config.needsAudio) {
                uploadSection.classList.remove('single-upload');
                pdfZone.classList.remove('hidden');
                audioZone.classList.remove('hidden');
            } else if (config.needsPdf) {
                uploadSection.classList.add('single-upload');
                pdfZone.classList.remove('hidden');
                audioZone.classList.add('hidden');
            } else {
                uploadSection.classList.add('single-upload');
                pdfZone.classList.add('hidden');
                audioZone.classList.remove('hidden');
            }
            if (!config.needsPdf) {
                pdfFile = null;
                pdfInput.value = '';
                pdfInfo.style.display = 'none';
                pdfZone.classList.remove('has-file');
            }
            if (!config.needsAudio) {
                audioFile = null;
                audioInput.value = '';
                releaseImportedAudioToken({ clearStatus: true });
                syncAudioInfoUI();
            }
            if (mode !== 'lecture-notes' && importedAudioToken) {
                releaseImportedAudioToken({ clearStatus: true });
                syncAudioInfoUI();
            }
            if (audioUrlImport) {
                audioUrlImport.style.display = mode === 'lecture-notes' ? '' : 'none';
            }
            setStudyFeature(selectedStudyFeatures);
            updateInterviewOptionsUI();
            updateProcessButton();
        }
        modeTabs.forEach(tab => tab.addEventListener('click', () => switchMode(tab.dataset.mode)));
        modeTabs.forEach((tab, index) => tab.addEventListener('keydown', (e) => {
            if (!modeTabs.length) return;
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault();
                const next = modeTabs[(index + 1) % modeTabs.length];
                switchMode(next.dataset.mode);
                next.focus();
            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault();
                const prev = modeTabs[(index - 1 + modeTabs.length) % modeTabs.length];
                switchMode(prev.dataset.mode);
                prev.focus();
            } else if (e.key === 'Home') {
                e.preventDefault();
                const first = modeTabs[0];
                switchMode(first.dataset.mode);
                first.focus();
            } else if (e.key === 'End') {
                e.preventDefault();
                const last = modeTabs[modeTabs.length - 1];
                switchMode(last.dataset.mode);
                last.focus();
            }
        }));
        advancedSettingsToggle.addEventListener('click', () => {
            const visible = !advancedSettingsBody.classList.contains('visible');
            setAdvancedSettingsVisible(visible);
            if (!visible) {
                setOutputLanguageMenuVisible(false);
                studyToolsPanel.classList.remove('visible');
                studyToolsToggle.classList.remove('open');
            }
        });

        function handlePdfFile(file) {
            if (!file) return;
            const lowerName = String(file.name || '').toLowerCase();
            const hasValidExt = allowedSlideExtensions.some(ext => lowerName.endsWith(ext));
            const mimeType = String(file.type || '').toLowerCase();
            const hasValidMime = allowedSlideMimeTypes.includes(mimeType);
            if (!hasValidExt || !hasValidMime) { showToast('Please select a valid PDF or PPTX file', 'error'); return; }
            if (file.size > 50 * 1024 * 1024) { showToast('Slide file must be under 50 MB', 'error'); return; }
            pdfFile = file;
            pdfName.textContent = file.name;
            pdfSize.textContent = formatFileSize(file.size);
            pdfInfo.style.display = 'flex';
            pdfZone.classList.add('has-file');
            updateProcessButton();
        }
        function handleAudioFile(file) {
            if (!file) return;
            const valid = ['.mp3', '.m4a', '.wav', '.aac', '.ogg', '.flac'];
            if (!valid.some(ext => file.name.toLowerCase().endsWith(ext))) { showToast('Please select a valid audio file', 'error'); return; }
            if (file.size > 500 * 1024 * 1024) { showToast('Audio file must be under 500 MB', 'error'); return; }
            if (importedAudioToken) {
                releaseImportedAudioToken({ clearStatus: true });
            }
            audioFile = file;
            syncAudioInfoUI();
            updateProcessButton();
        }
        function setupDropZone(zone, input, handler) {
            zone.addEventListener('click', (e) => { if (!e.target.closest('.file-remove')) input.click(); });
            input.addEventListener('change', (e) => { if (e.target.files.length) handler(e.target.files[0]); });
            zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
            zone.addEventListener('dragleave', (e) => { e.preventDefault(); zone.classList.remove('drag-over'); });
            zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('drag-over'); if (e.dataTransfer.files.length) handler(e.dataTransfer.files[0]); });
        }
        setupDropZone(pdfZone, pdfInput, handlePdfFile);
        setupDropZone(audioZone, audioInput, handleAudioFile);
        pdfRemove.addEventListener('click', (e) => { e.stopPropagation(); pdfFile = null; pdfInput.value = ''; pdfInfo.style.display = 'none'; pdfZone.classList.remove('has-file'); updateProcessButton(); });
        audioRemove.addEventListener('click', (e) => {
            e.stopPropagation();
            audioFile = null;
            audioInput.value = '';
            if (importedAudioToken) {
                releaseImportedAudioToken({ clearStatus: true });
            }
            syncAudioInfoUI();
            updateProcessButton();
        });

        function buildProgressSteps(steps) {
            progressSteps.innerHTML = '';
            progressSteps.classList.toggle('single-step', steps.length === 1);
            steps.forEach(s => {
                const el = document.createElement('div');
                el.className = 'progress-step';
                el.id = `step-${s.num}`;
                const indicator = document.createElement('div');
                indicator.className = 'step-indicator';
                indicator.textContent = String(s.num);
                const label = document.createElement('div');
                label.className = 'step-label';
                label.textContent = String(s.label || '');
                el.appendChild(indicator);
                el.appendChild(label);
                progressSteps.appendChild(el);
            });
        }
        function updateProgressUI(step, desc, total) {
            for (let i = 1; i <= total; i++) {
                const el = document.getElementById(`step-${i}`);
                if (!el) continue;
                el.classList.remove('active', 'complete');
                if (i < step) el.classList.add('complete');
                else if (i === step) el.classList.add('active');
            }
            statusText.textContent = desc || 'Processing...';
        }
        function getCurrentModeSteps() {
            if (currentMode === 'lecture-notes') {
                if (selectedStudyFeatures === 'none') return modeConfig['lecture-notes'].steps.slice(0, 3);
                return modeConfig['lecture-notes'].steps;
            }
            if (currentMode === 'slides-only') {
                if (selectedStudyFeatures === 'none') return modeConfig['slides-only'].steps.slice(0, 1);
                return modeConfig['slides-only'].steps;
            }
            if (selectedInterviewFeatures.length > 0) {
                return [{ num: 1, label: 'Transcribe' }, { num: 2, label: 'Create Extras' }];
            }
            return modeConfig['interview'].steps;
        }
        function scheduleNextPoll(delayMs) {
            if (pollInterval) clearTimeout(pollInterval);
            pollInterval = setTimeout(pollStatus, Math.max(0, delayMs || 0));
        }
        function setProgressRetryVisible(visible) {
            if (!progressRetry || !progressRetryBtn) return;
            progressRetry.style.display = visible ? 'flex' : 'none';
            if (visible) progressRetryBtn.disabled = false;
        }
        function retryStatusCheckNow() {
            if (!currentJobId) {
                showToast('No active job to retry.', 'info');
                setProgressRetryVisible(false);
                return;
            }
            setProgressRetryVisible(false);
            progressStatus.classList.remove('error');
            progressStatus.querySelector('.spinner').style.display = 'block';
            statusText.textContent = 'Re-checking job status...';
            trackEvent('processing_retry_requested', { job_id: currentJobId });
            startPolling();
        }
        function startPolling() {
            stopPolling();
            pollFailures = 0;
            pollStartedAt = Date.now();
            setProgressRetryVisible(false);
            scheduleNextPoll(0);
        }
        function stopPolling() {
            if (pollInterval) clearTimeout(pollInterval);
            pollInterval = null;
            pollFailures = 0;
            pollStartedAt = 0;
        }
        async function authenticatedFetch(path, options = {}, allowRefresh = true) {
            if (!currentUser) throw new Error('Please sign in');
            if (authClient && typeof authClient.authFetch === 'function') {
                const response = await authClient.authFetch(path, options, { retryOn401: allowRefresh !== false });
                if (authClient && typeof authClient.getToken === 'function') {
                    const latestToken = authClient.getToken();
                    if (latestToken) idToken = latestToken;
                }
                return response;
            }
            if (!idToken) idToken = await currentUser.getIdToken();
            const headers = { ...(options.headers || {}), 'Authorization': `Bearer ${idToken}` };
            const response = await fetch(path, { ...options, headers });
            if (response.status === 401 && allowRefresh) {
                idToken = await currentUser.getIdToken(true);
                return fetch(path, { ...options, headers: { ...(options.headers || {}), 'Authorization': `Bearer ${idToken}` } });
            }
            return response;
        }
        async function downloadAuthenticatedFile(path, fallbackName) {
            const response = await authenticatedFetch(path);
            if (!response.ok) {
                let message = 'Could not download file.';
                try {
                    const data = await response.json();
                    message = data.error || message;
                } catch (e) {}
                throw new Error(message);
            }
            if (downloadUtils.downloadResponseBlob) {
                await downloadUtils.downloadResponseBlob(response, fallbackName);
                return;
            }
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fallbackName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }
        async function exportMyAccountData() {
            if (!currentUser) {
                showAuthModal('signin');
                return;
            }
            if (accountActionInFlight) return;
            accountActionInFlight = true;
            try {
                const fallbackName = `lecture-processor-account-export-${localDateString()}.json`;
                await downloadAuthenticatedFile('/api/account/export', fallbackName);
                showToast('Your data export has been downloaded.', 'success', 5000);
            } catch (e) {
                captureClientError(e, 'account_export');
                showToast(e.message || 'Could not export your data.', 'error', 5000);
            } finally {
                accountActionInFlight = false;
            }
        }
        async function deleteMyAccountData() {
            if (!currentUser) {
                showAuthModal('signin');
                return;
            }
            if (accountActionInFlight) return;
            const expectedEmail = String(currentUser.email || '').trim();
            if (!expectedEmail) {
                showToast('Could not verify account email. Please sign in again.', 'error', 5000);
                return;
            }

            const confirmText = window.prompt(
                'This will permanently delete your account and stored data.\n\nType DELETE MY ACCOUNT to continue.'
            );
            if (confirmText === null) return;
            if (confirmText.trim().toUpperCase() !== 'DELETE MY ACCOUNT') {
                showToast('Deletion cancelled: confirmation text did not match.', 'info', 4500);
                return;
            }

            const confirmEmail = window.prompt(`Type your account email to confirm:\n${expectedEmail}`);
            if (confirmEmail === null) return;
            if (confirmEmail.trim().toLowerCase() !== expectedEmail.toLowerCase()) {
                showToast('Deletion cancelled: email did not match.', 'info', 4500);
                return;
            }

            if (!window.confirm('Final confirmation: this action is permanent and cannot be undone. Delete now?')) {
                return;
            }

            accountActionInFlight = true;
            try {
                const response = await authenticatedFetch('/api/account/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        confirm_text: 'DELETE MY ACCOUNT',
                        confirm_email: expectedEmail,
                    }),
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) {
                    throw new Error(data.error || 'Could not delete account data.');
                }

                showToast('Account deleted. Signing out...', 'success', 5000);
                try {
                    await auth.signOut();
                } catch (_) {}
                window.location.href = '/';
            } catch (e) {
                captureClientError(e, 'account_delete');
                showToast(e.message || 'Could not delete account data.', 'error', 6000);
            } finally {
                accountActionInFlight = false;
            }
        }
        async function pollStatus() {
            if (!currentJobId) return;
            if (pollStartedAt && (Date.now() - pollStartedAt) > POLL_MAX_RUNTIME_MS) {
                stopPolling();
                progressStatus.classList.add('error');
                progressStatus.querySelector('.spinner').style.display = 'none';
                statusText.textContent = 'Still processing on the server. Use retry to check now, or check again in a minute.';
                showToast('Processing is taking longer than expected. Please check again shortly.', 'info', 6000);
                if (currentJobId && trackedTerminalJobId !== currentJobId) {
                    trackedTerminalJobId = currentJobId;
                    trackEvent('processing_timeout', { job_id: currentJobId });
                }
                setProgressRetryVisible(true);
                updateProcessButton();
                return;
            }
            try {
                const r = await authenticatedFetch(`/status/${currentJobId}`);
                if (r.status === 401) {
                    stopPolling();
                    setProgressRetryVisible(false);
                    showAuthModal('signin');
                    return;
                }
                if (r.status === 403) {
                    stopPolling();
                    setProgressRetryVisible(false);
                    showError('You do not have access to this job.');
                    return;
                }
                const d = await r.json();
                if (d.error && d.status !== 'error') {
                    stopPolling();
                    setProgressRetryVisible(false);
                    showToast('Error: Job not found', 'error');
                    return;
                }
                updateProgressUI(d.step, d.step_description, d.total_steps);
                if (d.status === 'complete') {
                    stopPolling();
                    setProgressRetryVisible(false);
                    if (currentJobId && trackedTerminalJobId !== currentJobId) {
                        trackedTerminalJobId = currentJobId;
                        trackEvent('processing_completed', { job_id: currentJobId });
                    }
                    showResults(
                        d.result,
                        d.slide_text,
                        d.transcript,
                        d.flashcards || [],
                        d.test_questions || [],
                        d.study_generation_error || null,
                        d.study_pack_id || null,
                        d.study_features || 'none',
                        d.interview_summary || '',
                        d.interview_sections || '',
                        d.interview_combined || '',
                        d.interview_features_successful || [],
                        d.billing_receipt || null
                    );
                    fetchUserData();
                } else if (d.status === 'error') {
                    stopPolling();
                    setProgressRetryVisible(false);
                    if (currentJobId && trackedTerminalJobId !== currentJobId) {
                        trackedTerminalJobId = currentJobId;
                        trackEvent('processing_failed', { job_id: currentJobId, credit_refunded: Boolean(d.credit_refunded) });
                    }
                    showError(d.error, d.credit_refunded, d.billing_receipt || null);
                } else {
                    setProgressRetryVisible(false);
                    pollFailures = 0;
                    scheduleNextPoll(POLL_BASE_MS);
                }
            } catch (e) {
                console.error(e);
                captureClientError(e, 'poll_status');
                pollFailures += 1;
                const backoff = Math.min(POLL_MAX_MS, POLL_BASE_MS * Math.pow(2, Math.min(pollFailures, 5)));
                statusText.textContent = `Temporary connection issue. Retrying in ${Math.ceil(backoff / 1000)}s...`;
                scheduleNextPoll(backoff);
            }
        }
        async function processFiles() {
            if (!currentUser) { showAuthModal('signin'); return; }
            if (resultsLocked) {
                showToast('Click "Process Another File" to start a new generation.', 'info');
                return;
            }
            const cooldown = getUploadCooldownSeconds();
            if (cooldown > 0) {
                showToast(`Upload temporarily limited. Try again in ${formatRetryDelay(cooldown)}.`, 'info', 4500);
                updateProcessButton();
                return;
            }
            const config = modeConfig[currentMode];
            const fd = new FormData();
            fd.append('mode', currentMode);
            if (config.needsPdf && pdfFile) fd.append('pdf', pdfFile);
            if (config.needsAudio && audioFile) fd.append('audio', audioFile);
            if (currentMode === 'lecture-notes' && config.needsAudio && importedAudioToken && !audioFile) {
                fd.append('audio_import_token', importedAudioToken);
            }
            const selectedLanguage = outputLanguageSelect.value || 'english';
            fd.append('output_language', selectedLanguage);
            if (selectedLanguage === 'other') {
                const customLanguage = outputLanguageCustom.value.trim();
                if (!customLanguage) {
                    showToast('Please enter a custom output language.', 'error');
                    return;
                }
                fd.append('output_language_custom', customLanguage);
            }
            if (currentMode !== 'interview') {
                fd.append('flashcard_amount', selectedFlashcardAmount);
                fd.append('question_amount', selectedQuestionAmount);
                fd.append('study_features', selectedStudyFeatures);
            } else {
                fd.append('interview_features', getInterviewFeaturesValue());
            }
            const steps = getCurrentModeSteps();
            buildProgressSteps(steps);
            processButton.disabled = true;
            setProgressRetryVisible(false);
            progressSection.classList.add('visible');
            resultsSection.classList.remove('visible');
            progressStatus.classList.remove('error');
            progressStatus.querySelector('.spinner').style.display = 'block';
            updateProgressUI(0, 'Uploading files...', steps.length);
            trackEvent('process_clicked', {
                study_features: selectedStudyFeatures,
                flashcard_amount: selectedFlashcardAmount,
                question_amount: selectedQuestionAmount,
                interview_features_count: selectedInterviewFeatures.length,
            });
            try {
                const r = await authenticatedFetch('/upload', { method: 'POST', body: fd });
                const d = await r.json();
                if (d.error) {
                    trackEvent('processing_failed', { reason: d.error || 'upload_failed' });
                    if (typeof d.error === 'string' && d.error.toLowerCase().includes('imported audio token')) {
                        clearImportedAudioLocalState();
                        syncAudioInfoUI();
                    }
                    if (r.status === 401) showAuthModal();
                    else if (r.status === 402) { showError('No credits remaining. Please purchase more credits.'); noCreditsWarning.classList.add('visible'); }
                    else if (r.status === 429) {
                        const retryAfter = getRetryAfterSeconds(r, d);
                        const retryMsg = retryAfter ? `${d.error} Try again in ${formatRetryDelay(retryAfter)}.` : d.error;
                        if (retryAfter > 0) startUploadCooldown(retryAfter);
                        showError(retryMsg);
                        showToast(retryMsg, 'info', 6000);
                    } else showError(d.error);
                    return;
                }
                currentJobId = d.job_id;
                trackedTerminalJobId = '';
                trackEvent('processing_started', {
                    job_id: currentJobId,
                    study_features: selectedStudyFeatures,
                    interview_features_count: selectedInterviewFeatures.length,
                });
                startPolling();
            } catch (e) {
                captureClientError(e, 'process_files');
                showError('Failed to upload files. Please try again.');
            }
        }
        processButton.addEventListener('click', processFiles);

        function simpleMarkdownToHtml(md) {
            if (markdownUtils.parseMarkdownToSafeHtml) {
                return markdownUtils.parseMarkdownToSafeHtml(md);
            }
            return escapeHtml(String(md || '')).replace(/\n/g, '<br>');
        }
        function buildDownloadDropdown() {
            const options = [];
            const addPair = (type, label) => {
                options.push({ type, format: 'md', label, detail: 'Markdown (.md)' });
                options.push({ type, format: 'docx', label, detail: 'Word Document (.docx)' });
            };
            if (currentMode === 'lecture-notes') {
                addPair('result', DOWNLOAD_LABELS.lectureNotes);
                options.push({ divider: true });
                addPair('slides', DOWNLOAD_LABELS.slideExtract);
                options.push({ divider: true });
                addPair('transcript', DOWNLOAD_LABELS.lectureTranscript);
            } else if (currentMode === 'slides-only') {
                addPair('result', DOWNLOAD_LABELS.slideExtract);
            } else {
                addPair('result', DOWNLOAD_LABELS.interviewTranscript);
                if (interviewSummaryText && interviewSectionsText && interviewCombinedText) {
                    options.push({ divider: true });
                    addPair('combined', 'Summary + Structured Transcript');
                } else {
                    if (interviewSummaryText) {
                        options.push({ divider: true });
                        addPair('summary', 'Interview Summary');
                    }
                    if (interviewSectionsText) {
                        options.push({ divider: true });
                        addPair('sections', 'Structured Transcript');
                    }
                }
                if (transcript) {
                    options.push({ divider: true });
                    addPair('transcript', 'Raw Transcript');
                }
            }
            while (downloadDropdownContent.firstChild) downloadDropdownContent.removeChild(downloadDropdownContent.firstChild);
            options.forEach((option) => {
                if (option.divider) {
                    const divider = document.createElement('div');
                    divider.className = 'dropdown-divider';
                    downloadDropdownContent.appendChild(divider);
                    return;
                }
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'dropdown-item';
                item.setAttribute('role', 'menuitem');
                item.dataset.type = option.type;
                item.dataset.format = option.format;
                item.append(document.createTextNode(option.label));
                const detail = document.createElement('span');
                detail.textContent = option.detail;
                item.appendChild(detail);
                item.addEventListener('click', () => {
                    downloadFile(option.type, option.format);
                    setDownloadDropdownVisible(false);
                });
                downloadDropdownContent.appendChild(item);
            });
        }
        async function downloadFile(type, format) {
            let content = resultMarkdown;
            let filename = 'output.md';
            if (type === 'slides') { content = slideText; filename = format === 'md' ? 'slide-extract.md' : 'slide-extract.docx'; }
            else if (type === 'transcript') { content = transcript; filename = format === 'md' ? 'lecture-transcript.md' : 'lecture-transcript.docx'; }
            else if (type === 'summary') { content = interviewSummaryText || resultMarkdown; filename = format === 'md' ? 'interview-summary.md' : 'interview-summary.docx'; }
            else if (type === 'sections') { content = interviewSectionsText || resultMarkdown; filename = format === 'md' ? 'interview-structured.md' : 'interview-structured.docx'; }
            else if (type === 'combined') { content = interviewCombinedText || resultMarkdown; filename = format === 'md' ? 'interview-summary-structured.md' : 'interview-summary-structured.docx'; }
            else if (currentMode === 'lecture-notes') filename = format === 'md' ? 'lecture-notes.md' : 'lecture-notes.docx';
            else if (currentMode === 'slides-only') filename = format === 'md' ? 'slide-extract.md' : 'slide-extract.docx';
            else filename = format === 'md' ? 'interview-transcript.md' : 'interview-transcript.docx';
            if (format === 'md') {
                const blob = new Blob([content], { type: 'text/markdown' });
                if (downloadUtils.saveBlobAsFile) {
                    downloadUtils.saveBlobAsFile(blob, filename);
                } else {
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = filename;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                }
                showToast('Download started', 'success');
            } else {
                if (!currentJobId) return;
                try {
                    await downloadAuthenticatedFile(`/download-docx/${currentJobId}?type=${encodeURIComponent(type)}`, filename);
                    showToast('Download started', 'success');
                } catch (e) {
                    showToast(e.message || 'Could not download file.', 'error');
                }
            }
        }

        function updateExportCsvButton() {
            if (currentMode === 'interview') {
                exportStudyCsvBtn.style.display = 'none';
                return;
            }
            if (activeResultsTab === 'test' && testQuestions.length) {
                exportCsvType = 'test';
                exportStudyCsvText.textContent = 'Export Practice Test CSV';
                exportStudyCsvBtn.style.display = 'flex';
                return;
            }
            if (flashcards.length) {
                exportCsvType = 'flashcards';
                exportStudyCsvText.textContent = 'Export Flashcards CSV';
                exportStudyCsvBtn.style.display = 'flex';
                return;
            }
            if (testQuestions.length) {
                exportCsvType = 'test';
                exportStudyCsvText.textContent = 'Export Practice Test CSV';
                exportStudyCsvBtn.style.display = 'flex';
                return;
            }
            exportStudyCsvBtn.style.display = 'none';
        }
        function setActiveResultsTab(tab) {
            activeResultsTab = tab;
            tabButtons.forEach(btn => {
                const isActive = btn.dataset.tab === tab;
                btn.classList.toggle('active', isActive);
                btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
                btn.tabIndex = isActive ? 0 : -1;
            });
            paneNotes.classList.toggle('active', tab === 'notes');
            paneNotes.hidden = tab !== 'notes';
            paneFlashcards.classList.toggle('active', tab === 'flashcards');
            paneFlashcards.hidden = tab !== 'flashcards';
            paneTest.classList.toggle('active', tab === 'test');
            paneTest.hidden = tab !== 'test';
            updateExportCsvButton();
        }
        tabButtons.forEach(btn => btn.addEventListener('click', () => setActiveResultsTab(btn.dataset.tab)));
        tabButtons.forEach((btn, index) => btn.addEventListener('keydown', (e) => {
            if (!tabButtons.length) return;
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault();
                const next = tabButtons[(index + 1) % tabButtons.length];
                setActiveResultsTab(next.dataset.tab);
                next.focus();
            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault();
                const prev = tabButtons[(index - 1 + tabButtons.length) % tabButtons.length];
                setActiveResultsTab(prev.dataset.tab);
                prev.focus();
            } else if (e.key === 'Home') {
                e.preventDefault();
                const first = tabButtons[0];
                setActiveResultsTab(first.dataset.tab);
                first.focus();
            } else if (e.key === 'End') {
                e.preventDefault();
                const last = tabButtons[tabButtons.length - 1];
                setActiveResultsTab(last.dataset.tab);
                last.focus();
            }
        }));

        function renderFlashcard() {
            if (!flashcards.length) {
                flashcardEmpty.style.display = 'block';
                flashcardCard.style.display = 'none';
                flashcardProgress.textContent = 'Card 0 of 0';
                flashcardPrevBtn.disabled = true;
                flashcardNextBtn.disabled = true;
                flashcardFlipBtn.disabled = true;
                return;
            }
            flashcardEmpty.style.display = 'none';
            flashcardCard.style.display = 'block';
            const card = flashcards[flashcardIndex];
            flashcardFrontText.textContent = card.front;
            flashcardBackText.textContent = card.back;
            flashcardInner.classList.toggle('flipped', flashcardFlipped);
            flashcardProgress.textContent = `Card ${flashcardIndex + 1} of ${flashcards.length}`;
            flashcardPrevBtn.disabled = flashcardIndex === 0;
            flashcardNextBtn.disabled = flashcardIndex === flashcards.length - 1;
            flashcardFlipBtn.disabled = false;
        }
        function goFlashcard(offset) {
            if (!flashcards.length) return;
            flashcardIndex = Math.max(0, Math.min(flashcards.length - 1, flashcardIndex + offset));
            flashcardFlipped = false;
            renderFlashcard();
        }
        function flipFlashcard() {
            if (!flashcards.length) return;
            flashcardFlipped = !flashcardFlipped;
            renderFlashcard();
        }
        flashcardCard.addEventListener('click', flipFlashcard);
        flashcardPrevBtn.addEventListener('click', () => goFlashcard(-1));
        flashcardNextBtn.addEventListener('click', () => goFlashcard(1));
        flashcardFlipBtn.addEventListener('click', flipFlashcard);

        function renderQuizQuestion() {
            if (!testQuestions.length) {
                quizEmpty.style.display = 'block';
                quizQuestionText.textContent = '';
                quizOptions.innerHTML = '';
                quizExplanation.classList.remove('visible');
                quizNextBtn.style.display = 'none';
                quizProgress.textContent = 'Question 0 of 0';
                quizScoreEl.textContent = 'Score: 0/0';
                return;
            }
            quizEmpty.style.display = 'none';
            const q = testQuestions[quizIndex];
            quizAnswered = false;
            quizProgress.textContent = `Question ${quizIndex + 1} of ${testQuestions.length}`;
            quizScoreEl.textContent = `Score: ${quizScore}/${testQuestions.length}`;
            quizQuestionText.textContent = q.question;
            quizOptions.innerHTML = '';
            quizExplanation.classList.remove('visible');
            quizExplanation.textContent = '';
            q.options.forEach(option => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'quiz-option';
                btn.textContent = option;
                btn.addEventListener('click', () => answerQuizOption(btn, option));
                quizOptions.appendChild(btn);
            });
            quizNextBtn.style.display = 'none';
        }
        function answerQuizOption(clickedBtn, selectedOption) {
            if (quizAnswered) return;
            quizAnswered = true;
            const q = testQuestions[quizIndex];
            const optionButtons = [...quizOptions.querySelectorAll('.quiz-option')];
            optionButtons.forEach(btn => {
                btn.disabled = true;
                if (btn.textContent === q.answer) btn.classList.add('correct');
            });
            if (selectedOption === q.answer) {
                clickedBtn.classList.add('correct');
                quizScore += 1;
            } else {
                clickedBtn.classList.add('wrong');
            }
            quizScoreEl.textContent = `Score: ${quizScore}/${testQuestions.length}`;
            quizExplanation.textContent = q.explanation;
            quizExplanation.classList.add('visible');
            quizNextBtn.style.display = (quizIndex < testQuestions.length - 1) ? 'inline-flex' : 'none';
        }
        quizNextBtn.addEventListener('click', () => {
            if (quizIndex < testQuestions.length - 1) {
                quizIndex += 1;
                renderQuizQuestion();
            }
        });

        function showResults(md, slides, trans, generatedFlashcards, generatedQuestions, generationError, studyPackId, studyFeatures, summaryText, sectionsText, combinedText, successfulInterviewFeatures, billingReceipt) {
            const config = modeConfig[currentMode];
            resultMarkdown = md || '';
            slideText = slides || '';
            transcript = trans || '';
            flashcards = Array.isArray(generatedFlashcards) ? generatedFlashcards : [];
            testQuestions = Array.isArray(generatedQuestions) ? generatedQuestions : [];
            interviewSummaryText = summaryText || '';
            interviewSectionsText = sectionsText || '';
            interviewCombinedText = combinedText || '';
            studyGenerationError = generationError;
            currentStudyPackId = studyPackId;
            currentBillingReceipt = billingReceipt && typeof billingReceipt === 'object' ? billingReceipt : null;
            resultsLocked = true;
            updateQuickstartVisibility();
            resultsTitleText.textContent = config.resultTitle;
            setSanitizedHtml(resultsContent, simpleMarkdownToHtml(resultMarkdown), {
                ALLOWED_TAGS: ['h1', 'h2', 'h3', 'p', 'br', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li', 'blockquote', 'a', 'hr'],
                ALLOWED_ATTR: ['href', 'title', 'target', 'rel'],
            });
            flashcardCountBadge.textContent = String(flashcards.length);
            testCountBadge.textContent = String(testQuestions.length);
            const successfulSet = new Set(Array.isArray(successfulInterviewFeatures) ? successfulInterviewFeatures : []);
            if (currentMode === 'interview') {
                if (studyGenerationError) {
                    studyWarning.style.display = 'block';
                    studyWarning.textContent = studyGenerationError;
                } else if (!selectedInterviewFeatures.length) {
                    studyWarning.style.display = 'block';
                    studyWarning.textContent = 'No interview extras selected. Showing the transcript only.';
                } else if (successfulSet.size < selectedInterviewFeatures.length) {
                    const failed = selectedInterviewFeatures.length - successfulSet.size;
                    studyWarning.style.display = 'block';
                    studyWarning.textContent = `Some interview extras could not be generated (${failed} failed). Failed extras were refunded as slides credits.`;
                } else {
                    studyWarning.style.display = 'none';
                    studyWarning.textContent = '';
                }
            } else if (studyGenerationError) {
                studyWarning.style.display = 'block';
                studyWarning.textContent = studyGenerationError;
            } else if (studyFeatures === 'none') {
                studyWarning.style.display = 'block';
                studyWarning.textContent = 'Study tools were disabled for this generation (Notes-only mode).';
            } else {
                studyWarning.style.display = 'none';
                studyWarning.textContent = '';
            }
            renderBillingReceipt(currentMode === 'interview' ? currentBillingReceipt : null);

            flashcardIndex = 0;
            flashcardFlipped = false;
            quizIndex = 0;
            quizScore = 0;
            renderFlashcard();
            renderQuizQuestion();
            document.getElementById('tab-flashcards').style.display = currentMode === 'interview' ? 'none' : 'flex';
            document.getElementById('tab-test').style.display = currentMode === 'interview' ? 'none' : 'flex';
            setActiveResultsTab('notes');
            document.getElementById('tab-flashcards').disabled = currentMode === 'interview' || !flashcards.length;
            document.getElementById('tab-test').disabled = currentMode === 'interview' || !testQuestions.length;

            progressSection.classList.remove('visible');
            setProgressRetryVisible(false);
            resultsSection.classList.add('visible');
            buildDownloadDropdown();
            updateExportCsvButton();
            updateProcessButton();
            showToast('Processing complete!', 'success');
        }
        function showError(msg, creditRefunded, billingReceipt) {
            setProgressRetryVisible(false);
            renderBillingReceipt(null);
            progressStatus.classList.add('error');
            progressStatus.querySelector('.spinner').style.display = 'none';
            const billingReceiptText = buildBillingReceiptText(billingReceipt);
            if (creditRefunded) {
                statusText.textContent = `Error: ${msg} — Your credit has been refunded.`;
                showToast('Processing failed. Your credit has been refunded.', 'info', 5000);
                fetchUserData();
            } else {
                statusText.textContent = `Error: ${msg}`;
            }
            if (billingReceiptText) {
                showToast(billingReceiptText, 'info', 5500);
            }
            updateProcessButton();
        }
        function resetResultsState() {
            resultMarkdown = '';
            slideText = '';
            transcript = '';
            flashcards = [];
            testQuestions = [];
            interviewSummaryText = '';
            interviewSectionsText = '';
            interviewCombinedText = '';
            currentBillingReceipt = null;
            currentStudyPackId = null;
            resultsLocked = false;
            updateQuickstartVisibility();
            flashcardCountBadge.textContent = '0';
            testCountBadge.textContent = '0';
            studyWarning.style.display = 'none';
            renderBillingReceipt(null);
            exportStudyCsvBtn.style.display = 'none';
            document.getElementById('tab-flashcards').style.display = 'flex';
            document.getElementById('tab-test').style.display = 'flex';
            document.getElementById('tab-flashcards').disabled = false;
            document.getElementById('tab-test').disabled = false;
            setActiveResultsTab('notes');
        }

        function showPricingModal() {
            openOverlay(pricingOverlay);
            applyCheckoutButtonsState();
        }
        function hidePricingModal() { closeOverlay(pricingOverlay); }
        function showHistoryModal() { openOverlay(historyOverlay); loadPurchaseHistory(); }
        function hideHistoryModal() { closeOverlay(historyOverlay); }
        function formatPrice(cents, currency) { const amount = (cents / 100).toFixed(2); return currency === 'eur' ? `€${amount}` : `${amount} ${currency.toUpperCase()}`; }
        function formatCreditsText(credits) { return Object.entries(credits).map(([k, v]) => `${v} ${k.replace(/_/g, ' ').replace('credits ', '').replace('credits', '').trim()}`).join(', '); }
        function setHistoryMessage(message, loading = false) {
            while (historyList.firstChild) historyList.removeChild(historyList.firstChild);
            const wrapper = document.createElement('div');
            wrapper.className = loading ? 'history-loading' : 'history-empty';
            if (loading) {
                const spinner = document.createElement('div');
                spinner.className = 'spinner';
                wrapper.appendChild(spinner);
            }
            const text = document.createElement('span');
            text.textContent = message;
            wrapper.appendChild(text);
            historyList.appendChild(wrapper);
        }
        function setHistoryLoadingSkeleton() {
            while (historyList.firstChild) historyList.removeChild(historyList.firstChild);
            const wrapper = document.createElement('div');
            wrapper.className = 'history-skeleton-list';
            for (let i = 0; i < 3; i += 1) {
                const item = document.createElement('div');
                item.className = 'history-skeleton-item';

                const left = document.createElement('div');
                left.className = 'history-skeleton-left';
                const title = document.createElement('div');
                title.className = 'history-skeleton-line title';
                const meta = document.createElement('div');
                meta.className = 'history-skeleton-line meta';
                const subMeta = document.createElement('div');
                subMeta.className = 'history-skeleton-line submeta';
                left.appendChild(title);
                left.appendChild(meta);
                left.appendChild(subMeta);

                const price = document.createElement('div');
                price.className = 'history-skeleton-price';

                item.appendChild(left);
                item.appendChild(price);
                wrapper.appendChild(item);
            }
            historyList.appendChild(wrapper);
        }
        function setHistoryEmptyState() {
            while (historyList.firstChild) historyList.removeChild(historyList.firstChild);
            const wrapper = document.createElement('div');
            wrapper.className = 'history-empty';
            const title = document.createElement('span');
            title.textContent = 'No purchases yet';
            const note = document.createElement('div');
            note.className = 'history-empty-note';
            note.textContent = 'You can keep using free credits or buy a bundle when you need more.';
            const action = document.createElement('button');
            action.type = 'button';
            action.className = 'history-empty-action';
            action.textContent = 'Buy credits';
            action.addEventListener('click', () => {
                hideHistoryModal();
                showPricingModal();
            });
            wrapper.appendChild(title);
            wrapper.appendChild(note);
            wrapper.appendChild(action);
            historyList.appendChild(wrapper);
        }
        async function loadPurchaseHistory() {
            setHistoryLoadingSkeleton();
            if (!currentUser) return;
            try {
                const r = await authenticatedFetch('/api/purchase-history');
                const d = await r.json();
                if (!d.purchases || !d.purchases.length) {
                    setHistoryEmptyState();
                    return;
                }
                while (historyList.firstChild) historyList.removeChild(historyList.firstChild);
                d.purchases.forEach(p => {
                    const date = new Date(p.created_at * 1000);
                    const row = document.createElement('div');
                    row.className = 'history-item';

                    const left = document.createElement('div');
                    left.className = 'history-item-left';
                    const name = document.createElement('div');
                    name.className = 'history-item-name';
                    name.textContent = p.bundle_name || '-';
                    const dateEl = document.createElement('div');
                    dateEl.className = 'history-item-date';
                    dateEl.textContent = `${date.toLocaleDateString('en-GB')} at ${date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
                    const credits = document.createElement('div');
                    credits.className = 'history-item-credits';
                    credits.textContent = formatCreditsText(p.credits || {});
                    left.appendChild(name);
                    left.appendChild(dateEl);
                    left.appendChild(credits);

                    const price = document.createElement('div');
                    price.className = 'history-item-price';
                    price.textContent = formatPrice(p.price_cents || 0, p.currency || 'eur');
                    row.appendChild(left);
                    row.appendChild(price);
                    historyList.appendChild(row);
                });
            } catch (e) {
                setHistoryMessage('Could not load purchase history. Please try again.');
            }
        }
        async function purchaseBundle(bundleId) {
            if (!currentUser) { hidePricingModal(); showAuthModal(); return; }
            const remaining = getCheckoutCooldownSeconds();
            if (remaining > 0) {
                applyCheckoutButtonsState();
                showToast(`Checkout temporarily limited. Try again in ${formatRetryDelay(remaining)}.`, 'info', 4500);
                return;
            }
            if (checkoutRequestInFlight) return;
            checkoutRequestInFlight = true;
            const allBtns = document.querySelectorAll('.bundle-buy-btn');
            allBtns.forEach(btn => { btn.disabled = true; if (btn.dataset.bundleId === bundleId) btn.textContent = 'Redirecting...'; });
            try {
                trackEvent('checkout_started', { bundle_id: bundleId }, { preferBeacon: true });
                const r = await authenticatedFetch('/api/create-checkout-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bundle_id: bundleId }) });
                const d = await r.json();
                if (d.error) {
                    if (r.status === 429) {
                        const retryAfter = getRetryAfterSeconds(r, d);
                        const retryMsg = retryAfter ? `${d.error} Try again in ${formatRetryDelay(retryAfter)}.` : d.error;
                        showToast(retryMsg, 'info', 6000);
                        checkoutRequestInFlight = false;
                        if (retryAfter > 0) startCheckoutCooldown(retryAfter);
                        else applyCheckoutButtonsState();
                    } else {
                        showToast(d.error, 'error');
                        checkoutRequestInFlight = false;
                        applyCheckoutButtonsState();
                    }
                    return;
                }
                if (d.checkout_url) {
                    window.location.href = d.checkout_url;
                    return;
                }
                showToast('Could not start checkout. Please try again.', 'error');
                checkoutRequestInFlight = false;
                applyCheckoutButtonsState();
            } catch (e) {
                captureClientError(e, 'purchase_bundle');
                showToast('Something went wrong. Please try again.', 'error');
                checkoutRequestInFlight = false;
                applyCheckoutButtonsState();
            }
        }
        async function confirmCheckoutSession(sessionId) {
            if (!sessionId) return { ok: false, status: 'missing_session' };
            if (!currentUser) return { ok: false, status: 'not_signed_in' };
            try {
                const response = await authenticatedFetch(`/api/confirm-checkout-session?session_id=${encodeURIComponent(sessionId)}`);
                const data = await response.json();
                if (!response.ok) {
                    return { ok: false, status: data.error || 'confirm_failed' };
                }
                return { ok: true, status: data.status || 'granted' };
            } catch (e) {
                captureClientError(e, 'confirm_checkout_session');
                return { ok: false, status: 'confirm_failed' };
            }
        }
        async function checkPaymentResult() {
            const params = new URLSearchParams(window.location.search);
            const status = params.get('payment');
            const sessionId = params.get('session_id');
            if (status === 'success') {
                let confirmed = false;
                if (sessionId) {
                    const result = await confirmCheckoutSession(sessionId);
                    confirmed = result.ok;
                }
                if (confirmed) {
                    showToast('Payment successful! Your credits have been added.', 'success', 5000);
                    trackEvent('payment_confirmed', { session_id: sessionId || '' }, { preferBeacon: true });
                } else {
                    showToast('Payment received. Credits may take a few seconds to appear.', 'info', 5000);
                }
                window.history.replaceState({}, '', window.location.pathname);
                setTimeout(() => { if (currentUser) fetchUserData(); }, 1000);
                setTimeout(() => { if (currentUser) fetchUserData(); }, 4000);
            } else if (status === 'cancelled') {
                showToast('Payment cancelled. No charges were made.', 'info', 4000);
                trackEvent('payment_cancelled', {}, { preferBeacon: true });
                window.history.replaceState({}, '', window.location.pathname);
            }
        }

        headerSignInBtn.addEventListener('click', () => showAuthModal('signin'));
        signInToProcessBtn.addEventListener('click', () => showAuthModal('signin'));
        authModalClose.addEventListener('click', hideAuthModal);
        authOverlay.addEventListener('click', (e) => { if (e.target === authOverlay) hideAuthModal(); });
        switchToSignup.addEventListener('click', (e) => { e.preventDefault(); showAuthView('signup'); });
        switchToSignin.addEventListener('click', (e) => { e.preventDefault(); showAuthView('signin'); });
        forgotPasswordLink.addEventListener('click', (e) => { e.preventDefault(); showAuthView('reset'); });
        backToSignin.addEventListener('click', (e) => { e.preventDefault(); showAuthView('signin'); });
        signinForm.addEventListener('submit', async (e) => { e.preventDefault(); await signInWithEmail(signinEmail.value.trim(), signinPassword.value); });
        signupForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (signupPassword.value !== signupPasswordConfirm.value) { showAuthError(signupError, 'Passwords do not match.'); return; }
            await signUpWithEmail(signupEmail.value.trim(), signupPassword.value);
        });
        resetForm.addEventListener('submit', async (e) => { e.preventDefault(); await sendPasswordReset(resetEmail.value.trim()); });
        googleSignInBtn.addEventListener('click', signInWithGoogle);
        googleSignUpBtn.addEventListener('click', signInWithGoogle);
        document.querySelectorAll('.password-toggle').forEach(btn => {
            btn.addEventListener('click', () => {
                const input = document.getElementById(btn.dataset.target);
                const open = btn.querySelector('.eye-open');
                const closed = btn.querySelector('.eye-closed');
                if (input.type === 'password') { input.type = 'text'; open.style.display = 'none'; closed.style.display = 'block'; }
                else { input.type = 'password'; open.style.display = 'block'; closed.style.display = 'none'; }
            });
        });
        signOutBtn.addEventListener('click', signOut);
        userButton.addEventListener('click', (e) => {
            e.stopPropagation();
            const nextVisible = !userDropdown.classList.contains('visible');
            closeHeaderDropdowns(nextVisible ? 'user' : '');
            setUserDropdownVisible(nextVisible);
        });
        userButton.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                closeHeaderDropdowns('user');
                setUserDropdownVisible(true);
                focusMenuItem(userDropdown, '.user-dropdown-item', 'first');
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                closeHeaderDropdowns('user');
                setUserDropdownVisible(true);
                focusMenuItem(userDropdown, '.user-dropdown-item', 'last');
            }
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                const nextVisible = !userDropdown.classList.contains('visible');
                closeHeaderDropdowns(nextVisible ? 'user' : '');
                setUserDropdownVisible(nextVisible);
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                setUserDropdownVisible(false);
            }
        });
        userDropdown.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); focusMenuItem(userDropdown, '.user-dropdown-item', 'next'); }
            if (e.key === 'ArrowUp') { e.preventDefault(); focusMenuItem(userDropdown, '.user-dropdown-item', 'prev'); }
            if (e.key === 'Home') { e.preventDefault(); focusMenuItem(userDropdown, '.user-dropdown-item', 'first'); }
            if (e.key === 'End') { e.preventDefault(); focusMenuItem(userDropdown, '.user-dropdown-item', 'last'); }
            if (e.key === 'Escape') {
                e.preventDefault();
                setUserDropdownVisible(false);
                userButton.focus();
            }
            if (e.key === 'Tab') setUserDropdownVisible(false);
        });
        document.addEventListener('click', (e) => { if (!userMenu.contains(e.target)) setUserDropdownVisible(false); });
        buyCreditsBtn.addEventListener('click', () => { setUserDropdownVisible(false); showPricingModal(); });
        featuresPageBtn.addEventListener('click', () => { setUserDropdownVisible(false); window.location.href = '/features'; });
        plannerPageBtn.addEventListener('click', () => { setUserDropdownVisible(false); window.location.href = '/plan'; });
        purchaseHistoryBtn.addEventListener('click', () => { setUserDropdownVisible(false); showHistoryModal(); });
        exportDataBtn.addEventListener('click', async () => {
            setUserDropdownVisible(false);
            await exportMyAccountData();
        });
        deleteAccountBtn.addEventListener('click', async () => {
            setUserDropdownVisible(false);
            await deleteMyAccountData();
        });
        headerStudyLibraryBtn.addEventListener('click', () => {
            trackEvent('study_mode_opened', { source: 'header_study_library' }, { preferBeacon: true });
            window.location.href = '/study';
        });
        function openGoalModal() {
            if (!currentUser) return;
            goalModalError.classList.remove('visible');
            goalModalError.textContent = '';
            goalModalInput.value = String(getDailyGoalStorage(currentUser.uid));
            openOverlay(goalModalOverlay);
            setTimeout(() => goalModalInput.focus(), 30);
            setTimeout(() => goalModalInput.select(), 30);
        }
        function closeGoalModal() {
            closeOverlay(goalModalOverlay);
        }
        async function saveGoalFromModal() {
            if (!currentUser) return;
            const parsed = parseInt(String(goalModalInput.value || '').trim(), 10);
            if (!Number.isFinite(parsed) || parsed < 1 || parsed > 500) {
                goalModalError.textContent = 'Use a number between 1 and 500.';
                goalModalError.classList.add('visible');
                return;
            }
            localStorage.setItem(`daily_goal_${currentUser.uid}`, String(parsed));
            progressSummaryCache = Object.assign({}, progressSummaryCache || {}, { daily_goal: parsed });
            refreshStudyHeaderMetrics();
            try {
                await authenticatedFetch('/api/study-progress', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ daily_goal: parsed, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '' }),
                });
                await fetchStudyProgressSummary();
            } catch (e) {
                console.warn('Could not sync daily goal:', e);
            }
            closeGoalModal();
            showToast('Daily goal updated.', 'success', 1800);
        }
        progressButton.addEventListener('click', (e) => {
            e.stopPropagation();
            const visible = !progressDropdown.classList.contains('visible');
            closeHeaderDropdowns(visible ? 'progress' : '');
            setProgressDropdownVisible(visible);
            if (visible) refreshStudyHeaderMetrics();
        });
        progressButton.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                closeHeaderDropdowns('progress');
                setProgressDropdownVisible(true);
                refreshStudyHeaderMetrics();
                focusMenuItem(progressDropdown, '.progress-action-btn', 'first');
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                closeHeaderDropdowns('progress');
                setProgressDropdownVisible(true);
                refreshStudyHeaderMetrics();
                focusMenuItem(progressDropdown, '.progress-action-btn', 'last');
            }
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                const visible = !progressDropdown.classList.contains('visible');
                closeHeaderDropdowns(visible ? 'progress' : '');
                setProgressDropdownVisible(visible);
                if (visible) refreshStudyHeaderMetrics();
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                setProgressDropdownVisible(false);
            }
        });
        progressDropdown.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); focusMenuItem(progressDropdown, '.progress-action-btn', 'next'); }
            if (e.key === 'ArrowUp') { e.preventDefault(); focusMenuItem(progressDropdown, '.progress-action-btn', 'prev'); }
            if (e.key === 'Home') { e.preventDefault(); focusMenuItem(progressDropdown, '.progress-action-btn', 'first'); }
            if (e.key === 'End') { e.preventDefault(); focusMenuItem(progressDropdown, '.progress-action-btn', 'last'); }
            if (e.key === 'Escape') {
                e.preventDefault();
                setProgressDropdownVisible(false);
                progressButton.focus();
            }
            if (e.key === 'Tab') setProgressDropdownVisible(false);
        });
        progressSetGoalBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            setProgressDropdownVisible(false);
            openGoalModal();
        });
        progressOpenPlanBtn.addEventListener('click', () => {
            setProgressDropdownVisible(false);
            window.location.href = '/plan';
        });
        let mobileCreditsTooltipTimer = null;
        creditsDisplay.addEventListener('click', (e) => {
            const touchLike = window.matchMedia('(hover: none), (pointer: coarse)').matches;
            if (!touchLike) {
                showPricingModal();
                return;
            }

            if (!creditsDisplay.classList.contains('tooltip-open')) {
                e.preventDefault();
                creditsDisplay.classList.add('tooltip-open');
                if (mobileCreditsTooltipTimer) clearTimeout(mobileCreditsTooltipTimer);
                mobileCreditsTooltipTimer = setTimeout(() => {
                    creditsDisplay.classList.remove('tooltip-open');
                }, 2600);
                return;
            }

            creditsDisplay.classList.remove('tooltip-open');
            if (mobileCreditsTooltipTimer) clearTimeout(mobileCreditsTooltipTimer);
            showPricingModal();
        });
        document.addEventListener('click', (e) => {
            if (!creditsDisplay.contains(e.target)) {
                creditsDisplay.classList.remove('tooltip-open');
                if (mobileCreditsTooltipTimer) clearTimeout(mobileCreditsTooltipTimer);
            }
            if (!progressMenu.contains(e.target)) {
                setProgressDropdownVisible(false);
            }
        });
        goalModalCancelBtn.addEventListener('click', closeGoalModal);
        goalModalSaveBtn.addEventListener('click', saveGoalFromModal);
        goalModalInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                saveGoalFromModal();
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                closeGoalModal();
            }
        });
        goalModalOverlay.addEventListener('click', (e) => {
            if (e.target === goalModalOverlay) closeGoalModal();
        });
        window.addEventListener('focus', () => { if (currentUser) fetchStudyProgressSummary(); else refreshStudyHeaderMetrics(); });
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                if (currentUser) fetchStudyProgressSummary();
                else refreshStudyHeaderMetrics();
            }
        });
        adminDashboardBtn.addEventListener('click', () => { setUserDropdownVisible(false); window.location.href = '/admin'; });
        buyCreditsLink.addEventListener('click', (e) => { e.preventDefault(); showPricingModal(); });
        pricingModalClose.addEventListener('click', hidePricingModal);
        pricingOverlay.addEventListener('click', (e) => { if (e.target === pricingOverlay) hidePricingModal(); });
        historyModalClose.addEventListener('click', hideHistoryModal);
        historyOverlay.addEventListener('click', (e) => { if (e.target === historyOverlay) hideHistoryModal(); });
        document.addEventListener('keydown', (e) => {
            if (!activeModalOverlay) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                if (activeModalOverlay === authOverlay) hideAuthModal();
                else if (activeModalOverlay === pricingOverlay) hidePricingModal();
                else if (activeModalOverlay === historyOverlay) hideHistoryModal();
                else if (activeModalOverlay === goalModalOverlay) closeGoalModal();
                return;
            }
            if (e.key !== 'Tab') return;
            const focusables = getFocusableElements(activeModalOverlay);
            if (!focusables.length) return;
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            const active = document.activeElement;
            if (e.shiftKey && active === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && active === last) {
                e.preventDefault();
                first.focus();
            }
        });
        document.querySelectorAll('.bundle-buy-btn').forEach(btn => btn.addEventListener('click', () => purchaseBundle(btn.dataset.bundleId)));
        downloadButton.addEventListener('click', (e) => {
            e.stopPropagation();
            const visible = !downloadDropdownContent.classList.contains('visible');
            closeHeaderDropdowns(visible ? 'download' : '');
            setDownloadDropdownVisible(visible);
            if (visible) focusMenuItem(downloadDropdownContent, '.dropdown-item', 'first');
        });
        downloadButton.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                closeHeaderDropdowns('download');
                setDownloadDropdownVisible(true);
                focusMenuItem(downloadDropdownContent, '.dropdown-item', 'first');
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                closeHeaderDropdowns('download');
                setDownloadDropdownVisible(true);
                focusMenuItem(downloadDropdownContent, '.dropdown-item', 'last');
            }
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                const visible = !downloadDropdownContent.classList.contains('visible');
                closeHeaderDropdowns(visible ? 'download' : '');
                setDownloadDropdownVisible(visible);
                if (visible) focusMenuItem(downloadDropdownContent, '.dropdown-item', 'first');
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                setDownloadDropdownVisible(false);
            }
        });
        downloadDropdownContent.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); focusMenuItem(downloadDropdownContent, '.dropdown-item', 'next'); }
            if (e.key === 'ArrowUp') { e.preventDefault(); focusMenuItem(downloadDropdownContent, '.dropdown-item', 'prev'); }
            if (e.key === 'Home') { e.preventDefault(); focusMenuItem(downloadDropdownContent, '.dropdown-item', 'first'); }
            if (e.key === 'End') { e.preventDefault(); focusMenuItem(downloadDropdownContent, '.dropdown-item', 'last'); }
            if (e.key === 'Escape') {
                e.preventDefault();
                setDownloadDropdownVisible(false);
                downloadButton.focus();
            }
            if (e.key === 'Tab') setDownloadDropdownVisible(false);
        });
        moreActionsButton.addEventListener('click', (e) => {
            e.stopPropagation();
            const visible = !moreActionsContent.classList.contains('visible');
            closeHeaderDropdowns(visible ? 'more-actions' : '');
            setMoreActionsDropdownVisible(visible);
            if (visible) focusMenuItem(moreActionsContent, '.dropdown-item', 'first');
        });
        moreActionsButton.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                closeHeaderDropdowns('more-actions');
                setMoreActionsDropdownVisible(true);
                focusMenuItem(moreActionsContent, '.dropdown-item', 'first');
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                closeHeaderDropdowns('more-actions');
                setMoreActionsDropdownVisible(true);
                focusMenuItem(moreActionsContent, '.dropdown-item', 'last');
            }
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                const visible = !moreActionsContent.classList.contains('visible');
                closeHeaderDropdowns(visible ? 'more-actions' : '');
                setMoreActionsDropdownVisible(visible);
                if (visible) focusMenuItem(moreActionsContent, '.dropdown-item', 'first');
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                setMoreActionsDropdownVisible(false);
            }
        });
        moreActionsContent.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); focusMenuItem(moreActionsContent, '.dropdown-item', 'next'); }
            if (e.key === 'ArrowUp') { e.preventDefault(); focusMenuItem(moreActionsContent, '.dropdown-item', 'prev'); }
            if (e.key === 'Home') { e.preventDefault(); focusMenuItem(moreActionsContent, '.dropdown-item', 'first'); }
            if (e.key === 'End') { e.preventDefault(); focusMenuItem(moreActionsContent, '.dropdown-item', 'last'); }
            if (e.key === 'Escape') {
                e.preventDefault();
                setMoreActionsDropdownVisible(false);
                moreActionsButton.focus();
            }
            if (e.key === 'Tab') setMoreActionsDropdownVisible(false);
        });
        document.addEventListener('click', (e) => {
            if (!downloadDropdown.contains(e.target)) setDownloadDropdownVisible(false);
            if (!moreActionsDropdown.contains(e.target)) setMoreActionsDropdownVisible(false);
        });
        copyButton.addEventListener('click', async () => {
            setMoreActionsDropdownVisible(false);
            try {
                await navigator.clipboard.writeText(resultMarkdown);
                copyButtonText.textContent = 'Copied!';
                showToast('Notes copied to clipboard', 'success');
                setTimeout(() => { copyButtonText.textContent = 'Copy notes'; }, 1800);
            } catch (e) {
                showToast('Failed to copy notes', 'error');
            }
        });
        exportStudyCsvBtn.addEventListener('click', async () => {
            setMoreActionsDropdownVisible(false);
            if (!currentJobId) return;
            const fallback = exportCsvType === 'test' ? `practice-test-${currentJobId}.csv` : `flashcards-${currentJobId}.csv`;
            try {
                await downloadAuthenticatedFile(`/download-flashcards-csv/${currentJobId}?type=${encodeURIComponent(exportCsvType)}`, fallback);
                showToast('CSV download started.', 'success');
            } catch (e) {
                showToast(e.message || 'Could not export CSV.', 'error');
            }
        });
        studyLibraryBtn.addEventListener('click', () => {
            setMoreActionsDropdownVisible(false);
            trackEvent('study_mode_opened', { source: 'results_library' }, { preferBeacon: true });
            window.location.href = '/study';
        });
        studyNowBtn.addEventListener('click', () => {
            closeHeaderDropdowns('');
            if (!currentStudyPackId) {
                showToast('No saved study pack available yet for this result.', 'info');
                return;
            }
            trackEvent('study_mode_opened', { source: 'results_study_now', pack_id: currentStudyPackId }, { preferBeacon: true });
            window.open(`/study?pack_id=${encodeURIComponent(currentStudyPackId)}&mode=learn`, '_blank');
        });
        newLectureButton.addEventListener('click', () => {
            setMoreActionsDropdownVisible(false);
            pdfFile = null;
            audioFile = null;
            releaseImportedAudioToken({ clearStatus: true });
            currentJobId = null;
            trackedTerminalJobId = '';
            pdfInput.value = '';
            audioInput.value = '';
            pdfInfo.style.display = 'none';
            pdfZone.classList.remove('has-file');
            syncAudioInfoUI();
            progressSection.classList.remove('visible');
            setProgressRetryVisible(false);
            resultsSection.classList.remove('visible');
            progressStatus.classList.remove('error');
            progressStatus.querySelector('.spinner').style.display = 'block';
            resetResultsState();
            switchMode(currentMode);
            updateProcessButton();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
        if (quickstartApplyBtn) {
            quickstartApplyBtn.addEventListener('click', () => {
                applyRecommendedSetup();
                updateQuickstartVisibility();
            });
        }
        if (quickstartDismissBtn) {
            quickstartDismissBtn.addEventListener('click', () => {
                if (currentUser && currentUser.uid) {
                    try { localStorage.setItem(`quickstart_dismissed_${currentUser.uid}`, '1'); } catch (_) {}
                }
                setQuickstartVisible(false);
            });
        }
        progressRetryBtn.addEventListener('click', retryStatusCheckNow);
        studyToolsToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            studyToolsPanel.classList.toggle('visible');
            studyToolsToggle.classList.toggle('open', studyToolsPanel.classList.contains('visible'));
        });
        studyToolChips.forEach(chip => {
            chip.addEventListener('click', () => {
                setStudyFeature(chip.dataset.studyFeatures || 'none');
            });
        });
        flashcardAmountChips.forEach(chip => {
            chip.addEventListener('click', () => {
                if (chip.disabled) return;
                setAmountSelection('flashcards', chip.dataset.value);
            });
        });
        questionAmountChips.forEach(chip => {
            chip.addEventListener('click', () => {
                if (chip.disabled) return;
                setAmountSelection('questions', chip.dataset.value);
            });
        });
        interviewOptionButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.disabled) return;
                const feature = btn.dataset.feature;
                if (!feature) return;
                if (selectedInterviewFeatures.includes(feature)) {
                    selectedInterviewFeatures = selectedInterviewFeatures.filter(item => item !== feature);
                } else {
                    const maxAffordable = userCredits ? Math.max(0, Number(userCredits.slides || 0)) : 2;
                    if (selectedInterviewFeatures.length >= maxAffordable) {
                        showToast('Not enough slides credits for more interview extras.', 'info', 2600);
                        updateInterviewOptionsUI();
                        return;
                    }
                    selectedInterviewFeatures.push(feature);
                }
                selectedInterviewFeatures = selectedInterviewFeatures.slice(0, 2);
                updateInterviewOptionsUI();
            });
        });
        outputLanguageButton.addEventListener('click', (e) => {
            e.stopPropagation();
            const visible = !outputLanguageMenu.classList.contains('visible');
            closeHeaderDropdowns(visible ? 'language' : '');
            setOutputLanguageMenuVisible(visible);
            if (visible) focusMenuItem(outputLanguageMenu, '.app-select-item', 'active');
        });
        outputLanguageButton.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                closeHeaderDropdowns('language');
                setOutputLanguageMenuVisible(true);
                focusMenuItem(outputLanguageMenu, '.app-select-item', 'active');
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                closeHeaderDropdowns('language');
                setOutputLanguageMenuVisible(true);
                focusMenuItem(outputLanguageMenu, '.app-select-item', 'last');
            }
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                const visible = !outputLanguageMenu.classList.contains('visible');
                closeHeaderDropdowns(visible ? 'language' : '');
                setOutputLanguageMenuVisible(visible);
                if (visible) focusMenuItem(outputLanguageMenu, '.app-select-item', 'active');
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                setOutputLanguageMenuVisible(false);
            }
        });
        outputLanguageMenu.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); focusMenuItem(outputLanguageMenu, '.app-select-item', 'next'); }
            if (e.key === 'ArrowUp') { e.preventDefault(); focusMenuItem(outputLanguageMenu, '.app-select-item', 'prev'); }
            if (e.key === 'Home') { e.preventDefault(); focusMenuItem(outputLanguageMenu, '.app-select-item', 'first'); }
            if (e.key === 'End') { e.preventDefault(); focusMenuItem(outputLanguageMenu, '.app-select-item', 'last'); }
            if (e.key === 'Escape') {
                e.preventDefault();
                setOutputLanguageMenuVisible(false);
                outputLanguageButton.focus();
            }
            if (e.key === 'Tab') setOutputLanguageMenuVisible(false);
        });
        outputLanguageItems.forEach(item => {
            item.addEventListener('click', () => {
                const value = item.dataset.value || 'english';
                setOutputLanguage(value, item.textContent.trim());
                setOutputLanguageMenuVisible(false);
                if (value === 'other') {
                    outputLanguageCustom.focus();
                    outputLanguageCustom.select();
                } else {
                    scheduleLanguagePreferenceSave();
                    outputLanguageButton.focus();
                }
            });
        });
        outputLanguageCustom.addEventListener('input', () => {
            if (outputLanguageSelect.value !== 'other') return;
            outputLanguageLabel.textContent = getLanguageLabel('other', outputLanguageCustom.value);
            scheduleLanguagePreferenceSave();
        });
        outputLanguageCustom.addEventListener('blur', () => {
            if (outputLanguageSelect.value !== 'other') return;
            outputLanguageLabel.textContent = getLanguageLabel('other', outputLanguageCustom.value);
            scheduleLanguagePreferenceSave();
        });
        if (audioUrlFetchBtn) {
            audioUrlFetchBtn.addEventListener('click', importAudioFromUrl);
        }
        if (audioUrlInput) {
            audioUrlInput.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                importAudioFromUrl();
            });
        }
        languageOnboardingButtons.forEach((button) => {
            button.addEventListener('click', () => {
                setOnboardingLanguageSelection(button.dataset.value || 'english');
                setOnboardingError('');
                if ((button.dataset.value || '') === 'other') {
                    languageOnboardingCustom.focus();
                }
            });
        });
        languageOnboardingCustom.addEventListener('input', () => setOnboardingError(''));
        languageOnboardingCustom.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                saveLanguageOnboardingPreference();
            }
        });
        languageOnboardingSaveBtn.addEventListener('click', saveLanguageOnboardingPreference);
        languageOnboardingOverlay.addEventListener('click', (e) => {
            if (e.target === languageOnboardingOverlay) {
                languageOnboardingCustom.focus();
            }
        });
        document.addEventListener('click', (e) => {
            if (!studyToolsPanel.contains(e.target) && !studyToolsToggle.contains(e.target)) {
                studyToolsPanel.classList.remove('visible');
                studyToolsToggle.classList.remove('open');
            }
            if (!outputLanguagePicker.contains(e.target)) {
                setOutputLanguageMenuVisible(false);
            }
        });
        window.addEventListener('keydown', (e) => {
            if (!resultsSection.classList.contains('visible')) return;
            if (activeResultsTab !== 'flashcards') return;
            if (e.key === 'ArrowLeft') { e.preventDefault(); goFlashcard(-1); }
            if (e.key === 'ArrowRight') { e.preventDefault(); goFlashcard(1); }
            if (e.code === 'Space') { e.preventDefault(); flipFlashcard(); }
        });
        window.addEventListener('beforeunload', (e) => { if (currentJobId && pollInterval) { e.preventDefault(); e.returnValue = ''; } });

        function updateHeaderNavActiveState() {
            const currentPath = window.location.pathname.replace(/\/+$/, '') || '/';
            document.querySelectorAll('.header-nav-link').forEach((link) => {
                const href = (link.getAttribute('href') || '').replace(/\/+$/, '') || '/';
                const isDashboardHome = currentPath === '/dashboard' && href === '/';
                link.classList.toggle('active', href === currentPath || isDashboardHome);
            });
        }

        setAmountSelection('flashcards', selectedFlashcardAmount);
        setAmountSelection('questions', selectedQuestionAmount);
        setStudyFeature('both');
        updateInterviewOptionsUI();
        setOutputLanguage('english', '🇬🇧 English');
        switchMode('lecture-notes');
        resetResultsState();
        updateHeaderNavActiveState();
