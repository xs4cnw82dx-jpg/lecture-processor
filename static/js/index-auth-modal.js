// Sign-in, registration, verification and return navigation for the processing page.
/* global activateVerifiedUser, auth, authenticatedFetch, captureClientError, closeOverlay,
   currentUser, currentUserIsAdmin, handleUnverifiedEmailUser, headerSignInBtn, openOverlay,
   releaseImportedAudioToken, setHidden, showToast, signInToProcessBtn, trackEvent,
   unverifiedEmailUser:writable, userProfileLoaded */
/* exported authOverlay, authSubmitBusyKind, bindProcessingAuthModal, checkEmailAllowed,
   getPendingAuthReturnUrl, hideAuthModal, isAdminAuthReturnUrl, isUnverifiedEmailUser,
   maybeOpenAuthModalFromQuery, resumePendingAuthReturnIfNeeded,
   resumePendingNonAdminAuthReturnIfNeeded, showAuthError, showAuthModal,
   showEmailVerificationPrompt, signOut, signinError, signupError, signupView */

const AUTH_RETURN_STORAGE_KEY = 'lectureProcessorAuthReturnUrl';

let authReturnResumePromise = null;
let authReturnRedirectStarted = false;

const authOverlay = document.getElementById('auth-overlay');
const authModalClose = document.getElementById('auth-modal-close');
const signinView = document.getElementById('signin-view');
const signupView = document.getElementById('signup-view');
const resetView = document.getElementById('reset-view');
const signinForm = document.getElementById('signin-form');
const signupForm = document.getElementById('signup-form');
const resetForm = document.getElementById('reset-form');
const signinSubmit = document.getElementById('signin-submit');
const signupSubmit = document.getElementById('signup-submit');
const resetSubmit = document.getElementById('reset-submit');
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

let authSubmitBusyKind = '';

