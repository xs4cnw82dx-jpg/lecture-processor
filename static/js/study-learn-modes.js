// Study Write and Match modes: write-mode answer checking and grading, the
// match grid and timer, and per-pack match high scores.
// Loaded as a classic script just BEFORE study.js, so these functions exist
// even for study.js code that runs during page load (the auth callback can run
// between scripts). Keep this file to function declarations only: their bodies
// use study.js's top-level names (state, DOM refs, helpers) when called. The
// buttons' event listeners stay in study.js, after its DOM refs.
// Shared with study.js.
/* global auth, getFlashcardQueue, markCardSeen, matchCards:writable, matchElapsed:writable,
   matchGridEl, matchMatched:writable, matchResultsBadge, matchResultsEl, matchResultsHistory,
   matchResultsTime, matchRunning:writable, matchSelected:writable, matchStartTime:writable,
   matchTimerEl, matchTimerInterval:writable, matchTotal:writable, recordWriteAttempt,
   selectedPackId, sessionSettings, setHidden, studySessionUtils, updateDifficultyToolbar,
   updateLearnCardStatus, updateLearnProgressBar, writeCardStatus, writeCheckBtn,
   writeChecked:writable, writeFeedbackEl, writeIndex:writable, writeInputEl, writeNextBtn,
   writeProgressEl, writePromptEl, writePromptSwapped:writable, writeRevealBtn,
   writeRevealed:writable */
// Defined here and used by study.js.
/* exported checkWriteAnswer, getWriteCards, initMatchMode, initWriteMode, renderMatchGrid,
   renderWriteCard, revealWriteAnswer, startMatchTimer, stopMatchTimer */
/* ── Match high scores (localStorage) ── */
function getMatchScoreKey() { return 'match_scores_' + (auth.currentUser ? auth.currentUser.uid : 'anon') + '_' + selectedPackId; }
function loadMatchScores() { try { return JSON.parse(localStorage.getItem(getMatchScoreKey())) || []; } catch (e) { return []; } }
function saveMatchScore(timeMs) {
  var scores = loadMatchScores();
  scores.push(timeMs);
  scores.sort(function (a, b) { return a - b; });
  if (scores.length > 10) { scores = scores.slice(0, 10); }
  try { localStorage.setItem(getMatchScoreKey(), JSON.stringify(scores)); } catch (e) { }
  return scores;
}
function getScoreRank(scores, timeMs) {
  for (var i = 0; i < scores.length; i++) {
    if (scores[i] === timeMs) { return i + 1; }
  }
  return scores.length;
}

/* ── Answer grading (for write mode) ── */
function normalizeAnswer(str) {
  if (studySessionUtils && typeof studySessionUtils.normalizeAnswer === 'function') {
    return studySessionUtils.normalizeAnswer(str, sessionSettings);
  }
  return String(str || '').trim();
}
function gradeAnswer(userAnswer, correctAnswer) {
  if (studySessionUtils && typeof studySessionUtils.gradeAnswer === 'function') {
    return studySessionUtils.gradeAnswer(userAnswer, correctAnswer, sessionSettings);
  }
  return normalizeAnswer(userAnswer) === normalizeAnswer(correctAnswer);
}

