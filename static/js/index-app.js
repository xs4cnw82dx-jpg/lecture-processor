// The processing page loads its auth, language and audio controls before bootstrap.
/* global applyPreferencesToOutputLanguage, audioDownload, audioFile, audioImportInFlight,
   audioInput, audioRemove, audioUrlStatus, authOverlay, authSubmitBusyKind,
   bindAudioImportControls, bindLanguageOnboarding, bindOutputLanguagePicker,
   bindProcessingAuthModal, bindRecordingControls, checkEmailAllowed, clearImportedAudioLocalState,
   clearLanguagePreferenceSaveTimer, clearSelectedAudioFile, closeLanguageOnboarding,
   currentAudioBytes, discardActiveRecording, downloadSelectedAudio, getLanguageLabel,
   getPendingAuthReturnUrl, getReadyImportedAudioToken, handleAudioFile,
   hasReadyImportedAudioToken, hideAuthModal, isAdminAuthReturnUrl, isUnverifiedEmailUser,
   languageOnboardingOverlay, maybeOpenAuthModalFromQuery, outputLanguageCustom,
   outputLanguagePicker, outputLanguageSelect, recordingState, releaseImportedAudioToken,
   removeSelectedAudio, resumePendingAuthReturnIfNeeded, resumePendingNonAdminAuthReturnIfNeeded,
   setOutputLanguage, setOutputLanguageMenuVisible, showAuthError, showAuthModal,
   showEmailVerificationPrompt, signOut, signinError, signupError, signupView, stopAudioRecording,
   syncAudioInfoUI, syncRecorderUI, warnBeforeLeavingRecording */
/* exported activateVerifiedUser, audioZone, auth, authenticatedFetch, captureClientError,
   closeHeaderDropdowns, closeOverlay, currentMode, currentUser, currentUserIsAdmin,
   downloadLocalPreviewFile, downloadUtils, focusMenuItem, formatFileSize, formatRetryDelay,
   getRetryAfterSeconds, handleUnverifiedEmailUser, headerSignInBtn, modeConfig, openOverlay,
   otherAudioOpen, otherAudioToggle, setHidden, showToast, signInToProcessBtn,
   syncProcessingLayout, trackEvent, unverifiedEmailUser, updateProcessButton, userPreferences,
   userProfileLoaded */

const runtimeConfig = window.LectureProcessorRuntime || {};
const sentryFrontendDsn = runtimeConfig.sentryFrontendDsn || '';
const sentryEnvironment = runtimeConfig.sentryEnvironment || '';
const sentryRelease = runtimeConfig.sentryRelease || '';
const sentryCaptureLocal = runtimeConfig.sentryCaptureLocal === true;
const sentryLocalHostnames = new Set(['localhost', '127.0.0.1', '[::1]']);
const sentryHostname = String(window.location.hostname || '').trim().toLowerCase();
const sentryEnvironmentName = String(sentryEnvironment || '').trim().toLowerCase();
const frontendSentryEnabled = (
    !!window.Sentry
    && !!sentryFrontendDsn
    && (sentryCaptureLocal || (!sentryLocalHostnames.has(sentryHostname) && !sentryHostname.endsWith('.local')))
    && sentryEnvironmentName !== 'test'
    && sentryEnvironmentName !== 'testing'
);

if (frontendSentryEnabled) {
    window.Sentry.init({
        dsn: sentryFrontendDsn,
        environment: sentryEnvironment || 'production',
        release: sentryRelease || undefined,
        tracesSampleRate: 0.0,
    });
}

const bootstrap = window.LectureProcessorBootstrap || {};
const auth = bootstrap.getAuth ? bootstrap.getAuth() : firebase.auth();
const authUtils = window.LectureProcessorAuth || {};
const authClient = authUtils.createAuthClient ? authUtils.createAuthClient(auth, { notSignedInMessage: 'Please sign in' }) : null;
const analyticsUtils = window.LectureProcessorIndexAnalytics || {};
const markdownUtils = window.LectureProcessorMarkdown || {};
const uxUtils = window.LectureProcessorUx || {};
const creditUtils = window.LectureProcessorCreditUtils || {};
const downloadUtils = window.LectureProcessorDownload || {};
const topbarUtils = window.LectureProcessorTopbar || {};
const progressUtils = window.LectureProcessorStudyProgressUtils || {};
const displayFormatUtils = window.LectureProcessorDisplayFormatUtils || {};
const runtimeJobUtils = window.LectureProcessorRuntimeJobUtils || {};
const processingUi = window.LectureProcessorProcessingUi || {};
const progressFlowUtils = window.LectureProcessorIndexProgress || {};
const indexResultsUtils = window.LectureProcessorIndexResults || {};
const pageConfig = window.LectureProcessorPageConfig || {};
const forcedMode = ['lecture-notes', 'slides-only', 'interview'].includes(String(pageConfig.forcedMode || '').trim())
    ? String(pageConfig.forcedMode || '').trim()
    : '';
const appShell = document.getElementById('app-shell');
const analyticsPage = typeof analyticsUtils.resolveProcessingAnalyticsPage === 'function'
    ? analyticsUtils.resolveProcessingAnalyticsPage({
        forcedMode,
        pathname: window.location.pathname,
        shellPageKey: appShell ? appShell.getAttribute('data-page-key') : '',
    })
    : 'processing';
const setHidden = typeof uxUtils.setHidden === 'function'
    ? uxUtils.setHidden
    : function (element, hidden) {
        if (!element) return;
        element.hidden = Boolean(hidden);
    };

let currentUser = null;
let unverifiedEmailUser = null;
let userCredits = null;
let publicCreditConfig = null;
let creationProfileRevision = 0;
let idToken = null;
let currentUserIsAdmin = false;
let authStateResolved = Boolean(auth && auth.currentUser);
let verifiedUserActivationPromise = null;
let verifiedUserActivationUid = '';
let pdfFile = null;
let currentJobId = null;
let pollInterval = null;
let pollFailures = 0;
let pollMissingResponses = 0;
let pollStartedAt = 0;
let currentMode = forcedMode || 'lecture-notes';
let resultMarkdown = '';
let slideText = '';
let transcript = '';
let flashcards = [];
let testQuestions = [];
let activeResultsTab = 'notes';
let flashcardIndex = 0;
let flashcardFlipped = false;
let activeRuntimeJobs = [];
let runtimeJobsRefreshTimer = null;
let runtimeJobsRefreshInFlight = false;
let notificationPermissionRequested = false;
let notifiedTerminalJobIds = new Set();

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
let userPreferences = null;
let interviewSummaryText = '';
let interviewSectionsText = '';
let interviewCombinedText = '';
let currentBillingReceipt = null;
let exportCsvType = 'flashcards';
let progressSummaryCache = null;
let userTotalProcessed = 0;
let userHasCreatedStudyPack = false;
let userProfileLoaded = false;
let trackedTerminalJobId = '';
let otherAudioOpen = false;
const analyticsEndpoint = '/api/lp-event';
const POLL_BASE_MS = 2000;
const POLL_MAX_MS = 30000;
const POLL_MAX_RUNTIME_MS = 30 * 60 * 1000;
const ACTIVE_RUNTIME_JOBS_CACHE_KEY = 'active_runtime_jobs';
const RUNTIME_JOBS_REFRESH_MS = 12000;
const DOWNLOAD_LABELS = Object.freeze({
    lectureNotes: 'Lecture Notes',
    slideExtract: 'Slide Extract',
    lectureTranscript: 'Lecture Transcript',
    interviewTranscript: 'Interview Transcription',
});