const authSubmitButtons = {
    signin: signinSubmit,
    signup: signupSubmit,
    reset: resetSubmit,
    google: [googleSignInBtn, googleSignUpBtn],
};
const authSubmitForms = {
    signin: signinForm,
    signup: signupForm,
    reset: resetForm,
};
const authSubmitBusyLabels = {
    signin: 'Signing in...',
    signup: 'Creating account...',
    reset: 'Sending...',
    google: 'Continuing...',
};

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
function sanitizeAuthReturnUrl(rawValue) {
    const raw = String(rawValue || '').trim();
    if (!raw) return '';
    try {
        const target = new URL(raw, window.location.origin);
        if (target.origin !== window.location.origin) return '';
        return target.pathname + target.search + target.hash;
    } catch (_) {
        return '';
    }
}
function setPendingAuthReturnUrl(rawValue) {
    const safeUrl = sanitizeAuthReturnUrl(rawValue);
    if (!safeUrl) return;
    try {
        sessionStorage.setItem(AUTH_RETURN_STORAGE_KEY, safeUrl);
    } catch (_) { }
}
function getPendingAuthReturnUrl() {
    let safeUrl = '';
    try {
        safeUrl = sanitizeAuthReturnUrl(sessionStorage.getItem(AUTH_RETURN_STORAGE_KEY) || '');
    } catch (_) {
        safeUrl = '';
    }
    return safeUrl;
}
function clearPendingAuthReturnUrl() {
    try {
        sessionStorage.removeItem(AUTH_RETURN_STORAGE_KEY);
    } catch (_) { }
}
function isAdminAuthReturnUrl(returnUrl) {
    const safeUrl = sanitizeAuthReturnUrl(returnUrl);
    if (!safeUrl) return false;
    try {
        const pathname = new URL(safeUrl, window.location.origin).pathname;
        return pathname === '/admin' || pathname.startsWith('/admin/');
    } catch (_) {
        return false;
    }
}
function redirectToPendingAuthReturn(returnUrl) {
    if (authReturnRedirectStarted) return true;
    const currentUrl = window.location.pathname + window.location.search + window.location.hash;
    clearPendingAuthReturnUrl();
    if (returnUrl === currentUrl) return false;
    authReturnRedirectStarted = true;
    window.location.assign(returnUrl);
    return true;
}
function resumePendingNonAdminAuthReturnIfNeeded() {
    const returnUrl = getPendingAuthReturnUrl();
    if (!returnUrl || isAdminAuthReturnUrl(returnUrl)) return false;
    return redirectToPendingAuthReturn(returnUrl);
}
async function performPendingAuthReturn() {
    const returnUrl = getPendingAuthReturnUrl();
    if (!returnUrl) return false;
    if (!isAdminAuthReturnUrl(returnUrl)) {
        return redirectToPendingAuthReturn(returnUrl);
    }
    if (!currentUser) return false;
    if (!userProfileLoaded) {
        showToast('Could not verify admin access. Please retry after your account finishes loading.', 'error', 5200);
        return false;
    }
    if (!currentUserIsAdmin) {
        showToast('This account does not have admin access. Sign out and retry with an admin account.', 'error', 5600);
        return false;
    }

    try {
        const sessionResponse = await authenticatedFetch('/api/session/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        if (!sessionResponse.ok) {
            throw new Error('Could not create the secure admin session.');
        }
        return redirectToPendingAuthReturn(returnUrl);
    } catch (error) {
        captureClientError(error, 'admin_auth_return_session');
        showToast('Could not open the admin page. Your destination is saved; please retry sign-in.', 'error', 5600);
        return false;
    }
}
function resumePendingAuthReturnIfNeeded() {
    if (authReturnRedirectStarted) return Promise.resolve(true);
    if (authReturnResumePromise) return authReturnResumePromise;
    const operation = performPendingAuthReturn();
    authReturnResumePromise = operation;
    return operation.finally(() => {
        if (authReturnResumePromise === operation) authReturnResumePromise = null;
    });
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
const AUTH_ERROR_FIELDS = {
    'signin-error': ['signin-email', 'signin-password'],
    'signup-error': ['signup-email', 'signup-password', 'signup-password-confirm'],
    'reset-error': ['reset-email'],
};
function setAuthFieldsInvalid(errorEl, invalid) {
    if (!errorEl || !errorEl.id) return;
    (AUTH_ERROR_FIELDS[errorEl.id] || []).forEach(fieldId => {
        const field = document.getElementById(fieldId);
        if (!field) return;
        const described = (field.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== errorEl.id);
        if (invalid) {
            field.setAttribute('aria-invalid', 'true');
            described.push(errorEl.id);
        } else {
            field.removeAttribute('aria-invalid');
        }
        if (described.length) field.setAttribute('aria-describedby', described.join(' '));
        else field.removeAttribute('aria-describedby');
    });
}
function clearAuthErrors() {
    [signinError, signupError, resetError, resetSuccess].forEach(el => {
        el.classList.remove('visible');
        el.textContent = '';
        setAuthFieldsInvalid(el, false);
    });
}
function showAuthError(el, msg) {
    el.textContent = msg;
    el.classList.add('visible');
    setAuthFieldsInvalid(el, true);
}
function isUnverifiedEmailUser(user) {
    return Boolean(user && user.email && user.emailVerified === false);
}
async function sendEmailVerificationIfPossible(user) {
    const targetUser = user || unverifiedEmailUser || auth.currentUser;
    if (!targetUser || typeof targetUser.sendEmailVerification !== 'function') {
        throw new Error('Could not send a verification email for this account.');
    }
    await targetUser.sendEmailVerification();
}
function showEmailVerificationPrompt(user, options = {}) {
    unverifiedEmailUser = user || unverifiedEmailUser || auth.currentUser;
    const view = options.view || (signupView.classList.contains('active') ? 'signup' : 'signin');
    const target = view === 'signup' ? signupError : signinError;
    const email = String((unverifiedEmailUser && unverifiedEmailUser.email) || '').trim();
    showAuthModal(view);
    target.innerHTML = '';
    target.classList.add('visible');

    const message = document.createElement('div');
    message.textContent = email
        ? `Verify ${email} before continuing.`
        : 'Verify your email address before continuing.';
    target.appendChild(message);

    const detail = document.createElement('div');
    detail.textContent = 'Use the verification link in your inbox, then return here.';
    target.appendChild(detail);

    const status = document.createElement('div');
    status.textContent = options.verificationEmailSent
        ? 'Verification email sent. Check your inbox.'
        : '';
    target.appendChild(status);

    const resendButton = document.createElement('button');
    resendButton.type = 'button';
    resendButton.className = 'auth-submit-btn u-mt-8';
    resendButton.textContent = 'Resend verification email';
    resendButton.addEventListener('click', async () => {
        resendButton.disabled = true;
        status.textContent = 'Sending verification email...';
        try {
            await sendEmailVerificationIfPossible(unverifiedEmailUser);
            status.textContent = 'Verification email sent. Check your inbox.';
        } catch (error) {
            captureClientError(error, 'resend_email_verification');
            status.textContent = getFirebaseErrorMessage(error);
        } finally {
            resendButton.disabled = false;
        }
    });
    target.appendChild(resendButton);

    const verifiedButton = document.createElement('button');
    verifiedButton.type = 'button';
    verifiedButton.className = 'google-sign-in-button u-mt-8';
    verifiedButton.textContent = 'I verified my email';
    verifiedButton.addEventListener('click', async () => {
        verifiedButton.disabled = true;
        status.textContent = 'Checking verification status...';
        try {
            const targetUser = unverifiedEmailUser || auth.currentUser;
            if (!targetUser || typeof targetUser.reload !== 'function') {
                throw new Error('Please sign in again after verifying your email.');
            }
            await targetUser.reload();
            const refreshedUser = auth.currentUser || targetUser;
            if (isUnverifiedEmailUser(refreshedUser)) {
                status.textContent = 'Email is not verified yet. Open the link from your inbox, then try again.';
                return;
            }
            // Email verification changed the token claims; refresh only here.
            await refreshedUser.getIdToken(true);
            const redirected = await activateVerifiedUser(refreshedUser);
            hideAuthModal();
            if (redirected) return;
            showToast('Email verified. You are signed in.', 'success');
        } catch (error) {
            captureClientError(error, 'check_email_verification');
            status.textContent = getFirebaseErrorMessage(error);
        } finally {
            verifiedButton.disabled = false;
        }
    });
    target.appendChild(verifiedButton);

    const signOutButton = document.createElement('button');
    signOutButton.type = 'button';
    signOutButton.className = 'google-sign-in-button u-mt-8';
    signOutButton.textContent = 'Sign out';
    signOutButton.addEventListener('click', async () => {
        signOutButton.disabled = true;
        try {
            unverifiedEmailUser = null;
            await auth.signOut();
            showToast('Signed out', 'success');
        } catch (error) {
            captureClientError(error, 'signout_unverified_email');
            status.textContent = getFirebaseErrorMessage(error);
        } finally {
            signOutButton.disabled = false;
        }
    });
    target.appendChild(signOutButton);
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
        'auth/network-request-failed': 'Network error. Please check your connection.',
        'auth/internal-error': 'Sign-in is temporarily unavailable right now. Please try again in a minute. If this keeps happening, contact support because the Firebase sign-in configuration likely needs to be redeployed.',
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
function getAuthButtonsForKind(kind) {
    const entry = authSubmitButtons[kind];
    if (!entry) return [];
    return Array.isArray(entry) ? entry.filter(Boolean) : [entry].filter(Boolean);
}
function setAuthButtonBusy(button, active, busyLabel) {
    if (!button) return;
    if (!button.dataset.defaultHtml) {
        button.dataset.defaultHtml = button.innerHTML;
    }
    button.disabled = Boolean(authSubmitBusyKind);
    button.setAttribute('aria-disabled', authSubmitBusyKind ? 'true' : 'false');
    if (active) {
        button.textContent = busyLabel || 'Working...';
    } else {
        button.innerHTML = button.dataset.defaultHtml;
    }
}
function syncAuthSubmitBusyState() {
    Object.keys(authSubmitButtons).forEach((kind) => {
        const active = authSubmitBusyKind === kind;
        getAuthButtonsForKind(kind).forEach((button) => {
            setAuthButtonBusy(button, active, authSubmitBusyLabels[kind]);
        });
    });
    Object.keys(authSubmitForms).forEach((kind) => {
        if (!authSubmitForms[kind]) return;
        authSubmitForms[kind].setAttribute('aria-busy', authSubmitBusyKind === kind ? 'true' : 'false');
    });
}
function beginAuthSubmit(kind) {
    if (authSubmitBusyKind) return false;
    authSubmitBusyKind = kind;
    syncAuthSubmitBusyState();
    return true;
}
function endAuthSubmit(kind) {
    if (authSubmitBusyKind !== kind) return;
    authSubmitBusyKind = '';
    syncAuthSubmitBusyState();
}
async function signInWithEmail(email, password) {
    if (!beginAuthSubmit('signin')) return;
    try {
        const check = await checkEmailAllowed(email);
        if (!check.allowed) {
            trackEvent('auth_failed', { method: 'email', reason: 'disallowed_email' });
            showAuthError(signinError, check.message);
            return;
        }
        const credential = await auth.signInWithEmailAndPassword(email, password);
        if (isUnverifiedEmailUser(credential.user)) {
            handleUnverifiedEmailUser(credential.user, { view: 'signin' });
            return;
        }
        hideAuthModal();
        if (resumePendingNonAdminAuthReturnIfNeeded()) return;
        if (await activateVerifiedUser(credential.user)) return;
        showToast('Signed in successfully!', 'success');
        trackEvent('auth_success', { method: 'email' });
    } catch (e) {
        trackEvent('auth_failed', { method: 'email', reason: e.code || 'unknown' });
        captureClientError(e, 'signin_email');
        showAuthError(signinError, getFirebaseErrorMessage(e));
    } finally {
        endAuthSubmit('signin');
    }
}
async function signUpWithEmail(email, password) {
    if (!beginAuthSubmit('signup')) return;
    try {
        const check = await checkEmailAllowed(email);
        if (!check.allowed) {
            trackEvent('auth_failed', { method: 'signup_email', reason: 'disallowed_email' });
            showAuthError(signupError, check.message);
            return;
        }
        const credential = await auth.createUserWithEmailAndPassword(email, password);
        let verificationEmailSent = false;
        if (credential.user) {
            try {
                await sendEmailVerificationIfPossible(credential.user);
                verificationEmailSent = true;
            } catch (verifyError) {
                captureClientError(verifyError, 'signup_send_email_verification');
            }
        }
        handleUnverifiedEmailUser(credential.user, { view: 'signup', verificationEmailSent });
        trackEvent('auth_success', { method: 'signup_email', verification_required: true });
    } catch (e) {
        trackEvent('auth_failed', { method: 'signup_email', reason: e.code || 'unknown' });
        captureClientError(e, 'signup_email');
        showAuthError(signupError, getFirebaseErrorMessage(e));
    } finally {
        endAuthSubmit('signup');
    }
}
async function signInWithGoogle() {
    if (!beginAuthSubmit('google')) return;
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
        if (isUnverifiedEmailUser(result.user)) {
            handleUnverifiedEmailUser(result.user, { view: signinView.classList.contains('active') ? 'signin' : 'signup' });
            return;
        }
        hideAuthModal();
        if (resumePendingNonAdminAuthReturnIfNeeded()) return;
        if (await activateVerifiedUser(result.user)) return;
        showToast('Signed in successfully!', 'success');
        trackEvent('auth_success', { method: 'google' });
    } catch (e) {
        trackEvent('auth_failed', { method: 'google', reason: e.code || 'unknown' });
        captureClientError(e, 'signin_google');
        showAuthError(signinView.classList.contains('active') ? signinError : signupError, getFirebaseErrorMessage(e));
    } finally {
        endAuthSubmit('google');
    }
}
async function sendPasswordReset(email) {
    if (!beginAuthSubmit('reset')) return;
    try {
        await auth.sendPasswordResetEmail(email);
        resetSuccess.textContent = 'Password reset email sent! Check your inbox.';
        resetSuccess.classList.add('visible');
    } catch (e) {
        showAuthError(resetError, getFirebaseErrorMessage(e));
    } finally {
        endAuthSubmit('reset');
    }
}
async function signOut() {
    try {
        await releaseImportedAudioToken({ clearStatus: true });
        try {
            await fetch('/api/session/logout', {
                method: 'POST',
                credentials: 'include'
            });
        } catch (_) { }
        await auth.signOut();
        showToast('Signed out', 'success');
    } catch (e) {
        console.error(e);
        captureClientError(e, 'fetch_user_data');
    }
}

function maybeOpenAuthModalFromQuery() {
    const params = new URLSearchParams(window.location.search);
    const requested = String(params.get('auth') || '').trim().toLowerCase();
    if (!requested) return;
    setPendingAuthReturnUrl(params.get('next') || '');
    params.delete('next');
    if (currentUser && resumePendingAuthReturnIfNeeded()) return;
    const view = ['signin', 'signup', 'reset'].includes(requested) ? requested : 'signin';
    showAuthModal(view);
    params.delete('auth');
    const query = params.toString();
    const nextUrl = window.location.pathname + (query ? `?${query}` : '') + window.location.hash;
    window.history.replaceState({}, '', nextUrl);
}

function bindProcessingAuthModal() {
    if (headerSignInBtn) {
        headerSignInBtn.addEventListener('click', () => showAuthModal('signin'));
    }
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
            if (!input) return;
            if (input.type === 'password') {
                input.type = 'text';
                setHidden(open, true);
                setHidden(closed, false);
                btn.setAttribute('aria-pressed', 'true');
                btn.setAttribute('aria-label', 'Hide password');
            }
            else {
                input.type = 'password';
                setHidden(open, false);
                setHidden(closed, true);
                btn.setAttribute('aria-pressed', 'false');
                btn.setAttribute('aria-label', 'Show password');
            }
        });
    });
}
