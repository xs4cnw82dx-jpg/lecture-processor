import { M, D, $, esc, selectField, toggle } from "./book-studio-ui.js";

export function createBookIO(state, editor) {
  async function imageInfo(file) {
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
      throw new Error("Choose a PNG, JPEG or WebP image.");
    if (file.size > 10 * 1024 * 1024)
      throw new Error(
        "This image is larger than 10 MB. Choose a smaller file.",
      );
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch (_) {
      throw new Error(
        "This image could not be opened. Try saving it again as a PNG, JPEG or WebP.",
      );
    }
    const dimensions = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    if (dimensions.width * dimensions.height > 32000000)
      throw new Error("Resize this image to at most 32 megapixels.");
    return dimensions;
  }
  async function importImages(files, pid, point) {
    if (!editor.editable() || state.reading) {
      editor.notify("Start an editing turn before adding images.");
      return;
    }
    const current = state.book, generation = state.accountGeneration,
      p = current.pages.find((p) => p.id === pid) || editor.page();
    if (!editor.checkpoint()) return;
    state.uploads++;
    let offset = 0;
    try {
      for (const file of Array.from(files)) {
        const progress = document.createElement("div");
        progress.className = "book-upload";
        progress.textContent = "Adding " + file.name + "…";
        $("upload-list").appendChild(progress);
        try {
          const dims = await imageInfo(file);
          editor.assertAccount(generation);
          if (state.book !== current) return;
          if (
            current.assets.reduce((n, a) => n + a.size, 0) + file.size >
            25 * 1024 * 1024
          )
            throw new Error("This book has reached its image allowance.");
          const aid = M.id(),
            asset = {
              id: aid,
              name: file.name || "Pasted image",
              size: file.size,
              ...dims,
              mime: file.type,
              local: true,
            };
          await D.putAsset({ ...asset, blob: file });
          editor.assertAccount(generation);
          if (state.book !== current) return;
          current.assets.push(asset);
          editor.renderedAssets[aid] = {
            src: URL.createObjectURL(file),
            ...dims,
            blob: file,
          };
          const old = state.replacement && p.items.find((o) => o.id === state.replacement);
          let o;
          if (old) {
            o = old;
            if (!o.originalAssetId) o.originalAssetId = o.assetId;
            o.assetId = aid;
            state.replacement = "";
          } else {
            const size = M.imageSize(dims.width, dims.height);
            o = M.object("image", {
              ...size,
              assetId: aid,
              name: asset.name,
              x: M.clamp(
                (point ? point.x - size.w / 2 : (M.W - size.w) / 2) + offset,
                0,
                M.W - size.w,
              ),
              y: M.clamp(
                (point ? point.y - size.h / 2 : (M.H - size.h) / 2) + offset,
                0,
                M.H - size.h,
              ),
            });
            p.items.push(o);
            offset += 5;
          }
          if (state.book === current) {
            state.active = p.id;
            state.furnitureSelection = "";
            state.selected = [o.id];
            editor.changed();
          }
          progress.textContent = file.name + " · Saved on this device";
          if (!current.local) {
            try {
              await uploadOne(asset, file, current);
              progress.remove();
            } catch (e) {
              state.saveError = e.message;
              editor.updateStatus();
              progress.textContent = file.name + " · " + e.message;
              const retry = document.createElement("button");
              retry.className = "secondary-btn";
              retry.textContent = "Retry";
              retry.onclick = editor.action(async () => {
                if (state.book !== current)
                  throw new Error("Open this book before retrying.");
                await uploadOne(asset, file, current);
                progress.remove();
              });
              progress.appendChild(retry);
            }
          } else setTimeout(() => progress.remove(), 2500);
        } catch (e) {
          progress.textContent = e.message;
          setTimeout(() => progress.remove(), 9000);
        }
      }
    } finally {
      state.uploads--;
      if (state.book === current) editor.changed();
    }
  }
  async function uploadOne(asset, file, current) {
    // Flush only after remapping all local references, so no local asset IDs reach cloud pages.
    clearTimeout(state.saveTimer);
    if (state.saving) await state.saving;
    if (state.book !== current) throw editor.accountChangedError();
    if (!state.leaseToken)
      throw new Error("Start a new editing turn, then retry the image upload.");
    const form = new FormData();
    form.append("image", file, asset.name);
    form.append("lease_token", state.leaseToken);
    form.append("base_revision", current.revision);
    form.append("idempotency_key", "asset:" + asset.id);
    const result = await editor.api("/api/books/" + current.id + "/assets", {
        method: "POST",
        body: form,
      }),
      remote = result.asset;
    if (state.book !== current) throw editor.accountChangedError();
    await D.putAsset({ ...remote, blob: file });
    if (state.book !== current) throw editor.accountChangedError();
    editor.renderedAssets[remote.id] = editor.renderedAssets[asset.id];
    current.pages
      .concat(
        current.deletedPages || [],
        ...(current.versions || []).map((v) =>
          v.pages.concat(v.deletedPages || []),
        ),
        ...state.undoStack.map((v) => v.pages.concat(v.deletedPages || [])),
        ...state.redoStack.map((v) => v.pages.concat(v.deletedPages || [])),
      )
      .forEach((p) =>
        p.items.forEach((o) => {
          if (o.assetId === asset.id) o.assetId = remote.id;
          if (o.originalAssetId === asset.id) o.originalAssetId = remote.id;
        }),
      );
    current.assets = current.assets.map((a) =>
      a.id === asset.id ? remote : a,
    );
    if (state.book === current) {
      editor.changed();
      if (!state.uploads && !current.assets.some((a) => a.local)) await editor.persist();
    }
  }
  const cloudSync = window.BookCloudSync.create({
    storage: D,
    holder: editor.instance,
    session: () => state.session,
    accountMatches: (uid) => state.user?.uid === uid,
    request: (url, options, uid) => editor.api(url, options, false, uid),
  });
  async function ensureCloudBook(allowRecovery = false) {
    const current = state.book, uid = state.user?.uid, generation = state.accountGeneration;
    if (!current?.local || !uid || current.deleted) return;
    if (current.id.startsWith("local-recovery-") && !allowRecovery) return;
    if (state.cloudPromotion) return state.cloudPromotion;
    if (!D.canReadBook(current, editor.storageScope())) {
      state.cloudBlocked = true;
      state.saveError = "Sign in with the account that first saved this draft to continue.";
      editor.updateStatus();
      return;
    }
    current.cloudAccountUid = uid;
    current.cacheAccountUid = uid;
    state.cloudBlocked = false;
    state.cloudPhase = "saving";
    state.saveError = "";
    state.cloudPromotion = (async () => {
      try {
        const result = await cloudSync.sync(current, uid, {
          isCurrent: () => state.book === current && generation === state.accountGeneration,
          isBusy: () => state.uploads > 0,
          onClaim: async () => { editor.queueLocalSave(current); await editor.localSaves.flush(); },
          beforeComplete: () => editor.localSaves.flush(),
          onState: (phase) => {
            if (state.book !== current || generation !== state.accountGeneration) return;
            state.cloudPhase = phase;
            editor.updateStatus();
          },
        });
        editor.assertAccount(generation);
        if (state.book !== current) return;
        if (result.existingId) {
          // A second tab completed this promotion. Keep any separate edits as recovery.
          if (state.dirty) {
            const recovery = {
              ...M.clone(current), id: "local-recovery-" + M.id(),
              title: current.title + " (recovered draft)", pending: false,
            };
            recovery.cacheAccountUid = uid;
            delete recovery.cloudAccountUid;
            await D.putBook(recovery);
            editor.notify("This book was saved in another tab. Your separate edits are safe in a recovered draft.");
          }
          state.cloudPromotion = null;
          state.cloudPhase = "";
          state.dirty = false;
          await editor.openBook(result.existingId);
          return;
        }
        Object.entries(result.assetMap).forEach(([localId, remote]) => {
          if (editor.renderedAssets[localId]) editor.renderedAssets[remote.id] = editor.renderedAssets[localId];
          [...state.undoStack, ...state.redoStack].forEach((version) =>
            version.pages.concat(version.deletedPages || []).forEach((p) => p.items.forEach((o) => {
              if (o.assetId === localId) o.assetId = remote.id;
              if (o.originalAssetId === localId) o.originalAssetId = remote.id;
            })),
          );
        });
        Object.assign(current, result.book);
        delete current.cloudAccountUid;
        delete current.cloudSaveError;
        state.leaseToken = result.leaseToken;
        sessionStorage.setItem("book-lease-" + current.id, state.leaseToken);
        state.accessToken = "";
        state.savedPages = Object.fromEntries(current.pages.concat(current.deletedPages || []).map((p) => [p.id, JSON.stringify(p)]));
        state.dirty = false;
        state.saveError = "";
        state.cloudPhase = "";
        history.replaceState({}, "", "/books/" + current.id);
        if ($("publish-book")) editor.closeDialog();
        editor.renderAll();
      } catch (e) {
        if (state.book === current) {
          state.cloudPhase = "error";
          state.cloudBlocked = ["account", "tab", "conflict"].includes(e.code);
          state.saveError = e.message;
          current.cloudSaveError = e.message;
          if (!["tab", "account"].includes(e.code)) await D.putBook(current);
          editor.notify(e.message, true);
          editor.renderAll();
        }
        throw e;
      } finally {
        state.cloudPromotion = null;
        if (state.book === current && state.cloudPhase !== "error") state.cloudPhase = "";
        if (state.book === current) editor.updateStatus();
      }
    })();
    editor.updateStatus();
    return state.cloudPromotion;
  }
  async function publish() {
    if (!state.user) await signIn();
    if (state.user) await ensureCloudBook(true);
  }
  async function retryCloudSave() {
    state.saveError = "";
    if (state.book.local) return ensureCloudBook();
    if (!state.leaseToken) await editor.acquire();
    for (const asset of state.book.assets.filter((a) => a.local)) {
      const stored = await D.getAsset(asset.id);
      if (!stored?.blob) throw new Error("An illustration is missing. Add it again before saving.");
      await uploadOne(asset, stored.blob, state.book);
    }
    await editor.persist();
    editor.updateStatus();
  }
  async function signIn() {
    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      await editor.auth.signInWithPopup(provider);
    } catch (e) {
      throw new Error(
        e.code === "auth/popup-blocked"
          ? "Allow the Google sign-in window, then try again."
          : e.code === "auth/popup-closed-by-user"
            ? "Sign-in was closed. Your local books are still here."
            : "Google sign-in could not finish. Please try again.",
      );
    }
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  async function dataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("This image could not be read."));
      reader.readAsDataURL(blob);
    });
  }
  async function fontCss(pages, pageNumbers) {
    const families = new Set(
      pages.flatMap((p) =>
        p.items
          .filter((o) => ["text", "flow", "table"].includes(o.type))
          .flatMap((o) => [
            o["style"].font,
            ...(o.runs || []).map((r) => r["style"].font),
          ]),
      ),
    );
    if (pageNumbers?.enabled) families.add(M.pageNumberOptions(pageNumbers).font);
    const response = await fetch("/static/css/book-studio.css"),
      css = await response.text();
    const faces = css.match(/@font-face\s*\{[^}]+\}/g) || [];
    let embedded = "";
    for (const face of faces) {
      const family = (face.match(/font-family:\s*([^;]+)/) || [])[1]
        ?.replace(/["']/g, "")
        .trim();
      if (!families.has(family)) continue;
      const url = (face.match(/url\(\s*["']?([^"')\s]+)["']?\s*\)/) || [])[1];
      if (!url) continue;
      if (!editor.fontCache[url])
        editor.fontCache[url] = await dataUrl(await (await fetch(url)).blob());
      embedded += face
        .replace(url, editor.fontCache[url])
        .replace(/font-display:\s*swap/g, "font-display:block");
    }
    return embedded;
  }
  async function raster(p, assets, fonts, options) {
    const svg = M.svg(p, assets, { ...options, fonts }).replace(
      'width="148.5" height="210"',
      'width="1754" height="2480"',
    );
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 1754;
      canvas.height = 2480;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0);
      const result = canvas.toDataURL("image/png");
      canvas.width = canvas.height = 1;
      return result;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  function exportDialog() {
    const issues = M.checks(state.book);
    editor.dialog(
      "Export your book",
      `<p class="book-muted">Choose how you want to use your book. Your original stays editable here.</p><div class="book-row">${selectField(
        "File",
        "exportFormat",
        "faithful",
        [
          ["faithful", "Word · exact appearance"],
          ["editable", "Word · editable text & shapes"],
          ["pdf", "PDF · ready to print"],
        ],
      )}</div><div id="export-advice" class="book-status-banner">Print single-sided on A4 landscape. Cut along the middle and assemble the pages in reading order.</div><div class="book-row">${toggle("Show center guide", "exportGuides", true)}${toggle("Save ink", "economy", false)}</div>${issues.length ? "<details><summary>" + issues.length + ' things to check before printing</summary><ul class="book-check-list">' + issues.map((i) => "<li>" + esc(i) + "</li>").join("") + "</ul></details>" : '<p class="book-muted">Your pages are ready for a closer look.</p>'}<div id="editable-notes"></div><h3>Sheet preview</h3><div id="print-preview" class="book-print-preview"></div><div class="book-row"><button class="primary-btn" id="download-export">Download</button><button class="secondary-btn" id="download-backup">Download backup</button></div><p class="book-muted" id="export-progress" role="status"></p>`,
    );
    printPreview();
  }
  function printPreview() {
    const format = $("dialog-content").querySelector(
        "[data-field=exportFormat]",
      ).value,
      economy = $("dialog-content").querySelector("[data-field=economy]").checked,
      showGuides = $("dialog-content").querySelector("[data-field=exportGuides]").checked;
    const pairs = M.sheetPairs(state.book.pages);
    $("print-preview").innerHTML = pairs
      .map(
        (pair, i) =>
          `<div><div class="book-print-sheet${showGuides ? " with-guide" : ""}${economy ? " save-ink" : ""}">${pair.map((index) => (index === null ? '<div class="empty-half"></div>' : M.svg(state.book.pages[index], editor.renderedAssets, { ...M.pageRenderOptions(state.book.pages[index], state.book.pages, state.book.pageNumbers), economy }))).join("")}</div><small class="book-muted">Sheet ${i + 1} · ${pair.map((index) => (index === null ? "Blank" : index === 0 ? "Cover" : index === state.book.pages.length - 1 ? "Back cover" : "Page " + index)).join(" / ")}</small></div>`,
      )
      .join("");
    $("export-advice").textContent =
      "Print single-sided on A4 landscape. Cut along the middle and assemble the pages in reading order. The cover is the first half-page." +
      (format === "editable"
        ? " Install the book fonts for the closest match. Word changes stay in the downloaded file."
        : "");
    const notes = [];
    if (format === "editable") {
      state.book.pages.forEach((p, i) =>
        p.items
          .filter((o) => !o.hidden)
          .forEach((o) => {
            const name =
              (p.role === "page" ? "Page " + i : p.title) + " · " + o.name;
            if (!M.nativeEligible(o)) notes.push(name + ": kept as an image.");
            else if (o.type === "text") {
              const weights = new Set(
                (o.runs.length ? o.runs : [o]).map((r) => r["style"].weight),
              );
              weights.forEach((w) => {
                if (![400, 700].includes(w))
                  notes.push(
                    name +
                      ": thickness " +
                      w +
                      " becomes " +
                      (w >= 600 ? "Bold (700)" : "Regular (400)") +
                      ".",
                  );
              });
            }
          }),
      );
    }
    $("editable-notes").innerHTML =
      format === "editable"
        ? '<p class="book-muted">Text boxes and simple shapes stay editable. Word may adjust wrapping and layer order.</p><details><summary>' +
          notes.length +
          ' export adjustments</summary><ul class="book-check-list">' +
          notes.map((n) => "<li>" + esc(n) + "</li>").join("") +
          '</ul></details><a class="secondary-btn" href="/api/books/fonts" download>Download book fonts</a>'
        : "";
  }
  async function doExport() {
    const generation = state.accountGeneration;
    await editor.persist();
    editor.assertAccount(generation);
    if (!state.book) throw editor.accountChangedError();
    if (state.dirty && !state.book.local)
      throw new Error(
        "Save your latest changes before exporting. Start an editing turn or download a backup.",
      );
    if (state.book.assets.some((a) => a.local) && !state.book.local)
      throw new Error("Finish uploading your images before exporting.");
    const button = $("download-export");
    button.disabled = true;
    const snapshot = M.clone(state.book),
      format = $("dialog-content").querySelector(
        "[data-field=exportFormat]",
      ).value,
      economy = $("dialog-content").querySelector(
        "[data-field=economy]",
      ).checked,
      showGuides = $("dialog-content").querySelector(
        "[data-field=exportGuides]",
      ).checked;
    try {
      $("export-progress").textContent = "Preparing fonts and illustrations…";
      await document.fonts.ready;
      const fonts = await fontCss(snapshot.pages, snapshot.pageNumbers),
        assets = {};
      editor.assertAccount(generation);
      for (const a of snapshot.assets) {
        let stored = await D.getAsset(a.id),
          blob = stored && stored.blob;
        editor.assertAccount(generation);
        if (!snapshot.local) {
          blob = await editor.api(
            "/api/books/" + snapshot.id + "/assets/" + a.id + "?original=1",
            {},
            true,
          );
        }
        if (blob)
          assets[a.id] = {
            src: await dataUrl(blob),
            width: a.width,
            height: a.height,
          };
        else
          throw new Error(
            "An illustration is missing. Reload it before exporting.",
          );
      }
      const previews = [];
      for (let i = 0; i < snapshot.pages.length; i++) {
        editor.assertAccount(generation);
        $("export-progress").textContent =
          "Preparing page " + (i + 1) + " of " + snapshot.pages.length + "…";
        previews.push(
          await raster(snapshot.pages[i], assets, fonts, {
            ...M.pageRenderOptions(snapshot.pages[i], snapshot.pages, snapshot.pageNumbers),
            editable: format === "editable",
            economy,
          }),
        );
      }
      editor.assertAccount(generation);
      $("export-progress").textContent = "Creating your download…";
      const blob = await editor.api(
        "/api/books/export",
        {
          method: "POST",
          body: JSON.stringify({
            title: snapshot.title,
            pages: snapshot.pages,
            previews,
            format,
            arrangement: "cut",
            economy,
            guides: showGuides,
            book_id: snapshot.local ? null : snapshot.id,
            revision: snapshot.revision,
          }),
        },
        true,
      );
      download(
        blob,
        (snapshot.title || "Book") +
          " - cut and bind" +
          (format === "editable" ? " - editable" : "") +
          "." +
          (format === "pdf" ? "pdf" : "docx"),
      );
      $("export-progress").textContent =
        "Your book is ready. Check your downloads.";
    } finally {
      button.disabled = false;
    }
  }
  async function backup() {
    const generation = state.accountGeneration;
    // Backups must remain available as an escape hatch when device storage is full.
    await editor.localSaves.flush().catch(() => {});
    editor.assertAccount(generation);
    if (!state.book) throw editor.accountChangedError();
    const snapshot = M.clone(state.book),
      files = {};
    if (!snapshot.local) {
      const history = await editor.api(
        "/api/books/" + snapshot.id + "/history?include_pages=1",
      );
      snapshot.versions = history.versions;
    }
    files["book.json"] = window.BookZip.strToU8(JSON.stringify(snapshot));
    for (const a of snapshot.assets) {
      const stored = await D.getAsset(a.id);
      editor.assertAccount(generation);
      let blob = stored && stored.blob;
      if (!snapshot.local && a.ready)
        blob = await editor.api(
          "/api/books/" + snapshot.id + "/assets/" + a.id + "?original=1",
          {},
          true,
        );
      if (!blob)
        throw new Error(
          "An illustration is missing. Load it before downloading a backup.",
        );
      files["assets/" + a.id] = new Uint8Array(await blob.arrayBuffer());
    }
    editor.assertAccount(generation);
    download(
      new Blob([window.BookZip.zipSync(files, { level: 1 })], {
        type: "application/zip",
      }),
      snapshot.title + " - backup.zip",
    );
    editor.notify("Backup downloaded.");
  }
  async function importBackup(file) {
    const generation = state.accountGeneration, uid = state.user?.uid;
    await editor.localSaves.flush();
    if (file.size > 40 * 1024 * 1024)
      throw new Error("Choose a backup smaller than 40 MB.");
    let uncompressed = 0;
    const entries = window.BookZip.unzipSync(
      new Uint8Array(await file.arrayBuffer()),
      {
        filter: (entry) => {
          uncompressed += entry.originalSize;
          if (uncompressed > 80 * 1024 * 1024)
            throw new Error("This backup is too large.");
          return (
            entry.name === "book.json" ||
            /^assets\/[a-zA-Z0-9_-]+$/.test(entry.name)
          );
        },
      },
    );
    if (!entries["book.json"])
      throw new Error("This is not a Book Studio backup.");
    const raw = M.readBackup(
      JSON.parse(window.BookZip.strFromU8(entries["book.json"])),
    );
    const next = { ...raw, assets: [] },
      mapping = {};
    let assetBytes = 0;
    for (const old of raw.assets) {
      const bytes = entries["assets/" + old.id];
      if (!bytes)
        throw new Error("An illustration is missing from this backup.");
      const blob = new Blob([bytes], { type: old.mime });
      assetBytes += blob.size;
      if (assetBytes > 25 * 1024 * 1024)
        throw new Error("This backup exceeds the book image allowance.");
      const info = await imageInfo(blob),
        aid = M.id();
      mapping[old.id] = aid;
      const asset = {
        ...old,
        ...info,
        id: aid,
        local: true,
        ready: false,
        size: blob.size,
      };
      await D.putAsset({ ...asset, blob });
      editor.assertAccount(generation);
      next.assets.push(asset);
    }
    next.pages
      .concat(
        next.deletedPages,
        ...next.versions.map((v) => v.pages.concat(v.deletedPages)),
      )
      .forEach((p) =>
        p.items.forEach((o) => {
          if (o.assetId) o.assetId = mapping[o.assetId] || "";
          if (o.originalAssetId)
            o.originalAssetId = mapping[o.originalAssetId] || "";
        }),
      );
    editor.scopeDraft(next, uid);
    await D.putBook(next);
    editor.assertAccount(generation);
    await editor.openBook(next.id);
    editor.notify(state.user ? "Your imported book is saving to your account." : "Backup opened as a new local book.");
  }

  return {
    importImages, ensureCloudBook, publish, retryCloudSave, signIn, download,
    exportDialog, printPreview, doExport, backup, importBackup,
  };
}