/* ── Write mode ── */
function initWriteMode() {
  writeIndex = 0; writeRevealed = false; writeChecked = false; writePromptSwapped = false;
  renderWriteCard();
}
function getWriteCards() {
  return getFlashcardQueue();
}
function renderWriteCard() {
  var cards = getWriteCards();
  if (!cards.length) {
    writePromptEl.textContent = 'No flashcards available.';
    if (writeCardStatus) writeCardStatus.hidden = true;
    setHidden(writeInputEl, true);
    setHidden(writeCheckBtn, true);
    setHidden(writeRevealBtn, true);
    setHidden(writeNextBtn, true);
    return;
  }
  var entry = cards[writeIndex];
  var c = entry.card || {};
  writePromptSwapped = sessionSettings.swapAnswerQuestion || (sessionSettings.randomSwap && Math.random() > 0.5);
  writePromptEl.textContent = writePromptSwapped ? (c.back || '') : (c.front || '');
  writeInputEl.value = ''; writeInputEl.disabled = false; writeInputEl.className = 'write-input';
  setHidden(writeInputEl, false); setHidden(writeCheckBtn, false); setHidden(writeRevealBtn, false);
  writeFeedbackEl.className = 'write-feedback'; setHidden(writeFeedbackEl, false); writeFeedbackEl.classList.remove('visible');
  writeChecked = false; writeRevealed = false;
  writeProgressEl.textContent = (writeIndex + 1) + ' / ' + cards.length;
  setHidden(writeNextBtn, false);
  writeInputEl.focus();
  updateLearnProgressBar();
  updateDifficultyToolbar();
  updateLearnCardStatus();
}
function checkWriteAnswer() {
  if (writeChecked || writeRevealed) return;
  writeChecked = true;
  var cards = getWriteCards();
  var entry = cards[writeIndex] || { card: {}, idx: writeIndex };
  var c = entry.card || {};
  var correctAnswer = writePromptSwapped ? (c.front || '') : (c.back || '');
  var isCorrect = gradeAnswer(writeInputEl.value, correctAnswer);
  writeInputEl.disabled = true;
  recordWriteAttempt('fc_' + entry.idx);
  markCardSeen('fc_' + entry.idx, isCorrect);
  if (isCorrect) {
    writeInputEl.className = 'write-input correct-input';
    writeFeedbackEl.className = 'write-feedback visible correct-fb';
    writeFeedbackEl.textContent = window.LectureI18n ? window.LectureI18n.t('Correct!') : 'Correct!';
  } else {
    writeInputEl.className = 'write-input wrong-input';
    writeFeedbackEl.className = 'write-feedback visible wrong-fb';
    writeFeedbackEl.textContent = 'Incorrect. Expected: ' + correctAnswer;
  }
}
function revealWriteAnswer() {
  if (writeRevealed) return;
  writeRevealed = true; writeChecked = true;
  var cards = getWriteCards();
  var entry = cards[writeIndex] || { card: {}, idx: writeIndex };
  var c = entry.card || {};
  var correctAnswer = writePromptSwapped ? (c.front || '') : (c.back || '');
  writeInputEl.disabled = true; writeInputEl.className = 'write-input wrong-input';
  writeFeedbackEl.className = 'write-feedback visible wrong-fb';
  writeFeedbackEl.textContent = 'Answer: ' + correctAnswer;
  recordWriteAttempt('fc_' + entry.idx);
  markCardSeen('fc_' + entry.idx, false);
}

