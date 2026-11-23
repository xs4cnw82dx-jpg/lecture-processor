import { M, P, D, $, esc, field, selectField, toggle, icon } from "./book-studio-ui.js";
import { createBookInspector } from "./book-studio-inspector.js";
import { createBookPointerTools } from "./book-studio-pointer.js";
import { createBookIO } from "./book-studio-io.js";
import { bindBookEvents } from "./book-studio-events.js";

function startBookStudio() {
  const auth = window.LectureProcessorBootstrap.getAuth();
  // Each page owns one editor session. Only its feature instances share this state.
  const state = {
    user: null,
    session: sessionStorage.getItem("book-tab-session") || M.id(),
    accountGeneration: 0,
    startupState: "loading",
    collection: "mine",
    opening: false,

    book: null,
    active: "",
    selected: [],
    furnitureSelection: "",
    activePathPoint: -1,
    selectionRange: null,
    inlineEdit: null,
    editBatch: null,
    undoStack: [],
    redoStack: [],

    tool: "select",
    brushColor: "#263343",
    brushWidth: 0.8,
    zoom: 1,
    fit: "book",
    reading: false,
    guides: true,
    snap: true,
    rulers: false,
    grid: false,
    thirds: false,
    inspectorOpen: true,
    inspectorTab: "settings",
    themeChoice: 0,
    xpedVariant: "corner",
    xpedMode: "light",

    dirty: false,
    saving: null,
    saveTimer: undefined,
    localWrites: 0,
    localSaveError: "",
    saveError: "",
    savedPages: {},

    leaseToken: "",
    accessToken: "",
    lastRefresh: 0,
    cloudPromotion: null,
    cloudPhase: "",
    cloudBlocked: false,

    imageTarget: "",
    replacement: "",
    uploads: 0,
  };
  let turn = 0;
  let localBooks = [],
    cloudBooks = [],
    changeCount = 0,
    pagesTimer;
  const renderedAssets = {},
    fontCache = {},
    coverCache = {};
  let startupError = null,
    startupTask = null;
  const instance = M.id(),
    tabChannel =
      typeof BroadcastChannel !== "undefined"
        ? new BroadcastChannel("book-studio-tabs")
        : null;
  if (tabChannel)
    tabChannel.onmessage = ({ data }) => {
      if (data.session !== state.session || data.instance === instance) return;
      if (data.type === "probe")
        tabChannel.postMessage({ type: "occupied", session: state.session, instance });
      else if (data.type === "occupied") {
        state.session = M.id();
        sessionStorage.setItem("book-tab-session", state.session);
      }
    };
  if (tabChannel) tabChannel.postMessage({ type: "probe", session: state.session, instance });
  sessionStorage.setItem("book-tab-session", state.session);
  const storageScope = () => state.user?.uid || "guest:" + state.session;
  const accountChangedError = () => Object.assign(new Error("Your account changed. Open the book again in the right account."), { code: "account" });
  function assertAccount(generation) {
    if (generation !== state.accountGeneration) throw accountChangedError();
  }
  function scopeDraft(book, uid = state.user?.uid) {
    if (uid && !D.accountUid(book)) book.cacheAccountUid = uid;
    return book;
  }
  const localSaves = D.createSaveQueue({
    key: ({ book }) => D.accountUid(book) + ":" + book.id,
    snapshot: ({ book, count }) => ({ book: M.clone(book), count }),
    write: ({ book }) => D.putBook(book),
    onState: ({ busy }) => { state.localWrites = Number(busy); updateStatus(); },
    onSaved: ({ book, count }) => {
      if (state.book?.id !== book.id || D.accountUid(state.book) !== D.accountUid(book)) return;
      state.localSaveError = "";
      if (state.book.local && changeCount === count) state.dirty = false;
    },
    onError: (error) => {
      state.localSaveError = error.message;
      if (state.book) notify(error.message, true);
    },
  });
  function queueLocalSave(book = state.book, count = changeCount) {
    if (book) localSaves.enqueue({ book, count });
  }
  function clearWorkspace() {
    finishText();
    clearTimeout(state.saveTimer);
    clearTimeout(pagesTimer);
    cancelAnimationFrame(stageFrame);
    stageFrame = 0;
    window.BookColorPicker?.close();
    closeDialog();
    state.book = null;
    state.leaseToken = state.accessToken = state.active = "";
    state.cloudPhase = "";
    state.cloudBlocked = false;
    state.selected = [];
    state.undoStack = [];
    state.redoStack = [];
    state.savedPages = {};
    state.selectionRange = null;
    state.furnitureSelection = "";
    state.dirty = false;
    state.saveError = state.localSaveError = "";
    localBooks = [];
    cloudBooks = [];
    Object.values(renderedAssets).forEach((asset) => URL.revokeObjectURL(asset.src));
    Object.keys(renderedAssets).forEach((id) => delete renderedAssets[id]);
    Object.keys(coverCache).forEach((id) => delete coverCache[id]);
    ["page-list", "book-spread", "inspector", "dialog-content", "upload-list", "book-grid", "selection-toolbar"].forEach((id) => $(id).replaceChildren());
    $("book-title").value = "";
    document.title = "Book Studio · Lecture Processor";
    $("workspace").hidden = $("title-wrap").hidden = true;
    $("editor-status").textContent = "";
    ["edit-turn", "finish-turn", "reading", "share", "export", "retry-cloud-save"].forEach((id) => { $(id).hidden = true; });
  }
  async function retirePrivateBook(error) {
    const previous = state.book;
    let recovery;
    if (previous && (state.dirty || previous.pending)) {
      // Recovery remains tied to the viewer who made these edits, including
      // collaborators whose uid differs from the book owner's uid.
      previous.cacheAccountUid ||= storageScope();
      queueLocalSave(previous);
      if (!previous.local) recovery = {
        ...M.clone(previous), id: "local-recovery-" + M.id(),
        title: previous.title + " (recovered draft)", local: true, pending: false, role: "owner",
      };
    }
    clearWorkspace();
    if (previous) sessionStorage.removeItem("book-lease-" + previous.id);
    try {
      await localSaves.flush();
      if (recovery) {
        await D.putBook(recovery);
        await D.deleteBook(previous.id);
      }
    } catch (_) { /* The original draft is retained in the queue for retry. */ }
    if (error) showStartupError(error);
  }
  const busyButtons = new WeakSet();
  const action = (fn) => async (event) => {
    const button = event?.target?.closest("button");
    if (button && (button.disabled || busyButtons.has(button))) return;
    if (button) {
      busyButtons.add(button);
      button.setAttribute("aria-busy", "true");
    }
    try {
      await fn(event);
    } catch (error) {
      notify(error.message || "That did not work. Please try again.", true);
    } finally {
      if (button) {
        busyButtons.delete(button);
        button.removeAttribute("aria-busy");
      }
    }
  };
  const page = () =>
    (state.book && state.book.pages.find((p) => p.id === state.active)) || (state.book && state.book.pages[0]);
  const item = () => page() && page().items.find((o) => o.id === state.selected[0]);
  const editable = () => !!state.book && (state.book.local || !!state.leaseToken) && !state.book.deleted && state.cloudPhase !== "finishing" && !state.cloudBlocked;
  const metadata = () => ({
    title: state.book.title,
    folder: state.book.folder,
    tags: state.book.tags,
    favorite: state.book.favorite,
    palette: state.book.palette,
    styles: state.book.styles,
    illustration: state.book.illustration,
    theme: state.book.theme || null,
    pageNumbers: M.pageNumberOptions(state.book.pageNumbers),
  });
  let stageFrame = 0;
  let cachedVersions = [];
  const themes = [
    {
      name: "Moonlit story",
      paper: "#fffdf7",
      palette: ["#6554a4", "#e6dff1", "#f3d7a4", "#30334b"],
      font: "Fraunces",
      body: "Nunito",
    },
    {
      name: "Woodland tales",
      paper: "#fbfaf0",
      palette: ["#4c7563", "#deeadb", "#e6bc90", "#304337"],
      font: "Andika",
      body: "Andika",
    },
    {
      name: "Peach daydream",
      paper: "#fff8f3",
      palette: ["#b46765", "#f5dcda", "#f8dfab", "#553e48"],
      font: "Playpen Sans",
      body: "Nunito",
    },
    {
      name: "Ocean notebook",
      paper: "#f6fbfd",
      palette: ["#39748c", "#d5e9f0", "#edd5a8", "#273f53"],
      font: "Fraunces",
      body: "Comic Neue",
    },
  ];
  try {
    const prefs = JSON.parse(
      localStorage.getItem("book-view-preferences") || "{}",
    );
    state.guides = prefs.guides ?? true;
    state.snap = prefs.snap ?? true;
    state.rulers = !!prefs.rulers;
    state.grid = !!prefs.grid;
    state.thirds = !!prefs.thirds;
    state.inspectorOpen = prefs.inspectorOpen !== false;
  } catch (_) {
    /* A browser may block device preferences. Editing still works. */
  }
  function saveView() {
    try {
      localStorage.setItem(
        "book-view-preferences",
        JSON.stringify({ guides: state.guides, snap: state.snap, rulers: state.rulers, grid: state.grid, thirds: state.thirds, inspectorOpen: state.inspectorOpen }),
      );
    } catch (_) {
      /* Optional preference storage. */
    }
  }
  function clearSelection() {
    finishText();
    state.selected = [];
    state.furnitureSelection = "";
    state.activePathPoint = -1;
    state.selectionRange = null;
    renderSelection();
    inspector.renderInspector();
  }
  function editCheckpoint(key) {
    if (!editable() || item()?.locked) return false;
    if (state.editBatch === key) return true;
    if (!checkpoint()) return false;
    state.editBatch = key;
    return true;
  }
  function decorateTools() {
    const names = {
      "add-image": "image",
      "more-tools": "more",
      undo: "undo",
      redo: "redo",
      "page-settings": "settings",
      history: "history",
    };
    document.querySelectorAll(".book-toolbar button,#history").forEach((el) => {
      const name = names[el.id] || el.dataset.add || el.dataset.tool;
      if (!name) return;
      const label =
        el.querySelector("span")?.textContent ||
        { "page-settings": "Settings", history: "Version history" }[el.id] ||
        "";
      el.innerHTML = icon(name) + (label ? `<span>${esc(label)}</span>` : "");
      if (!el.title) el.title = el.getAttribute("aria-label") || label;
    });
    inspector.setInspector(state.inspectorOpen);
  }
  function rulerMarkup() {
    const ticks = (extent, vertical) =>
      Array.from({ length: Math.floor(extent / 5) + 1 }, (_, i) => {
        const n = i * 5,
          big = n % 10 === 0;
        return vertical
          ? `<path d="M${big ? 8 : 9} ${n} H10"/>${big ? `<text x="7" y="${n + 1}" text-anchor="end">${n}</text>` : ""}`
          : `<path d="M${n} ${big ? 6 : 7} V8"/>${big ? `<text x="${n + 0.5}" y="4">${n}</text>` : ""}`;
      }).join("");
    return `<svg class="book-ruler-x" viewBox="0 0 ${M.W} 8" preserveAspectRatio="none" aria-hidden="true">${ticks(M.W, false)}</svg><svg class="book-ruler-y" viewBox="0 0 10 ${M.H}" preserveAspectRatio="none" aria-hidden="true">${ticks(M.H, true)}</svg>`;
  }
  function editorGuides(pid) {
    if (state.reading || (!state.grid && !state.thirds)) return "";
    return `<svg class="book-grid-overlay" viewBox="0 0 ${M.W} ${M.H}" aria-hidden="true">${state.grid ? `<defs><pattern id="layout-${pid}" width="5" height="5" patternUnits="userSpaceOnUse"><path d="M5 0H0V5" fill="none" stroke="#7282ac" stroke-width=".15" opacity=".35"/></pattern></defs><rect width="${M.W}" height="${M.H}" fill="url(#layout-${pid})"/>` : ""}${state.thirds ? [1 / 3, 0.5, 2 / 3].map((f) => `<path d="M${M.W * f} 0V${M.H} M0 ${M.H * f}H${M.W}" stroke="#8b77bd" stroke-width=".25" stroke-dasharray="1 2" opacity=".6"/>`).join("") : ""}</svg>`;
  }
  function feedback(lines = [], box = null) {
    document
      .querySelectorAll(".book-drag-guides,.book-drag-hud")
      .forEach((n) => n.remove());
    const sheet = $("book-spread").querySelector(`[data-page-id="${state.active}"]`);
    if (!sheet) return;
    if (lines.length)
      sheet.insertAdjacentHTML(
        "beforeend",
        `<svg class="book-drag-guides" viewBox="0 0 ${M.W} ${M.H}" aria-hidden="true">${lines.map((l) => `<path d="${l.axis === "x" ? `M${l.value} 0V${M.H}` : `M0 ${l.value}H${M.W}`}"/><text x="${l.axis === "x" ? l.value + 2 : 2}" y="${l.axis === "y" ? l.value - 2 : 6}">${l.label}</text>`).join("")}</svg>`,
      );
    if (box)
      $("book-viewport").insertAdjacentHTML(
        "beforeend",
        `<output class="book-drag-hud">X ${box.x.toFixed(1)} · Y ${box.y.toFixed(1)} &nbsp; ${box.w.toFixed(1)} × ${box.h.toFixed(1)} mm</output>`,
      );
  }
  function selectionToolbar() {
    const bar = $("selection-toolbar"),
      o = item();
    if (!bar) return;
    bar.hidden = (!o && !state.furnitureSelection) || state.reading || !editable();
    if (!bar.hidden && state.furnitureSelection) {
      bar.innerHTML = `<span>${state.furnitureSelection === "logo" ? "xPED logo" : "Page number"}</span><button data-command="furniture-settings" class="secondary-btn">${icon("settings")} Position & style</button><button data-command="reset-furniture" class="secondary-btn">Reset position</button>`;
      return;
    }
    if (bar.hidden) return;
    bar.innerHTML = `<span>${state.selected.length > 1 ? state.selected.length + " selected" : esc(o.name)}</span><button data-command="object-settings" class="secondary-btn" aria-label="Object settings">${icon("settings")} Settings</button>${o.locked ? `<button data-lock="${o.id}" class="secondary-btn">${icon("unlock")} Unlock</button>` : `${o.type === "text" ? '<button data-command="edit-on-page" class="secondary-btn">' + icon("text") + " Edit text</button>" : ""}<button data-command="duplicate-object" class="icon-btn" title="Duplicate (⌘/Ctrl D)" aria-label="Duplicate selection">${icon("copy")}</button><button data-command="delete-object" class="icon-btn book-danger" title="Delete" aria-label="Delete selection">${icon("trash")}</button>${state.selected.length > 1 ? '<button data-command="group-objects" class="secondary-btn">' + (o.group ? "Ungroup" : "Group") + "</button>" : ""}`}`;
  }
  function startText() {
    const o = item();
    if (!o || o.type !== "text" || o.locked || !editable() || state.inlineEdit)
      return;
    const sheet = $("book-spread").querySelector(`[data-page-id="${state.active}"]`);
    if (!sheet) return;
    const editor = document.createElement("textarea");
    editor.id = "canvas-text-editor";
    editor.className = "book-inline-text";
    editor.setAttribute("aria-label", "Edit text on page");
    editor.maxLength = 12000;
    editor.spellcheck = true;
    editor.value = o.runs?.length ? o.runs.map((r) => r.text).join("") : o.text;
    positionTextEditor(o, sheet);
    state.inlineEdit = { id: o.id, page: state.active, editor };
    sheet.append(editor);
    editor.focus();
    editor.select();
    editor.addEventListener("input", () => {
      if (!editCheckpoint("inline-" + o.id)) return;
      M.replaceText(o, editor.value);
      state.selectionRange = null;
      changed(false);
      if ($("object-text")) $("object-text").value = editor.value;
      schedulePages();
    });
    const range = () => {
      state.selectionRange = {
        start: editor.selectionStart,
        end: editor.selectionEnd,
      };
    };
    editor.addEventListener("select", range);
    editor.addEventListener("keyup", range);
    editor.addEventListener("pointerup", range);
    editor.addEventListener("keydown", (e) => {
      if (
        e.key === "Escape" ||
        ((e.metaKey || e.ctrlKey) && e.key === "Enter")
      ) {
        e.preventDefault();
        e.stopPropagation();
        finishText();
        state.selectionRange = null;
        renderStage();
        inspector.renderInspector();
        $("book-spread").querySelector(`[data-page-id="${state.active}"]`)?.focus();
      }
    });
  }
  function positionTextEditor(o, sheet) {
    const scale = sheet.clientWidth / M.W;
    layoutRule("#canvas-text-editor", {
      left: o.x * scale + "px",
      top: o.y * scale + "px",
      width: o.w * scale + "px",
      height: o.h * scale + "px",
      fontFamily: `"${o["style"].font}"`,
      fontSize: o["style"].size * M.PT * scale + "px",
      fontWeight: o["style"].weight,
      fontStyle: o["style"].italic ? "italic" : "normal",
      lineHeight: o["style"].lineHeight,
      letterSpacing: ((o["style"].letterSpacing * 25.4) / 96) * scale + "px",
      color: o["style"].color,
      textAlign: o["style"].align,
      backgroundColor: page().background,
      transform: `rotate(${o.rotation}deg)`,
    });
  }
  function finishText() {
    if (!state.inlineEdit) return;
    state.inlineEdit.editor.remove();
    state.inlineEdit = null;
    state.editBatch = null;
    cancelAnimationFrame(stageFrame);
    stageFrame = requestAnimationFrame(() => {
      stageFrame = 0;
      if (!state.inlineEdit && state.book) renderStage();
    });
  }
  function selectedItems() {
    return page().items.filter((o) => state.selected.includes(o.id) && !o.locked);
  }
  function pageBlocks() {
    const blocks = [],
      seen = new Set();
    state.book.pages.slice(1, -1).forEach((p) => {
      if (seen.has(p.id)) return;
      const link = p.items.find((o) => o.spanId);
      const block = link
        ? state.book.pages
            .slice(1, -1)
            .filter((q) => q.items.some((o) => o.spanId === link.spanId))
        : [p];
      block.forEach((q) => seen.add(q.id));
      blocks.push(block);
    });
    return blocks;
  }
  function canMovePage(direction) {
    const blocks = pageBlocks(),
      at = blocks.findIndex((group) => group.some((p) => p.id === state.active));
    return at >= 0 && at + direction >= 0 && at + direction < blocks.length;
  }
  function movePage(direction) {
    if (!canMovePage(direction) || !checkpoint()) return;
    const blocks = pageBlocks(),
      at = blocks.findIndex((group) => group.some((p) => p.id === state.active));
    [blocks[at], blocks[at + direction]] = [blocks[at + direction], blocks[at]];
    state.book.pages = [state.book.pages[0], ...blocks.flat(), state.book.pages.at(-1)];
    keepSpreadsTogether();
    changed();
  }
  function themeDialog() {
    const isXped = state.themeChoice === "xped";
    const xpedOptions = isXped
      ? `<section class="book-xped-options" aria-label="xPED design options"><div class="book-theme-setting"><div><h3>Inside pages</h3><p class="book-muted">Alternating signature corners, on light or dark paper.</p></div><div class="book-segmented" role="group" aria-label="Inside page appearance"><button data-xped-mode="light" aria-pressed="${state.xpedMode === "light"}">Light pages</button><button data-xped-mode="dark" aria-pressed="${state.xpedMode === "dark"}">Dark pages</button></div></div><h3>Choose a cover pair</h3><div class="book-cover-grid">${M.xped.variants.map((v) => `<button class="book-cover-choice" data-xped-variant="${v.id}" aria-pressed="${state.xpedVariant === v.id}"><span class="book-cover-pair"><span>${M.svg(M.coverPreview(v.id, state.xpedMode, "front"))}<small>Front</small></span><span>${M.svg(M.coverPreview(v.id, state.xpedMode, "back"))}<small>Back</small></span></span><strong>${esc(v.name)}</strong><span>${esc(v.description)}</span></button>`).join("")}</div><p class="book-muted">Your words and illustrations stay in place. Theme artwork can be hidden on any page.</p></section>` : "";
    dialog(
      "Book themes",
      `<p class="book-muted">A coordinated palette, paper and text styles for the whole book. Existing custom colors stay as you chose them.</p><div class="book-theme-grid">${themes.map((t, i) => `<button class="book-theme" data-theme="${i}" aria-pressed="${i === state.themeChoice}"><svg viewBox="0 0 160 105" aria-hidden="true"><rect width="160" height="105" rx="8" fill="${t.paper}"/><circle cx="126" cy="30" r="17" fill="${t.palette[2]}"/><path d="M0 80Q50 35 95 83T160 70V105H0Z" fill="${t.palette[1]}"/><text x="12" y="37" font-family="${t.font}" font-size="16" fill="${t.palette[3]}">A little story</text><path d="M13 51h68M13 60h55" stroke="${t.palette[0]}" stroke-width="2"/></svg><strong>${t.name}</strong><span>${t.font} + ${t.body}</span></button>`).join("")}<button class="book-theme book-theme-xped" data-theme="xped" aria-pressed="${isXped}"><span class="book-xped-swatch" aria-hidden="true"><span></span><span></span><span></span></span><strong>xPED</strong><span>Four cover designs · light or dark pages</span></button></div>${xpedOptions}<div class="book-theme-apply"><button id="apply-theme" class="primary-btn">Apply ${isXped ? "xPED" : themes[state.themeChoice].name}</button><span class="book-muted">You can undo this change.</span></div>`,
    );
  }
  function applyTheme() {
    if (!checkpoint()) return;
    if (state.themeChoice === "xped") {
      M.applyXpedTheme(state.book, state.xpedVariant, state.xpedMode);
      changed();
      closeDialog();
      notify("xPED applied to your book.");
      return;
    }
    const t = themes[state.themeChoice],
      old = state.book.palette.slice(),
      oldBodyFont = state.book.styles.body.font;
    state.book.theme = null;
    state.book.palette = t.palette.slice();
    ["heading", "body", "caption"].forEach((k) => {
      state.book.styles[k].font = k === "heading" ? t.font : t.body;
      state.book.styles[k].color = t.palette[3];
    });
    state.book.pages.forEach((p) => {
      p.background = t.paper;
      p.decoration = null;
      p.items.forEach((o) => {
        if (o.styleName) {
          o.style = { ...o.style, ...state.book.styles[o.styleName] };
          o.runs = [];
        }
        if (o.type === "table" && o.tableStyle !== "custom") {
          if (o["style"].font === oldBodyFont) o["style"].font = t.body;
          o["style"].color = t.palette[3];
        }
        if (o.type === "flow" && o.flowStyle !== "custom") {
          if (o["style"].font === oldBodyFont) o["style"].font = t.body;
          o["style"].color = t.palette[3];
          o.fill = t.palette[1];
          o.stroke = t.palette[0];
        }
        ["fill", "stroke"].forEach((k) => {
          const i = old.indexOf(o[k]);
          if (i >= 0) o[k] = t.palette[i % 4];
        });
      });
    });
    changed();
    closeDialog();
    notify(t.name + " applied to your book.");
  }
  function resizeTable(axis, delta) {
    const o = item();
    if (!o || !checkpoint()) return;
    const rows = o.cells.length || 1,
      cols = Math.max(1, ...o.cells.map((r) => r.length));
    const nr = M.clamp(rows + (axis === "row" ? delta : 0), 1, 8),
      nc = M.clamp(cols + (axis === "column" ? delta : 0), 1, 8);
    o.cells = Array.from({ length: nr }, (_, r) =>
      Array.from({ length: nc }, (_, c) => o.cells[r]?.[c] || ""),
    );
    changed();
  }
  function shortcutsDialog() {
    const rows = [
      ["Pages", "← / →", "Previous / next spread"],
      ["Pages", "Home / End", "First / last page"],
      ["Pages", "Alt + ← / →", "Turn pages with an object selected"],
      ["Pages", "Shift + N", "Add a page"],
      ["Objects", "⌘ / Ctrl + C, V, X", "Copy, paste, cut selected objects"],
      ["Objects", "⌘ / Ctrl + D", "Duplicate selection"],
      ["Objects", "⌘ / Ctrl + A", "Select all unlocked, visible objects"],
      ["Objects", "Arrow keys", "Nudge 0.5 mm; hold Shift for 5 mm"],
      ["Objects", "Shift + click / drag empty space", "Select several objects"],
      ["Objects", "Alt + drag", "Ignore snapping while dragging"],
      ["Lines", "Right-click", "Add a bend or remove a selected bend"],
      ["Lines", "Arrow keys", "Move a focused line point; hold Shift for 5 mm"],
      ["Lines", "Shift + drag point", "Place a point on the 5 mm grid"],
      ["Text", "Double-click / Enter", "Edit text directly on the page"],
      ["Text", "Escape / ⌘ / Ctrl + Enter", "Finish editing text"],
      [
        "Text",
        "Arrow keys, copy and paste",
        "Normal text editing while typing",
      ],
      ["History", "⌘ / Ctrl + Z", "Undo; add Shift to redo"],
      ["View", "⌘ / Ctrl + +, −, 0", "Zoom in, out, reset"],
      ["View", "Escape", "Clear selection or close a dialog"],
    ];
    dialog(
      "Keyboard shortcuts",
      `<input id="shortcut-search" type="search" aria-label="Search shortcuts" placeholder="Find a shortcut…"><div class="book-shortcut-list">${rows.map((r) => `<div class="book-shortcut" data-search="${esc(r.join(" ").toLowerCase())}"><span>${r[0]}</span><kbd>${r[1]}</kbd><p>${r[2]}</p></div>`).join("")}</div>`,
    );
  }
  function notify(message, error = false) {
    const node = $("book-toast");
    const ux = window.LectureProcessorUx;
    if (ux && ux.toast) {
      ux.toast(message, { element: node, type: error ? "error" : "info", duration: error ? 9500 : 4200, show: (el) => { el.classList.toggle("error", error); el.hidden = false; }, hide: (el) => { el.hidden = true; } });
      return;
    }
    node.textContent = message;
    node.hidden = false;
  }
  function status(message) {
    $("save-state").textContent = message;
  }
  async function api(url, options = {}, blob = false, accountUid = "") {
    const headers = { "X-Book-Session": state.session, ...options.headers };
    const requestUser = state.user, generation = state.accountGeneration;
    if (accountUid && requestUser?.uid !== accountUid)
      throw new Error("Sign in with the same account to continue saving this draft.");
    if (requestUser) headers.Authorization = "Bearer " + (await requestUser.getIdToken());
    assertAccount(generation);
    if (accountUid && state.user?.uid !== accountUid)
      throw new Error("Cloud saving paused because your account changed.");
    if (state.accessToken && !accountUid) headers["X-Book-Access"] = state.accessToken;
    if (options.body && !(options.body instanceof FormData))
      headers["Content-Type"] = "application/json";
    const r = await fetch(url, { ...options, headers });
    assertAccount(generation);
    if (!r.ok) {
      let p;
      try {
        p = await r.json();
      } catch (_) {
        p = { error: "Could not reach the server. Your local draft is safe." };
      }
      assertAccount(generation);
      const e = new Error(p.error || "Please try again.");
      e.status = r.status;
      const path = url.split("?")[0], current = state.book;
      if ([401, 403, 404].includes(r.status) && current && !current.local) {
        const bookPath = "/api/books/" + current.id;
        if (path === bookPath || path === bookPath + "/revision") {
          state.accountGeneration++;
          await retirePrivateBook(e);
        } else if (path.startsWith(bookPath + "/") && r.status !== 404) {
          // Losing an editing capability does not necessarily revoke viewing.
          // Missing images/versions are also recoverable without closing a book.
          try { await api(bookPath + "/revision"); } catch (_) { /* A denied revision request clears the private workspace. */ }
        }
      }
      throw e;
    }
    const result = await (blob ? r.blob() : r.json());
    assertAccount(generation);
    return result;
  }
  async function loadLibrary() {
    const generation = state.accountGeneration, uid = state.user?.uid;
    const stored = await D.listBooks(storageScope());
    assertAccount(generation);
    localBooks = stored;
    cloudBooks = [];
    if (state.user) {
      try {
        const result = await api("/api/books");
        assertAccount(generation);
        cloudBooks = result.books;
        const pending = await Promise.all(localBooks.filter((draft) => draft.local && draft.cloudAccountUid === uid).map((draft) => D.getSync(draft.id)));
        assertAccount(generation);
        const uploadingIds = new Set(pending.filter((operation) => operation && !operation.complete).map((operation) => operation.remoteId));
        const uploadingKeys = new Set(pending.filter((operation) => operation && !operation.complete).map((operation) => operation.key));
        cloudBooks = cloudBooks.filter((book) => !uploadingIds.has(book.id) && !uploadingKeys.has(book.creation_key));
      } catch (e) {
        if (e.code === "account") return;
        notify(e.message, true);
      }
    }
    renderLibrary();
    await loadCovers();
  }
  async function loadCovers() {
    const generation = state.accountGeneration;
    for (const entry of cloudBooks.filter((x) => !x.deleted).slice(0, 30)) {
      if (state.book) return;
      try {
        const cached = localBooks.find(
          (x) =>
            x.id === entry.id && !x.pending && x.revision === entry.revision,
        );
        const result = cached
          ? { pages: [cached.pages[0]], assets: cached.assets }
          : await api("/api/books/" + entry.id + "?cover=1");
        assertAccount(generation);
        coverCache[entry.id] = result.pages[0];
        for (const a of result.assets) {
          if (renderedAssets[a.id]) continue;
          const stored = await D.getAsset(a.id);
          assertAccount(generation);
          let blob = stored && stored.blob;
          if (!blob && a.ready) {
            blob = await api(
              "/api/books/" + entry.id + "/assets/" + a.id,
              {},
              true,
            );
            await D.putAsset({ ...a, blob });
            assertAccount(generation);
          }
          if (blob)
            renderedAssets[a.id] = {
              src: URL.createObjectURL(blob),
              width: a.width,
              height: a.height,
            };
        }
        renderLibrary();
      } catch (_) {
        if (generation !== state.accountGeneration) return;
        /* The bookshelf remains usable if a cover cannot load. */
      }
    }
  }
  function renderLibrary() {
    if (state.book || startupError) return;
    let list =
      state.collection === "shared"
        ? cloudBooks.filter((x) => x.role !== "owner" && !x.deleted)
        : state.collection === "local"
          ? localBooks.filter((x) => x.local && !x.deleted)
          : state.collection === "trash"
            ? [
                ...localBooks.filter((x) => x.local && x.deleted),
                ...cloudBooks.filter((x) => x.deleted),
              ]
            : state.user
              ? [
                  ...cloudBooks.filter((x) => x.role === "owner" && !x.deleted),
                  ...localBooks.filter((x) => x.local && !x.deleted && x.cloudAccountUid === state.user.uid),
                ]
              : localBooks.filter((x) => x.local && !x.deleted);
    const query = $("book-search").value.toLowerCase();
    list = list.filter((x) =>
      [x.title, x.folder, ...(x.tags || [])]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
    const sort = $("book-sort").value;
    list.sort((a, b) =>
      sort === "title"
        ? a.title.localeCompare(b.title)
        : sort === "favorite"
          ? Number(b.favorite) - Number(a.favorite) ||
            b.updated_at - a.updated_at
          : b.updated_at - a.updated_at,
    );
    $("book-library-count").textContent = `${list.length} ${list.length === 1 ? "book" : "books"}${query ? " matching your search" : " in this view"}`;
    $("book-grid").innerHTML = list.length
      ? list
          .map((x) => {
            const cached = localBooks.find((l) => l.id === x.id),
              cover =
                coverCache[x.id] || (cached && cached.pages && cached.pages[0]);
            return `<article class="book-card"><button class="book-cover-button" data-open="${esc(x.id)}" aria-label="Open ${esc(x.title)}"><span class="book-mini-cover">${cover ? M.svg(cover, renderedAssets) : M.svg({ ...M.page("front"), items: [M.object("text", { text: x.title, y: 38, w: 108, h: 90, style: { ...M.baseStyle, font: "Fraunces", size: 28 } })] })}</span></button><div class="book-card-title"><h3>${x.favorite ? "★ " : ""}${esc(x.title)}</h3><button class="icon-btn" data-book-options="${esc(x.id)}" aria-label="Options for ${esc(x.title)}">•••</button></div><p>${esc(x.local && state.user?.uid && x.cloudAccountUid === state.user.uid ? "Waiting to save to your account" : x.folder || (x.local ? "On this device" : "Saved to cloud"))} · ${new Date(x.updated_at * 1000).toLocaleDateString((window.LectureI18n ? window.LectureI18n.locale() : 'en-GB'), { month: "short", day: "numeric" })}</p></article>`;
          })
          .join("")
      : `<div class="book-empty"><h2>${query ? "No books found" : state.collection === "trash" ? "Nothing in the trash" : state.collection === "shared" ? "A place for shared stories" : "Your next idea starts here"}</h2><p>${query ? "Try another title, folder or tag." : state.collection === "shared" ? "Books shared with your email address will appear here." : state.collection === "trash" ? "Deleted books can be restored here." : "Start with a blank page or choose a little inspiration."}</p>${!query && ["mine", "local"].includes(state.collection) ? '<button class="primary-btn" data-new>＋ Create a book</button>' : ""}</div>`;
  }
  function dialog(title, html, userTitle = false) {
    finishText();
    window.BookColorPicker?.close();
    $("dialog-content").innerHTML =
      `<h2 id="book-dialog-title"${userTitle ? ' data-user-content' : ''}>${esc(title)}</h2>${html}`;
    $("book-dialog").setAttribute("aria-labelledby", "book-dialog-title");
    if (!$("book-dialog").open) $("book-dialog").showModal();
  }
  function closeDialog() {
    $("book-dialog").close();
  }
  function newBookDialog() {
    dialog(
      "What will you make?",
      `<p class="book-muted">Every book starts with a cover and two inside pages. Add as many as your idea needs.</p><div class="book-template-grid">${[
        ["blank", "Blank sketchbook", "A fresh page for anything."],
        ["story", "Picture book", "A little room for a big adventure."],
        ["journal", "Journal", "Lined pages for everyday discoveries."],
        ["explain", "Visual explanation", "Make an idea easy to understand."],
      ]
        .map(
          (t) =>
            `<button class="book-template" aria-label="${t[1]} ${t[2]}" data-template="${t[0]}"><strong>${t[1]}</strong><span class="book-muted">${t[2]}</span></button>`,
        )
        .join("")}</div>`,
    );
  }
  async function create(template) {
    const generation = state.accountGeneration, next = scopeDraft(M.book(template));
    await D.putBook(next);
    assertAccount(generation);
    closeDialog();
    await openBook(next.id);
  }
  function currentSpreads() {
    return M.spreads(state.book.pages, state.fit === "page" || window.innerWidth <= 780);
  }
  function syncTurn() {
    const spreads = currentSpreads(),
      index = spreads.findIndex((s) => s.includes(state.active));
    turn = Math.max(0, index);
    return spreads;
  }
  async function openBook(id) {
    if (state.opening) return;
    const generation = state.accountGeneration;
    let switched = false;
    state.opening = true;
    $("book-loading").hidden = false;
    $("library").hidden = true;
    status("Opening book…");
    try {
      if (state.book) await persist();
      if (state.cloudPromotion) await state.cloudPromotion.catch(() => {});
      assertAccount(generation);
      if (state.book && !state.book.local && state.leaseToken) await release();
      assertAccount(generation);
      const cached = await D.getBook(id, storageScope());
      assertAccount(generation);
      clearWorkspace();
      switched = true;
      state.book = cached;
      if (!state.book && id.startsWith("local-")) {
        const operation = await D.getSync(id);
        assertAccount(generation);
        if (operation?.complete && operation.uid === state.user?.uid) {
          id = operation.remoteId;
          const promoted = await D.getBook(id, storageScope());
          assertAccount(generation);
          state.book = promoted;
        }
      }
      state.leaseToken = "";
      state.selected = [];
      state.furnitureSelection = "";
      state.activePathPoint = -1;
      state.undoStack = [];
      state.redoStack = [];
      state.dirty = false;
      changeCount = 0;
      state.cloudPhase = "";
      state.cloudBlocked = false;
      state.accessToken = sessionStorage.getItem("book-access-" + id) || "";
      if (!id.startsWith("local-")) {
        const local = state.book;
        const result = await api("/api/books/" + id);
        assertAccount(generation);
        state.book = {
          ...result.book,
          pages: result.book.page_ids
            .map((pid) => result.pages.find((p) => p.id === pid))
            .filter(Boolean),
          deletedPages: (result.book.deleted_page_ids || [])
            .map((pid) => result.pages.find((p) => p.id === pid))
            .filter(Boolean),
          assets: result.assets,
          local: false,
          cacheAccountUid: storageScope(),
        };
        if (local && local.pending) {
          await D.putBook({
            ...local,
            id: "local-recovery-" + M.id(),
            title: local.title + " (recovered draft)",
            local: true,
            pending: false,
            role: "owner",
            cacheAccountUid: D.accountUid(local) || storageScope(),
          });
          assertAccount(generation);
          notify(
            "Your unsaved changes are safe in a recovered draft on your bookshelf.",
          );
        }
      }
      if (!state.book)
        throw new Error("This book is no longer available on this device.");
      state.active = state.book.pages[0].id;
      turn = 0;
      state.zoom = 1;
      state.reading = false;
      document.body.classList.remove("book-reading");
      $("library").hidden = true;
      $("workspace").hidden = false;
      $("title-wrap").hidden = false;
      ["reading", "share", "export"].forEach((i) => ($(i).hidden = false));
      $("book-title").value = state.book.title;
      history.replaceState({}, "", "/books/" + id);
      state.savedPages = Object.fromEntries(
        state.book.pages
          .concat(state.book.deletedPages || [])
          .map((p) => [p.id, JSON.stringify(p)]),
      );
      state.saveError = "";
      await loadAssets();
      assertAccount(generation);
      renderAll();
      if (!state.book.local && !state.book.deleted && (state.book.role === "owner" || state.book.role === "edit")) {
        const resume = sessionStorage.getItem("book-lease-" + id);
        try {
          await acquire(false, resume);
        } catch (error) {
          if (generation !== state.accountGeneration) throw error;
          notify(
            "Opened for viewing. You can start editing when the book is available.",
          );
        }
      }
      if (!state.book.local) await D.putBook(state.book);
      assertAccount(generation);
      updateStatus();
    } catch (error) {
      if (generation === state.accountGeneration && (switched || !state.book)) {
        clearWorkspace();
        showStartupError(error);
      }
      throw error;
    } finally {
      state.opening = false;
      if (generation === state.accountGeneration) {
        $("book-loading").hidden = true;
        if (state.book) updateStatus();
        else $("library").hidden = false;
      }
    }
    if (state.book?.local && state.user && !state.book.id.startsWith("local-recovery-"))
      io.ensureCloudBook().catch(() => {});
  }
  async function loadAssets(original = false) {
    const current = state.book, generation = state.accountGeneration;
    if (!current) return;
    for (const a of current.assets) {
      const stored = await D.getAsset(a.id);
      assertAccount(generation);
      if (state.book !== current) return;
      let blob = stored && stored.blob;
      if (!blob && !current.local && a.ready) {
        try {
          blob = await api(
            "/api/books/" +
              current.id +
              "/assets/" +
              a.id +
              (original ? "?original=1" : ""),
            {},
            true,
          );
          await D.putAsset({ ...a, blob });
          assertAccount(generation);
        } catch (e) {
          if (state.book !== current || e.code === "account") throw e;
          notify(e.message, true);
          continue;
        }
      }
      if (blob && !renderedAssets[a.id])
        renderedAssets[a.id] = {
          src: URL.createObjectURL(blob),
          width: a.width,
          height: a.height,
          blob,
        };
    }
  }
  async function acquire(takeover = false, resume = "") {
    const current = state.book;
    if (!current || current.local) return;
    const result = await api("/api/books/" + state.book.id + "/lease", {
      method: "POST",
      body: JSON.stringify({
        action: "acquire",
        takeover,
        lease_token: resume || state.leaseToken,
      }),
    });
    if (state.book !== current) return;
    state.leaseToken = result.lease_token;
    sessionStorage.setItem("book-lease-" + state.book.id, state.leaseToken);
    const remote = await api("/api/books/" + state.book.id + "/revision");
    if (state.book !== current) return;
    if (remote.book.revision !== state.book.revision) {
      if (state.dirty) {
        await D.putBook({
          ...M.clone(state.book),
          id: "local-recovery-" + M.id(),
          title: state.book.title + " (recovered draft)",
          local: true,
          pending: false,
          role: "owner",
          cacheAccountUid: D.accountUid(current) || storageScope(),
        });
        notify(
          "A newer version is open. Your unsaved changes are in a recovered draft.",
        );
      }
      state.dirty = false;
      await reloadRemote();
    }
    updateStatus();
    inspector.renderInspector();
  }
  async function release() {
    if (!state.book || state.book.local || !state.leaseToken) return;
    const current = state.book;
    await persist();
    if (state.book !== current) return;
    await api("/api/books/" + state.book.id + "/lease", {
      method: "POST",
      body: JSON.stringify({ action: "release", lease_token: state.leaseToken }),
    });
    if (state.book !== current) return;
    state.leaseToken = "";
    sessionStorage.removeItem("book-lease-" + state.book.id);
    updateStatus();
    inspector.renderInspector();
  }
  function updateStatus() {
    if (!state.book) return;
    document.title = state.book.title + " · Book Studio";
    const can = editable();
    if ($("retry-cloud-save")) {
      $("retry-cloud-save").hidden = !state.saveError || !state.user || (!state.book.local && !state.book.pending);
      $("retry-cloud-save").disabled = !!state.cloudPromotion || (state.book.cloudAccountUid && state.book.cloudAccountUid !== state.user?.uid);
      $("retry-cloud-save").title = state.saveError || "Retry saving to your account";
    }
    $("book-title").disabled = !can;
    $("edit-turn").hidden =
      state.book.local || can || !["owner", "edit"].includes(state.book.role) || state.book.deleted;
    $("finish-turn").hidden = state.book.local || !can;
    $("share").disabled = state.book.deleted;
    $("export").disabled = !state.book.local && !["owner", "edit"].includes(state.book.role);
    $("editor-status").textContent = state.book.local
      ? ""
      : can
        ? "Your editing turn"
        : state.book.editor
          ? state.book.editor.name + " is editing"
          : "Viewing";
    $("edit-turn").textContent =
      state.book.editor && state.book.role === "owner" ? "Start / take over" : "Start editing";
    status(
      state.opening
        ? "Opening book…"
        : state.cloudPromotion || state.cloudPhase === "saving" || state.cloudPhase === "finishing"
          ? "Saving to your account…"
        : state.localSaveError
          ? "Needs attention · Changes not saved on this device"
        : state.saveError
          ? state.book.local && state.book.cloudAccountUid
            ? navigator.onLine ? "Couldn’t save to cloud · Draft safe on this device" : "Offline · Saved on this device"
            : "Needs attention"
          : state.saving || state.localWrites
            ? "Saving…"
            : state.dirty
              ? "Saving…"
              : state.book.local
                ? "Saved on this device"
                : "Saved to cloud",
    );
    if (state.lastRefresh && !can)
      $("editor-status").textContent +=
        " · Updated " +
        new Date(state.lastRefresh).toLocaleTimeString((window.LectureI18n ? window.LectureI18n.locale() : 'en-GB'), {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
    document
      .querySelectorAll(
        "[data-add],#text-presets,#add-image,#add-page,#add-page-side,[data-tool]:not([data-tool=select])",
      )
      .forEach((el) => (el.disabled = !can));
    $("undo").disabled = !can || !state.undoStack.length;
    $("redo").disabled = !can || !state.redoStack.length;
    $("history").disabled = !state.book.local && !["owner", "edit"].includes(state.book.role);
    $("history").title = $("history").disabled
      ? "Version history is available to book editors"
      : "Preview and restore saved versions";
  }
  function checkpoint() {
    if (!editable()) return false;
    state.editBatch = null;
    state.undoStack.push(
      M.clone({
        pages: state.book.pages,
        deletedPages: state.book.deletedPages,
        ...metadata(),
        activePage: state.active,
      }),
    );
    if (state.undoStack.length > 60) state.undoStack.shift();
    state.redoStack = [];
    return true;
  }
  function changed(render = true) {
    if (!state.book) return;
    syncLinkedItems();
    state.book.updated_at = Date.now() / 1000;
    state.dirty = true;
    state.book.pending = !state.book.local;
    changeCount++;
    queueLocalSave();
    clearTimeout(state.saveTimer);
    if (!state.book.local)
      state.saveTimer = setTimeout(
        () => persist().catch((e) => notify(e.message, true)),
        5000,
      );
    if (render) renderAll();
    else updateStatus();
  }
  async function persist() {
    if (!state.book) return;
    if (state.book.local && state.cloudBlocked) return;
    clearTimeout(state.saveTimer);
    const current = state.book, generation = state.accountGeneration;
    queueLocalSave(current);
    await localSaves.flush();
    assertAccount(generation);
    if (state.book !== current) return;
    if (state.saving) {
      await state.saving;
      if (state.book === current && state.dirty && state.leaseToken) return persist();
      return;
    }
    if (state.cloudPromotion) return;
    if (current.local) {
      updateStatus();
      return;
    }
    if (!state.dirty || !state.leaseToken || state.uploads || current.assets.some((a) => a.local))
      return;
    const count = changeCount,
      sent = M.clone({
        pages: current.pages
          .concat(current.deletedPages || [])
          .filter((p) => state.savedPages[p.id] !== JSON.stringify(p)),
        page_ids: current.pages.map((p) => p.id),
        deleted_page_ids: (current.deletedPages || []).map((p) => p.id),
        metadata: metadata(),
        base_revision: current.revision,
        lease_token: state.leaseToken,
      });
    status("Saving…");
    state.saving = (async () => {
      try {
        const result = await api("/api/books/" + current.id, {
          method: "PUT",
          body: JSON.stringify(sent),
        });
        if (state.book !== current) return;
        current.revision = result.revision;
        sent.pages.forEach((p) => (state.savedPages[p.id] = JSON.stringify(p)));
        state.saveError = "";
        if (changeCount === count) {
          state.dirty = false;
          current.pending = false;
        }
        queueLocalSave(current);
        await localSaves.flush();
        updateStatus();
      } catch (e) {
        if (state.book !== current || generation !== state.accountGeneration) throw e;
        if (e.status === 409 || e.status === 403) {
          state.leaseToken = "";
          sessionStorage.removeItem("book-lease-" + current.id);
        }
        state.saveError = e.message;
        updateStatus();
        throw e;
      } finally {
        state.saving = null;
        updateStatus();
      }
    })();
    return state.saving;
  }
  function renderAll() {
    if (!state.book) return;
    finishText();
    if (document.activeElement !== $("book-title")) $("book-title").value = state.book.title;
    renderPages();
    renderStage();
    inspector.renderInspector();
    updateStatus();
  }
  function renderPages() {
    clearTimeout(pagesTimer);
    if (!state.book) return;
    const spreads = syncTurn(), visible = spreads[turn] || [], list = $("page-list");
    const existing = new Map([...list.children].map((node) => [node.dataset.page, node]));
    state.book.pages.forEach((p, i) => {
      const node = existing.get(p.id) || document.createElement("button");
      existing.delete(p.id);
      node.className = "book-thumb";
      node.dataset.page = p.id;
      node.draggable = editable() && p.role === "page";
      node.setAttribute("aria-current", String(p.id === state.active));
      node.dataset.visible = String(visible.includes(p.id));
      node.title = p.title;
      node.setAttribute("aria-label", p.role === "page" ? "Page " + i + ": " + p.title : p.title);
      const options = M.pageRenderOptions(p, state.book.pages, state.book.pageNumbers);
      const assets = p.items.filter((o) => o.assetId).map((o) => renderedAssets[o.assetId]?.src || "");
      const key = JSON.stringify([p, options, assets]);
      if (node.bookPreviewKey !== key) {
        node.innerHTML = `<span class="book-thumb-preview">${M.svg(p, renderedAssets, options)}</span><span${p.role !== "page" ? ' data-user-content' : ''}>${esc(p.role === "page" ? "Page " + i : p.title)}</span>${p.role === "page" && p.title !== "Untitled page" ? `<span class="book-thumb-title">${esc(p.title)}</span>` : ""}`;
        node.bookPreviewKey = key;
      }
      if (list.children[i] !== node) list.insertBefore(node, list.children[i] || null);
    });
    existing.forEach((node) => node.remove());
    if (list.dataset.active !== state.active) {
      list.dataset.active = state.active;
      const thumb = list.querySelector(`[data-page="${state.active}"]`);
      if (thumb && list.clientHeight) {
        const box = thumb.getBoundingClientRect(), bounds = list.getBoundingClientRect();
        if (box.top < bounds.top) list.scrollTop -= bounds.top - box.top;
        else if (box.bottom > bounds.bottom) list.scrollTop += box.bottom - bounds.bottom;
      }
    }
  }
  function schedulePages() {
    clearTimeout(pagesTimer);
    pagesTimer = setTimeout(renderPages, 250);
  }
  const layoutRules = new Map();
  function layoutRule(selector, properties) {
    const sheet = Array.from(document.styleSheets).find(
      (s) => s.href && s.href.includes("book-studio.css"),
    );
    if (!sheet) return;
    const body = Object.entries(properties)
        .map(
          ([key, value]) =>
            key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()) + ":" + value,
        )
        .join(";");
    const previous = layoutRules.get(selector);
    if (previous?.body === body) return;
    if (previous) {
      const at = [...sheet.cssRules].indexOf(previous.rule);
      if (at >= 0) sheet.deleteRule(at);
    }
    const at = sheet.insertRule(selector + "{" + body + "}", sheet.cssRules.length);
    layoutRules.set(selector, { body, rule: sheet.cssRules[at] });
  }
  function removeLayoutRule(selector) {
    const entry = layoutRules.get(selector);
    if (!entry) return;
    const sheet = [...document.styleSheets].find((s) => s.href?.includes("book-studio.css"));
    const at = sheet ? [...sheet.cssRules].indexOf(entry.rule) : -1;
    if (at >= 0) sheet.deleteRule(at);
    layoutRules.delete(selector);
  }
  function fitStage() {
    if (!state.book || !$("book-spread").children.length) return;
    const count = $("book-spread").children.length,
      rect = $("book-viewport").getBoundingClientRect();
    const height =
      Math.max(
        120,
        Math.min(rect.height - 58, ((rect.width - 64) / count / M.W) * M.H),
      ) * state.zoom;
    layoutRule(".book-sheet", {
      width: (height / M.H) * M.W + "px",
      height: height + "px",
    });
    $("zoom-value").textContent = Math.round(state.zoom * 100) + "%";
    $("zoom-in").disabled = state.zoom >= 2.5;
    $("zoom-out").disabled = state.zoom <= 0.4;
    if (state.inlineEdit) {
      const sheet = state.inlineEdit.editor.closest(".book-sheet"), o = item();
      if (sheet && o) positionTextEditor(o, sheet);
    }
    renderSelection();
  }
  function renderStage(direction = 0) {
    if (state.inlineEdit) finishText();
    cancelAnimationFrame(stageFrame);
    stageFrame = 0;
    const spreads = syncTurn(),
      ids = (spreads[turn] || spreads[0]).filter(Boolean);
    $("book-spread").className =
      "book-spread" +
      (ids.length === 2 ? " two-pages" : "") +
      (direction > 0 ? " book-turn" : direction < 0 ? " book-turn-back" : "");
    $("book-spread").innerHTML = ids
      .map((pid) => {
        const p = state.book.pages.find((p) => p.id === pid);
        return `<div class="book-sheet" data-page-id="${p.id}" data-active="${p.id === state.active}" tabindex="0" aria-label="${esc(p.role === "page" ? "Page " + state.book.pages.indexOf(p) + ": " + p.title : p.title)}">${state.rulers && !state.reading ? rulerMarkup() : ""}${M.svg(p, renderedAssets, { ...M.pageRenderOptions(p, state.book.pages, state.book.pageNumbers), guides: state.guides && !state.reading })}${editorGuides(p.id)}</div>`;
      })
      .join("");
    const p = page();
    $("page-position").textContent =
      p.role === "front"
        ? "Front cover"
        : p.role === "back"
          ? "Back cover"
          : ids
              .filter(Boolean)
              .map((id) => state.book.pages.findIndex((p) => p.id === id))
              .join("–") +
            " / " +
            (state.book.pages.length - 2);
    $("first-page").disabled = $("prev-page").disabled = turn === 0;
    $("last-page").disabled = $("next-page").disabled =
      turn === spreads.length - 1;
    document.title = state.book.title + " · Book Studio";
    fitStage();
    renderContentWarnings();
  }
  function renderContentWarnings() {
    const box = $("object-content-warnings"), o = item();
    if (box) box.innerHTML = o ? M.contentOverflow(o).map((warning) => `<p class="book-warning">${esc(warning[0].toUpperCase() + warning.slice(1))}</p>`).join("") : "";
  }
  const isPath = (o) => o && ["line", "arrow"].includes(o.type);
  function furnitureBox(kind = state.furnitureSelection) {
    const options = M.pageRenderOptions(page(), state.book.pages, state.book.pageNumbers);
    return kind === "logo" ? M.logoGeometry(page(), options) : M.numberGeometry(page(), options);
  }
  function placeFurniture(box) {
    const p = page();
    if (state.furnitureSelection === "logo") {
      const old = furnitureBox(), w = M.clamp(box.w, 8, 60), h = w * old.h / old.w;
      p.logoPlacement = { x: M.clamp(box.x, 0, M.W - w), y: M.clamp(box.y, 0, M.H - h), w };
    } else p.numberPlacement = { x: M.clamp(box.x, 0, M.W - box.w), y: M.clamp(box.y, 0, M.H - box.h) };
  }
  function selectFurniture(kind) {
    if (!editable() || !furnitureBox(kind)) return;
    finishText(); state.selected = []; state.furnitureSelection = kind; state.activePathPoint = -1;
    state.inspectorTab = "settings";
    inspector.setInspector(true, innerWidth <= 780);
    renderSelection(); inspector.renderInspector();
  }
  function renderSelection() {
    if (state.furnitureSelection && !furnitureBox()) state.furnitureSelection = "";
    for (const key of layoutRules.keys())
      if (key.startsWith(".book-selection")) removeLayoutRule(key);
    document.querySelectorAll(".book-selection").forEach((el) => el.remove());
    selectionToolbar();
    if (state.reading || !editable()) return;
    const sheet = $("book-spread").querySelector(
      '[data-page-id="' + state.active + '"]',
    );
    if (!sheet) return;
    const scale = sheet.clientWidth / M.W;
    if (state.furnitureSelection) {
      const box = furnitureBox();
      if (box) {
        const el = document.createElement("div");
        el.className = "book-selection book-furniture-selection";
        el.dataset.furniture = state.furnitureSelection;
        layoutRule('.book-selection[data-furniture="' + state.furnitureSelection + '"]', {
          left: box.x * scale + "px", top: box.y * scale + "px",
          width: box.w * scale + "px", height: box.h * scale + "px",
        });
        el.innerHTML = state.furnitureSelection === "logo" ? '<button class="book-handle se" data-furniture="logo" data-logo-resize="true" aria-label="Resize xPED logo"></button>' : "";
        sheet.appendChild(el);
      }
    }
    state.selected.forEach((id) => {
      const o = page().items.find((x) => x.id === id);
      if (!o || o.locked || o.hidden) return;
      const el = document.createElement("div");
      el.className = "book-selection";
      el.dataset.object = id;
      layoutRule('.book-selection[data-object="' + id + '"]', {
        left: o.x * scale + "px",
        top: o.y * scale + "px",
        width: o.w * scale + "px",
        height: o.h * scale + "px",
        transform: "rotate(" + o.rotation + "deg)",
      });
      el.innerHTML = ["nw", "ne", "sw", "se"]
        .map(
          (c) =>
            `<button class="book-handle ${c}" data-handle="${c}" data-object="${id}" aria-label="Resize ${esc(o.name)} from ${c}"></button>`,
        )
        .join("");
      if (isPath(o) && state.selected.length === 1) {
        el.classList.add("book-path-selection");
        P.points(o).forEach((pt, index) => {
          const handle = document.createElement("button");
          handle.className = "book-path-point" + (index === state.activePathPoint ? " active" : "");
          handle.dataset.pathPoint = index;
          handle.dataset.object = o.id;
          handle.setAttribute("aria-label", index === 0 ? "Move line start" : index === P.points(o).length - 1 ? "Move line end" : "Move bend " + index);
          handle.title = "Drag to reshape · Arrow keys to adjust";
          layoutRule(`.book-selection[data-object="${id}"] [data-path-point="${index}"]`, { left: pt[0] * 100 + "%", top: pt[1] * 100 + "%" });
          el.appendChild(handle);
        });
      }
      sheet.appendChild(el);
    });
  }
  function go(offset, absolute) {
    const spreads = syncTurn();
    const next =
      absolute === undefined
        ? M.clamp(turn + offset, 0, spreads.length - 1)
        : absolute;
    if (next === turn) return;
    finishText();
    turn = next;
    const prev = state.active;
    state.active = spreads[turn].find(Boolean);
    state.selected = [];
    state.furnitureSelection = "";
    state.activePathPoint = -1;
    state.selectionRange = null;
    renderStage(offset || (prev === state.active ? 0 : 1));
    renderPages();
    inspector.renderInspector();
  }
  function syncLinkedItems() {
    const o = item();
    if (!o || !o.spanId) return;
    state.book.pages.forEach((p) =>
      p.items.forEach((other) => {
        if (other.spanId === o.spanId && other.id !== o.id) {
          const keep = { id: other.id, spanSide: other.spanSide };
          Object.assign(other, M.clone(o), keep);
        }
      }),
    );
  }
  function keepSpreadsTogether() {
    const result = M.preserveSpreads(state.book.pages);
    if (result.length > 100) {
      const previous = state.undoStack.pop();
      if (previous) {
        const { activePage, ...snapshot } = previous;
        Object.assign(state.book, snapshot);
        state.active = activePage;
      }
      throw new Error(
        "This change needs a blank page to keep the spread together. The book is at its page limit.",
      );
    }
    state.book.pages = result;
  }
  function addObject(type, preset = "body") {
    finishText();
    if (page().items.length >= 300)
      return notify(
        "This page has 300 objects. Add another page to keep creating.",
        true,
      );
    if (!checkpoint()) return;
    const styles =
      type === "text"
        ? {
            style: M.clone(state.book.styles[preset]),
            styleName: preset,
            text:
              preset === "heading"
                ? "A new chapter"
                : preset === "caption"
                  ? "A little detail"
                  : "Your story starts here.",
          }
        : {};
    state.inspectorTab = "settings";
    state.activePathPoint = -1;
    const o = M.object(type, {
      ...styles,
      fill: state.book.palette[1],
      stroke: state.book.palette[0],
    });
    const baseName =
      type === "text"
        ? { heading: "Heading", body: "Body text", caption: "Caption" }[preset]
        : o.name;
    let count = 1;
    o.name = baseName;
    while (page().items.some((x) => x.name === o.name))
      o.name = baseName + " " + ++count;
    if (type === "table") {
      o.h = 55;
      o.strokeWidth = 0.2;
      o.style = { ...state.book.styles.body, size: 13, color: state.book.palette[3] };
      o.cells = [
        ["Character", "Favorite thing"],
        ["Little fox", "Moonlight"],
        ["Owl", "Stories"],
      ];
    }
    if (type === "flow") {
      o.w = 88;
      o.h = 100;
      o.x = (M.W - o.w) / 2;
      o.style = { ...state.book.styles.body, size: 15, color: state.book.palette[3] };
      o.steps = ["An idea", "A little adventure", "A happy ending"];
    }
    if (["line", "arrow"].includes(type)) {
      o.w = 65;
      o.h = 35;
      o.x = 40;
      o.y = 80;
    }
    if (type === "shape") {
      o.w = 42;
      o.h = 42;
      o.x = 53;
      o.y = 74;
    }
    if (type === "image") return;
    M.styleObjectForBook(o, state.book, page());
    if (state.book.theme?.id === "xped" && type === "table")
      o.cells = [["Topic", "Notes"], ["An idea", "What matters to you"], ["Next step", "Something to explore"]];
    if (state.book.theme?.id === "xped" && type === "flow")
      o.steps = ["Start here", "Explore an idea", "Choose a next step"];
    page().items.push(o);
    state.furnitureSelection = "";
    state.selected = [o.id];
    state.tool = "select";
    changed();
    inspector.setInspector(true, window.innerWidth <= 780);
  }
  function addPage() {
    if (state.book.pages.length >= 100) {
      notify("This book has reached 100 pages.", true);
      return;
    }
    if (!checkpoint()) return;
    const index = Math.min(
      state.book.pages.length - 1,
      Math.max(1, state.book.pages.indexOf(page()) + 1),
    );
    const p = M.pageForBook(state.book);
    if (state.book.theme?.id !== "xped") p.background = page().background;
    p.texture = page().texture;
    state.book.pages.splice(index, 0, p);
    keepSpreadsTogether();
    state.active = p.id;
    state.selected = [];
    state.furnitureSelection = "";
    state.activePathPoint = -1;
    changed();
  }
  function deletePage() {
    const p = page();
    if (p.role !== "page") {
      notify(
        "Keep the cover and back cover. You can clear their objects instead.",
      );
      return;
    }
    if (state.book.pages.length <= 4) {
      notify("Keep at least two inside pages in your book.");
      return;
    }
    const i = state.book.pages.indexOf(p);
    if (p.items.some((o) => o.spanId)) {
      notify("Split the spread illustration before deleting this page.");
      return;
    }
    if (!checkpoint()) return;
    state.book.deletedPages.push(p);
    state.book.pages.splice(i, 1);
    keepSpreadsTogether();
    state.active = state.book.pages[Math.min(i, state.book.pages.length - 1)].id;
    state.selected = [];
    state.furnitureSelection = "";
    state.activePathPoint = -1;
    changed();
  }
  function copyPage(p) {
    const next = M.clone(p);
    next.id = M.id();
    next.role = "page";
    next.title = p.title + " copy";
    const groups = {};
    next.items.forEach((o) => {
      o.id = M.id();
      if (o.group) o.group = groups[o.group] || (groups[o.group] = M.id());
    });
    return next;
  }
  function duplicatePages(spread) {
    const sources = spread
      ? currentSpreads()
          [turn].filter(Boolean)
          .map((id) => state.book.pages.find((p) => p.id === id))
      : [page()];
    if (!spread && page().items.some((o) => o.spanId)) {
      notify("Use Duplicate spread to keep this illustration together.");
      return;
    }
    if (state.book.pages.length + sources.length > 100) {
      notify("This book has reached its page limit.");
      return;
    }
    if (!checkpoint()) return;
    const copies = sources.map(copyPage),
      spanMap = {};
    copies.forEach((p) =>
      p.items.forEach((o) => {
        if (o.spanId)
          o.spanId = spanMap[o.spanId] || (spanMap[o.spanId] = M.id());
      }),
    );
    state.book.pages.splice(
      Math.min(
        state.book.pages.length - 1,
        state.book.pages.indexOf(sources[sources.length - 1]) + 1,
      ),
      0,
      ...copies,
    );
    keepSpreadsTogether();
    state.active = copies[0].id;
    state.selected = [];
    state.furnitureSelection = "";
    state.activePathPoint = -1;
    changed();
  }
  function duplicateObject() {
    finishText();
    if (!selectedItems().length) return;
    if (page().items.length + selectedItems().length > 300)
      return notify("This page is full. Paste onto another page.", true);
    if (!checkpoint()) return;
    const groups = new Map();
    const copies = page()
      .items.filter((o) => state.selected.includes(o.id) && !o.locked)
      .map((o) => ({
        ...M.clone(o),
        id: M.id(),
        x: Math.min(M.W - o.w, o.x + 4),
        y: Math.min(M.H - o.h, o.y + 4),
        spanId: "",
        spanSide: "",
        group: o.group
          ? groups.get(o.group) ||
            (groups.set(o.group, M.id()), groups.get(o.group))
          : "",
      }));
    page().items.push(...copies);
    state.selected = copies.map((o) => o.id);
    changed();
  }
  function deleteObjects() {
    finishText();
    if (!selectedItems().length || !checkpoint()) return;
    const removable = selectedItems().map((o) => o.id);
    const spanIds = page()
      .items.filter((o) => removable.includes(o.id))
      .map((o) => o.spanId)
      .filter(Boolean);
    state.book.pages.forEach((p) => {
      p.items = p.items.filter(
        (o) => !removable.includes(o.id) && !spanIds.includes(o.spanId),
      );
    });
    state.selected = [];
    state.furnitureSelection = "";
    state.activePathPoint = -1;
    changed();
  }
  function undo(redo = false) {
    finishText();
    state.editBatch = null;
    if (!editable()) return;
    const from = redo ? state.redoStack : state.undoStack,
      to = redo ? state.undoStack : state.redoStack;
    if (!from.length) return;
    to.push(
      M.clone({
        pages: state.book.pages,
        deletedPages: state.book.deletedPages,
        ...metadata(),
        activePage: state.active,
      }),
    );
    const { activePage, ...snapshot } = from.pop();
    Object.assign(state.book, snapshot);
    state.active = state.book.pages.some((p) => p.id === activePage)
      ? activePage
      : state.book.pages[0].id;
    state.selected = [];
    state.furnitureSelection = "";
    state.activePathPoint = -1;
    changed();
  }
  function sizeImage(preset) {
    const o = item(),
      a = state.book.assets.find((a) => a.id === o.assetId);
    if (!o || !a || !checkpoint()) return;
    Object.assign(o, M.imageSize(a.width, a.height, preset));
    o.x = M.clamp(o.x, 0, M.W - o.w);
    o.y = M.clamp(o.y, 0, M.H - o.h);
    changed();
  }
  function spanImage() {
    const o = item();
    if (!o || !checkpoint()) return;
    if (o.spanId) {
      const span = o.spanId;
      state.book.pages.forEach((p) => {
        p.items = p.items.filter((x) => x.spanId !== span || x.id === o.id);
      });
      o.spanId = "";
      o.spanSide = "";
      changed();
      return;
    }
    const ids = M.spreads(state.book.pages).find((s) => s.includes(state.active));
    if (!ids || ids.length !== 2 || !ids.every(Boolean)) {
      notify("Choose two facing inside pages first.");
      return;
    }
    const span = M.id(),
      left = state.book.pages.find((p) => p.id === ids[0]),
      right = state.book.pages.find((p) => p.id === ids[1]);
    page().items = page().items.filter((x) => x.id !== o.id);
    const h = Math.min(M.H, o.h),
      y = M.clamp(o.y, 0, M.H - h);
    left.items.push({
      ...M.clone(o),
      id: M.id(),
      spanId: span,
      spanSide: "left",
      x: 0,
      y,
      w: M.W,
      h,
      fit: "cover",
    });
    right.items.push({
      ...M.clone(o),
      id: M.id(),
      spanId: span,
      spanSide: "right",
      x: 0,
      y,
      w: M.W,
      h,
      fit: "cover",
    });
    state.selected = [];
    state.furnitureSelection = "";
    state.activePathPoint = -1;
    changed();
  }
  function sharingLinks(links) {
    return (
      links
        .filter(
          (l) =>
            !l.revoked && (!l.expires_at || l.expires_at > Date.now() / 1000),
        )
        .map(
          (l) =>
            `<p>${l.role === "edit" ? "Edit" : "View"} link · ${l.require_signin ? "Sign-in required" : "Guests welcome"} <button class="ghost-btn" data-revoke="${esc(l.id)}">Turn off</button></p>`,
        )
        .join("") || '<p class="book-muted">No active links.</p>'
    );
  }
  async function shareDialog() {
    if (state.book.local && state.user && !state.book.id.startsWith("local-recovery-")) await io.ensureCloudBook();
    if (state.book.local) {
      dialog(
        "Save your book to share it",
        state.user
          ? '<p class="book-muted">Your draft is safe on this device. Finish saving it to your account to share it.</p><button class="primary-btn" data-command="retry-cloud-save">Retry cloud save</button>'
          : '<p class="book-muted">Sign in to save your book and invite people.</p><button class="primary-btn" id="publish-book">Sign in to share</button>',
      );
      return;
    }
    if (state.book.role !== "owner") {
      notify("Only the owner can change sharing.");
      return;
    }
    await persist();
    const settings = await api("/api/books/" + state.book.id + "/sharing");
    dialog(
      "Share your book",
      `<p class="book-muted">Your book is private until you invite someone or create a link. Only one person edits at a time.</p><h3>Invite by email</h3><div class="book-row">${field("Email address", "inviteEmail", "", "email")}${selectField(
        "Access",
        "inviteRole",
        "edit",
        [
          ["view", "View & comment"],
          ["edit", "Edit"],
        ],
      )}</div><button class="secondary-btn" id="invite-member">Add person</button><div id="members">${Object.entries(
        settings.members,
      )
        .map(
          ([email, role]) =>
            `<p>${esc(email)} · ${role === "edit" ? "Edit" : "View"} <button class="ghost-btn" data-remove-member="${esc(email)}">Remove</button></p>`,
        )
        .join(
          "",
        )}</div><h3>Sharing link</h3><div class="book-row">${selectField(
        "Access",
        "linkRole",
        "view",
        [
          ["view", "View & comment"],
          ["edit", "Edit"],
        ],
      )}${selectField("Expires", "linkDays", 7, [
        [7, "In 7 days"],
        [30, "In 30 days"],
        [0, "No expiry"],
      ])}</div>${toggle("Require sign-in", "linkSignin", false)}<button class="primary-btn" id="create-link">Create link</button><div id="share-result"></div><h3>Existing links</h3><div id="existing-links">${sharingLinks(settings.links)}</div>`,
    );
    $("dialog-content")._members = settings.members;
  }
  async function invite(remove) {
    const members = { ...$("dialog-content")._members };
    if (remove) delete members[remove];
    else {
      const email = $("dialog-content")
        .querySelector("[data-field=inviteEmail]")
        .value.trim()
        .toLowerCase();
      members[email] = $("dialog-content").querySelector(
        "[data-field=inviteRole]",
      ).value;
    }
    await api("/api/books/" + state.book.id + "/sharing", {
      method: "POST",
      body: JSON.stringify({ members }),
    });
    state.leaseToken = "";
    await reloadRemote();
    await shareDialog();
    notify(
      remove
        ? "Access removed."
        : "Access added. Share the book address with them.",
    );
  }
  async function createLink() {
    const role = $("dialog-content").querySelector(
        "[data-field=linkRole]",
      ).value,
      days = +$("dialog-content").querySelector("[data-field=linkDays]").value,
      require_signin = $("dialog-content").querySelector(
        "[data-field=linkSignin]",
      ).checked;
    const result = await api("/api/books/" + state.book.id + "/sharing", {
      method: "POST",
      body: JSON.stringify({ role, days, require_signin }),
    });
    $("share-result").innerHTML =
      `<label class="book-field"><span>Share this link</span><input id="share-url" readonly value="${esc(result.url)}"></label><button class="secondary-btn" id="copy-link">Copy link</button>`;
    const settings = await api("/api/books/" + state.book.id + "/sharing");
    $("existing-links").innerHTML = sharingLinks(settings.links);
  }
  async function reloadRemote() {
    if (!state.book || state.book.local) return;
    const current = state.book, generation = state.accountGeneration;
    const result = await api("/api/books/" + state.book.id + "?since=" + state.book.revision),
      remote = result.book;
    if (state.book !== current) return;
    const pagesById = new Map(
      state.book.pages.concat(state.book.deletedPages || [], result.pages).map((p) => [p.id, p]),
    );
    Object.assign(state.book, remote, {
      pages: remote.page_ids.map((id) => pagesById.get(id)).filter(Boolean),
      deletedPages: (remote.deleted_page_ids || [])
        .map((id) => pagesById.get(id))
        .filter(Boolean),
      assets: result.assets,
      local: false,
    });
    $("book-title").value = state.book.title;
    state.savedPages = Object.fromEntries(
      state.book.pages.concat(state.book.deletedPages).map((p) => [p.id, JSON.stringify(p)]),
    );
    if (!state.book.pages.some((p) => p.id === state.active)) state.active = state.book.pages[0].id;
    await loadAssets();
    assertAccount(generation);
    if (state.book !== current) return;
    await D.putBook(state.book);
    assertAccount(generation);
    renderAll();
  }
  function detailsDialog() {
    dialog(
      "Book details",
      field("Title", "detailsTitle", state.book.title) +
        field("Folder", "detailsFolder", state.book.folder) +
        field(
          "Tags · separate with commas",
          "detailsTags",
          (state.book.tags || []).join(", "),
        ) +
        toggle("Favorite", "detailsFavorite", state.book.favorite) +
        '<div class="book-row"><button class="primary-btn" id="save-details">Save details</button><button class="secondary-btn" id="copy-book">Make a copy</button></div>' +
        (state.book.local && (!state.user || state.book.id.startsWith("local-recovery-"))
          ? '<button class="secondary-btn" id="publish-book">Save to my account</button>'
          : ""),
    );
  }
  async function copyBook(source = state.book) {
    const generation = state.accountGeneration, uid = state.user?.uid;
    await localSaves.flush();
    assertAccount(generation);
    if (!source.local) {
      for (const a of source.assets) {
        if (a.ready) {
          const blob = await api(
            "/api/books/" + source.id + "/assets/" + a.id + "?original=1",
            {},
            true,
          );
          await D.putAsset({ ...a, blob });
          assertAccount(generation);
        }
      }
    }
    const next = M.clone(source);
    if (!source.local)
      next.versions = (
        await api("/api/books/" + source.id + "/history?include_pages=1")
      ).versions;
    next.id = "local-" + M.id();
    next.local = true;
    next.role = "owner";
    next.revision = 0;
    next.pending = false;
    next.deleted = false;
    next.title += " (copy)";
    next.updated_at = Date.now() / 1000;
    delete next.cloudAccountUid;
    delete next.cloudSaveError;
    delete next.owner_uid;
    delete next.cacheAccountUid;
    scopeDraft(next, uid);
    next.assets = next.assets.map((a) => ({ ...a, local: true }));
    await D.putBook(next);
    assertAccount(generation);
    closeDialog();
    if (state.book && !state.book.local && state.leaseToken) await release();
    await openBook(next.id);
    notify(state.user ? "Your new copy is saving to your account." : "A new copy is ready on this device.");
  }
  function illustrationDialog() {
    const p = page(),
      o = item();
    dialog(
      "Illustration prompt",
      `<p class="book-muted">Turn a sketch into artwork that feels at home in your book. Attach your sketch and character references in ChatGPT.</p>${field("Drawing style", "illustrationStyle", state.book.illustration.style)}<label class="book-field"><span>Characters and details to keep</span><textarea id="character-details">${esc(state.book.illustration.characters)}</textarea></label>${field("Leave space for text", "illustrationSpace", state.book.illustration.space)}${toggle("Blend into page", "illustrationBlend", state.book.illustration.blend)}${toggle("Transparent background", "illustrationTransparent", state.book.illustration.transparent)}<label class="book-field"><span>Your prompt</span><textarea id="illustration-prompt" rows="7">${esc(M.prompt(state.book, p, o))}</textarea></label><div class="book-row"><button class="primary-btn" id="copy-prompt">Copy prompt</button><a class="secondary-btn" href="${esc(document.body.dataset.chatgptUrl || "https://chatgpt.com/")}" target="_blank" rel="noopener noreferrer">Open ChatGPT</a></div>${o && o.type === "image" ? '<button class="secondary-btn" id="download-reference">Download sketch/reference</button>' : ""}<p class="book-muted">In ChatGPT, choose image creation, attach your sketch and paste the prompt. Download the result, then drag it onto your book or use Replace.</p>`,
    );
  }
  function updatePrompt() {
    if (!editable()) return;
    const get = (name) =>
      $("dialog-content").querySelector("[data-field=" + name + "]");
    state.book.illustration = {
      style: get("illustrationStyle").value,
      characters: $("character-details").value,
      space: get("illustrationSpace").value,
      blend: get("illustrationBlend").checked,
      transparent: get("illustrationTransparent").checked,
    };
    $("illustration-prompt").value = M.prompt(state.book, page(), item());
    changed(false);
  }
  async function original(reference = false) {
    const o = item(),
      id = reference ? o.originalAssetId || o.assetId : o.assetId;
    const a = state.book.assets.find((a) => a.id === id);
    if (!a) throw new Error("This original is unavailable.");
    const stored = await D.getAsset(id),
      blob = state.book.local
        ? stored && stored.blob
        : await api(
            "/api/books/" + state.book.id + "/assets/" + id + "?original=1",
            {},
            true,
          );
    if (blob) io.download(blob, a.name);
  }
  async function assetsDialog() {
    await loadAssets();
    dialog(
      "Your illustrations",
      `<p class="book-muted">Keep characters and sketches close by. Choose an image to add it to the current page.</p><div class="book-search-row"><input type="search" id="asset-search" aria-label="Search illustrations" placeholder="Find an illustration…"><button class="secondary-btn" id="asset-upload">＋ Add images</button></div><p id="asset-no-results" class="book-muted" ${state.book.assets.length ? "hidden" : ""}>No illustrations yet. Add sketches or pictures to reuse them on any page.</p><div class="book-asset-grid">${state.book.assets.map((a) => `<div class="book-asset-card" data-search="${esc(a.name.toLowerCase())}">${renderedAssets[a.id] ? `<img src="${esc(renderedAssets[a.id].src)}" alt="${esc(a.name)}">` : ""}<p>${esc(a.name)}</p><button class="secondary-btn" data-use-asset="${a.id}">Add to page</button><button class="ghost-btn" data-remove-asset="${a.id}">Remove unused</button></div>`).join("")}</div>`,
    );
  }
  async function historyDialog() {
    cachedVersions = state.book.versions || [];
    if (!state.book.local)
      cachedVersions = (await api("/api/books/" + state.book.id + "/history")).versions;
    cachedVersions = cachedVersions
      .slice()
      .sort((a, z) => (z.created_at || 0) - (a.created_at || 0));
    dialog(
      "Version history",
      `<p class="book-muted">Save a milestone before trying a new idea. Preview a version before restoring it. Restoring can be undone.</p><div class="book-version-save">${field("Version name", "versionName", "", "text", 'placeholder="For example: First illustrated draft" maxlength="100"')}<button class="primary-btn" id="save-version" ${!editable() ? "disabled" : ""}>Save version</button></div><h3>Saved versions</h3><div class="book-version-list">${cachedVersions.map((v) => `<article class="book-version"><div>${icon("history")}<div><strong>${esc(v.name)}</strong><p>${v.created_at ? new Date(v.created_at * 1000).toLocaleString((window.LectureI18n ? window.LectureI18n.locale() : 'en-GB')) : "Earlier version"} · ${(v.pages || v.page_ids || []).length} pages</p></div></div><button class="secondary-btn" data-preview-version="${v.id}">Preview</button></article>`).join("") || '<p class="book-muted">Your saved milestones will appear here. Your current work also saves automatically.</p>'}</div><details><summary>Deleted pages · ${(state.book.deletedPages || []).length}</summary>${(state.book.deletedPages || []).map((p) => `<div class="book-version"><strong>${esc(p.title)}</strong><button class="secondary-btn" data-restore-page="${p.id}" ${!editable() ? "disabled" : ""}>Restore page</button></div>`).join("") || '<p class="book-muted">No deleted pages.</p>'}</details><button class="secondary-btn" id="recover-copy">Save recovery copy on this device</button>`,
    );
  }
  async function previewVersion(id) {
    let version = cachedVersions.find((v) => v.id === id);
    if (!version?.pages) {
      cachedVersions = (
        await api("/api/books/" + state.book.id + "/history?include_pages=1")
      ).versions;
      version = cachedVersions.find((v) => v.id === id);
    }
    if (!version)
      throw new Error(
        "This version is no longer available. Reopen version history.",
      );
    dialog(
      version.name,
      `<p class="book-muted">${version.created_at ? new Date(version.created_at * 1000).toLocaleString((window.LectureI18n ? window.LectureI18n.locale() : 'en-GB')) : "Saved version"} · ${version.pages.length} pages</p><div class="book-version-preview">${version.pages.map((p, i) => `<figure>${M.svg(p, renderedAssets, M.pageRenderOptions(p, version.pages, version.metadata?.pageNumbers))}<figcaption>${esc(p.role === "page" ? "Page " + i : p.title)}</figcaption></figure>`).join("")}</div><p>Restore these pages and book styles? You can undo this after restoring.</p><div class="book-row"><button class="secondary-btn" id="history">Back to versions</button><button class="primary-btn" data-confirm-version="${id}" ${!editable() ? "disabled" : ""}>Restore this version</button></div>`,
    );
  }
  async function saveVersion() {
    if (!editable()) return;
    const name =
      $("dialog-content").querySelector("[data-field=versionName]").value ||
      "Saved version";
    if (state.book.local) {
      if (state.book.versions.length >= 20)
        throw new Error("You can keep up to 20 versions per book.");
      state.book.versions.push({
        id: M.id(),
        name,
        created_at: Date.now() / 1000,
        pages: M.clone(state.book.pages),
        deletedPages: M.clone(state.book.deletedPages),
        metadata: M.clone(metadata()),
      });
      changed(false);
      await D.putBook(state.book);
    } else {
      await persist();
      await api("/api/books/" + state.book.id + "/history", {
        method: "POST",
        body: JSON.stringify({
          name,
          lease_token: state.leaseToken,
          base_revision: state.book.revision,
        }),
      });
    }
    await historyDialog();
  }
  async function restoreVersion(id) {
    if (!checkpoint()) return;
    let version;
    if (state.book.local) version = state.book.versions.find((v) => v.id === id);
    else {
      version = await api("/api/books/" + state.book.id + "/history", {
        method: "POST",
        body: JSON.stringify({
          restore: id,
          lease_token: state.leaseToken,
          base_revision: state.book.revision,
        }),
      });
      version = {
        ...version,
        pages: version.page_ids.map((pid) =>
          version.pages.find((p) => p.id === pid),
        ),
        deletedPages: (version.deleted_page_ids || []).map((pid) =>
          version.pages.find((p) => p.id === pid),
        ),
      };
    }
    Object.assign(state.book, version.metadata, {
      theme: version.metadata?.theme || null,
      pageNumbers: M.pageNumberOptions(version.metadata?.pageNumbers),
      pages: M.clone(version.pages),
      deletedPages: M.clone(version.deletedPages || []),
    });
    state.active = state.book.pages[0].id;
    state.selected = [];
    state.furnitureSelection = "";
    state.activePathPoint = -1;
    changed();
    closeDialog();
  }
  async function commentsDialog() {
    if (state.book.local && state.user && !state.book.id.startsWith("local-recovery-")) await io.ensureCloudBook();
    if (state.book.local) {
      dialog(
        "Comments",
        state.user
          ? '<p class="book-muted">Your draft is safe on this device. Finish saving it to your account to invite comments.</p><button class="primary-btn" data-command="retry-cloud-save">Retry cloud save</button>'
          : '<p class="book-muted">Sign in to save your book and invite comments.</p><button class="primary-btn" id="publish-book">Sign in for comments</button>',
      );
      return;
    }
    const result = await api("/api/books/" + state.book.id + "/comments");
    dialog(
      "Comments",
      `<p class="book-muted">Leave a note on ${esc(page().title)}${item() ? " · " + esc(item().name) : ""}.</p><label class="book-field"><span>Your comment</span><textarea id="comment-text" maxlength="2000"></textarea></label><button class="primary-btn" id="add-comment">Add comment</button><div class="book-comments">${
        result.comments
          .filter((c) => !c.resolved)
          .map(
            (c) =>
              `<article><strong>${esc(c.author)}</strong><small> · ${esc((state.book.pages.find((p) => p.id === c.page_id) || {}).title || "Deleted page")}</small><p>${esc(c.text)}</p><button class="ghost-btn" data-comment-page="${esc(c.page_id)}">Go to page</button><button class="ghost-btn" data-resolve-comment="${c.id}">Resolve</button></article>`,
          )
          .join("") || '<p class="book-muted">No comments yet.</p>'
      }</div>`,
    );
  }
  async function bookOptions(id) {
    const source =
      localBooks.find((x) => x.id === id) ||
      cloudBooks.find((x) => x.id === id);
    dialog(
      source.title,
      `<div class="book-button-stack"><button class="primary-btn" data-open="${id}">Open book</button>${source.role === "owner" || source.local ? `<button class="secondary-btn" data-library-favorite="${id}">${source.favorite ? "Remove favorite" : "Add to favorites"}</button><button class="secondary-btn" data-library-delete="${id}">${source.deleted ? "Restore book" : "Move to trash"}</button>` : ""}</div>`,
      true,
    );
  }
  async function libraryChange(id, key) {
    const local = localBooks.find((x) => x.id === id),
      source =
        local && local.local ? local : cloudBooks.find((x) => x.id === id);
    const value = !source[key];
    if (source.local) {
      source[key] = value;
      await D.putBook(source);
    } else
      await api("/api/books/" + id, {
        method: "PATCH",
        body: JSON.stringify({ [key]: value }),
      });
    closeDialog();
    await loadLibrary();
  }
  function showStartupError(error) {
    startupError = error;
    state.startupState = "error";
    document.body.dataset.ready = "error";
    $("book-loading").hidden = true;
    $("workspace").hidden = true;
    $("library").hidden = false;
    $("title-wrap").hidden = true;
    $("editor-status").textContent = "";
    ["edit-turn", "finish-turn", "reading", "share", "export"].forEach((id) => { $(id).hidden = true; });
    document.querySelector(".book-library-heading").hidden = true;
    document.querySelector(".book-library-tools").hidden = true;
    $("book-grid").innerHTML =
      '<div class="book-empty" role="alert"><h2>' +
      (error.code === "storage-blocked" ? "Another Book Studio tab needs to close" : document.body.dataset.bookId && error.code !== "storage-unavailable" ? "This book is not available" : "Your books couldn’t open") +
      '</h2><p>' + esc(error.message || "Please try again. Your saved drafts have not been changed.") +
      '</p><div class="book-row"><button id="retry-book-startup" class="primary-btn">Try again</button><button id="reload-book-startup" class="secondary-btn">Reload this tab</button></div><a class="book-text-link" href="/books">Back to your bookshelf</a></div>';
  }
  async function initializeStudio() {
    if (startupTask) return startupTask;
    const generation = state.accountGeneration;
    state.startupState = "loading";
    startupError = null;
    document.body.dataset.ready = "false";
    $("book-loading").hidden = false;
    $("library").hidden = true;
    document.querySelector(".book-library-heading").hidden = false;
    document.querySelector(".book-library-tools").hidden = false;
    startupTask = (async () => {
      try {
        await boot();
        if (generation !== state.accountGeneration) return;
        state.startupState = "ready";
        document.body.dataset.ready = "true";
        $("library").hidden = !!state.book;
      } catch (error) {
        if (generation === state.accountGeneration) showStartupError(error);
      } finally {
        $("book-loading").hidden = true;
        startupTask = null;
      }
    })();
    return startupTask;
  }
  async function boot() {
    await new Promise((resolve) => setTimeout(resolve, 80));
    state.user = auth.currentUser;
    $("sign-in").hidden = !!state.user;
    $("account-name").hidden = !state.user;
    $("account-name").textContent = state.user ? state.user.displayName || state.user.email : "";
    const share = document.body.dataset.shareToken;
    let id = document.body.dataset.bookId;
    if (share) {
      dialog(
        "Open a shared book",
        field("Your name", "guestName", state.user ? state.user.displayName || "" : "") +
          '<p class="book-muted">Your name appears with comments and while you edit.</p><button class="primary-btn" id="open-shared">Open book</button>',
      );
      $("open-shared").onclick = action(async () => {
        const name = $("dialog-content").querySelector(
          "[data-field=guestName]",
        ).value;
        const result = await api("/api/books/share-session", {
          method: "POST",
          body: JSON.stringify({ token: share, name }),
        });
        sessionStorage.setItem(
          "book-access-" + result.book_id,
          result.access_token,
        );
        closeDialog();
        await openBook(result.book_id);
      });
    } else if (id) {
      try {
        await openBook(id);
      } catch (e) {
        state.book = null;
        throw e;
      }
    } else await loadLibrary();
  }

  const editor = {
    auth, instance, storageScope, accountChangedError, assertAccount, scopeDraft, api,
    localSaves, queueLocalSave, acquire, release, reloadRemote, persist, initializeStudio,

    page, item, editable, selectedItems, furnitureBox, isPath, currentSpreads,
    canMovePage,

    action, notify, status, updateStatus, dialog, closeDialog, decorateTools, renderAll,
    renderLibrary, renderPages, renderStage, renderSelection, renderContentWarnings,
    selectionToolbar, schedulePages, fitStage, layoutRule, feedback, saveView,

    checkpoint, editCheckpoint, changed, undo, clearSelection, startText, finishText,
    addObject, duplicateObject, deleteObjects, addPage, duplicatePages, deletePage,
    movePage, go, placeFurniture, selectFurniture, syncLinkedItems, keepSpreadsTogether,
    resizeTable, sizeImage, spanImage,

    newBookDialog, create, openBook, copyBook, bookOptions, libraryChange, detailsDialog,
    themeDialog, applyTheme, shortcutsDialog,

    renderedAssets, fontCache, illustrationDialog, updatePrompt, original, assetsDialog,
    shareDialog, invite, createLink, commentsDialog, historyDialog, previewVersion,
    saveVersion, restoreVersion,
  };
  const inspector = createBookInspector(state, editor);
  const pointerTools = createBookPointerTools(state, editor, inspector);
  const io = createBookIO(state, editor);
  bindBookEvents(state, editor, inspector, pointerTools, io);

  let initialized = false;
  auth.onAuthStateChanged(
    action(async (next) => {
      const previousUid = state.user?.uid;
      if (initialized && previousUid !== next?.uid) {
        const generation = ++state.accountGeneration;
        const anonymousDraft = state.book?.local && !D.accountUid(state.book) && !previousUid;
        if (!anonymousDraft) {
          const promotion = state.cloudPromotion;
          const retiring = retirePrivateBook();
          state.user = next;
          for (const key of Object.keys(sessionStorage)) {
            if (key.startsWith("book-lease-") || key.startsWith("book-access-")) sessionStorage.removeItem(key);
          }
          await retiring;
          if (promotion) await promotion.catch(() => {});
          assertAccount(generation);
          startupError = null;
          state.startupState = "ready";
          document.body.dataset.bookId = "";
          document.body.dataset.shareToken = "";
          document.body.dataset.ready = "true";
          history.replaceState({}, "", "/books");
          $("library").hidden = false;
          $("book-loading").hidden = true;
          document.querySelector(".book-library-heading").hidden = false;
          document.querySelector(".book-library-tools").hidden = false;
        }
      }
      state.user = next;
      $("sign-in").hidden = !!next;
      $("account-name").hidden = !next;
      $("account-name").textContent = next
        ? next.displayName || next.email
        : "";
      if (!initialized) {
        initialized = true;
        await initializeStudio();
      } else if (state.startupState === "error") await initializeStudio();
      else if (!state.book) await loadLibrary();
      else if (state.book.local && next) await io.ensureCloudBook();
    }),
  );
}

startBookStudio();