function createAnalyticsSessionId() {
    try {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
            return window.crypto.randomUUID().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
        }
    } catch (_) { }
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
    if (!frontendSentryEnabled || !window.Sentry || !error) return;
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
        page: analyticsPage,
        path: window.location.pathname,
        properties: Object.assign({}, properties || {}, { mode: currentMode }),
    };
    const body = JSON.stringify(payload);
    if (options.preferBeacon && navigator.sendBeacon) {
        try {
            const blob = new Blob([body], { type: 'application/json' });
            return Promise.resolve(navigator.sendBeacon(analyticsEndpoint, blob));
        } catch (_) { }
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

const modeConfig = window.LectureProcessorIndexModeConfig || {};

const UPLOAD_ESTIMATE_COPY = Object.freeze({
    'lecture-notes': 'A 60-minute lecture usually finishes in about 5 minutes. Longer or noisy recordings can take longer.',
    'slides-only': 'Most slide extractions finish within a couple of minutes. Large or image-heavy decks can take longer.',
    'interview': 'Most interview transcripts finish within a few minutes. Summary and structured transcript extras add more time.',
});

const allowedSlideExtensions = ['.pdf', '.pptx'];
const allowedSlideMimeTypes = [
    'application/pdf',
    'application/x-pdf',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.ms-powerpoint',
    'application/octet-stream',
    '',
];

const headerSignInBtn = document.getElementById('header-sign-in-btn');
const headerNavToggle = document.getElementById('header-nav-toggle');
const headerSidebar = document.getElementById('header-sidebar');
const headerSidebarBackdrop = document.getElementById('header-sidebar-backdrop');
const headerSidebarClose = document.getElementById('header-sidebar-close');
const headerStudyLibraryBtn = document.getElementById('header-study-library-btn');
const headerFeaturesBtn = document.getElementById('header-features-btn');
const headerToolsBtn = document.getElementById('header-tools-btn');
const headerPlannerBtn = document.getElementById('header-planner-btn');
const headerPlannerGroup = document.getElementById('header-planner-group');
const headerCalendarBtn = document.getElementById('header-calendar-btn');
const progressMenu = document.getElementById('progress-menu');
const progressButton = document.getElementById('progress-button');
const progressDropdown = document.getElementById('progress-dropdown');
const progressStreakCount = document.getElementById('progress-streak-count');
const progressDueCount = document.getElementById('progress-due-count');
const progressGoalText = document.getElementById('progress-goal-text');
const progressSetGoalBtn = document.getElementById('progress-set-goal-btn');
const progressOpenCalendarBtn = document.getElementById('progress-open-calendar-btn');
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
const purchaseHistoryBtn = document.getElementById('purchase-history-btn');
const adminDashboardBtn = document.getElementById('admin-dashboard-btn');
const signOutBtn = document.getElementById('sign-out-btn');

const signInRequired = document.getElementById('sign-in-required');
const signInToProcessBtn = document.getElementById('sign-in-to-process-btn');
const studyPackTitleLabel = document.getElementById('study-pack-title-label');
const studyPackTitleInput = document.getElementById('study-pack-title-input');
const studyPackTitleError = document.getElementById('study-pack-title-error');
const modeTabs = document.querySelectorAll('.mode-tab');
const modeDescriptionText = document.getElementById('mode-description-text');
const modeCreditCost = document.getElementById('mode-credit-cost');
const modeCostSummary = document.getElementById('mode-cost-summary');
const uploadEstimate = document.getElementById('upload-estimate');
const uploadEstimateTime = document.getElementById('upload-estimate-time');
const uploadEstimateMeta = document.getElementById('upload-estimate-meta');
const uploadSection = document.getElementById('upload-section');
const processingSecondaryGrid = document.querySelector('.processing-secondary-grid');
const buttonSection = document.getElementById('button-section');
const mobileProcessSummary = document.getElementById('mobile-process-summary');
const generationControls = document.getElementById('generation-controls');
const interviewControls = document.getElementById('interview-controls');
const languageControls = document.getElementById('language-controls');
const quickstartCard = document.getElementById('quickstart-card');
const quickstartApplyBtn = document.getElementById('quickstart-apply-btn');
const quickstartDismissBtn = document.getElementById('quickstart-dismiss-btn');
const advancedSettingsToggle = document.getElementById('advanced-settings-toggle');
const advancedSettingsBody = document.getElementById('advanced-settings-body');
const advancedSettingsSummary = document.getElementById('advanced-settings-summary');
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

const pdfZone = document.getElementById('pdf-zone');
const audioZone = document.getElementById('audio-zone');
if (typeof uxUtils.manageUploadZone === 'function') {
    uxUtils.manageUploadZone(pdfZone);
    uxUtils.manageUploadZone(audioZone);
}
const pdfZoneTitle = document.getElementById('pdf-zone-title');
const pdfZoneBadge = document.getElementById('pdf-zone-badge');
const pdfZoneHelper = document.getElementById('pdf-zone-helper');
const audioZoneTitle = document.getElementById('audio-zone-title');
const audioZoneBadge = document.getElementById('audio-zone-badge');
const audioZoneHelper = document.getElementById('audio-zone-helper');
const pdfInput = document.getElementById('pdf-input');
const pdfInfo = document.getElementById('pdf-info');
const pdfName = document.getElementById('pdf-name');
const pdfSize = document.getElementById('pdf-size');
const pdfDownload = document.getElementById('pdf-download');
const pdfRemove = document.getElementById('pdf-remove');
const audioUrlImportTitle = document.getElementById('audio-url-import-title');
const audioUrlImportHint = document.getElementById('audio-url-import-hint');
const otherAudioDisclosure = document.getElementById('other-audio-disclosure');
const otherAudioToggle = document.getElementById('other-audio-toggle');
const otherAudioBody = document.getElementById('other-audio-body');
const otherAudioSummary = document.getElementById('other-audio-summary');

const processButton = document.getElementById('process-button');
const processDisabledReason = document.getElementById('process-disabled-reason');
const noCreditsWarning = document.getElementById('no-credits-warning');
const buyCreditsLink = document.getElementById('buy-credits-link');
const progressSection = document.getElementById('progress-section');
const progressSteps = document.getElementById('progress-steps');
const progressStatus = document.getElementById('progress-status');
const statusText = document.getElementById('status-text');
const progressSpinner = progressStatus ? progressStatus.querySelector('.spinner') : null;
const progressSafeBanner = document.getElementById('progress-safe-banner');
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
const tabFlashcards = document.getElementById('tab-flashcards');
const tabTest = document.getElementById('tab-test');
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

const toast = document.getElementById('toast');
const toastIcon = document.getElementById('toast-icon');
const toastText = document.getElementById('toast-text');

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
function buildUserScopedCacheKey(baseKey, userOrUid) {
    const uid = typeof userOrUid === 'string'
        ? userOrUid
        : (userOrUid && userOrUid.uid ? String(userOrUid.uid) : '');
    const safeUid = String(uid || '').trim();
    return safeUid ? `${baseKey}:${safeUid}` : '';
}
function readUiCacheJsonForUser(userOrUid, baseKey, fallbackValue) {
    const storageKey = buildUserScopedCacheKey(baseKey, userOrUid);
    if (!storageKey) return fallbackValue;
    try {
        const raw = localStorage.getItem(storageKey);
        if (!raw) return fallbackValue;
        const parsed = JSON.parse(raw);
        return parsed == null ? fallbackValue : parsed;
    } catch (_) {
        return fallbackValue;
    }
}
function writeUiCacheJsonForUser(userOrUid, baseKey, value) {
    const storageKey = buildUserScopedCacheKey(baseKey, userOrUid);
    if (!storageKey) return value;
    try {
        localStorage.setItem(storageKey, JSON.stringify(value));
    } catch (_) { }
    return value;
}
function formatCreditTypeLabel(creditType) {
    const value = String(creditType || '').trim();
    const map = {
        lecture_credits_standard: 'lecture credit',
        lecture_credits_extended: 'lecture extended credit',
        slides_credits: 'text extraction credit',
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
        setHidden(billingReceiptPanel, true);
        return;
    }
    billingReceiptPanel.textContent = text;
    setHidden(billingReceiptPanel, false);
    billingReceiptPanel.classList.add('visible');
}
function getDailyGoalStorage(uid) {
    if (progressUtils && typeof progressUtils.readDailyGoalCache === 'function') {
        return progressUtils.readDailyGoalCache(uid, progressUtils.DEFAULT_DAILY_GOAL || 20);
    }
    const parsed = parseInt(localStorage.getItem(`daily_goal_${uid}`) || '20', 10);
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 500) : 20;
}
function getProgressSummaryForHeader(uid) {
    const summary = (progressSummaryCache && typeof progressSummaryCache === 'object') ? progressSummaryCache : {};
    if (progressUtils && typeof progressUtils.buildSummary === 'function') {
        return progressUtils.buildSummary(summary, getDailyGoalStorage(uid));
    }
    const goal = Number(summary.daily_goal || getDailyGoalStorage(uid) || 20);
    return { current_streak: Number(summary.current_streak || 0), due_today: Number(summary.due_today || 0), today_progress: Number(summary.today_progress || 0), daily_goal: Number.isFinite(goal) && goal > 0 ? goal : 20 };
}
function refreshStudyHeaderMetrics() {
    if (!progressMenu || !progressButton || !progressStreakCount || !progressDueCount || !progressGoalText) {
        return;
    }
    if (!currentUser) {
        setHidden(progressMenu, true);
        return;
    }
    const uid = currentUser.uid;
    const summary = getProgressSummaryForHeader(uid);
    const streak = summary.current_streak;
    const due = summary.due_today;
    progressStreakCount.textContent = String(streak);
    progressDueCount.textContent = String(due);
    progressGoalText.textContent = progressUtils && typeof progressUtils.goalProgressText === 'function'
        ? progressUtils.goalProgressText(summary, getDailyGoalStorage(uid))
        : `${Math.min(summary.today_progress, summary.daily_goal)} / ${summary.daily_goal}`;
    progressButton.title = `Streak ${streak} days · ${due} due today · Goal ${progressGoalText.textContent}`;
    setHidden(progressMenu, false);
}
async function fetchStudyProgressSummary() {
    if (!currentUser) return;
    try {
        const response = await authenticatedFetch('/api/study-progress/summary');
        if (!response.ok) return;
        const payload = await response.json();
        const summary = (payload && payload.summary && typeof payload.summary === 'object')
            ? payload.summary
            : (payload && typeof payload === 'object' ? payload : null);
        if (!summary) return;
        progressSummaryCache = summary;
        if (typeof summary.daily_goal === 'number' && summary.daily_goal > 0) {
            try {
                if (progressUtils && typeof progressUtils.writeDailyGoalCache === 'function') {
                    progressUtils.writeDailyGoalCache(currentUser.uid, summary.daily_goal);
                } else {
                    localStorage.setItem(`daily_goal_${currentUser.uid}`, String(summary.daily_goal));
                }
            } catch (_) { }
        }
        refreshStudyHeaderMetrics();
    } catch (e) {
        console.warn('Could not fetch study progress summary:', e);
    }
}