/* ── Match mode ── */
function initMatchMode() {
  stopMatchTimer();
  setHidden(matchResultsEl, true);
  setHidden(matchGridEl, false);
  matchSelected = null; matchMatched = 0;
  var eligible = getFlashcardQueue();
  var cards = eligible.map(function (entry) { return entry.card; });
  // Pick 6 random cards for 4x3 grid (6 pairs = 12 cells)
  var poolSize = Math.min(6, Math.floor(cards.length));
  var shuffled = cards.map(function (card, idx) { return { card: card, idx: eligible[idx].idx }; }).sort(function () { return Math.random() - 0.5; });
  var picked = shuffled.slice(0, poolSize);
  matchTotal = poolSize;
  // Build cells: each card produces a front cell and a back cell
  var cells = [];
  picked.forEach(function (entry, i) {
    var c = entry.card || {};
    cells.push({ id: 'm_' + i, side: 'front', text: c.front || '', pairId: i, cardIdx: entry.idx });
    cells.push({ id: 'm_' + i, side: 'back', text: c.back || '', pairId: i, cardIdx: entry.idx });
  });
  // Shuffle cells
  cells.sort(function () { return Math.random() - 0.5; });
  matchCards = cells;
  renderMatchGrid();
  startMatchTimer();
}
function renderMatchGrid() {
  matchGridEl.innerHTML = '';
  matchCards.forEach(function (cell, idx) {
    var div = document.createElement('button');
    div.type = 'button';
    div.className = 'match-cell';
    div.textContent = cell.text;
    div.dataset.idx = String(idx);
    div.dataset.pairId = String(cell.pairId);
    div.dataset.side = cell.side;
    if (cell.matched) { div.classList.add('matched'); div.disabled = true; }
    div.classList.toggle('selected', matchSelected === idx);
    div.setAttribute('aria-pressed', matchSelected === idx ? 'true' : 'false');
    div.addEventListener('click', function () { handleMatchClick(idx); });
    matchGridEl.appendChild(div);
  });
}
function handleMatchClick(idx) {
  var cell = matchCards[idx];
  if (cell.matched) return;
  var cellEl = matchGridEl.children[idx];
  if (matchSelected === null) {
    // First selection
    matchSelected = idx;
    cellEl.classList.add('selected');
    cellEl.setAttribute('aria-pressed', 'true');
  } else if (matchSelected === idx) {
    // Deselect
    cellEl.classList.remove('selected');
    cellEl.setAttribute('aria-pressed', 'false');
    matchSelected = null;
  } else {
    // Second selection — check match
    var firstCell = matchCards[matchSelected];
    var firstEl = matchGridEl.children[matchSelected];
    if (firstCell.pairId === cell.pairId && firstCell.side !== cell.side) {
      // Correct match
      firstCell.matched = true; cell.matched = true;
      firstEl.classList.remove('selected'); firstEl.classList.add('matched');
      cellEl.classList.add('matched');
      firstEl.setAttribute('aria-pressed', 'false');
      cellEl.setAttribute('aria-pressed', 'false');
      firstEl.disabled = true;
      cellEl.disabled = true;
      matchMatched++;
      markCardSeen('fc_' + cell.cardIdx, true);
      if (matchMatched >= matchTotal) {
        // All matched — stop timer and show results
        stopMatchTimer();
        showMatchResults();
      }
    } else {
      // Wrong match — flash red briefly
      cellEl.classList.add('wrong-flash'); firstEl.classList.add('wrong-flash');
      var fi = matchSelected;
      setTimeout(function () {
        cellEl.classList.remove('wrong-flash');
        if (matchGridEl.children[fi]) {
          matchGridEl.children[fi].classList.remove('wrong-flash', 'selected');
          matchGridEl.children[fi].setAttribute('aria-pressed', 'false');
        }
      }, 500);
    }
    matchSelected = null;
  }
  updateLearnProgressBar();
}
function startMatchTimer(savedElapsed) {
  matchElapsed = Number(savedElapsed) || 0; matchStartTime = Date.now() - matchElapsed; matchRunning = true;
  matchTimerEl.textContent = (matchElapsed / 1000).toFixed(1) + 's';
  matchTimerInterval = setInterval(function () {
    if (!matchRunning) return;
    matchElapsed = Date.now() - matchStartTime;
    matchTimerEl.textContent = (matchElapsed / 1000).toFixed(1) + 's';
  }, 100);
}
function stopMatchTimer() {
  matchRunning = false;
  if (matchTimerInterval) { clearInterval(matchTimerInterval); matchTimerInterval = null; }
}
function showMatchResults() {
  setHidden(matchGridEl, true);
  setHidden(matchResultsEl, false);
  var timeMs = matchElapsed;
  var timeSec = (timeMs / 1000).toFixed(2);
  matchResultsTime.textContent = timeSec + 's';
  // Save and get rank
  var scores = saveMatchScore(timeMs);
  var rank = getScoreRank(scores, timeMs);
  if (rank === 1) {
    matchResultsBadge.textContent = 'New High Score!';
    matchResultsBadge.className = 'match-results-badge gold';
  } else if (rank === 2) {
    matchResultsBadge.textContent = '2nd Best Time!';
    matchResultsBadge.className = 'match-results-badge silver';
  } else if (rank === 3) {
    matchResultsBadge.textContent = '3rd Best Time!';
    matchResultsBadge.className = 'match-results-badge bronze';
  } else {
    matchResultsBadge.textContent = '';
    matchResultsBadge.className = 'match-results-badge';
  }
  // Show top 3 history
  var historyParts = [];
  var labels = ['1st', '2nd', '3rd'];
  for (var i = 0; i < Math.min(3, scores.length); i++) {
    historyParts.push(labels[i] + ': ' + (scores[i] / 1000).toFixed(2) + 's');
  }
  matchResultsHistory.textContent = historyParts.join(' · ');
}
