// Output language selection, onboarding and saved preferences for the processing page.
/* global authenticatedFetch, captureClientError, closeHeaderDropdowns, closeOverlay, currentUser,
   focusMenuItem, openOverlay, setHidden, showToast, syncProcessingLayout,
   userPreferences:writable */
/* exported applyPreferencesToOutputLanguage, bindLanguageOnboarding, bindOutputLanguagePicker,
   clearLanguagePreferenceSaveTimer, closeLanguageOnboarding, getLanguageLabel,
   languageOnboardingOverlay, outputLanguageCustom, outputLanguagePicker, outputLanguageSelect,
   setOutputLanguage, setOutputLanguageMenuVisible */

let languageOnboardingOpen = false;
let languageOnboardingSaving = false;

let languagePreferenceSaveTimer = null;
let suppressLanguagePreferencePersist = false;

const OUTPUT_LANGUAGE_LABELS = Object.freeze({
    dutch: '🇳🇱 Dutch',
    english: '🇬🇧 English',
    spanish: '🇪🇸 Spanish',
    french: '🇫🇷 French',
    german: '🇩🇪 German',
    chinese: '🇨🇳 Chinese',
    other: '🌐 Other',
});

const outputLanguageSelect = document.getElementById('output-language-select');
const outputLanguagePicker = document.getElementById('output-language-picker');
const outputLanguageButton = document.getElementById('output-language-button');
const outputLanguageLabel = document.getElementById('output-language-label');
const outputLanguageMenu = document.getElementById('output-language-menu');
const outputLanguageItems = document.querySelectorAll('#output-language-menu .app-select-item');
const outputLanguageCustom = document.getElementById('output-language-custom');

const languageOnboardingOverlay = document.getElementById('language-onboarding-overlay');
const languageOnboardingButtons = document.querySelectorAll('#language-onboarding-grid .onboarding-language-btn');
const languageOnboardingCustom = document.getElementById('language-onboarding-custom');
const languageOnboardingError = document.getElementById('language-onboarding-error');
const languageOnboardingSaveBtn = document.getElementById('language-onboarding-save-btn');

function setOutputLanguageMenuVisible(visible) {
    outputLanguageMenu.classList.toggle('visible', visible);
    outputLanguageButton.classList.toggle('open', visible);
    outputLanguageButton.setAttribute('aria-expanded', visible ? 'true' : 'false');
}

function updateOutputLanguageInput() {
    const isOther = outputLanguageSelect.value === 'other';
    setHidden(outputLanguageCustom, !isOther);
    if (!isOther) outputLanguageCustom.value = '';
    syncProcessingLayout();
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
        const selected = btn.dataset.value === target;
        btn.classList.toggle('active', selected);
        btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    const showCustom = target === 'other';
    setHidden(languageOnboardingCustom, !showCustom);
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
    if (key === 'other') setHidden(languageOnboardingCustom, false);
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

function bindOutputLanguagePicker() {
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
}

function bindLanguageOnboarding() {
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
}
