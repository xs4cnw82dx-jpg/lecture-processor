import { M, P, D, $, esc, icon } from "./book-studio-ui.js";

export function bindBookEvents(state, editor, inspector, pointerTools, io) {
  document.addEventListener(
    "click",
    editor.action(async (event) => {
      const target = event.target.closest("button,a");
      if (!target) return;
      const ds = target.dataset,
        id = ds.command || target.id;
      if (state.book && target.tagName === "A" && !target.hasAttribute("download") && target.target !== "_blank" && target.origin === window.location.origin) {
        event.preventDefault();
        await editor.persist();
        await editor.localSaves.flush();
        window.location.assign(target.href);
        return;
      }
      if (ds.template) return editor.create(ds.template);
      if (ds.open) {
        editor.closeDialog();
        return editor.openBook(ds.open);
      }
      if (ds.bookOptions) return editor.bookOptions(ds.bookOptions);
      if (ds.libraryFavorite)
        return editor.libraryChange(ds.libraryFavorite, "favorite");
      if (ds.libraryDelete) return editor.libraryChange(ds.libraryDelete, "deleted");
      if (ds.collection) {
        state.collection = ds.collection;
        document
          .querySelectorAll("[data-collection]")
          .forEach((el) =>
            el.setAttribute("aria-selected", String(el === target)),
          );
        return editor.renderLibrary();
      }
      if (ds.new !== undefined || id === "new-book") return editor.newBookDialog();
      if (id === "sign-in") return io.signIn();
      if (id === "retry-book-startup") return editor.initializeStudio();
      if (id === "reload-book-startup") return window.location.reload();
      if (id === "retry-cloud-save") return io.retryCloudSave();
      if (id === "import-backup") return $("backup-input").click();
      if (!state.book) return;
      if (ds.selectFurniture) return editor.selectFurniture(ds.selectFurniture);
      if (ds.numberPosition && editor.checkpoint()) {
        state.book.pageNumbers = M.pageNumberOptions({ ...state.book.pageNumbers, enabled: true, position: ds.numberPosition });
        state.book.pages.forEach((p) => delete p.numberPlacement);
        editor.changed();
        return;
      }
      if (id === "page-numbers") return inspector.showPageNumbers();
      if (id === "furniture-settings") { inspector.setInspector(true, innerWidth <= 780); inspector.renderInspector(); return; }
      if (id === "reset-furniture" && editor.checkpoint()) {
        delete editor.page()[state.furnitureSelection === "logo" ? "logoPlacement" : "numberPlacement"];
        editor.changed(); return;
      }
      if (id === "add-path-bend") return pointerTools.addPathBend();
      if (id === "remove-path-bend") return pointerTools.removePathBend();
      if (id === "straighten-path" && editor.isPath(editor.item()) && editor.checkpoint()) {
        const pts = P.points(editor.item()); editor.item().pathPoints = [pts[0], pts[pts.length - 1]];
        state.activePathPoint = -1; editor.changed(); return;
      }
      if (ds.panel) {
        state.inspectorTab = ds.panel;
        inspector.renderInspector();
        return;
      }
      if (ds.page) {
        editor.finishText();
        state.active = ds.page;
        state.selected = [];
        state.furnitureSelection = "";
        state.activePathPoint = -1;
        editor.renderAll();
        return;
      }
      if (ds.add) return editor.addObject(ds.add);
      if (ds.textPreset) {
        editor.addObject("text", ds.textPreset);
        editor.closeDialog();
        return;
      }
      if (ds.theme !== undefined) {
        state.themeChoice = ds.theme === "xped" ? "xped" : +ds.theme;
        editor.themeDialog();
        if (state.themeChoice === 'xped') $("dialog-content").querySelector('.book-xped-options').scrollIntoView({ block: 'start' });
        return;
      }
      if (ds.xpedVariant || ds.xpedMode) {
        const scroll = $("book-dialog").scrollTop;
        if (ds.xpedVariant) state.xpedVariant = ds.xpedVariant;
        if (ds.xpedMode) state.xpedMode = ds.xpedMode;
        editor.themeDialog();
        $("book-dialog").scrollTop = scroll;
        $("dialog-content").querySelector(ds.xpedVariant ? `[data-xped-variant="${state.xpedVariant}"]` : `[data-xped-mode="${state.xpedMode}"]`).focus({ preventScroll: true });
        return;
      }
      if (ds.tableAxis) return editor.resizeTable(ds.tableAxis, +ds.delta);
      if (ds.stepMove !== undefined && editor.checkpoint()) {
        const i = +ds.stepMove;
        [editor.item().steps[i - 1], editor.item().steps[i]] = [
          editor.item().steps[i],
          editor.item().steps[i - 1],
        ];
        editor.changed();
        return;
      }
      if (ds.stepRemove !== undefined && editor.checkpoint()) {
        editor.item().steps.splice(+ds.stepRemove, 1);
        editor.changed();
        return;
      }
      if (ds.distribute && editor.selectedItems().length >= 3 && editor.checkpoint()) {
        M.distribute(editor.selectedItems(), ds.distribute);
        editor.changed();
        return;
      }
      if (
        ds.palette !== undefined &&
        editor.item() &&
        !editor.item().locked &&
        editor.checkpoint()
      ) {
        const color = state.book.palette[+ds.palette];
        if (editor.item().type === "text") inspector.applyStyle("color", color);
        else if (["drawing", "arrow", "line"].includes(editor.item().type))
          editor.item().stroke = color;
        else {
          if (editor.item().type === "table" && editor.item().tableStyle !== "custom") {
            const colors = M.tableAppearance(editor.item(), editor.page().background, editor.page().decoration);
            editor.item().stroke = colors.line;
            editor.item()["style"].color = colors.ink;
            editor.item().tableStyle = "custom";
          }
          if (editor.item().type === "flow" && editor.item().flowStyle !== "custom") {
            const colors = M.flowAppearance(editor.item(), editor.page().background, editor.page().decoration);
            editor.item().stroke = colors.stroke;
            editor.item()["style"].color = colors.ink;
            editor.item().flowStyle = "custom";
          }
          editor.item().fill = color;
        }
        editor.changed();
        return;
      }
      if (ds.previewVersion) return editor.previewVersion(ds.previewVersion);
      if (ds.confirmVersion) return editor.restoreVersion(ds.confirmVersion);
      if (ds.tool) {
        state.tool = ds.tool;
        document
          .querySelectorAll("[data-tool]")
          .forEach((el) =>
            el.setAttribute("aria-pressed", String(el.dataset.tool === state.tool)),
          );
        inspector.setInspector(true);
        inspector.renderInspector();
        return;
      }
      if (ds.size) return editor.sizeImage(ds.size);
      if (ds.align && editor.selectedItems().length && editor.checkpoint()) {
        M.alignItems(editor.selectedItems(), ds.align);
        editor.changed();
        return;
      }
      if (ds.styleToggle && editor.item() && !editor.item().locked && editor.checkpoint()) {
        inspector.applyStyle(ds.styleToggle, !inspector.selectedStyle(editor.item())[ds.styleToggle]);
        editor.changed();
        return;
      }
      if (ds.selectObject) {
        state.furnitureSelection = "";
        state.activePathPoint = -1;
        if (event.shiftKey)
          state.selected = state.selected.includes(ds.selectObject)
            ? state.selected.filter((x) => x !== ds.selectObject)
            : [...state.selected, ds.selectObject];
        else state.selected = [ds.selectObject];
        inspector.setInspector(true);
        editor.renderSelection();
        inspector.renderInspector();
        return;
      }
      if (ds.lock || ds.hide || ds.layerUp || ds.layerDown) {
        if (!editor.checkpoint()) return;
        const oid = ds.lock || ds.hide || ds.layerUp || ds.layerDown,
          o = editor.page().items.find((x) => x.id === oid);
        if (ds.lock) o.locked = !o.locked;
        if (ds.hide) o.hidden = !o.hidden;
        if (ds.layerUp || ds.layerDown) {
          const ix = editor.page().items.indexOf(o);
          editor.page().items.splice(ix, 1);
          editor.page().items.splice(
            M.clamp(ix + (ds.layerUp ? 1 : -1), 0, editor.page().items.length),
            0,
            o,
          );
        }
        editor.changed();
        return;
      }
      if (ds.removeMember) return editor.invite(ds.removeMember);
      if (ds.revoke) {
        await editor.api("/api/books/" + state.book.id + "/sharing", {
          method: "POST",
          body: JSON.stringify({ revoke: ds.revoke }),
        });
        return editor.shareDialog();
      }
      if (ds.restoreVersion) return editor.previewVersion(ds.restoreVersion);
      if (ds.restorePage) {
        if (!editor.checkpoint()) return;
        const p = state.book.deletedPages.find((p) => p.id === ds.restorePage);
        if (state.book.pages.length >= 100)
          throw new Error("This book already has 100 pages.");
        state.book.deletedPages = state.book.deletedPages.filter((p) => p.id !== ds.restorePage);
        state.book.pages.splice(state.book.pages.length - 1, 0, p);
        state.active = p.id;
        editor.changed();
        return editor.closeDialog();
      }
      if (ds.commentPage) {
        if (state.book.pages.some((p) => p.id === ds.commentPage)) {
          state.active = ds.commentPage;
          state.selected = [];
          state.furnitureSelection = "";
          state.activePathPoint = -1;
          editor.renderAll();
          editor.closeDialog();
        }
        return;
      }
      if (ds.resolveComment) {
        await editor.api("/api/books/" + state.book.id + "/comments", {
          method: "POST",
          body: JSON.stringify({ resolve: ds.resolveComment, resolved: true }),
        });
        return editor.commentsDialog();
      }
      if (ds.useAsset) {
        if (!editor.checkpoint()) return;
        const a = state.book.assets.find((a) => a.id === ds.useAsset),
          size = M.imageSize(a.width, a.height),
          o = M.object("image", {
            ...size,
            assetId: a.id,
            name: a.name,
            x: (M.W - size.w) / 2,
            y: (M.H - size.h) / 2,
          });
        editor.page().items.push(o);
        state.furnitureSelection = "";
        state.selected = [o.id];
        editor.changed();
        editor.closeDialog();
        return;
      }
      if (ds.removeAsset) {
        if (!editor.editable()) return;
        const aid = ds.removeAsset;
        if (
          state.book.pages
            .concat(state.book.deletedPages)
            .some((p) =>
              p.items.some(
                (o) => o.assetId === aid || o.originalAssetId === aid,
              ),
            ) ||
          (state.book.versions || []).some((v) =>
            v.pages.some((p) =>
              p.items.some(
                (o) => o.assetId === aid || o.originalAssetId === aid,
              ),
            ),
          )
        )
          throw new Error("This image is used in a page or saved version.");
        if (!state.book.local) {
          await editor.persist();
          const removed = await editor.api("/api/books/" + state.book.id + "/assets/" + aid, {
            method: "DELETE",
            body: JSON.stringify({
              lease_token: state.leaseToken,
              base_revision: state.book.revision,
            }),
          });
          state.book.revision = removed.revision;
        }
        state.book.assets = state.book.assets.filter((a) => a.id !== aid);
        await D.deleteAsset(aid);
        editor.changed();
        return editor.assetsDialog();
      }
      switch (id) {
        case "text-presets":
          editor.dialog(
            "Add text",
            `<div class="book-text-presets">${["heading", "body", "caption"].map((k) => `<button class="book-template" data-text-preset="${k}"><strong>${k[0].toUpperCase() + k.slice(1)}</strong><span>${state.book.styles[k].font} · ${state.book.styles[k].size} pt</span></button>`).join("")}</div>`,
          );
          break;
        case "edit-on-page":
          editor.startText();
          break;
        case "fit-text-height":
          if (editor.item() && editor.checkpoint()) {
            editor.item().h = Math.min(420, M.textLines(editor.item()).height + 1);
            editor.changed();
          }
          break;
        case "rotate-object":
          if (editor.selectedItems().length && editor.checkpoint()) {
            editor.selectedItems().forEach(
              (o) => (o.rotation = (o.rotation + 90) % 360),
            );
            editor.changed();
          }
          break;
        case "reset-rotation":
          if (editor.selectedItems().length && editor.checkpoint()) {
            editor.selectedItems().forEach((o) => (o.rotation = 0));
            editor.changed();
          }
          break;
        case "zoom-value":
          state.zoom = 1;
          editor.fitStage();
          break;
        case "apply-paper":
          if (editor.checkpoint()) {
            state.book.pages.forEach((p) => {
              p.background = editor.page().background;
              p.texture = editor.page().texture;
            });
            editor.changed();
            editor.notify("Paper updated on all pages. You can undo this change.");
          }
          break;
        case "page-earlier":
          editor.movePage(-1);
          break;
        case "page-later":
          editor.movePage(1);
          break;
        case "book-themes":
          if (state.book.theme?.id === "xped") {
            state.themeChoice = "xped";
            state.xpedVariant = state.book.theme.variant;
            state.xpedMode = state.book.theme.mode;
          }
          editor.themeDialog();
          break;
        case "apply-theme":
          editor.applyTheme();
          break;
        case "add-flow-step":
          if (editor.item()?.steps.length < 8 && editor.checkpoint()) {
            editor.item().steps.push("Next step");
            editor.changed();
          }
          break;
        case "edit-turn":
          if (state.book.editor && state.book.role === "owner") {
            editor.dialog(
              "Take an editing turn?",
              `<p>${esc(state.book.editor.name)} is editing. Taking over ends their editing turn. Any changes they have not saved will stay on their device for recovery.</p><button class="primary-btn" id="confirm-takeover">Take over editing</button>`,
            );
          } else await editor.acquire();
          break;
        case "confirm-takeover":
          await editor.acquire(true);
          editor.closeDialog();
          await editor.reloadRemote();
          break;
        case "finish-turn":
          await editor.release();
          break;
        case "add-page":
        case "add-page-side":
          editor.addPage();
          break;
        case "first-page":
          editor.go(-1, 0);
          break;
        case "prev-page":
          editor.go(-1);
          break;
        case "next-page":
          editor.go(1);
          break;
        case "last-page":
          editor.go(1, editor.currentSpreads().length - 1);
          break;
        case "page-position":
          editor.dialog(
            "Go to a page",
            `<div class="book-button-stack">${state.book.pages.map((p, i) => `<button class="secondary-btn" data-jump="${p.id}">${esc(p.role === "page" ? "Page " + i : p.title)}</button>`).join("")}</div>`,
          );
          break;
        case "zoom-in":
          state.zoom = M.clamp(state.zoom + 0.1, 0.4, 2.5);
          editor.fitStage();
          break;
        case "zoom-out":
          state.zoom = M.clamp(state.zoom - 0.1, 0.4, 2.5);
          editor.fitStage();
          break;
        case "reading":
          state.reading = !state.reading;
          document.body.classList.toggle("book-reading", state.reading);
          target.textContent = state.reading ? "Edit view" : "Read";
          state.selected = [];
          state.furnitureSelection = "";
          state.activePathPoint = -1;
          editor.renderAll();
          break;
        case "undo":
          editor.undo();
          break;
        case "redo":
          editor.undo(true);
          break;
        case "add-image":
        case "asset-upload":
          state.imageTarget = state.active;
          state.replacement = "";
          $("image-input").click();
          break;
        case "replace-image":
          state.replacement = editor.item().id;
          state.imageTarget = state.active;
          $("image-input").click();
          break;
        case "duplicate-page":
          editor.duplicatePages(false);
          break;
        case "duplicate-spread":
          editor.duplicatePages(true);
          break;
        case "delete-page":
          editor.deletePage();
          break;
        case "duplicate-object":
          editor.duplicateObject();
          break;
        case "delete-object":
          editor.deleteObjects();
          break;
        case "group-objects":
          if (editor.checkpoint()) {
            const group = editor.item().group,
              next = group ? "" : M.id();
            editor.page()
              .items.filter((o) =>
                group ? o.group === group : state.selected.includes(o.id),
              )
              .forEach((o) => (o.group = next));
            editor.changed();
          }
          break;
        case "fill-page":
          if (editor.checkpoint()) {
            Object.assign(editor.item(), { x: 0, y: 0, w: M.W, h: M.H, fit: "cover" });
            editor.changed();
          }
          break;
        case "span-pages":
          editor.spanImage();
          break;
        case "download-original":
          await editor.original();
          break;
        case "download-reference":
          await editor.original(true);
          break;
        case "save-text-style":
          if (editor.checkpoint()) {
            const o = editor.item(),
              name = o.styleName || "body";
            state.book.styles[name] = M.clone(o.style);
            state.book.pages.forEach((p) =>
              p.items.forEach((x) => {
                if (x.type === "text" && x.styleName === name) {
                  x.style = M.clone(o.style);
                  x.runs = [];
                }
              }),
            );
            editor.changed();
            editor.notify("Your " + name + " style is updated throughout the book.");
          }
          break;
        case "object-settings":
          editor.finishText();
          state.inspectorTab = "settings";
          inspector.setInspector(true, true);
          inspector.renderInspector();
          break;
        case "page-settings":
          editor.finishText();
          state.selected = [];
          state.furnitureSelection = "";
          state.activePathPoint = -1;
          state.selectionRange = null;
          state.inspectorTab = "settings";
          inspector.setInspector(true, true);
          editor.renderSelection();
          inspector.renderInspector();
          break;
        case "close-inspector":
          inspector.setInspector(false);
          $("page-settings").focus();
          break;
        case "organize":
          editor.detailsDialog();
          break;
        case "save-details":
          if (editor.checkpoint()) {
            const val = (name) =>
              $("dialog-content").querySelector("[data-field=" + name + "]");
            state.book.title = val("detailsTitle").value.trim() || "Untitled book";
            state.book.folder = val("detailsFolder").value;
            state.book.tags = val("detailsTags")
              .value.split(",")
              .map((x) => x.trim())
              .filter(Boolean);
            state.book.favorite = val("detailsFavorite").checked;
            $("book-title").value = state.book.title;
            editor.changed();
            editor.closeDialog();
          }
          break;
        case "copy-book":
        case "recover-copy":
          await editor.copyBook();
          break;
        case "publish-book":
          await io.publish();
          editor.closeDialog();
          break;
        case "share":
          await editor.shareDialog();
          break;
        case "invite-member":
          await editor.invite();
          break;
        case "create-link":
          await editor.createLink();
          break;
        case "copy-link":
          await navigator.clipboard.writeText($("share-url").value);
          editor.notify("Link copied.");
          break;
        case "illustration-assistant":
          editor.illustrationDialog();
          break;
        case "copy-prompt":
          await navigator.clipboard.writeText($("illustration-prompt").value);
          editor.notify("Prompt copied.");
          break;
        case "assets":
          await editor.assetsDialog();
          break;
        case "history":
          await editor.historyDialog();
          break;
        case "save-version":
          await editor.saveVersion();
          break;
        case "comments":
          await editor.commentsDialog();
          break;
        case "add-comment":
          await editor.api("/api/books/" + state.book.id + "/comments", {
            method: "POST",
            body: JSON.stringify({
              text: $("comment-text").value,
              page_id: state.active,
              item_id: state.selected[0] || "",
            }),
          });
          await editor.commentsDialog();
          break;
        case "export":
          io.exportDialog();
          break;
        case "download-export":
          await io.doExport();
          break;
        case "download-backup":
          await io.backup();
          break;
        case "more-tools":
          editor.dialog(
            "Create on the page",
            `<div class="book-template-grid">${[
              ["line", "Line", "Draw a route, curve or connection"],
              ["arrow", "Arrow", "Point the way with editable bends"],
              ["table", "Table", "Compare and collect ideas"],
              ["flow", "Story steps", "One moment after another"],
            ]
              .map(
                ([type, label, description]) =>
                  `<button class="book-template" data-extra="${type}">${icon(type)}<strong>${label}</strong><span>${description}</span></button>`,
              )
              .join("")}${[
              ["pencil", "Pencil", "Soft sketch lines"],
              ["highlighter", "Highlighter", "A little emphasis"],
              ["eraser", "Eraser", "Remove a drawing stroke"],
            ]
              .map(
                ([type, label, description]) =>
                  `<button class="book-template" data-drawing="${type}">${icon("pen")}<strong>${label}</strong><span>${description}</span></button>`,
              )
              .join(
                "",
              )}</div><div class="book-mobile-book-actions"><button class="secondary-btn" id="organize">Book details</button><button class="secondary-btn" id="history">Version history</button><button class="secondary-btn" id="comments">Comments</button></div>`,
          );
          break;
        case "shortcuts":
          editor.shortcutsDialog();
          break;
      }
      if (ds.jump) {
        state.active = ds.jump;
        state.selected = [];
        state.furnitureSelection = "";
        state.activePathPoint = -1;
        editor.renderAll();
        editor.closeDialog();
      }
      if (ds.extra) {
        editor.addObject(ds.extra);
        editor.closeDialog();
      }
      if (ds.drawing) {
        state.tool = ds.drawing;
        inspector.renderInspector();
        inspector.setInspector(true, true);
        editor.closeDialog();
      }
    }),
  );
  $("inspector").addEventListener(
    "change",
    editor.action((e) => {
      if (e.target.type === "number" && e.target.dataset.field) {
        if (e.target.value.trim() === "" || !e.target.validity.valid) e.target.value = e.target.dataset.lastValue;
        else { inspector.changeField(e.target); e.target.value = e.target.dataset.lastValue; }
        return;
      }
      if (
        e.target.tagName === "SELECT" ||
        e.target.type === "checkbox" ||
        e.target.type === "color"
      )
        inspector.changeField(e.target);
    }),
  );
  $("inspector").addEventListener("input", (e) => {
    if (
      e.target.dataset.field &&
      e.target.tagName !== "SELECT" &&
      e.target.type !== "checkbox"
    ) {
      inspector.changeField(e.target);
      if (e.target.type === "range") {
        const span = e.target.previousElementSibling;
        span.textContent =
          span.textContent.split(" · ")[0] + " · " + e.target.value;
      }
      return;
    }
    const o = editor.item();
    if (!o || !editor.editable() || o.locked) return;
    if (e.target.dataset.cell || e.target.dataset.step !== undefined) {
      if (!editor.editCheckpoint(e.target)) return;
      if (e.target.dataset.cell) {
        const [r, c] = e.target.dataset.cell.split(",").map(Number);
        o.cells[r][c] = e.target.value;
      } else o.steps[+e.target.dataset.step] = e.target.value;
      editor.changed(false);
      editor.renderStage();
      editor.schedulePages();
      return;
    }
    if (e.target.id === "object-text") {
      if (!editor.editCheckpoint(e.target)) return;
      M.replaceText(o, e.target.value);
      state.selectionRange = null;
      editor.changed(false);
      editor.renderStage();
      editor.schedulePages();
    }
    if (e.target.id === "table-content") {
      editor.checkpoint();
      o.cells = e.target.value
        .split("\n")
        .slice(0, 8)
        .map((r) =>
          r
            .split("|")
            .slice(0, 8)
            .map((s) => s.trim()),
        );
      editor.changed(false);
      editor.renderStage();
    }
    if (e.target.id === "flow-content") {
      editor.checkpoint();
      o.steps = e.target.value.split("\n").slice(0, 8);
      editor.changed(false);
      editor.renderStage();
    }
  });
  $("inspector").addEventListener("select", (e) => {
    if (e.target.id === "object-text")
      state.selectionRange = {
        start: e.target.selectionStart,
        end: e.target.selectionEnd,
      };
  });
  $("dialog-content").addEventListener(
    "change",
    editor.action((e) => {
      const field = e.target.dataset.field;
      if (["exportFormat", "exportGuides", "economy"].includes(field)) io.printPreview();
      if (field && field.startsWith("illustration")) editor.updatePrompt();
    }),
  );
  $("dialog-content").addEventListener("input", (e) => {
    if (e.target.id === "character-details") editor.updatePrompt();
  });
  $("book-title").addEventListener("input", () => {
    if (!editor.editable()) return;
    if (state.editBatch !== "book-title") {
      if (!editor.checkpoint()) return;
      state.editBatch = "book-title";
    }
    state.book.title = $("book-title").value.trim() || "Untitled book";
    editor.changed(false);
  });
  $("book-title").addEventListener("blur", () => {
    state.editBatch = null;
    if (state.book) $("book-title").value = state.book.title;
  });
  $("book-search").addEventListener("input", editor.renderLibrary);
  $("book-sort").addEventListener("change", editor.renderLibrary);
  $("fit-mode").addEventListener("change", () => {
    state.fit = $("fit-mode").value;
    state.zoom = 1;
    editor.renderStage();
  });
  $("image-input").addEventListener(
    "change",
    editor.action(async () => {
      const files = Array.from($("image-input").files);
      $("image-input").value = "";
      await io.importImages(files, state.imageTarget || state.active);
    }),
  );
  $("backup-input").addEventListener(
    "change",
    editor.action(async () => {
      const file = $("backup-input").files[0];
      $("backup-input").value = "";
      if (file) await io.importBackup(file);
    }),
  );
  $("book-spread").addEventListener("contextmenu", pointerTools.pathContextMenu);
  $("book-spread").addEventListener("pointerdown", pointerTools.pointer);
  $("book-spread").addEventListener("dblclick", (e) => {
    if (e.target.closest("#canvas-text-editor")) return;
    const node = e.target.closest("[data-object]");
    if (node && editor.item()?.type === "text") editor.startText();
    else if (node && editor.item()) {
      inspector.setInspector(true, true);
      inspector.renderInspector();
    }
  });
  let draggedPage = "";
  $("page-list").addEventListener("dragstart", (e) => {
    const node = e.target.closest("[data-page]");
    if (!node || !editor.editable()) return;
    e.dataTransfer.setData("application/x-book-page", node.dataset.page);
    draggedPage = node.dataset.page;
  });
  $("page-list").addEventListener("dragover", (e) => {
    if (draggedPage) e.preventDefault();
  });
  $("page-list").addEventListener("drop", (e) => {
    if (!draggedPage) return;
    e.preventDefault();
    const target = e.target.closest("[data-page]");
    if (!target) return;
    const source = state.book.pages.find((p) => p.id === draggedPage),
      dest = state.book.pages.find((p) => p.id === target.dataset.page);
    draggedPage = "";
    if (
      !source ||
      source.role !== "page" ||
      dest.role !== "page" ||
      source === dest
    )
      return;
    if (!editor.checkpoint()) return;
    const linked = source.items.find((o) => o.spanId),
      group = linked
        ? state.book.pages.filter((p) => p.items.some((o) => o.spanId === linked.spanId))
        : [source];
    if (group.includes(dest)) return;
    state.book.pages = state.book.pages.filter((p) => !group.includes(p));
    const index = state.book.pages.indexOf(dest);
    state.book.pages.splice(index, 0, ...group);
    editor.keepSpreadsTogether();
    editor.changed();
  });
  $("page-list").addEventListener("dragend", () => (draggedPage = ""));
  document.addEventListener("dragover", (e) => {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      document
        .querySelectorAll(".drop-target")
        .forEach((n) => n.classList.remove("drop-target"));
      const sheet = e.target.closest("[data-page-id]");
      if (sheet && editor.editable()) sheet.classList.add("drop-target");
    }
  });
  document.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget)
      document
        .querySelectorAll(".drop-target")
        .forEach((n) => n.classList.remove("drop-target"));
  });
  document.addEventListener(
    "drop",
    editor.action(async (e) => {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      document
        .querySelectorAll(".drop-target")
        .forEach((n) => n.classList.remove("drop-target"));
      const sheet = e.target.closest("[data-page-id]");
      if (!sheet || !state.book) {
        editor.notify("Open a book and drop the image onto a page.");
        return;
      }
      const rect = sheet.getBoundingClientRect();
      state.replacement = "";
      await io.importImages(e.dataTransfer.files, sheet.dataset.pageId, {
        x: ((e.clientX - rect.left) / rect.width) * M.W,
        y: ((e.clientY - rect.top) / rect.height) * M.H,
      });
    }),
  );
  document.addEventListener(
    "paste",
    editor.action(async (e) => {
      if (
        !state.book ||
        !editor.editable() ||
        state.reading ||
        $("book-dialog").open ||
        e.target.closest("input,textarea,select,[contenteditable=true]")
      )
        return;
      const encoded =
        e.clipboardData.getData("application/x-book-studio") ||
        e.clipboardData.getData("text/plain");
      if (encoded.startsWith("BOOK-STUDIO:")) {
        e.preventDefault();
        const data = JSON.parse(encoded.slice(12));
        if (data.book !== state.book.id)
          throw new Error(
            "Paste these objects within the same book so their images stay connected.",
          );
        const sample = M.book();
        sample.pages[0].items = data.items;
        const clean = M.readBackup(sample).pages[0].items;
        if (editor.page().items.length + clean.length > 300)
          throw new Error("This page is full. Paste onto another page.");
        if (!editor.checkpoint()) return;
        const groups = new Map();
        clean.forEach((o) => {
          o.id = M.id();
          o.locked = false;
          o.hidden = false;
          o.spanId = "";
          o.spanSide = "";
          o.x += 4;
          o.y += 4;
          if (o.group) {
            if (!groups.has(o.group)) groups.set(o.group, M.id());
            o.group = groups.get(o.group);
          }
        });
        editor.page().items.push(...clean);
        state.selected = clean.map((o) => o.id);
        editor.changed();
        inspector.setInspector(true);
        editor.notify(
          clean.length === 1
            ? "Object pasted."
            : clean.length + " objects pasted.",
        );
        return;
      }
      const files = Array.from(e.clipboardData.items)
        .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
        .map((i) => i.getAsFile());
      if (files.length) {
        e.preventDefault();
        state.replacement = "";
        await io.importImages(files, state.active);
      }
    }),
  );
  document.addEventListener("keydown", (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      const list = tab.closest('[role="tablist"]'), tabs = [...list.querySelectorAll('[role="tab"]')];
      const step = e.key === "ArrowLeft" ? -1 : 1;
      const index = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (tabs.indexOf(tab) + step + tabs.length) % tabs.length;
      tabs[index].click();
      const label = list.getAttribute("aria-label");
      document.querySelector(`[role="tablist"][aria-label="${label}"] [aria-selected="true"]`)?.focus();
      return;
    }
    if (
      !state.book ||
      e.defaultPrevented ||
      e.target.closest(".book-color-popover") ||
      $("book-dialog").open ||
      e.target.closest("input,textarea,select,[contenteditable=true]")
    )
      return;
    if ((e.ctrlKey || e.metaKey) && ["=", "+", "-", "0"].includes(e.key)) {
      e.preventDefault();
      state.zoom =
        e.key === "0"
          ? 1
          : M.clamp(state.zoom + (e.key === "-" ? -0.1 : 0.1), 0.4, 2.5);
      editor.fitStage();
      return;
    }
    if (state.reading) {
      if (["ArrowLeft", "ArrowRight", "Home", "End", "Escape"].includes(e.key)) {
        e.preventDefault();
        if (e.key === "Escape") $("reading").click();
        else if (e.key === "Home" || e.key === "End") editor.go(e.key === "Home" ? -1 : 1, e.key === "Home" ? 0 : editor.currentSpreads().length - 1);
        else editor.go(e.key === "ArrowRight" ? 1 : -1);
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
      e.preventDefault();
      editor.duplicateObject();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      state.furnitureSelection = "";
      state.selected = editor.page()
        .items.filter((o) => !o.locked && !o.hidden)
        .map((o) => o.id);
      editor.renderSelection();
      inspector.renderInspector();
      return;
    }
    if (
      e.key === "Enter" &&
      editor.item()?.type === "text" &&
      !e.target.closest("button,a,summary,[role=tab]")
    ) {
      e.preventDefault();
      editor.startText();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
      e.preventDefault();
      editor.undo(true);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      editor.undo(e.shiftKey);
      return;
    }
    if (e.key === "Escape") {
      pointerTools.closePathMenu();
      state.selected = [];
      state.furnitureSelection = "";
      state.activePathPoint = -1;
      state.tool = "select";
      $("inspector").classList.remove("mobile-open");
      editor.renderAll();
      return;
    }
    if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "n") {
      e.preventDefault();
      editor.addPage();
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && e.target.dataset.pathPoint !== undefined && state.activePathPoint > 0 && state.activePathPoint < P.points(editor.item()).length - 1) {
      e.preventDefault(); pointerTools.removePathBend(); return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && state.selected.length) {
      e.preventDefault();
      editor.deleteObjects();
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      editor.go(
        e.key === "Home" ? -1 : 1,
        e.key === "Home" ? 0 : editor.currentSpreads().length - 1,
      );
      return;
    }
    if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      if (state.furnitureSelection && !e.altKey && editor.editable() && editor.checkpoint()) {
        const box = editor.furnitureBox(), step = e.shiftKey ? 5 : .5;
        box.x += e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0;
        box.y += e.key === "ArrowDown" ? step : e.key === "ArrowUp" ? -step : 0;
        editor.placeFurniture(box); editor.changed(); return;
      }
      if (e.target.dataset.pathPoint !== undefined && !e.altKey && editor.isPath(editor.item()) && editor.editable() && editor.checkpoint()) {
        const o = editor.item(), index = +e.target.dataset.pathPoint, pt = P.points(o)[index];
        const angle = (o.rotation || 0) * Math.PI / 180, dx = (pt[0] - .5) * o.w, dy = (pt[1] - .5) * o.h;
        const step = e.shiftKey ? 5 : .5;
        const world = { x: o.x + o.w / 2 + dx * Math.cos(angle) - dy * Math.sin(angle), y: o.y + o.h / 2 + dx * Math.sin(angle) + dy * Math.cos(angle) };
        world.x += e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0;
        world.y += e.key === "ArrowDown" ? step : e.key === "ArrowUp" ? -step : 0;
        Object.assign(o, P.movePoint(o, index, world)); editor.changed();
        document.querySelector(`[data-path-point="${index}"]`)?.focus(); return;
      }
      if (state.selected.length && !e.altKey && editor.editable()) {
        editor.checkpoint();
        const step = e.shiftKey ? 5 : 0.5;
        editor.page()
          .items.filter((o) => state.selected.includes(o.id) && !o.locked)
          .forEach((o) => {
            o.x +=
              e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0;
            o.y +=
              e.key === "ArrowDown" ? step : e.key === "ArrowUp" ? -step : 0;
          });
        editor.changed();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight")
        editor.go(e.key === "ArrowRight" ? 1 : -1);
    }
  });
  let pollBusy = false;
  setInterval(async () => {
    if (!state.book || state.book.local || document.hidden || state.opening || pollBusy) return;
    const current = state.book;
    pollBusy = true;
    try {
      const result = await editor.api("/api/books/" + state.book.id + "/revision");
      if (state.book !== current) return;
      state.lastRefresh = Date.now();
      const editorChanged =
        JSON.stringify(state.book.editor) !== JSON.stringify(result.book.editor);
      state.book.editor = result.book.editor;
      state.book.role = result.book.role;
      if (
        state.leaseToken &&
        (!result.book.editor || !["owner", "edit"].includes(state.book.role))
      ) {
        state.leaseToken = "";
        sessionStorage.removeItem("book-lease-" + state.book.id);
      }
      if (!state.leaseToken && !state.dirty && result.book.revision !== state.book.revision)
        await editor.reloadRemote();
      editor.updateStatus();
      if (editorChanged && !state.leaseToken) inspector.renderInspector();
    } catch (e) {
      if (state.book === current && e.code !== "account") editor.status("Updates paused · Reconnecting…");
    } finally {
      pollBusy = false;
    }
  }, 5000);
  setInterval(async () => {
    if (!state.book || state.book.local || !state.leaseToken) return;
    const current = state.book;
    try {
      await editor.api("/api/books/" + state.book.id + "/lease", {
        method: "POST",
        body: JSON.stringify({ action: "renew", lease_token: state.leaseToken }),
      });
    } catch (e) {
      if (state.book !== current) return;
      state.leaseToken = "";
      sessionStorage.removeItem("book-lease-" + state.book.id);
      editor.updateStatus();
      inspector.renderInspector();
      editor.renderSelection();
      editor.notify(e.message, true);
    }
  }, 20000);
  window.addEventListener("resize", () => {
    if (state.book) {
      if (state.inlineEdit) {
        const ids = editor.currentSpreads().find((spread) => spread.includes(state.active)).filter(Boolean);
        const shown = [...$("book-spread").children].map((sheet) => sheet.dataset.pageId);
        if (ids.join() !== shown.join()) {
          const { selectionStart, selectionEnd } = state.inlineEdit.editor;
          editor.renderStage();
          editor.startText();
          state.inlineEdit?.editor.setSelectionRange(selectionStart, selectionEnd);
          editor.renderPages();
        } else editor.fitStage();
      }
      else { editor.renderStage(); editor.renderPages(); }
    }
  });
  window.addEventListener("online", () => {
    if (state.book?.local && state.user && !state.book.id.startsWith("local-recovery-")) {
      io.ensureCloudBook().catch(() => {});
      return;
    }
    if (state.book && state.dirty && state.leaseToken)
      editor.persist().catch((e) => editor.notify(e.message, true));
  });
  window.addEventListener("beforeunload", (e) => {
    if (state.book) {
      editor.localSaves.flush().catch(() => {});
      if (state.dirty || state.localWrites || state.localSaveError || state.cloudPromotion) {
        e.preventDefault();
        e.returnValue = "";
      }
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state.book) {
      editor.localSaves.flush().catch(() => {});
      if (state.dirty && state.leaseToken) editor.persist().catch(() => {});
    }
  });
  function refreshFontLayouts() {
    if (state.startupState !== "ready") return;
    if (state.book) {
      $("page-list").querySelectorAll(".book-thumb").forEach((node) => { node.bookPreviewKey = null; });
      if (!state.inlineEdit) editor.renderStage();
      editor.renderPages();
    } else if (!state.book) editor.renderLibrary();
  }
  document.fonts.ready.then(refreshFontLayouts);
  document.fonts.addEventListener("loadingdone", refreshFontLayouts);
  editor.decorateTools();
  document.addEventListener("book-color-start", () => { state.editBatch = null; });
  $("inspector").addEventListener("focusout", (e) => {
    if (e.target.type === "color" && !e.relatedTarget) return;
    state.editBatch = null;
  });
  $("inspector").addEventListener("pointerdown", (e) => {
    if (e.target.type === "color") state.editBatch = null;
  });
  document.addEventListener("pointerdown", (e) => {
    if (!e.target.closest("#book-path-menu")) pointerTools.closePathMenu();
    if (state.inlineEdit && !e.target.closest("#canvas-text-editor")) editor.finishText();
    if (
      state.book &&
      e.target.closest("#book-viewport") &&
      !e.target.closest("[data-page-id]")
    )
      editor.clearSelection();
  });
  let backdropDown = false;
  $("book-dialog").addEventListener("pointerdown", (e) => {
    const r = $("book-dialog").getBoundingClientRect();
    backdropDown =
      e.target === $("book-dialog") &&
      (e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom);
  });
  $("book-dialog").addEventListener("click", (e) => {
    if (backdropDown && e.target === $("book-dialog")) editor.closeDialog();
    backdropDown = false;
  });
  ["copy", "cut"].forEach((type) =>
    document.addEventListener(type, (e) => {
      if (
        !state.book ||
        !editor.editable() ||
        state.reading ||
        !state.selected.length ||
        $("book-dialog").open ||
        e.target.closest("input,textarea,select,[contenteditable=true]")
      )
        return;
      const objects = editor.selectedItems();
      if (!objects.length) return;
      const value =
        "BOOK-STUDIO:" + JSON.stringify({ book: state.book.id, items: objects });
      e.clipboardData.setData("application/x-book-studio", value);
      e.clipboardData.setData("text/plain", value);
      e.preventDefault();
      if (type === "cut") editor.deleteObjects();
      editor.notify(
        objects.length === 1
          ? "Object " + (type === "cut" ? "cut." : "copied.")
          : objects.length +
              " objects " +
              (type === "cut" ? "cut." : "copied."),
      );
    }),
  );
  $("dialog-content").addEventListener("input", (e) => {
    if (e.target.id === "shortcut-search")
      document.querySelectorAll(".book-shortcut").forEach((n) => {
        n.hidden = !n.dataset.search.includes(e.target.value.toLowerCase());
      });
    if (e.target.id === "asset-search") {
      let count = 0;
      document.querySelectorAll(".book-asset-card").forEach((n) => {
        n.hidden = !n.dataset.search.includes(e.target.value.toLowerCase());
        if (!n.hidden) count++;
      });
      $("asset-no-results").hidden = count > 0;
    }
  });
}
