(function (root) {
  "use strict";
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const metadata = (book) => Object.fromEntries(
    ["title", "folder", "tags", "favorite", "palette", "styles", "illustration", "theme", "pageNumbers"]
      .filter((key) => book[key] !== undefined).map((key) => [key, clone(book[key])]),
  );
  function error(message, code) {
    return Object.assign(new Error(message), { code });
  }
  function matches(actual, expected) {
    if (Array.isArray(expected))
      return Array.isArray(actual) && actual.length === expected.length && expected.every((value, i) => matches(actual[i], value));
    if (expected && typeof expected === "object")
      return !!actual && Object.keys(expected).every((key) => matches(actual[key], expected[key]));
    return actual === expected;
  }
  function remoteDocument(result) {
    return {
      metadata: metadata(result.book),
      page_ids: result.book.page_ids,
      deleted_page_ids: result.book.deleted_page_ids || [],
      pages: result.book.page_ids.concat(result.book.deleted_page_ids || []).map((id) => result.pages.find((page) => page.id === id)),
    };
  }
  function remap(book, assets) {
    const next = clone(book);
    const allPages = next.pages.concat(next.deletedPages || [], ...(next.versions || []).map((version) => version.pages.concat(version.deletedPages || [])));
    allPages.forEach((page) => { delete page.revision; delete page._id; delete page.updated_at; });
    allPages.forEach((page) => page.items.forEach((object) => {
      for (const key of ["assetId", "originalAssetId"])
        if (object[key]) {
          if (!assets[object[key]]) throw error("An illustration is still waiting to upload. Please retry cloud saving.", "asset");
          object[key] = assets[object[key]].id;
        }
    }));
    next.assets = next.assets.map((asset) => {
      if (!assets[asset.id]) throw error("An illustration is still waiting to upload. Please retry cloud saving.", "asset");
      return clone(assets[asset.id]);
    });
    return next;
  }
  function create(options) {
    const { storage, request, accountMatches, holder, session } = options;
    const inFlight = new Map();
    async function run(book, uid, hooks = {}) {
      const id = book.id;
      const sessionId = typeof session === "function" ? session() : session;
      let op = await storage.claimSync(id, uid, holder), renewal, renewalError, acquired = false;
      const assertCurrent = () => {
        if (!accountMatches(uid) || hooks.isCurrent?.() === false)
          throw error("Cloud saving paused. Open this draft in the same account to continue.", "account");
        if (renewalError) throw renewalError;
      };
      const send = async (url, settings) => {
        assertCurrent();
        const result = await request(url, settings, uid);
        assertCurrent();
        return result;
      };
      const remember = async () => {
        assertCurrent();
        op.expiresAt = Date.now() + 60000;
        await storage.putSync(clone(op));
      };
      if (op.blocked === "account")
        throw error("This draft is waiting for the account that first saved it. Sign in with that account to continue.", "account");
      if (op.blocked === "tab")
        throw error("This book is saving in another tab. Finish there, then retry here.", "tab");
      try {
        assertCurrent();
        if (op.complete) return { existingId: op.remoteId };
        await hooks.onClaim?.();
        hooks.onState?.("saving");
        if (!op.remoteId) {
          const pages = clone(book.pages);
          pages.forEach((page) => page.items.forEach((object) => {
            object.assetId = "";
            object.originalAssetId = "";
          }));
          const result = await send("/api/books", {
            method: "POST",
            body: JSON.stringify({ ...metadata(book), pages, idempotency_key: op.key }),
          });
          op.remoteId = result.book.id;
          op.revision = result.book.revision;
          await remember();
        }
        const lease = await send("/api/books/" + op.remoteId + "/lease", {
          method: "POST",
          body: JSON.stringify({ action: "acquire", lease_token: op.session === sessionId ? op.leaseToken || "" : "" }),
        });
        acquired = true;
        op.leaseToken = lease.lease_token;
        op.session = sessionId;
        await remember();
        renewal = setInterval(() => {
          send("/api/books/" + op.remoteId + "/lease", {
            method: "POST",
            body: JSON.stringify({ action: "renew", lease_token: op.leaseToken }),
          }).then(remember).catch((e) => { renewalError = e; });
        }, 20000);
        const remote = await send("/api/books/" + op.remoteId);
        if (op.pendingWrite && remote.book.revision > op.pendingWrite.baseRevision) {
          if (!matches(remoteDocument(remote), op.pendingWrite.document))
            throw error("A newer cloud version is available. Your draft is safe on this device; open the cloud book to compare it.", "conflict");
          op.revision = remote.book.revision;
          delete op.pendingWrite;
          await remember();
        } else if (remote.book.revision !== op.revision) {
          throw error("A newer cloud version is available. Your draft is safe on this device; open the cloud book to compare it.", "conflict");
        }
        for (;;) {
          assertCurrent();
          if (hooks.isBusy?.()) {
            await new Promise((resolve) => setTimeout(resolve, 80));
            continue;
          }
          for (const asset of book.assets) {
            if (op.assets[asset.id]) continue;
            const stored = await storage.getAsset(asset.id);
            if (!stored?.blob) throw error("An illustration is missing from this device. Add it again before retrying cloud saving.", "asset");
            const form = new FormData();
            form.append("image", stored.blob, asset.name);
            form.append("lease_token", op.leaseToken);
            form.append("base_revision", op.revision);
            form.append("idempotency_key", "asset:" + asset.id);
            const result = await send("/api/books/" + op.remoteId + "/assets", { method: "POST", body: form });
            op.assets[asset.id] = result.asset;
            await storage.putAsset({ ...result.asset, blob: stored.blob });
            await remember();
          }
          if (hooks.isBusy?.() || book.assets.some((asset) => !op.assets[asset.id])) continue;
          const source = clone(book), snapshot = remap(source, op.assets);
          const document = {
            metadata: metadata(snapshot),
            pages: snapshot.pages.concat(snapshot.deletedPages || []),
            page_ids: snapshot.pages.map((page) => page.id),
            deleted_page_ids: (snapshot.deletedPages || []).map((page) => page.id),
          };
          op.pendingWrite = { baseRevision: op.revision, document };
          await remember();
          const saved = await send("/api/books/" + op.remoteId, {
            method: "PUT",
            body: JSON.stringify({ ...document, base_revision: op.revision, lease_token: op.leaseToken }),
          });
          op.revision = saved.revision;
          delete op.pendingWrite;
          await remember();
          for (const version of snapshot.versions || []) {
            const versionKey = version.id;
            if (op.versions[versionKey]) continue;
            await send("/api/books/" + op.remoteId + "/history", {
              method: "POST",
              body: JSON.stringify({
                name: version.name,
                pages: version.pages.concat(version.deletedPages || []),
                page_ids: version.pages.map((page) => page.id),
                deleted_page_ids: (version.deletedPages || []).map((page) => page.id),
                metadata: version.metadata || metadata(snapshot),
                base_revision: op.revision,
                lease_token: op.leaseToken,
                idempotency_key: "version:" + versionKey,
              }),
            });
            op.versions[versionKey] = true;
            await remember();
          }
          // Edits made while uploads were running get another complete save before promotion.
          if (hooks.isBusy?.() || !matches(book, source) || !matches(source, book)) continue;
          assertCurrent();
          hooks.onState?.("finishing");
          const cloud = {
            ...snapshot, id: op.remoteId, owner_uid: uid, role: "owner", local: false,
            revision: op.revision, pending: false,
            page_ids: snapshot.pages.map((page) => page.id),
            deleted_page_ids: (snapshot.deletedPages || []).map((page) => page.id),
          };
          delete cloud.cloudAccountUid;
          delete cloud.cloudSaveError;
          await storage.completeCloudDraft(id, cloud, op);
          assertCurrent();
          return { book: cloud, leaseToken: op.leaseToken, assetMap: clone(op.assets) };
        }
      } catch (e) {
        if (acquired && accountMatches(uid)) {
          try {
            await request("/api/books/" + op.remoteId + "/lease", {
              method: "POST", body: JSON.stringify({ action: "release", lease_token: op.leaseToken }),
            }, uid);
            op.leaseToken = "";
          } catch (_) { /* The server lease expires if a connection is unavailable. */ }
        }
        throw e;
      } finally {
        clearInterval(renewal);
        op.holder = "";
        op.expiresAt = 0;
        const latest = await storage.getSync(id);
        if (latest?.holder === holder) await storage.putSync({ ...op, complete: latest.complete || op.complete }, holder);
      }
    }
    return {
      sync(book, uid, hooks) {
        const key = uid + ":" + book.id;
        if (!inFlight.has(key)) {
          const pending = run(book, uid, hooks).finally(() => inFlight.delete(key));
          inFlight.set(key, pending);
        }
        return inFlight.get(key);
      },
    };
  }
  const exports = { create, metadata, remap, matches, remoteDocument };
  if (typeof module === "object" && module.exports) module.exports = exports;
  else root.BookCloudSync = exports;
})(typeof window === "object" ? window : globalThis);
