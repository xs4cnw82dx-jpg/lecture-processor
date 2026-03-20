(function () {
  const config = window.SharedStudyConfig || {};
  const markdownUtils = window.LectureProcessorMarkdown || {};

  const shareToken = String(config.shareToken || '').trim();
  const titleEl = document.getElementById('shared-study-title');
  const subtitleEl = document.getElementById('shared-study-subtitle');
  const loadingEl = document.getElementById('shared-study-loading');
  const errorEl = document.getElementById('shared-study-error');
  const errorTextEl = document.getElementById('shared-study-error-text');
  const packShell = document.getElementById('shared-pack-shell');
  const folderShell = document.getElementById('shared-folder-shell');

  const packModeEl = document.getElementById('shared-pack-mode');
  const packMetaEl = document.getElementById('shared-pack-meta');
  const notesViewEl = document.getElementById('shared-notes-view');
  const flashcardsListEl = document.getElementById('shared-flashcards-list');
  const questionsListEl = document.getElementById('shared-questions-list');

  const folderPackListEl = document.getElementById('shared-folder-pack-list');
  const folderEmptyEl = document.getElementById('shared-folder-empty');
  const folderPackPreviewEl = document.getElementById('shared-folder-pack-preview');
  const folderPackModeEl = document.getElementById('shared-folder-pack-mode');
  const folderPackMetaEl = document.getElementById('shared-folder-pack-meta');
  const folderNotesViewEl = document.getElementById('shared-folder-notes-view');
  const folderFlashcardsListEl = document.getElementById('shared-folder-flashcards-list');
  const folderQuestionsListEl = document.getElementById('shared-folder-questions-list');

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setLoadingState(visible) {
    if (loadingEl) loadingEl.hidden = !visible;
  }

  function showError(message) {
    setLoadingState(false);
    if (packShell) packShell.hidden = true;
    if (folderShell) folderShell.hidden = true;
    if (errorEl) errorEl.hidden = false;
    if (errorTextEl) errorTextEl.textContent = String(message || 'Shared content is unavailable.');
    if (titleEl) titleEl.textContent = 'Shared content unavailable';
    if (subtitleEl) subtitleEl.textContent = 'This view is read-only.';
  }

  function notesToHtml(markdown) {
    if (markdownUtils.parseMarkdownToSafeHtml) {
      return markdownUtils.parseMarkdownToSafeHtml(markdown, {
        preprocess: function (raw) {
          return String(raw || '')
            .replace(/\r\n/g, '\n')
            .replace(/^\s*<!--\s*audio:\d+\s*-\s*\d+\s*-->\s*$/gim, '');
        },
      });
    }
    return '<p>' + escapeHtml(markdown || '').replace(/\n/g, '<br>') + '</p>';
  }

  function formatModeLabel(mode) {
    const safeMode = String(mode || '').trim().toLowerCase();
    if (!safeMode) return 'Study Pack';
    if (safeMode === 'lecture-notes') return 'Lecture Notes';
    if (safeMode === 'slides-only') return 'Slides Extraction';
    if (safeMode === 'interview') return 'Interview Transcription';
    return safeMode
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map(function (part) {
        return part.charAt(0).toUpperCase() + part.slice(1);
      })
      .join(' ');
  }

  function buildMetaLine(pack) {
    const parts = [
      pack.course,
      pack.subject,
      pack.semester,
      pack.block,
    ].filter(Boolean);
    return parts.join(' · ') || 'Read-only shared pack';
  }

  function renderFlashcards(target, cards) {
    if (!target) return;
    const items = Array.isArray(cards) ? cards : [];
    if (!items.length) {
      target.innerHTML = '<div class="shared-empty">No flashcards in this shared pack.</div>';
      return;
    }
    target.innerHTML = items.map(function (card) {
      return ''
        + '<article class="shared-card">'
        + '<div class="shared-card-label">Front</div>'
        + '<div class="shared-card-front">' + escapeHtml(card.front || '') + '</div>'
        + '<div class="shared-card-label">Back</div>'
        + '<div class="shared-card-back">' + escapeHtml(card.back || '') + '</div>'
        + '</article>';
    }).join('');
  }

  function renderQuestions(target, questions) {
    if (!target) return;
    const items = Array.isArray(questions) ? questions : [];
    if (!items.length) {
      target.innerHTML = '<div class="shared-empty">No practice questions in this shared pack.</div>';
      return;
    }
    target.innerHTML = items.map(function (question, index) {
      const options = Array.isArray(question.options) ? question.options : [];
      return ''
        + '<article class="shared-question">'
        + '<div class="shared-question-label">Question ' + (index + 1) + '</div>'
        + '<div class="shared-question-title">' + escapeHtml(question.question || '') + '</div>'
        + '<ol class="shared-question-options">'
        + options.map(function (option) { return '<li>' + escapeHtml(option || '') + '</li>'; }).join('')
        + '</ol>'
        + '<div class="shared-question-answer">Answer: ' + escapeHtml(question.answer || '') + '</div>'
        + '<div class="shared-question-explanation">' + escapeHtml(question.explanation || '') + '</div>'
        + '</article>';
    }).join('');
  }

  function renderPackPreview(pack, targets) {
    const resolvedTargets = targets || {};
    if (resolvedTargets.modeEl) resolvedTargets.modeEl.textContent = formatModeLabel(pack.mode);
    if (resolvedTargets.metaEl) resolvedTargets.metaEl.textContent = buildMetaLine(pack);
    if (resolvedTargets.notesEl) {
      const notes = String(pack.notes_markdown || '').trim();
      if (notes) {
        resolvedTargets.notesEl.innerHTML = notesToHtml(notes);
      } else if (pack.interview_combined || pack.interview_summary || pack.interview_sections) {
        const fragments = [pack.interview_combined, pack.interview_summary, pack.interview_sections].filter(Boolean);
        resolvedTargets.notesEl.innerHTML = notesToHtml(fragments.join('\n\n'));
      } else {
        resolvedTargets.notesEl.innerHTML = '<div class="shared-empty">No notes in this shared pack.</div>';
      }
    }
    renderFlashcards(resolvedTargets.flashcardsEl, pack.flashcards || []);
    renderQuestions(resolvedTargets.questionsEl, pack.test_questions || []);
  }

  async function loadFolderPack(packId) {
    const response = await fetch('/api/shared/' + encodeURIComponent(shareToken) + '/packs/' + encodeURIComponent(packId));
    const payload = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      throw new Error(payload.error || 'Could not load shared pack.');
    }
    if (folderEmptyEl) folderEmptyEl.hidden = true;
    if (folderPackPreviewEl) folderPackPreviewEl.hidden = false;
    renderPackPreview(payload, {
      modeEl: folderPackModeEl,
      metaEl: folderPackMetaEl,
      notesEl: folderNotesViewEl,
      flashcardsEl: folderFlashcardsListEl,
      questionsEl: folderQuestionsListEl,
    });
    Array.from(folderPackListEl.querySelectorAll('.item')).forEach(function (item) {
      item.classList.toggle('active', item.dataset.packId === packId);
    });
  }

  function renderFolder(payload) {
    const folder = payload.folder || {};
    const packs = Array.isArray(payload.study_packs) ? payload.study_packs : [];
    if (titleEl) titleEl.textContent = folder.name || 'Shared folder';
    if (subtitleEl) subtitleEl.textContent = 'Read-only folder share with ' + packs.length + ' pack' + (packs.length === 1 ? '' : 's') + '.';
    if (folderShell) folderShell.hidden = false;
    if (!folderPackListEl) return;
    folderPackListEl.innerHTML = '';
    packs.forEach(function (pack) {
      const item = document.createElement('div');
      item.className = 'item';
      item.dataset.packId = pack.study_pack_id;
      item.innerHTML = ''
        + '<div class="item-head"><span class="item-title">' + escapeHtml(pack.title || 'Untitled pack') + '</span></div>'
        + '<div class="item-sub">' + escapeHtml(buildMetaLine(pack)) + '</div>'
        + '<div class="item-sub">' + escapeHtml(String(pack.flashcards_count || 0) + ' cards · ' + String(pack.test_questions_count || 0) + ' questions') + '</div>';
      item.addEventListener('click', function () {
        loadFolderPack(pack.study_pack_id).catch(function (error) {
          showError(error && error.message ? error.message : 'Could not load shared pack.');
        });
      });
      folderPackListEl.appendChild(item);
    });
    if (packs.length) {
      loadFolderPack(packs[0].study_pack_id).catch(function (error) {
        showError(error && error.message ? error.message : 'Could not load shared pack.');
      });
    }
  }

  function renderPack(payload) {
    const pack = payload.study_pack || {};
    if (titleEl) titleEl.textContent = pack.title || 'Shared pack';
    if (subtitleEl) subtitleEl.textContent = 'Read-only shared pack.';
    if (packShell) packShell.hidden = false;
    renderPackPreview(pack, {
      modeEl: packModeEl,
      metaEl: packMetaEl,
      notesEl: notesViewEl,
      flashcardsEl: flashcardsListEl,
      questionsEl: questionsListEl,
    });
  }

  async function init() {
    if (!shareToken) {
      showError('The shared link is invalid.');
      return;
    }
    try {
      const response = await fetch('/api/shared/' + encodeURIComponent(shareToken));
      const payload = await response.json().catch(function () { return {}; });
      if (!response.ok) {
        throw new Error(payload.error || 'Shared content is unavailable.');
      }
      setLoadingState(false);
      if (errorEl) errorEl.hidden = true;
      if (payload.entity_type === 'folder') {
        renderFolder(payload);
        return;
      }
      renderPack(payload);
    } catch (error) {
      showError(error && error.message ? error.message : 'Shared content is unavailable.');
    }
  }

  init();
})();