let activeModalOverlay = null;
let modalStateStack = [];
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
function requestCloseOverlay(overlay) {
    if (overlay === authOverlay) { hideAuthModal(); return; }
    if (overlay === goalModalOverlay) { closeGoalModal(); return; }
    if (overlay === languageOnboardingOverlay) { closeLanguageOnboarding(); return; }
    closeOverlay(overlay);
}
function openOverlay(overlay) {
    if (!overlay) return;
    if (!modalStateStack.some((entry) => entry.overlay === overlay)) {
        modalStateStack.push({ overlay, restore: document.activeElement });
    }
    activeModalOverlay = overlay;
    if (typeof uxUtils.openModalOverlay === 'function') {
        uxUtils.openModalOverlay(overlay, {
            openClass: 'visible',
            onRequestClose: () => requestCloseOverlay(overlay),
        });
        return;
    }
    overlay.hidden = false;
    overlay.classList.add('visible');
    overlay.setAttribute('aria-hidden', 'false');
    const focusables = getFocusableElements(overlay);
    if (focusables.length) {
        setTimeout(() => focusables[0].focus(), 30);
    }
}
function closeOverlay(overlay) {
    if (!overlay) return;
    let restoreTarget = null;
    for (let i = modalStateStack.length - 1; i >= 0; i -= 1) {
        if (modalStateStack[i].overlay === overlay) {
            restoreTarget = modalStateStack[i].restore || null;
            modalStateStack.splice(i, 1);
            break;
        }
    }
    activeModalOverlay = modalStateStack.length ? modalStateStack[modalStateStack.length - 1].overlay : null;
    if (typeof uxUtils.closeModalOverlay === 'function') {
        uxUtils.closeModalOverlay(overlay, {
            openClass: 'visible',
            returnFocus: restoreTarget,
        });
        return;
    }
    overlay.classList.remove('visible');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.hidden = true;
    if (restoreTarget && typeof restoreTarget.focus === 'function') {
        try { restoreTarget.focus(); } catch (_) { }
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
    if (!userDropdown || !userButton) return;
    userDropdown.classList.toggle('visible', visible);
    userButton.setAttribute('aria-expanded', visible ? 'true' : 'false');
}
function setProgressDropdownVisible(visible) {
    if (!progressDropdown || !progressButton) return;
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
    if (!visible) {
        setOutputLanguageMenuVisible(false);
    }
    advancedSettingsBody.classList.toggle('visible', visible);
    advancedSettingsToggle.classList.toggle('open', visible);
    advancedSettingsToggle.setAttribute('aria-expanded', visible ? 'true' : 'false');
    advancedSettingsBody.setAttribute('aria-hidden', visible ? 'false' : 'true');
}
function setHeaderSidebarVisible(visible) {
    if (!headerSidebar || !headerSidebarBackdrop || !headerNavToggle) return;
    const show = Boolean(visible);
    headerSidebar.classList.toggle('visible', show);
    headerSidebarBackdrop.classList.toggle('visible', show);
    headerSidebar.setAttribute('aria-hidden', show ? 'false' : 'true');
    headerNavToggle.setAttribute('aria-expanded', show ? 'true' : 'false');
    document.body.classList.toggle('sidebar-open', show);
    if (!show && headerPlannerGroup) {
        headerPlannerGroup.classList.remove('open');
    }
}
function closeHeaderDropdowns(except) {
    if (except !== 'user') setUserDropdownVisible(false);
    if (except !== 'progress') setProgressDropdownVisible(false);
    if (except !== 'download') setDownloadDropdownVisible(false);
    if (except !== 'more-actions') setMoreActionsDropdownVisible(false);
    if (except !== 'language') setOutputLanguageMenuVisible(false);
    if (except !== 'sidebar' && except !== 'progress') setHeaderSidebarVisible(false);
}
async function fetchUserData(options = {}) {
    if (!currentUser) return;
    const session = authClient.captureSession();
    const revision = ++creationProfileRevision;
    try {
        const shell = window.LectureProcessorShell;
        if (!shell || !shell.refreshCreditSnapshot) throw new Error('Credits are unavailable. Please try again.');
        const result = await shell.refreshCreditSnapshot(options);
        if (!session.isCurrent() || revision !== creationProfileRevision || result.uid !== currentUser.uid) return;
        const d = result.profile;
        userCredits = result.snapshot.scheme === 1 ? { ...d.credits, unlimited: result.snapshot.unlimited } : null;
        userTotalProcessed = Number(d.total_processed || 0);
        userHasCreatedStudyPack = Boolean(d.has_created_study_pack || userTotalProcessed > 0);
        userProfileLoaded = true;
        currentUserIsAdmin = Boolean(d.is_admin);
        userPreferences = (d.preferences && typeof d.preferences === 'object') ? d.preferences : null;
        if (adminDashboardBtn) setHidden(adminDashboardBtn, !currentUserIsAdmin);
        if (userPreferences) applyPreferencesToOutputLanguage(userPreferences, { forceOnboardingOpen: true });
        updateCreditsDisplay();
        void fetchStudyProgressSummary();
        refreshStudyHeaderMetrics();
        updateQuickstartVisibility();
    } catch (error) {
        if (!session.isCurrent() || revision !== creationProfileRevision) return;
        userProfileLoaded = false;
        if (error.status === 401 || error.status === 403) {
            currentUserIsAdmin = false;
            userPreferences = null;
            closeLanguageOnboarding();
            if (adminDashboardBtn) setHidden(adminDashboardBtn, true);
        }
        updateModeCreditDisplay();
        updateProcessButton();
    }
}
function creationCreditText(message, params = {}) {
    if (window.LectureI18n) return window.LectureI18n.t(message, params);
    return message.replace(/\{(\w+)\}/g, (_match, key) => String(params[key] ?? ''));
}
function creationCreditState() {
    const shell = window.LectureProcessorShell;
    const value = shell && shell.getCreditState ? shell.getCreditState() : null;
    return value && currentUser && value.uid === currentUser.uid ? value : null;
}
function creationCreditSnapshot() {
    const state = creationCreditState();
    if (state && state.snapshot) return state.snapshot;
    return publicCreditConfig && publicCreditConfig.scheme === 2
        ? { scheme: 2, balance: 0, categories: null, unlimited: {}, costs: publicCreditConfig.costs } : null;
}
function usesUnifiedCreationCredits() {
    return creationCreditSnapshot()?.scheme === 2;
}
function usesLegacyCreationCredits() {
    const snapshot = creationCreditSnapshot();
    return snapshot ? snapshot.scheme === 1 : publicCreditConfig?.scheme === 1;
}
function creationCreditQuote() {
    const snapshot = creationCreditSnapshot();
    if (!snapshot || snapshot.scheme !== 2 || !creditUtils.quote) return null;
    const components = [{ action: modeConfig[currentMode].creditAction, units: 1 }];
    if (currentMode === 'interview' && selectedInterviewFeatures.length) {
        components.push({ action: 'interview_extra', units: selectedInterviewFeatures.length });
    }
    return creditUtils.quote(snapshot, components);
}
function creationCreditStatus() {
    const state = creationCreditState();
    const quote = creationCreditQuote();
    if (!state || state.status === 'loading') return creationCreditText('Checking credits…');
    if (state.status !== 'ready' || state.source !== 'server' || !quote) {
        return creationCreditText('Credits are unavailable. Please try again.');
    }
    return quote.sufficient
        ? creationCreditText('{credits} available', { credits: creditUtils.formatCredits(quote.available) })
        : creditUtils.formatInsufficient({ needed: quote.needed, available: quote.available });
}
function updateSignupCreditGrant() {
    const signup = document.getElementById('signup-credit-grant');
    if (!signup) return;
    signup.textContent = publicCreditConfig?.scheme === 2 && publicCreditConfig.freeSignupCredits !== null
        ? creationCreditText('Get started with {credits}', { credits: creditUtils.formatCredits(publicCreditConfig.freeSignupCredits) })
        : publicCreditConfig?.scheme === 1
            ? creationCreditText('Get started with 1 free lecture credit')
            : creationCreditText('Create your study account');
}
async function loadCreationPublicCredits() {
    try {
        const response = await fetch('/api/config');
        if (!response.ok) return;
        publicCreditConfig = creditUtils.parsePublicConfig(await response.json());
        updateSignupCreditGrant();
        updateInterviewOptionsUI();
    } catch (_) { /* Keep account quotes independent of public pricing availability. */ }
}
function updateCreditsDisplay() {
    const snapshot = creationCreditState()?.snapshot;
    if (snapshot && snapshot.scheme === 1) {
        userCredits = { lecture_standard: snapshot.categories.lecture, lecture_extended: 0,
            slides: snapshot.categories.slides, interview_short: snapshot.categories.interview,
            interview_medium: 0, interview_long: 0, unlimited: snapshot.unlimited };
    }
    if (usesUnifiedCreationCredits()) {
        const snapshot = creationCreditSnapshot();
        if (creditsCount) creditsCount.textContent = creditUtils.formatCredits(snapshot.balance);
        updateInterviewOptionsUI();
        refreshStudyHeaderMetrics();
        return;
    }
    if (!userCredits) { updateInterviewOptionsUI(); return; }
    const lecture = userCredits.lecture_standard + userCredits.lecture_extended;
    const interview = userCredits.interview_short + userCredits.interview_medium + userCredits.interview_long;
    const total = lecture + userCredits.slides + interview;
    const lectureLabel = formatCategoryCreditValue('lecture', lecture);
    const slidesLabel = formatCategoryCreditValue('slides', userCredits.slides);
    const interviewLabel = formatCategoryCreditValue('interview', interview);
    const totalLabel = hasAnyUnlimitedCredits() ? 'Unlimited' : String(total);
    if (creditsCount) creditsCount.textContent = totalLabel;
    if (creditsDisplay) {
        creditsDisplay.setAttribute('data-tooltip', `Lecture ${lectureLabel}, Text extraction ${slidesLabel}, Interview ${interviewLabel}, Total ${totalLabel}`);
    }
    if (creditsTooltip) {
        setSanitizedHtml(
            creditsTooltip,
            `<div class="credit-tip-row"><span>Lecture</span><strong>${lectureLabel}</strong></div>
             <div class="credit-tip-row"><span>Text extraction</span><strong>${slidesLabel}</strong></div>
             <div class="credit-tip-row"><span>Interview</span><strong>${interviewLabel}</strong></div>
             <div class="credit-tip-row total"><span>Total</span><strong>${totalLabel}</strong></div>`
        );
    }
    if (dropdownLectureCredits) dropdownLectureCredits.textContent = lectureLabel;
    if (dropdownSlidesCredits) dropdownSlidesCredits.textContent = slidesLabel;
    if (dropdownInterviewCredits) dropdownInterviewCredits.textContent = interviewLabel;
    updateInterviewOptionsUI();
    refreshStudyHeaderMetrics();
}
function getUnlimitedCredits() {
    const snapshot = creationCreditSnapshot();
    if (snapshot && snapshot.scheme === 2) return snapshot.unlimited;
    return (userCredits && userCredits.unlimited && typeof userCredits.unlimited === 'object') ? userCredits.unlimited : {};
}
function hasUnlimitedCredit(category) {
    return Boolean(getUnlimitedCredits()[category]);
}
function hasAnyUnlimitedCredits() {
    const unlimited = getUnlimitedCredits();
    return Boolean(unlimited.lecture || unlimited.slides || unlimited.interview);
}
function formatCategoryCreditValue(category, value) {
    return hasUnlimitedCredit(category) ? 'Unlimited' : String(Number(value || 0));
}
function getTotalInterviewCredits() {
    if (!userCredits) return 0;
    if (hasUnlimitedCredit('interview')) return Number.POSITIVE_INFINITY;
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
function getStudyPackTitleValue() {
    if (!studyPackTitleInput) return '';
    return String(studyPackTitleInput.value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
}
function setStudyPackTitleInvalid(invalid) {
    if (!studyPackTitleInput) return;
    studyPackTitleInput.setAttribute('aria-invalid', invalid ? 'true' : 'false');
    if (studyPackTitleError) {
        studyPackTitleError.hidden = !invalid;
    }
}
function updateModeCostSummary() {
    if (!modeCostSummary) return;
    modeCostSummary.textContent = usesUnifiedCreationCredits() && currentUser ? creationCreditStatus() : '';
    setHidden(modeCostSummary, !modeCostSummary.textContent);
}
function updateInterviewOptionAvailability() {
    if (usesUnifiedCreationCredits()) {
        interviewOptionButtons.forEach(btn => { btn.disabled = false; btn.classList.remove('disabled'); btn.title = ''; btn.setAttribute('aria-disabled', 'false'); });
        return;
    }
    const slidesCredits = creationCreditState()?.snapshot?.scheme === 1 && userCredits
        ? (hasUnlimitedCredit('slides') ? Number.POSITIVE_INFINITY : Number(userCredits.slides || 0)) : Number.POSITIVE_INFINITY;
    const selectedCount = selectedInterviewFeatures.length;
    interviewOptionButtons.forEach(btn => {
        const feature = btn.dataset.feature;
        const selected = selectedInterviewFeatures.includes(feature);
        const nextCost = selected ? Math.max(0, selectedCount - 1) : (selectedCount + 1);
        const canEnable = slidesCredits >= nextCost;
        btn.disabled = !canEnable && !selected;
        btn.classList.toggle('disabled', btn.disabled);
        btn.title = btn.disabled ? 'Not enough text extraction credits for this extra.' : '';
        btn.setAttribute('aria-disabled', btn.disabled ? 'true' : 'false');
    });
}
function updateModeCreditDisplay() {
    if (!creationCreditSnapshot() && publicCreditConfig?.scheme !== 1) {
        modeCreditCost.textContent = creationCreditText('Credit cost unavailable.');
        updateModeCostSummary();
        return;
    }
    if (usesUnifiedCreationCredits()) {
        const quote = creationCreditQuote();
        modeCreditCost.textContent = quote ? creationCreditText('Uses {credits}.', { credits: creditUtils.formatCredits(quote.needed) }) : creationCreditText('Credit cost unavailable.');
        updateModeCostSummary();
        return;
    }
    if (currentMode !== 'interview') {
        setSanitizedHtml(modeCreditCost, modeConfig[currentMode].creditCost);
        updateModeCostSummary();
        return;
    }
    const extraCost = getInterviewExtraCost();
    if (!extraCost) {
        setSanitizedHtml(modeCreditCost, 'Uses <strong>1 interview credit</strong>. Optional extras cost <strong>1 text extraction credit</strong> each.');
    } else {
        setSanitizedHtml(modeCreditCost, `Uses <strong>1 interview credit</strong> + <strong>${extraCost} text extraction credits</strong> for selected extras.`);
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
        const active = chip.dataset.studyFeatures === selectedStudyFeatures;
        chip.classList.toggle('active', active);
        chip.setAttribute('aria-pressed', active ? 'true' : 'false');
        chip.setAttribute('aria-selected', active ? 'true' : 'false');
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
        } catch (_) { }
    }
    const disableFlashcards = currentMode === 'interview' || selectedStudyFeatures === 'none' || selectedStudyFeatures === 'test';
    const disableQuestions = currentMode === 'interview' || selectedStudyFeatures === 'none' || selectedStudyFeatures === 'flashcards';
    flashcardAmountChips.forEach(chip => { chip.disabled = disableFlashcards; });
    questionAmountChips.forEach(chip => { chip.disabled = disableQuestions; });
    setHidden(flashcardAmountControl, disableFlashcards);
    setHidden(questionAmountControl, disableQuestions);
    syncProcessingLayout();
    updateProcessButton();
}
function setAmountSelection(kind, value) {
    if (kind === 'flashcards') {
        selectedFlashcardAmount = value;
        flashcardAmountChips.forEach(chip => {
            const active = chip.dataset.value === value;
            chip.classList.toggle('active', active);
            chip.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
    } else {
        selectedQuestionAmount = value;
        questionAmountChips.forEach(chip => {
            const active = chip.dataset.value === value;
            chip.classList.toggle('active', active);
            chip.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
    }
}
function updateInterviewOptionsUI() {
    const legacyCredits = creationCreditState()?.snapshot?.scheme === 1 ? userCredits : null;
    if (legacyCredits) {
        const maxAffordable = hasUnlimitedCredit('slides') ? 2 : Math.max(0, Number(userCredits.slides || 0));
        if (selectedInterviewFeatures.length > maxAffordable) {
            selectedInterviewFeatures = selectedInterviewFeatures.slice(0, maxAffordable);
        }
    }
    updateInterviewOptionAvailability();
    interviewOptionButtons.forEach(btn => {
        const active = selectedInterviewFeatures.includes(btn.dataset.feature);
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    const slidesCredits = legacyCredits ? (hasUnlimitedCredit('slides') ? Number.POSITIVE_INFINITY : Number(legacyCredits.slides || 0)) : 0;
    if (usesUnifiedCreationCredits()) {
        const extra = creditUtils.quote(creationCreditSnapshot(), [{ action: 'interview_extra', units: selectedInterviewFeatures.length || 1 }]);
        interviewExtraNote.textContent = extra
            ? creationCreditText(selectedInterviewFeatures.length ? 'Selected extras: {credits}.' : 'Optional extras: {credits} each.', { credits: creditUtils.formatCredits(extra.needed) })
            : creationCreditText('Credit cost unavailable.');
    } else if (!usesLegacyCreationCredits()) {
        interviewExtraNote.textContent = creationCreditText('Credit cost unavailable.');
    } else if (!selectedInterviewFeatures.length && legacyCredits && hasUnlimitedCredit('slides')) {
        interviewExtraNote.textContent = 'No extras selected. Text extraction extras are available with unlimited credits.';
    } else if (!selectedInterviewFeatures.length && legacyCredits && slidesCredits <= 0) {
        interviewExtraNote.textContent = 'No extras selected. You currently have 0 text extraction credits, so extras are disabled.';
    } else if (!selectedInterviewFeatures.length) {
        interviewExtraNote.textContent = 'No extras selected. Select one or both options (1 text extraction credit per option).';
    } else if (selectedInterviewFeatures.length === 1) {
        interviewExtraNote.textContent = 'Selected 1 extra option. This adds 1 text extraction credit.';
    } else {
        interviewExtraNote.textContent = 'Selected both extra options. This adds 2 text extraction credits.';
    }
    syncProcessingLayout();
    updateModeCreditDisplay();
    updateProcessButton();
}
function setQuickstartVisible(visible) {
    if (!quickstartCard) return;
    setHidden(quickstartCard, !visible);
}
function syncProcessingLayout() {
    if (processingUi && typeof processingUi.syncProcessingLayout === 'function') {
        processingUi.syncProcessingLayout(
            {
                uploadSection,
                pdfZone,
                audioZone,
                uploadEstimate,
                processingSecondaryGrid,
                otherAudioDisclosure,
                otherAudioToggle,
                otherAudioBody,
                otherAudioSummary,
                generationControls,
                interviewControls,
                advancedSettingsSummary,
            },
            {
                signedIn: Boolean(currentUser),
                currentMode,
                modeConfig,
                hasAnySourceFile: Boolean(pdfFile || audioFile || hasReadyImportedAudioToken()),
                audioImportInFlight,
                importedAudioReady: hasReadyImportedAudioToken(),
                recordingState,
                audioStatusText: audioUrlStatus ? String(audioUrlStatus.textContent || '').trim() : '',
                outputLanguageValue: outputLanguageSelect ? outputLanguageSelect.value : 'english',
                outputLanguageCustomValue: outputLanguageCustom ? outputLanguageCustom.value : '',
                selectedStudyFeatures,
                selectedInterviewFeatures,
                otherAudioOpen,
                getLanguageLabel,
            },
        );
        return;
    }
    setHidden(uploadEstimate, !(currentUser && (pdfFile || audioFile || hasReadyImportedAudioToken())));
}
function applyStoredStudyFeaturePreference(user) {
    if (!user || !user.uid) return;
    let stored = '';
    try {
        stored = localStorage.getItem(`study_tools_pref_${user.uid}`) || '';
    } catch (_) { }
    const next = ['none', 'flashcards', 'test', 'both'].includes(stored) ? stored : 'both';
    setStudyFeature(next);
}
function applyRecommendedSetup() {
    switchMode('lecture-notes');
    setStudyFeature('both');
    setAdvancedSettingsVisible(false);
    showToast('Recommended setup applied: Lecture Notes + Flashcards + Test.', 'success');
    try {
        uploadSection.scrollIntoView({ behavior: uxUtils.prefersReducedMotion && uxUtils.prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    } catch (_) { }
}
function updateQuickstartVisibility() {
    if (!currentUser || !quickstartCard || !userProfileLoaded) {
        setQuickstartVisible(false);
        return;
    }
    const isNewUser = !userHasCreatedStudyPack;
    let dismissed = false;
    try {
        dismissed = localStorage.getItem(`quickstart_dismissed_${currentUser.uid}`) === '1';
    } catch (_) { }
    setQuickstartVisible(isNewUser && !dismissed && !resultsLocked && currentMode === 'lecture-notes');
}
function mergeRuntimeJobs(currentJobs, incomingJobs) {
    if (runtimeJobUtils && typeof runtimeJobUtils.mergeActiveRuntimeJobs === 'function') {
        return runtimeJobUtils.mergeActiveRuntimeJobs(currentJobs, incomingJobs);
    }
    return Array.isArray(incomingJobs) ? incomingJobs.slice() : [];
}
function getLatestRuntimeJob(jobs) {
    if (runtimeJobUtils && typeof runtimeJobUtils.findLatestRuntimeJob === 'function') {
        return runtimeJobUtils.findLatestRuntimeJob(jobs);
    }
    return Array.isArray(jobs) && jobs.length ? jobs[0] : null;
}
function readActiveRuntimeJobsCache(userOrUid) {
    return mergeRuntimeJobs([], readUiCacheJsonForUser(userOrUid, ACTIVE_RUNTIME_JOBS_CACHE_KEY, []));
}
function writeActiveRuntimeJobsCache(userOrUid, jobs) {
    return writeUiCacheJsonForUser(userOrUid, ACTIVE_RUNTIME_JOBS_CACHE_KEY, mergeRuntimeJobs([], jobs));
}
function setActiveRuntimeJobs(jobs) {
    activeRuntimeJobs = mergeRuntimeJobs([], jobs);
    if (currentUser) {
        writeActiveRuntimeJobsCache(currentUser, activeRuntimeJobs);
    }
}
function cacheActiveRuntimeJob(job) {
    if (!job) return;
    setActiveRuntimeJobs(mergeRuntimeJobs(activeRuntimeJobs, [job]));
}
function removeActiveRuntimeJob(jobId) {
    const safeJobId = String(jobId || '').trim();
    if (!safeJobId) return;
    if (runtimeJobUtils && typeof runtimeJobUtils.removeRuntimeJob === 'function') {
        activeRuntimeJobs = runtimeJobUtils.removeRuntimeJob(activeRuntimeJobs, safeJobId);
    } else {
        activeRuntimeJobs = (Array.isArray(activeRuntimeJobs) ? activeRuntimeJobs : []).filter((job) => String(job && job.job_id || '').trim() !== safeJobId);
    }
    if (currentUser) {
        writeActiveRuntimeJobsCache(currentUser, activeRuntimeJobs);
    }
}
function clearRuntimeJobsRefreshTimer() {
    if (!runtimeJobsRefreshTimer) return;
    clearTimeout(runtimeJobsRefreshTimer);
    runtimeJobsRefreshTimer = null;
}
function scheduleRuntimeJobsRefresh(delayMs = RUNTIME_JOBS_REFRESH_MS) {
    clearRuntimeJobsRefreshTimer();
    if (!currentUser) return;
    runtimeJobsRefreshTimer = setTimeout(() => {
        runtimeJobsRefreshTimer = null;
        refreshActiveRuntimeJobs(false);
    }, Math.max(1000, Number(delayMs || RUNTIME_JOBS_REFRESH_MS)));
}
function showProgressSafeBanner(visible) {
    if (!progressSafeBanner) return;
    progressSafeBanner.hidden = !visible;
}
function updateUIForAuthState(user) {
    if (user) {
        userProfileLoaded = false;
        userHasCreatedStudyPack = false;
        closeHeaderDropdowns('');
        if (headerSignInBtn) setHidden(headerSignInBtn, true);
        if (headerNavToggle) setHidden(headerNavToggle, false);
        if (creditsDisplay) setHidden(creditsDisplay, false);
        if (headerStudyLibraryBtn) setHidden(headerStudyLibraryBtn, false);
        if (headerFeaturesBtn) setHidden(headerFeaturesBtn, false);
        if (headerToolsBtn) setHidden(headerToolsBtn, false);
        if (headerPlannerBtn) setHidden(headerPlannerBtn, false);
        if (progressMenu) setHidden(progressMenu, false);
        if (userMenu) setHidden(userMenu, false);
        if (adminDashboardBtn) setHidden(adminDashboardBtn, true);
        signInRequired.classList.remove('visible');
        setHidden(buttonSection, false);
        setHidden(languageControls, false);
        setAdvancedSettingsVisible(false);
        applyStoredStudyFeaturePreference(user);
        const displayName = user.displayName || user.email.split('@')[0];
        const initial = displayName.charAt(0).toUpperCase();
        if (userAvatar) {
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
        }
        if (userName) userName.textContent = displayName;
        if (topbarUtils.applyAuthState && userEmail) {
            topbarUtils.applyAuthState({
                user: user,
                userTextEl: userEmail,
                signedInText: function (activeUser) { return activeUser && activeUser.email ? activeUser.email : ''; },
            });
        } else if (userEmail) {
            userEmail.textContent = user.email;
        }
        switchMode(currentMode);
        updateModeCostSummary();
        refreshStudyHeaderMetrics();
        updateQuickstartVisibility();
        syncProcessingLayout();
    } else {
        closeHeaderDropdowns('');
        if (headerSignInBtn) setHidden(headerSignInBtn, false);
        if (headerNavToggle) setHidden(headerNavToggle, true);
        if (creditsDisplay) setHidden(creditsDisplay, true);
        if (headerStudyLibraryBtn) setHidden(headerStudyLibraryBtn, true);
        if (headerFeaturesBtn) setHidden(headerFeaturesBtn, true);
        if (headerToolsBtn) setHidden(headerToolsBtn, true);
        if (headerPlannerBtn) setHidden(headerPlannerBtn, true);
        if (progressMenu) setHidden(progressMenu, true);
        if (userMenu) setHidden(userMenu, true);
        signInRequired.classList.add('visible');
        setHidden(buttonSection, false);
        generationControls.classList.add('hidden');
        interviewControls.classList.add('hidden');
        setHidden(languageControls, false);
        setAdvancedSettingsVisible(false);
        releaseImportedAudioToken({ clearStatus: true });
        currentUser = null;
        userCredits = null;
        idToken = null;
        if (authClient && typeof authClient.clearToken === 'function') authClient.clearToken();
        progressSummaryCache = null;
        userTotalProcessed = 0;
        userHasCreatedStudyPack = false;
        userProfileLoaded = false;
        currentUserIsAdmin = false;
        userPreferences = null;
        clearLanguagePreferenceSaveTimer();
        closeLanguageOnboarding();
        stopPolling();
        currentJobId = null;
        setActiveRuntimeJobs([]);
        clearRuntimeJobsRefreshTimer();
        runtimeJobsRefreshInFlight = false;
        notificationPermissionRequested = false;
        notifiedTerminalJobIds = new Set();
        otherAudioOpen = false;
        uploadCooldownUntilMs = 0;
        clearUploadCooldownTimer();
        modalStateStack = [];
        activeModalOverlay = null;
        if (adminDashboardBtn) setHidden(adminDashboardBtn, true);
        updateInterviewOptionAvailability();
        updateModeCostSummary();
        if (processButton) processButton.disabled = true;
        updateProcessButton();
        showProgressSafeBanner(false);
        setQuickstartVisible(false);
        syncProcessingLayout();
    }
}
function handleUnverifiedEmailUser(user, options = {}) {
    unverifiedEmailUser = user || auth.currentUser || unverifiedEmailUser;
    currentUser = null;
    userCredits = null;
    idToken = null;
    currentUserIsAdmin = false;
    userProfileLoaded = false;
    userPreferences = null;
    if (authClient && typeof authClient.clearToken === 'function') authClient.clearToken();
    updateUIForAuthState(null);
    showEmailVerificationPrompt(unverifiedEmailUser, {
        view: options.view || 'signin',
        verificationEmailSent: Boolean(options.verificationEmailSent),
    });
}
function activateVerifiedUser(user) {
    if (!user) return Promise.resolve(false);
    const uid = String(user.uid || user.email || '').trim();
    if (verifiedUserActivationPromise && verifiedUserActivationUid === uid) {
        return verifiedUserActivationPromise;
    }
    const operation = (async () => {
        const session = authClient.captureSession();
        session.assertCurrent();
        if (session.user !== user) throw new Error('Your account changed. Please try again.');
        unverifiedEmailUser = null;
        currentUser = user;
        // Firebase reuses a valid token and refreshes it automatically when due.
        const token = await user.getIdToken();
        session.assertCurrent();
        idToken = token;
        if (authClient && typeof authClient.setToken === 'function') authClient.setToken(idToken);
        updateUIForAuthState(user);
        if (resumePendingNonAdminAuthReturnIfNeeded()) return true;
        const profileReady = fetchUserData();
        if (isAdminAuthReturnUrl(getPendingAuthReturnUrl())) {
            // Only profile authorization and the secure cookie gate admin entry.
            await profileReady;
            session.assertCurrent();
            return resumePendingAuthReturnIfNeeded();
        }
        setActiveRuntimeJobs(readActiveRuntimeJobsCache(user));
        resumeLatestRuntimeJob(activeRuntimeJobs, { startPolling: true });
        // Account details, payment reconciliation and job recovery must not
        // hold the sign-in button or toast while their requests finish.
        void checkPaymentResult().catch((error) => captureClientError(error, 'login_payment_result'));
        void refreshActiveRuntimeJobs(true);
        return false;
    })();
    verifiedUserActivationUid = uid;
    verifiedUserActivationPromise = operation;
    return operation.finally(() => {
        if (verifiedUserActivationPromise === operation) {
            verifiedUserActivationPromise = null;
            verifiedUserActivationUid = '';
        }
    });
}
let handlingDisallowedAuthState = false;
bootstrap.onAuthStateReady(auth, async (user) => {
    if (handlingDisallowedAuthState) return;
    authStateResolved = true;
    currentUser = user;
    if (user) {
        // Explicit sign-in/sign-up handlers own eligibility and verification
        // during submission. Running both paths duplicates checks and loading.
        if (['signin', 'signup', 'google'].includes(authSubmitBusyKind)) return;
        const session = authClient.captureSession();
        const check = await checkEmailAllowed(user.email || '');
        if (!session.isCurrent()) return;
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
        if (isUnverifiedEmailUser(user)) {
            handleUnverifiedEmailUser(user, { view: signupView.classList.contains('active') ? 'signup' : 'signin' });
            return;
        }
        await activateVerifiedUser(user);
    } else {
        unverifiedEmailUser = null;
        updateUIForAuthState(null);
    }
});
function formatFileSize(bytes) {
    if (!bytes) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
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
    const ux = window.LectureProcessorUx;
    if (ux && ux.toast) {
        ux.toast(message, { element: toast, textElement: toastText, type, duration, show: (el) => { el.className = `toast visible ${type}`; renderToastIcon(type); } });
        return;
    }
    toastText.textContent = message;
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
    const current = creationCreditState();
    if (!current || current.status !== 'ready' || current.source !== 'server') return false;
    if (usesUnifiedCreationCredits()) {
        const state = creationCreditState();
        const quote = creationCreditQuote();
        return Boolean(state && state.status === 'ready' && state.source === 'server' && quote && quote.sufficient);
    }
    if (!userCredits) return false;
    const config = modeConfig[currentMode];
    if (config.creditType === 'lecture') return hasUnlimitedCredit('lecture') || (userCredits.lecture_standard + userCredits.lecture_extended) > 0;
    if (config.creditType === 'slides') return hasUnlimitedCredit('slides') || userCredits.slides > 0;
    if (config.creditType === 'interview') {
        const extraCost = getInterviewExtraCost();
        const hasInterviewCredit = hasUnlimitedCredit('interview') || getTotalInterviewCredits() > 0;
        const hasSlidesForExtras = hasUnlimitedCredit('slides') || userCredits.slides >= extraCost;
        return hasInterviewCredit && hasSlidesForExtras;
    }
    return false;
}
function getProgressStepsForMode(mode, totalSteps) {
    if (progressFlowUtils && typeof progressFlowUtils.getProgressStepsForMode === 'function') {
        return progressFlowUtils.getProgressStepsForMode(mode, totalSteps, modeConfig);
    }
    const safeMode = String(mode || '').trim();
    return safeMode === 'slides-only'
        ? modeConfig['slides-only'].steps.slice()
        : modeConfig['lecture-notes'].steps.slice();
}
function updateProgressStepsForStatus(payload) {
    const totalSteps = Math.max(0, Number(payload && payload.total_steps || 0));
    const mode = String(payload && payload.mode || currentMode || '').trim() || currentMode;
    const steps = getProgressStepsForMode(mode, totalSteps);
    if (progressSteps.childElementCount !== steps.length) {
        buildProgressSteps(steps);
    }
}
function buildRuntimeJobSnapshot(job, fallback = {}) {
    if (progressFlowUtils && typeof progressFlowUtils.buildRuntimeJobSnapshot === 'function') {
        return progressFlowUtils.buildRuntimeJobSnapshot(job, fallback, runtimeJobUtils);
    }
    return Object.assign({}, fallback || {}, job || {});
}
function applyRuntimeJobProgress(job, options = {}) {
    const snapshot = buildRuntimeJobSnapshot(job);
    if (!snapshot.job_id) return false;
    if (snapshot.mode && snapshot.mode !== currentMode) {
        switchMode(snapshot.mode);
    }
    if (studyPackTitleInput && !String(studyPackTitleInput.value || '').trim() && snapshot.study_pack_title) {
        studyPackTitleInput.value = snapshot.study_pack_title;
    }
    const steps = getProgressStepsForMode(snapshot.mode || currentMode, options.totalSteps || snapshot.total_steps);
    buildProgressSteps(steps);
    progressSection.classList.add('visible');
    resultsSection.classList.remove('visible');
    progressStatus.classList.remove('error');
    setHidden(progressSpinner, false);
    showProgressSafeBanner(true);
    focusProgressSection();
    updateProgressUI(Math.max(0, Number(snapshot.step || 0)), snapshot.step_description || 'Processing continues in the background...', steps.length);
    currentJobId = snapshot.job_id;
    trackedTerminalJobId = '';
    cacheActiveRuntimeJob(snapshot);
    updateProcessButton();
    return true;
}
function shouldPromptForNotificationsAfterJobStart() {
    if (runtimeJobUtils && typeof runtimeJobUtils.shouldPromptForNotifications === 'function') {
        return runtimeJobUtils.shouldPromptForNotifications({
            jobStarted: true,
            notificationSupported: 'Notification' in window,
            permission: 'Notification' in window ? Notification.permission : 'denied',
        });
    }
    return 'Notification' in window && Notification.permission === 'default';
}
function maybeRequestNotificationPermissionAfterJobStart() {
    if (notificationPermissionRequested || !shouldPromptForNotificationsAfterJobStart()) return;
    notificationPermissionRequested = true;
    try {
        Notification.requestPermission().catch(() => { });
    } catch (_) { }
}
function maybeSendCompletionNotification(job, payload) {
    const snapshot = buildRuntimeJobSnapshot(job, payload);
    if (!snapshot.job_id || notifiedTerminalJobIds.has(snapshot.job_id)) return;
    const isHidden = document.visibilityState !== 'visible' || !document.hasFocus();
    if (!isHidden) return;
    if (!(runtimeJobUtils && typeof runtimeJobUtils.shouldSendCompletionNotification === 'function')) return;
    if (!runtimeJobUtils.shouldSendCompletionNotification({
        notificationSupported: 'Notification' in window,
        permission: 'Notification' in window ? Notification.permission : 'denied',
        status: payload && payload.status,
    })) {
        return;
    }
    const notification = runtimeJobUtils.buildCompletionNotification(snapshot, payload || {});
    if (!notification || !notification.title) return;
    notifiedTerminalJobIds.add(snapshot.job_id);
    try {
        const nativeNotification = new Notification(notification.title, {
            body: notification.body || '',
            silent: false,
        });
        nativeNotification.onclick = () => {
            try { window.focus(); } catch (_) { }
            window.location.href = '/study';
        };
    } catch (_) { }
}
function updateUploadEstimatePanel() {
    if (!uploadEstimate || !uploadEstimateTime || !uploadEstimateMeta) return;
    if (!currentUser || resultsLocked || !(pdfFile || audioFile || hasReadyImportedAudioToken())) {
        setHidden(uploadEstimate, true);
        return;
    }
    setHidden(uploadEstimate, false);
    uploadEstimateTime.textContent = UPLOAD_ESTIMATE_COPY[currentMode] || 'Processing time depends on the upload.';

    const totalBytes = (pdfFile ? Number(pdfFile.size || 0) : 0) + currentAudioBytes();
    const totalMb = totalBytes / (1024 * 1024);
    if (currentMode === 'lecture-notes') {
        uploadEstimateMeta.textContent = `Requires PDF or PPTX (max 50 MB) + audio (max 500 MB). Current upload: ${totalMb.toFixed(1)} MB.`;
    } else if (currentMode === 'slides-only') {
        uploadEstimateMeta.textContent = `Requires PDF or PPTX (max 50 MB). Current upload: ${totalMb.toFixed(1)} MB.`;
    } else {
        const extras = getInterviewExtraCost();
        uploadEstimateMeta.textContent = !usesLegacyCreationCredits()
            ? creationCreditText('Requires audio only (max 500 MB). Selected extras: {count}. Current upload: {size} MB.', { count: extras, size: totalMb.toFixed(1) })
            : `Requires audio only (max 500 MB). Selected extras: ${extras} (${extras} text extraction credits). Current upload: ${totalMb.toFixed(1)} MB.`;
    }
}
function setProcessButtonAvailability(disabled, reason) {
    if (!processButton) return;
    const isDisabled = Boolean(disabled);
    processButton.disabled = isDisabled;
    processButton.setAttribute('aria-disabled', isDisabled ? 'true' : 'false');
    if (processDisabledReason) {
        processDisabledReason.textContent = isDisabled ? String(reason || '') : '';
    }
}
function updateMobileProcessSummary(options = {}) {
    if (!mobileProcessSummary) return;
    const config = modeConfig[currentMode] || {};
    const uploadCooldown = Math.max(0, Number(options.uploadCooldown || 0));
    const hasCredits = options.hasCredits !== false;
    const pdfReady = !config.needsPdf || Boolean(pdfFile);
    const audioReady = !config.needsAudio || Boolean(audioFile) || hasReadyImportedAudioToken();
    if (usesUnifiedCreationCredits() && currentUser && !hasCredits && pdfReady && audioReady) {
        mobileProcessSummary.textContent = creationCreditStatus();
        return;
    }
    if (processingUi && typeof processingUi.getProcessReadinessSummary === 'function') {
        mobileProcessSummary.textContent = processingUi.getProcessReadinessSummary({
            signedIn: Boolean(currentUser),
            authPending: !authStateResolved && !currentUser,
            currentMode,
            modeConfig,
            pdfReady,
            audioReady,
            hasCredits,
            uploadedAudioReady: Boolean(audioFile),
            importedAudioReady: hasReadyImportedAudioToken(),
            hasLocalAudioFile: Boolean(audioFile),
            audioImportInFlight,
            currentJobActive: Boolean(currentJobId && !resultsLocked),
            uploadCooldown,
            formatRetryDelay,
        });
        return;
    }
    mobileProcessSummary.textContent = 'Complete the required items to start processing.';
}
function updateProcessButton() {
    const config = modeConfig[currentMode];
    const pdfReady = !config.needsPdf || pdfFile;
    const audioReady = !config.needsAudio || audioFile || hasReadyImportedAudioToken();
    const titleReady = Boolean(getStudyPackTitleValue());
    const hasCredits = hasEnoughCredits();
    const uploadCooldown = getUploadCooldownSeconds();
    updateUploadEstimatePanel();
    updateMobileProcessSummary({ pdfReady, audioReady, hasCredits, uploadCooldown });
    if (uploadCooldown > 0) {
        setProcessButtonAvailability(true, `Processing can resume in ${formatRetryDelay(uploadCooldown)}.`);
        processButton.querySelector('span').textContent = `Try again in ${formatRetryDelay(uploadCooldown)}`;
        noCreditsWarning.classList.remove('visible');
        return;
    }
    if (config.needsAudio && audioImportInFlight && !audioFile) {
        setProcessButtonAvailability(true, 'Lecture audio is still importing.');
        processButton.querySelector('span').textContent = 'Importing lecture audio...';
        noCreditsWarning.classList.remove('visible');
        return;
    }
    if (currentJobId && !resultsLocked) {
        setProcessButtonAvailability(true, 'A processing job is already running in the background.');
        processButton.querySelector('span').textContent = 'Processing in background...';
        noCreditsWarning.classList.remove('visible');
        return;
    }
    let disabledReason = '';
    if (resultsLocked) {
        disabledReason = 'The current results are still open.';
    } else if (!pdfReady && !audioReady) {
        disabledReason = 'Add the required slides and audio before processing.';
    } else if (!pdfReady) {
        disabledReason = 'Add the required slides before processing.';
    } else if (!audioReady) {
        disabledReason = 'Add the required audio before processing.';
    } else if (!titleReady) {
        disabledReason = config.missingTitleMessage || 'Add a title or name before processing.';
    } else if (!hasCredits) {
        disabledReason = usesUnifiedCreationCredits() || creationCreditState()?.status !== 'ready' ? creationCreditStatus() : currentMode === 'interview' && userCredits && getTotalInterviewCredits() > 0 && !hasUnlimitedCredit('slides') && userCredits.slides < getInterviewExtraCost()
            ? 'Not enough text extraction credits for the selected interview extras.'
            : 'Not enough credits for this processing mode.';
    }
    setProcessButtonAvailability(!(pdfReady && audioReady && titleReady && hasCredits) || resultsLocked, disabledReason);
    processButton.querySelector('span').textContent = config.buttonText;
    if (currentUser && !hasCredits && !resultsLocked) {
        if (usesUnifiedCreationCredits() || creationCreditState()?.status !== 'ready') {
            noCreditsWarning.textContent = creationCreditStatus();
        } else if (currentMode === 'interview' && getTotalInterviewCredits() > 0 && !hasUnlimitedCredit('slides') && userCredits.slides < getInterviewExtraCost()) {
            setSanitizedHtml(noCreditsWarning, "You don't have enough text extraction credits for the selected interview extras. <a href=\"#\" id=\"buy-credits-link-inline\">Buy more credits</a>");
        } else {
            setSanitizedHtml(noCreditsWarning, "You don't have enough credits. <a href=\"#\" id=\"buy-credits-link-inline\">Buy more credits</a>");
        }
        noCreditsWarning.classList.add('visible');
        const inlineLink = document.getElementById('buy-credits-link-inline');
        if (inlineLink) {
            inlineLink.addEventListener('click', (e) => {
                e.preventDefault();
                window.location.href = '/buy_credits';
            });
        }
    } else {
        noCreditsWarning.classList.remove('visible');
    }
}
function switchMode(mode) {
    if (forcedMode && mode !== forcedMode) {
        mode = forcedMode;
    }
    if (!((modeConfig[mode] || {}).needsAudio) && (recordingState === 'recording' || recordingState === 'paused')) {
        stopAudioRecording();
    }
    currentMode = mode;
    const config = modeConfig[mode];
    modeTabs.forEach(tab => {
        const isActive = tab.dataset.mode === mode;
        tab.classList.toggle('active', isActive);
        tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
        tab.tabIndex = isActive ? 0 : -1;
    });
    modeDescriptionText.textContent = config.description;
    if (studyPackTitleLabel) studyPackTitleLabel.textContent = config.titleLabel || 'Title / Name';
    if (studyPackTitleInput) studyPackTitleInput.placeholder = config.titlePlaceholder || '';
    if (studyPackTitleError) studyPackTitleError.textContent = `${config.titleLabel || 'Title / Name'} is required.`;
    if (pdfZoneTitle) pdfZoneTitle.textContent = config.pdfTitle || 'Lecture Slides';
    if (pdfZoneBadge) {
        pdfZoneBadge.textContent = config.pdfRequirement || 'Required';
        pdfZoneBadge.className = `upload-badge ${config.pdfRequirementTone || 'required'}`;
    }
    if (pdfZoneHelper) pdfZoneHelper.textContent = config.pdfHelper || '';
    audioZoneTitle.textContent = config.audioTitle;
    if (audioZoneBadge) {
        audioZoneBadge.textContent = config.audioRequirement || 'Required';
        audioZoneBadge.className = `upload-badge ${config.audioRequirementTone || 'required'}`;
    }
    if (audioZoneHelper) audioZoneHelper.textContent = config.audioHelper || '';
    if (audioUrlImportTitle) audioUrlImportTitle.textContent = config.lmsImportTitle || 'Import from lecture video URL';
    if (audioUrlImportHint) audioUrlImportHint.textContent = config.lmsImportHint || '';
    generationControls.classList.toggle('hidden', mode === 'interview');
    interviewControls.classList.toggle('hidden', mode !== 'interview');
    if (mode === 'interview') {
        setStudyToolsPanelVisible(false);
    }
    updateModeCreditDisplay();
    setHidden(pdfInfo, !pdfFile);
    pdfZone.classList.toggle('has-file', Boolean(pdfFile));
    if (!config.needsAudio) syncAudioInfoUI();
    setStudyFeature(selectedStudyFeatures);
    updateInterviewOptionsUI();
    syncRecorderUI();
    syncProcessingLayout();
    updateProcessButton();
}
modeTabs.forEach(tab => tab.addEventListener('click', () => switchMode(tab.dataset.mode)));
if (studyPackTitleInput) {
    studyPackTitleInput.addEventListener('input', () => {
        setStudyPackTitleInvalid(false);
        updateProcessButton();
    });
    studyPackTitleInput.addEventListener('blur', () => {
        setStudyPackTitleInvalid(!getStudyPackTitleValue());
    });
}
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
        setStudyToolsPanelVisible(false);
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
    setHidden(pdfInfo, false);
    pdfZone.classList.add('has-file');
    syncProcessingLayout();
    updateProcessButton();
}
function shouldIgnoreDropZoneActivation(target) {
    if (!target || typeof target.closest !== 'function') return false;
    return Boolean(
        target.closest('.file-remove')
        || target.closest('.file-info')
        || target.closest('.audio-recorder-panel')
        || target.closest('button')
        || target.closest('a')
        || target.closest('input')
        || target.closest('select')
        || target.closest('textarea')
    );
}
function setupDropZone(zone, input, handler) {
    zone.addEventListener('click', (e) => {
        if (shouldIgnoreDropZoneActivation(e.target)) return;
        input.click();
    });
    zone.addEventListener('keydown', (e) => {
        if (e.target !== zone) return;
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        input.click();
    });
    input.addEventListener('change', (e) => { if (e.target.files.length) handler(e.target.files[0]); });
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', (e) => { e.preventDefault(); zone.classList.remove('drag-over'); });
    zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('drag-over'); if (e.dataTransfer.files.length) handler(e.dataTransfer.files[0]); });
}
function downloadLocalPreviewFile(file) {
    if (!file) return false;
    const blobUrl = URL.createObjectURL(file);
    const anchor = document.createElement('a');
    anchor.href = blobUrl;
    anchor.download = String(file.name || 'upload');
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(blobUrl);
    return true;
}
setupDropZone(pdfZone, pdfInput, handlePdfFile);
setupDropZone(audioZone, audioInput, handleAudioFile);
bindRecordingControls();
const downloadSelectedPdf = () => {
    if (downloadLocalPreviewFile(pdfFile)) {
        showToast('Lecture slides download started.', 'success', 1600);
    }
};
if (pdfDownload) {
    pdfDownload.addEventListener('click', (e) => {
        e.stopPropagation();
        downloadSelectedPdf();
    });
}
if (audioDownload) {
    audioDownload.addEventListener('click', (e) => {
        e.stopPropagation();
        downloadSelectedAudio();
    });
}
pdfRemove.addEventListener('click', (e) => {
    e.stopPropagation();
    pdfFile = null;
    pdfInput.value = '';
    setHidden(pdfInfo, true);
    pdfZone.classList.remove('has-file');
    syncProcessingLayout();
    updateProcessButton();
});
audioRemove.addEventListener('click', removeSelectedAudio);

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
    progressSection.classList.remove('is-error');
    progressSection.querySelector('.progress-title').textContent = currentMode === 'interview' ? 'Preparing your transcript' : 'Preparing your study material';
    progressSection.querySelector('.progress-subtitle').textContent = 'Processing time depends on the size of your source.';
    for (let i = 1; i <= total; i++) {
        const el = document.getElementById(`step-${i}`);
        if (!el) continue;
        el.classList.remove('active', 'complete');
        if (i < step) el.classList.add('complete');
        else if (i === step) el.classList.add('active');
    }
    if (progressStatus) {
        progressStatus.setAttribute('role', 'status');
        progressStatus.setAttribute('aria-live', 'polite');
        progressStatus.setAttribute('aria-atomic', 'true');
    }
    statusText.textContent = desc || 'Processing...';
}
function announceProgressError(message) {
    if (!progressStatus || !statusText) return;
    progressStatus.setAttribute('role', 'alert');
    progressStatus.setAttribute('aria-live', 'assertive');
    progressStatus.setAttribute('aria-atomic', 'true');
    statusText.textContent = message || 'Error while processing.';
}
function focusProgressSection() {
    if (!progressSection) return;
    try {
        progressSection.focus({ preventScroll: true });
    } catch (_) {
        try { progressSection.focus(); } catch (_) { }
    }
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
    progressRetry.classList.toggle('visible', Boolean(visible));
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
    setHidden(progressSpinner, false);
    statusText.textContent = 'Re-checking job status...';
    trackEvent('processing_retry_requested', { job_id: currentJobId });
    startPolling();
}
function startPolling() {
    stopPolling();
    pollFailures = 0;
    pollMissingResponses = 0;
    pollStartedAt = Date.now();
    setProgressRetryVisible(false);
    scheduleNextPoll(0);
}
function stopPolling() {
    if (pollInterval) clearTimeout(pollInterval);
    pollInterval = null;
    pollFailures = 0;
    pollMissingResponses = 0;
    pollStartedAt = 0;
}
function resetProcessingSession(options = {}) {
    const keepProgressVisible = Boolean(options.keepProgressVisible);
    const keepStatusMessage = Boolean(options.keepStatusMessage);
    const hideRetry = options.hideRetry !== false;
    stopPolling();
    if (hideRetry) setProgressRetryVisible(false);
    currentJobId = null;
    trackedTerminalJobId = '';
    showProgressSafeBanner(false);
    if (!keepStatusMessage) {
        statusText.textContent = 'Starting...';
    }
    if (!keepProgressVisible && !resultsLocked) {
        progressSection.classList.remove('visible');
        progressStatus.classList.remove('error');
        setHidden(progressSpinner, false);
    }
    updateProcessButton();
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
        } catch (e) { }
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
function reconcileCachedRuntimeJobs(serverJobs) {
    if (!currentUser) {
        return Promise.resolve({ jobs: mergeRuntimeJobs([], serverJobs), latestJob: null });
    }
    const serverActiveJobs = mergeRuntimeJobs([], serverJobs);
    const cachedJobs = readActiveRuntimeJobsCache(currentUser);
    const missingJobs = cachedJobs.filter((job) => {
        const jobId = String(job && job.job_id || '').trim();
        return jobId && !serverActiveJobs.some((serverJob) => String(serverJob && serverJob.job_id || '').trim() === jobId);
    });
    if (!missingJobs.length) {
        return Promise.resolve({ jobs: serverActiveJobs, latestJob: getLatestRuntimeJob(serverActiveJobs) });
    }
    return Promise.all(missingJobs.map(async (job) => {
        const jobId = String(job && job.job_id || '').trim();
        if (!jobId) return null;
        try {
            const response = await authenticatedFetch(`/status/${encodeURIComponent(jobId)}`);
            if (!response.ok) {
                if (response.status === 404) {
                    removeActiveRuntimeJob(jobId);
                    return null;
                }
                return null;
            }
            const payload = await response.json();
            return { cached: job, payload };
        } catch (_) {
            return null;
        }
    })).then((results) => {
        let mergedJobs = serverActiveJobs.slice();
        results.forEach((result) => {
            if (!result || !result.payload) return;
            const status = String(result.payload.status || '').trim().toLowerCase();
            if (runtimeJobUtils && typeof runtimeJobUtils.isActiveStatus === 'function' && runtimeJobUtils.isActiveStatus(status)) {
                mergedJobs = mergeRuntimeJobs(mergedJobs, [Object.assign({}, result.cached || {}, result.payload || {})]);
                return;
            }
            removeActiveRuntimeJob(result.cached && result.cached.job_id);
        });
        return { jobs: mergedJobs, latestJob: getLatestRuntimeJob(mergedJobs) };
    });
}
function resumeLatestRuntimeJob(jobs, options = {}) {
    if (resultsLocked) return false;
    const latestJob = getLatestRuntimeJob(jobs);
    if (!latestJob || !latestJob.job_id) return false;
    if (currentJobId && currentJobId === latestJob.job_id && options.force !== true) {
        return true;
    }
    applyRuntimeJobProgress(latestJob);
    if (options.startPolling !== false) {
        startPolling();
    }
    return true;
}
async function refreshActiveRuntimeJobs(force) {
    if (!currentUser || !idToken) {
        setActiveRuntimeJobs([]);
        clearRuntimeJobsRefreshTimer();
        return;
    }
    if (runtimeJobsRefreshInFlight && !force) return;
    runtimeJobsRefreshInFlight = true;
    try {
        const response = await authenticatedFetch('/api/runtime-jobs/active');
        if (!response.ok) {
            throw new Error('Could not refresh active jobs.');
        }
        const payload = await response.json();
        const reconciled = await reconcileCachedRuntimeJobs(payload && payload.jobs ? payload.jobs : []);
        setActiveRuntimeJobs(reconciled.jobs || []);
        if (!resultsLocked) {
            resumeLatestRuntimeJob(reconciled.jobs || [], { startPolling: true, force });
        }
    } catch (error) {
        if (force) {
            showToast(error.message || 'Could not refresh processing jobs.', 'error');
        }
    } finally {
        runtimeJobsRefreshInFlight = false;
        scheduleRuntimeJobsRefresh(RUNTIME_JOBS_REFRESH_MS);
    }
}
async function pollStatus() {
    const jobId = currentJobId;
    if (!jobId) return;
    const session = authClient.captureSession();
    const isCurrentPoll = () => currentJobId === jobId && session.isCurrent();
    if (pollStartedAt && (Date.now() - pollStartedAt) > POLL_MAX_RUNTIME_MS) {
        const activeJobId = jobId;
        resetProcessingSession({ keepProgressVisible: true, keepStatusMessage: true });
        progressStatus.classList.add('error');
        setHidden(progressSpinner, true);
        statusText.textContent = 'Still processing on the server. Start a new run or retry later from Study Library.';
        showToast('Processing is taking longer than expected. Please check again shortly.', 'info', 6000);
        trackEvent('processing_timeout', activeJobId ? { job_id: activeJobId } : {});
        return;
    }
    try {
        const r = await authenticatedFetch(`/status/${encodeURIComponent(jobId)}`);
        if (!isCurrentPoll()) return;
        if (r.status === 401) {
            resetProcessingSession({ keepProgressVisible: true });
            showAuthModal('signin');
            return;
        }
        if (r.status === 403) {
            const reason = await r.json().catch(() => null);
            if (!isCurrentPoll()) return;
            resetProcessingSession({ keepProgressVisible: true });
            showError(reason && reason.error_code === 'email_not_verified'
                ? 'Verify your email address before continuing.'
                : 'You do not have access to this job.');
            return;
        }
        const d = await r.json();
        if (!isCurrentPoll()) return;
        if (d.error && d.status !== 'error') {
            const isRetryableMissing = r.status === 404 && (d.retryable || d.error_code === 'JOB_TEMPORARILY_UNAVAILABLE' || d.job_lost);
            if (isRetryableMissing && pollMissingResponses < 3) {
                pollMissingResponses += 1;
                const waitMs = Math.min(POLL_MAX_MS, POLL_BASE_MS * Math.pow(2, pollMissingResponses));
                statusText.textContent = `Reconnecting to job status... retrying in ${Math.ceil(waitMs / 1000)}s`;
                scheduleNextPoll(waitMs);
                return;
            }
            const terminalJobId = jobId;
            resetProcessingSession({ keepProgressVisible: true });
            trackEvent('processing_failed', {
                reason: d.error_code || 'job_not_found',
                job_id: terminalJobId || undefined,
            });
            showToast(d.error || 'Error: Job not found', 'error');
            return;
        }
        updateProgressStepsForStatus(d);
        updateProgressUI(d.step, d.step_description, d.total_steps);
        cacheActiveRuntimeJob({
            job_id: jobId,
            mode: d.mode || currentMode,
            status: d.status,
            step: d.step,
            step_description: d.step_description,
            study_pack_title: getStudyPackTitleValue(),
            started_at: Math.floor((pollStartedAt || Date.now()) / 1000),
            study_pack_id: d.study_pack_id || '',
            error: d.error || '',
        });
        if (d.status === 'complete') {
            stopPolling();
            setProgressRetryVisible(false);
            pollMissingResponses = 0;
            maybeSendCompletionNotification({
                job_id: jobId,
                mode: d.mode || currentMode,
                study_pack_title: getStudyPackTitleValue(),
                study_pack_id: d.study_pack_id || '',
            }, d);
            removeActiveRuntimeJob(jobId);
            if (trackedTerminalJobId !== jobId) {
                trackedTerminalJobId = jobId;
                trackEvent('processing_completed', { job_id: jobId });
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
            const activeJobId = jobId;
            maybeSendCompletionNotification({
                job_id: activeJobId,
                mode: d.mode || currentMode,
                study_pack_title: getStudyPackTitleValue(),
                study_pack_id: d.study_pack_id || '',
                error: d.error || '',
            }, d);
            removeActiveRuntimeJob(activeJobId);
            resetProcessingSession({ keepProgressVisible: true });
            pollMissingResponses = 0;
            if (activeJobId && trackedTerminalJobId !== activeJobId) {
                trackedTerminalJobId = activeJobId;
                trackEvent('processing_failed', { job_id: activeJobId, credit_refunded: Boolean(d.credit_refunded) });
            }
            showError(d.error, d.credit_refunded, d.billing_receipt || null);
        } else {
            showProgressSafeBanner(true);
            setProgressRetryVisible(false);
            pollFailures = 0;
            pollMissingResponses = 0;
            scheduleNextPoll(POLL_BASE_MS);
        }
    } catch (e) {
        if (!isCurrentPoll()) return;
        console.error(e);
        captureClientError(e, 'poll_status');
        pollFailures += 1;
        const backoff = Math.min(POLL_MAX_MS, POLL_BASE_MS * Math.pow(2, Math.min(pollFailures, 5)));
        statusText.textContent = `Temporary connection issue. Retrying in ${Math.ceil(backoff / 1000)}s...`;
        scheduleNextPoll(backoff);
    }
}
async function processFiles() {
    const submissionSession = authClient.captureSession();
    if (!currentUser) { showAuthModal('signin'); return; }
    if (resultsLocked) {
        showToast('Click "Process Another File" to start a new generation.', 'info');
        return;
    }
    if (currentJobId) {
        showToast('A job is already processing. You can safely leave and find the result in Study Library.', 'info', 4200);
        return;
    }
    const cooldown = getUploadCooldownSeconds();
    if (cooldown > 0) {
        showToast(`Upload temporarily limited. Try again in ${formatRetryDelay(cooldown)}.`, 'info', 4500);
        updateProcessButton();
        return;
    }
    const config = modeConfig[currentMode];
    const studyPackTitle = getStudyPackTitleValue();
    if (!studyPackTitle) {
        setStudyPackTitleInvalid(true);
        showToast(`${config.titleLabel || 'Title / Name'} is required.`, 'error');
        if (studyPackTitleInput && typeof studyPackTitleInput.focus === 'function') {
            studyPackTitleInput.focus();
        }
        return;
    }
    if (usesUnifiedCreationCredits() && !hasEnoughCredits()) {
        showToast(creationCreditStatus(), 'error');
        updateProcessButton();
        return;
    }
    const fd = new FormData();
    fd.append('mode', currentMode);
    fd.append('study_pack_title', studyPackTitle);
    if (config.needsPdf && pdfFile) fd.append('pdf', pdfFile);
    if (config.needsAudio && audioFile) fd.append('audio', audioFile);
    const readyImportedAudioToken = config.needsAudio ? getReadyImportedAudioToken() : '';
    if (config.needsAudio && readyImportedAudioToken && !audioFile) {
        fd.append('audio_import_token', readyImportedAudioToken);
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
    setHidden(progressSpinner, false);
    showProgressSafeBanner(false);
    try {
        progressSection.scrollIntoView({ behavior: uxUtils.prefersReducedMotion && uxUtils.prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    } catch (_) { }
    focusProgressSection();
    updateProgressUI(0, 'Uploading files...', steps.length);
    trackEvent('process_clicked', {
        study_features: selectedStudyFeatures,
        flashcard_amount: selectedFlashcardAmount,
        question_amount: selectedQuestionAmount,
        interview_features_count: selectedInterviewFeatures.length,
    });
    try {
        const r = await authenticatedFetch('/upload', { method: 'POST', body: fd });
        if (!submissionSession.isCurrent()) return;
        const d = await r.json();
        if (!submissionSession.isCurrent()) return;
        if (d.error) {
            trackEvent('processing_failed', { reason: d.error || 'upload_failed' });
            if (typeof d.error === 'string' && d.error.toLowerCase().includes('imported audio token')) {
                clearImportedAudioLocalState();
                syncAudioInfoUI();
            }
            if (r.status === 401) showAuthModal();
            else if (r.status === 402) {
                showError(creditUtils.formatInsufficient(d) || d.error || 'No credits remaining. Please purchase more credits.');
                noCreditsWarning.classList.add('visible');
                void fetchUserData({ force: true });
            }
            else if (r.status === 429) {
                const retryAfter = getRetryAfterSeconds(r, d);
                const retryMsg = retryAfter ? `${d.error} Try again in ${formatRetryDelay(retryAfter)}.` : d.error;
                if (retryAfter > 0) startUploadCooldown(retryAfter);
                showError(retryMsg);
                showToast(retryMsg, 'info', 6000);
            } else showError(d.error);
            resetProcessingSession({ keepProgressVisible: true, keepStatusMessage: true });
            return;
        }
        currentJobId = d.job_id;
        trackedTerminalJobId = '';
        cacheActiveRuntimeJob({
            job_id: currentJobId,
            mode: currentMode,
            status: 'starting',
            step: 0,
            step_description: 'Starting...',
            study_pack_title: studyPackTitle,
            started_at: Math.floor(Date.now() / 1000),
            study_pack_id: '',
            error: '',
        });
        showProgressSafeBanner(true);
        maybeRequestNotificationPermissionAfterJobStart();
        trackEvent('processing_started', {
            job_id: currentJobId,
            study_features: selectedStudyFeatures,
            interview_features_count: selectedInterviewFeatures.length,
        });
        startPolling();
    } catch (e) {
        if (!submissionSession.isCurrent()) return;
        captureClientError(e, 'process_files');
        showError('Failed to upload files. Please try again.');
        resetProcessingSession({ keepProgressVisible: true, keepStatusMessage: true });
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
    const options = typeof indexResultsUtils.buildDownloadOptions === 'function'
        ? indexResultsUtils.buildDownloadOptions({
            currentMode,
            currentStudyPackId,
            downloadLabels: DOWNLOAD_LABELS,
            interviewCombinedText,
            interviewSectionsText,
            interviewSummaryText,
            transcript,
        })
        : [];
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
    if (type === 'pdf-answers' || type === 'pdf-no-answers') {
        if (!currentStudyPackId) return;
        const withAnswers = type === 'pdf-answers';
        const query = 'answers=' + (withAnswers ? 'true' : 'false') + '&download=true';
        const filename = 'study-pack-' + currentStudyPackId + (withAnswers ? '' : '-no-answers') + '.pdf';

        showToast('Download started', 'success');
        try {
            const r = await authenticatedFetch('/api/study-packs/' + encodeURIComponent(currentStudyPackId) + '/export-pdf?' + query);
            const blob = await r.blob();
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
        } catch (e) {
            showToast(e.message || 'Could not download PDF.', 'error');
        }
        return;
    }
    const textDownload = typeof indexResultsUtils.resolveTextDownload === 'function'
        ? indexResultsUtils.resolveTextDownload({
            currentMode,
            format,
            interviewCombinedText,
            interviewSectionsText,
            interviewSummaryText,
            resultMarkdown,
            slideText,
            transcript,
            type,
        })
        : { content: resultMarkdown, filename: 'output.md' };
    const content = textDownload.content;
    const filename = textDownload.filename;
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
    const exportState = typeof indexResultsUtils.getExportCsvState === 'function'
        ? indexResultsUtils.getExportCsvState({
            activeResultsTab,
            currentMode,
            flashcards,
            testQuestions,
        })
        : { visible: false, type: '', text: '' };
    exportCsvType = exportState.type || exportCsvType;
    if (exportState.text) {
        exportStudyCsvText.textContent = exportState.text;
    }
    setHidden(exportStudyCsvBtn, !exportState.visible);
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
    const viewModel = typeof indexResultsUtils.buildFlashcardViewModel === 'function'
        ? indexResultsUtils.buildFlashcardViewModel(flashcards, flashcardIndex, flashcardFlipped)
        : { hasCards: false, progressText: 'Card 0 of 0', canGoPrev: false, canGoNext: false };
    if (!viewModel.hasCards) {
        setHidden(flashcardEmpty, false);
        setHidden(flashcardCard, true);
        flashcardProgress.textContent = viewModel.progressText;
        flashcardPrevBtn.disabled = true;
        flashcardNextBtn.disabled = true;
        flashcardFlipBtn.disabled = true;
        return;
    }
    setHidden(flashcardEmpty, true);
    setHidden(flashcardCard, false);
    flashcardFrontText.textContent = viewModel.front;
    flashcardBackText.textContent = viewModel.back;
    flashcardInner.classList.toggle('flipped', viewModel.flipped);
    flashcardProgress.textContent = viewModel.progressText;
    flashcardPrevBtn.disabled = !viewModel.canGoPrev;
    flashcardNextBtn.disabled = !viewModel.canGoNext;
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
    const viewModel = typeof indexResultsUtils.buildQuizViewModel === 'function'
        ? indexResultsUtils.buildQuizViewModel(testQuestions, quizIndex, quizScore)
        : { hasQuestions: false, progressText: 'Question 0 of 0', scoreText: 'Score: 0/0', options: [] };
    if (!viewModel.hasQuestions) {
        setHidden(quizEmpty, false);
        quizQuestionText.textContent = '';
        quizOptions.innerHTML = '';
        quizExplanation.classList.remove('visible');
        setHidden(quizNextBtn, true);
        quizProgress.textContent = viewModel.progressText;
        quizScoreEl.textContent = viewModel.scoreText;
        return;
    }
    setHidden(quizEmpty, true);
    quizAnswered = false;
    quizProgress.textContent = viewModel.progressText;
    quizScoreEl.textContent = viewModel.scoreText;
    quizQuestionText.textContent = viewModel.questionText;
    quizOptions.innerHTML = '';
    quizExplanation.classList.remove('visible');
    quizExplanation.textContent = '';
    viewModel.options.forEach(option => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'quiz-option';
        btn.textContent = option;
        btn.addEventListener('click', () => answerQuizOption(btn, option));
        quizOptions.appendChild(btn);
    });
    setHidden(quizNextBtn, true);
}
function answerQuizOption(clickedBtn, selectedOption) {
    if (quizAnswered) return;
    quizAnswered = true;
    const evaluation = typeof indexResultsUtils.evaluateQuizAnswer === 'function'
        ? indexResultsUtils.evaluateQuizAnswer(testQuestions, quizIndex, quizScore, selectedOption)
        : { correctAnswer: '', explanation: '', hasNext: false, nextScore: quizScore, selectedCorrect: false };
    const optionButtons = [...quizOptions.querySelectorAll('.quiz-option')];
    optionButtons.forEach(btn => {
        btn.disabled = true;
        if (btn.textContent === evaluation.correctAnswer) btn.classList.add('correct');
    });
    if (evaluation.selectedCorrect) {
        clickedBtn.classList.add('correct');
        quizScore = evaluation.nextScore;
    } else {
        clickedBtn.classList.add('wrong');
    }
    quizScoreEl.textContent = `Score: ${quizScore}/${testQuestions.length}`;
    quizExplanation.textContent = evaluation.explanation;
    quizExplanation.classList.add('visible');
    setHidden(quizNextBtn, !evaluation.hasNext);
}
quizNextBtn.addEventListener('click', () => {
    if (quizIndex < testQuestions.length - 1) {
        quizIndex += 1;
        renderQuizQuestion();
    }
});

function showResults(md, slides, trans, generatedFlashcards, generatedQuestions, generationError, studyPackId, studyFeatures, summaryText, sectionsText, combinedText, successfulInterviewFeatures, billingReceipt) {
    const completedJobId = currentJobId;
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
    if (currentStudyPackId) {
        userHasCreatedStudyPack = true;
        userProfileLoaded = true;
    }
    currentBillingReceipt = billingReceipt && typeof billingReceipt === 'object' ? billingReceipt : null;
    resultsLocked = true;
    updateQuickstartVisibility();
    resultsTitleText.textContent = config.resultTitle;
    setSanitizedHtml(resultsContent, simpleMarkdownToHtml(resultMarkdown), {
        ALLOWED_TAGS: ['h1', 'h2', 'h3', 'p', 'br', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li', 'blockquote', 'a', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
        ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'scope'],
    });
    flashcardCountBadge.textContent = String(flashcards.length);
    testCountBadge.textContent = String(testQuestions.length);
    const warningText = typeof indexResultsUtils.buildStudyWarning === 'function'
        ? indexResultsUtils.buildStudyWarning({
            currentMode,
            selectedInterviewFeatures,
            studyFeatures,
            studyGenerationError,
            successfulInterviewFeatures,
        })
        : '';
    setHidden(studyWarning, !warningText);
    studyWarning.textContent = warningText;
    renderBillingReceipt(currentMode === 'interview' ? currentBillingReceipt : null);

    flashcardIndex = 0;
    flashcardFlipped = false;
    quizIndex = 0;
    quizScore = 0;
    renderFlashcard();
    renderQuizQuestion();
    setHidden(tabFlashcards, currentMode === 'interview');
    setHidden(tabTest, currentMode === 'interview');
    setActiveResultsTab('notes');
    tabFlashcards.disabled = currentMode === 'interview' || !flashcards.length;
    tabTest.disabled = currentMode === 'interview' || !testQuestions.length;

    progressSection.classList.remove('visible');
    showProgressSafeBanner(false);
    setProgressRetryVisible(false);
    resultsSection.classList.add('visible');
    buildDownloadDropdown();
    updateExportCsvButton();
    if (completedJobId) {
        removeActiveRuntimeJob(completedJobId);
    }
    updateProcessButton();
    showToast('Processing complete!', 'success');
}
function showError(msg, creditRefunded, billingReceipt) {
    progressSection.classList.add('is-error');
    progressSection.querySelector('.progress-title').textContent = 'Processing stopped';
    progressSection.querySelector('.progress-subtitle').textContent = 'Your sources are still here. Check them and try again when you are ready.';
    const failedJobId = currentJobId;
    setProgressRetryVisible(false);
    renderBillingReceipt(null);
    progressStatus.classList.add('error');
    setHidden(progressSpinner, true);
    showProgressSafeBanner(false);
    const billingReceiptText = buildBillingReceiptText(billingReceipt);
    if (creditRefunded) {
        announceProgressError(`Error: ${msg} - Your credit has been refunded.`);
        showToast('Processing failed. Your credit has been refunded.', 'info', 5000);
        fetchUserData();
    } else {
        announceProgressError(`Error: ${msg}`);
    }
    if (billingReceiptText) {
        showToast(billingReceiptText, 'info', 5500);
    }
    if (failedJobId) {
        removeActiveRuntimeJob(failedJobId);
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
    setHidden(studyWarning, true);
    renderBillingReceipt(null);
    setHidden(exportStudyCsvBtn, true);
    showProgressSafeBanner(false);
    setHidden(tabFlashcards, false);
    setHidden(tabTest, false);
    tabFlashcards.disabled = false;
    tabTest.disabled = false;
    setActiveResultsTab('notes');
}

function showPricingModal() {
    window.location.href = '/buy_credits';
}
function showHistoryModal() { window.location.href = '/buy_credits'; }
if (displayFormatUtils && typeof displayFormatUtils.applyPricingCatalog === 'function') {
    displayFormatUtils.applyPricingCatalog(document);
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

bindProcessingAuthModal();
if (headerNavToggle) {
    headerNavToggle.addEventListener('click', () => {
        const shouldOpen = !(headerSidebar && headerSidebar.classList.contains('visible'));
        closeHeaderDropdowns(shouldOpen ? 'sidebar' : '');
        setHeaderSidebarVisible(shouldOpen);
    });
}
if (headerSidebarClose) {
    headerSidebarClose.addEventListener('click', () => setHeaderSidebarVisible(false));
}
if (headerSidebarBackdrop) {
    headerSidebarBackdrop.addEventListener('click', () => setHeaderSidebarVisible(false));
}
if (signOutBtn) {
    signOutBtn.addEventListener('click', signOut);
}
if (userButton && userDropdown) {
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
}
document.addEventListener('click', (e) => {
    if (userMenu && !userMenu.contains(e.target)) setUserDropdownVisible(false);
});
if (buyCreditsBtn) {
    buyCreditsBtn.addEventListener('click', () => { setUserDropdownVisible(false); showPricingModal(); });
}
if (purchaseHistoryBtn) {
    purchaseHistoryBtn.addEventListener('click', () => { setUserDropdownVisible(false); showHistoryModal(); });
}
if (headerStudyLibraryBtn) {
    headerStudyLibraryBtn.addEventListener('click', () => {
        setHeaderSidebarVisible(false);
        trackEvent('study_mode_opened', { source: 'header_study_library' }, { preferBeacon: true });
        window.location.href = '/study';
    });
}
if (headerFeaturesBtn) {
    headerFeaturesBtn.addEventListener('click', () => {
        setHeaderSidebarVisible(false);
        window.location.href = '/features';
    });
}
if (headerToolsBtn) {
    headerToolsBtn.addEventListener('click', () => {
        setHeaderSidebarVisible(false);
        trackEvent('tools_page_opened', { source: 'header_tools' }, { preferBeacon: true });
        window.location.href = '/tools';
    });
}
if (headerPlannerBtn) {
    headerPlannerBtn.addEventListener('click', () => {
        const touchLike = window.matchMedia('(hover: none), (pointer: coarse)').matches;
        if (touchLike && headerPlannerGroup && !headerPlannerGroup.classList.contains('open')) {
            headerPlannerGroup.classList.add('open');
            return;
        }
        setHeaderSidebarVisible(false);
        window.location.href = '/plan';
    });
}
if (headerPlannerGroup) {
    headerPlannerGroup.addEventListener('mouseenter', () => {
        headerPlannerGroup.classList.add('open');
    });
    headerPlannerGroup.addEventListener('mouseleave', () => {
        headerPlannerGroup.classList.remove('open');
    });
}
if (headerCalendarBtn) {
    headerCalendarBtn.addEventListener('click', () => {
        setHeaderSidebarVisible(false);
        window.location.href = '/calendar';
    });
}
function openGoalModal() {
    if (!currentUser) return;
    goalModalError.classList.remove('visible');
    goalModalError.textContent = '';
    goalModalInput.value = String(getProgressSummaryForHeader(currentUser.uid).daily_goal);
    openOverlay(goalModalOverlay);
    setTimeout(() => goalModalInput.focus(), 30);
    setTimeout(() => goalModalInput.select(), 30);
}
function closeGoalModal() {
    closeOverlay(goalModalOverlay);
}
async function saveGoalFromModal() {
    if (!currentUser) return;
    const parsed = progressUtils && typeof progressUtils.parseGoalValue === 'function'
        ? progressUtils.parseGoalValue(goalModalInput.value)
        : parseInt(String(goalModalInput.value || '').trim(), 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 500) {
        goalModalError.textContent = 'Use a number between 1 and 500.';
        goalModalError.classList.add('visible');
        return;
    }
    try {
        const response = await authenticatedFetch('/api/study-progress', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ daily_goal: parsed, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '' }),
        });
        if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.error || 'Could not sync daily goal.');
        }
        if (progressUtils && typeof progressUtils.writeDailyGoalCache === 'function') {
            progressUtils.writeDailyGoalCache(currentUser.uid, parsed);
        } else {
            localStorage.setItem(`daily_goal_${currentUser.uid}`, String(parsed));
        }
        progressSummaryCache = Object.assign({}, progressSummaryCache || {}, { daily_goal: parsed });
        await fetchStudyProgressSummary();
        closeGoalModal();
        showToast('Daily goal updated.', 'success', 1800);
    } catch (e) {
        console.warn('Could not sync daily goal:', e);
        goalModalError.textContent = e && e.message ? e.message : 'Could not sync daily goal.';
        goalModalError.classList.add('visible');
        return;
    }
}
if (progressButton && progressDropdown) {
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
}
if (progressSetGoalBtn) {
    progressSetGoalBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setHeaderSidebarVisible(false);
        setProgressDropdownVisible(false);
        openGoalModal();
    });
}
if (progressOpenPlanBtn) {
    progressOpenPlanBtn.addEventListener('click', () => {
        setHeaderSidebarVisible(false);
        setProgressDropdownVisible(false);
        window.location.href = '/plan';
    });
}
if (progressOpenCalendarBtn) {
    progressOpenCalendarBtn.addEventListener('click', () => {
        setHeaderSidebarVisible(false);
        setProgressDropdownVisible(false);
        window.location.href = '/calendar';
    });
}
let mobileCreditsTooltipTimer = null;
if (creditsDisplay) {
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
}
document.addEventListener('click', (e) => {
    if (creditsDisplay && !creditsDisplay.contains(e.target)) {
        creditsDisplay.classList.remove('tooltip-open');
        if (mobileCreditsTooltipTimer) clearTimeout(mobileCreditsTooltipTimer);
    }
    if (progressMenu && !progressMenu.contains(e.target)) {
        setProgressDropdownVisible(false);
    }
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        setHeaderSidebarVisible(false);
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
if (adminDashboardBtn) {
    adminDashboardBtn.addEventListener('click', async () => {
        setUserDropdownVisible(false);
        if (!currentUser || !currentUserIsAdmin) {
            showToast('Admin access is only available for configured admin accounts.', 'error', 4200);
            return;
        }
        try {
            const sessionResponse = await authenticatedFetch('/api/session/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            if (!sessionResponse.ok) {
                throw new Error('Could not start admin session.');
            }
            window.location.href = '/admin';
        } catch (e) {
            captureClientError(e, 'admin_session_login');
            showToast('Could not open admin dashboard right now. Please retry.', 'error', 4500);
        }
    });
}
buyCreditsLink.addEventListener('click', (e) => { e.preventDefault(); showPricingModal(); });
document.addEventListener('keydown', (e) => {
    if (!activeModalOverlay) return;
    if (typeof uxUtils.openModalOverlay === 'function' && typeof uxUtils.closeModalOverlay === 'function') return;
    if (e.key === 'Escape') {
        e.preventDefault();
        if (activeModalOverlay === authOverlay) hideAuthModal();
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
    discardActiveRecording();
    pdfFile = null;
    clearSelectedAudioFile();
    releaseImportedAudioToken({ clearStatus: true });
    currentJobId = null;
    trackedTerminalJobId = '';
    pdfInput.value = '';
    audioInput.value = '';
    setHidden(pdfInfo, true);
    pdfZone.classList.remove('has-file');
    syncAudioInfoUI();
    progressSection.classList.remove('visible');
    showProgressSafeBanner(false);
    setProgressRetryVisible(false);
    resultsSection.classList.remove('visible');
    progressStatus.classList.remove('error');
    setHidden(progressSpinner, false);
    resetResultsState();
    switchMode(currentMode);
    updateProcessButton();
    window.scrollTo({ top: 0, behavior: uxUtils.prefersReducedMotion && uxUtils.prefersReducedMotion() ? 'auto' : 'smooth' });
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
            try { localStorage.setItem(`quickstart_dismissed_${currentUser.uid}`, '1'); } catch (_) { }
        }
        setQuickstartVisible(false);
    });
}
progressRetryBtn.addEventListener('click', retryStatusCheckNow);
function setStudyToolsPanelVisible(visible) {
    const isVisible = Boolean(visible);
    studyToolsPanel.classList.toggle('visible', isVisible);
    studyToolsPanel.inert = !isVisible;
    studyToolsPanel.setAttribute('aria-hidden', isVisible ? 'false' : 'true');
    studyToolsToggle.classList.toggle('open', isVisible);
    studyToolsToggle.setAttribute('aria-expanded', isVisible ? 'true' : 'false');
}
studyToolsToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    setStudyToolsPanelVisible(!studyToolsPanel.classList.contains('visible'));
});
studyToolsToggle.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        setStudyToolsPanelVisible(false);
        studyToolsToggle.focus();
    }
});
studyToolChips.forEach(chip => {
    chip.addEventListener('click', () => {
        setStudyFeature(chip.dataset.studyFeatures || 'none');
        setStudyToolsPanelVisible(false);
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
            const maxAffordable = creationCreditState()?.snapshot?.scheme === 1 && userCredits
                ? (hasUnlimitedCredit('slides') ? 2 : Math.max(0, Number(userCredits.slides || 0))) : 2;
            if (selectedInterviewFeatures.length >= maxAffordable) {
                showToast('Not enough text extraction credits for more interview extras.', 'info', 2600);
                updateInterviewOptionsUI();
                return;
            }
            selectedInterviewFeatures.push(feature);
        }
        selectedInterviewFeatures = selectedInterviewFeatures.slice(0, 2);
        updateInterviewOptionsUI();
    });
});
bindOutputLanguagePicker();
bindAudioImportControls();
bindLanguageOnboarding();
document.addEventListener('click', (e) => {
    if (!studyToolsPanel.contains(e.target) && !studyToolsToggle.contains(e.target)) {
        setStudyToolsPanelVisible(false);
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
window.addEventListener('beforeunload', warnBeforeLeavingRecording);

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
if (forcedMode) {
    modeTabs.forEach((tab) => {
        tab.disabled = true;
        tab.setAttribute('aria-disabled', 'true');
    });
}
switchMode(forcedMode || 'lecture-notes');
maybeOpenAuthModalFromQuery();
resetResultsState();
updateHeaderNavActiveState();

window.addEventListener('lp:credits-changed', () => {
    if (!currentUser) return;
    updateCreditsDisplay();
});
window.addEventListener('lp:language-changed', () => {
    updateInterviewOptionsUI();
    updateSignupCreditGrant();
});
void loadCreationPublicCredits();
