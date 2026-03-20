(function (global) {
    'use strict';

    const uxUtils = global.LectureProcessorUx || {};
    const setHidden = typeof uxUtils.setHidden === 'function'
        ? uxUtils.setHidden
        : function (element, hidden) {
            if (!element) return;
            element.hidden = Boolean(hidden);
        };

    function setDisclosureState(toggle, body, visible) {
        if (!toggle || !body) return;
        const open = Boolean(visible);
        toggle.classList.toggle('open', open);
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        body.classList.toggle('visible', open);
        body.setAttribute('aria-hidden', open ? 'false' : 'true');
    }

    function getStudyToolsSummary(state) {
        const value = String(state.selectedStudyFeatures || 'both').trim().toLowerCase();
        if (value === 'none') return 'No study tools';
        if (value === 'flashcards') return 'Flashcards only';
        if (value === 'test') return 'Practice test only';
        return 'Flashcards + test';
    }

    function getInterviewExtrasSummary(state) {
        const count = Array.isArray(state.selectedInterviewFeatures) ? state.selectedInterviewFeatures.length : 0;
        if (count <= 0) return 'No extras';
        if (count === 1) return '1 extra';
        return count + ' extras';
    }

    function getLanguageSummary(state) {
        if (typeof state.getLanguageLabel === 'function') {
            return state.getLanguageLabel(state.outputLanguageValue, state.outputLanguageCustomValue);
        }
        return String(state.outputLanguageValue || 'English');
    }

    function getAdvancedSettingsSummary(state) {
        const language = getLanguageSummary(state);
        if (String(state.currentMode || '').trim().toLowerCase() === 'interview') {
            return getInterviewExtrasSummary(state) + ' · ' + language;
        }
        return getStudyToolsSummary(state) + ' · ' + language;
    }

    function shouldAutoOpenOtherAudio(state) {
        if (!state.signedIn || !state.needsAudio) return false;
        if (state.audioImportInFlight) return true;
        if (state.importedAudioReady) return true;
        if (state.recordingState === 'recording' || state.recordingState === 'paused' || state.recordingState === 'stopping') {
            return true;
        }
        return Boolean(state.audioStatusText);
    }

    function getOtherAudioSummary(state) {
        if (state.recordingState === 'recording') return 'Recording in progress';
        if (state.recordingState === 'paused') return 'Recording paused';
        if (state.audioImportInFlight) return 'Importing audio';
        if (state.importedAudioReady) return 'Imported LMS audio ready';
        if (state.audioStatusText) return state.audioStatusText;
        return 'Import from LMS or record in your browser';
    }

    function syncProcessingLayout(dom, state) {
        const mode = state.modeConfig && state.modeConfig[state.currentMode] ? state.modeConfig[state.currentMode] : {};
        const signedIn = Boolean(state.signedIn);
        const needsPdf = Boolean(mode.needsPdf);
        const needsAudio = Boolean(mode.needsAudio);
        const singleUpload = (needsPdf && !needsAudio) || (!needsPdf && needsAudio);
        if (dom.uploadSection) {
            dom.uploadSection.classList.toggle('single-upload', singleUpload);
        }
        setHidden(dom.pdfZone, !needsPdf);
        setHidden(dom.audioZone, !needsAudio);

        const shouldShowEstimate = signedIn && Boolean(state.hasAnySourceFile);
        setHidden(dom.uploadEstimate, !shouldShowEstimate);

        const showOtherAudio = signedIn && needsAudio;
        setHidden(dom.otherAudioDisclosure, !showOtherAudio);
        if (dom.otherAudioSummary) {
            dom.otherAudioSummary.textContent = getOtherAudioSummary({
                signedIn: signedIn,
                needsAudio: needsAudio,
                audioImportInFlight: state.audioImportInFlight,
                importedAudioReady: state.importedAudioReady,
                recordingState: state.recordingState,
                audioStatusText: state.audioStatusText,
            });
        }
        setDisclosureState(dom.otherAudioToggle, dom.otherAudioBody, showOtherAudio && shouldAutoOpenOtherAudio({
            signedIn: signedIn,
            needsAudio: needsAudio,
            audioImportInFlight: state.audioImportInFlight,
            importedAudioReady: state.importedAudioReady,
            recordingState: state.recordingState,
            audioStatusText: state.audioStatusText,
        }) || (showOtherAudio && Boolean(state.otherAudioOpen)));

        setHidden(dom.generationControls, state.currentMode === 'interview');
        setHidden(dom.interviewControls, state.currentMode !== 'interview');
        if (dom.advancedSettingsSummary) {
            dom.advancedSettingsSummary.textContent = getAdvancedSettingsSummary(state);
        }
    }

    const exported = {
        getAdvancedSettingsSummary: getAdvancedSettingsSummary,
        getOtherAudioSummary: getOtherAudioSummary,
        setDisclosureState: setDisclosureState,
        setHidden: setHidden,
        shouldAutoOpenOtherAudio: shouldAutoOpenOtherAudio,
        syncProcessingLayout: syncProcessingLayout,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = exported;
    }

    global.LectureProcessorProcessingUi = Object.assign({}, global.LectureProcessorProcessingUi || {}, exported);
})(typeof window !== 'undefined' ? window : globalThis);
