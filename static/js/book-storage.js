(function (root) {
  "use strict";
  // Old cloud caches and recovery copies predate cacheAccountUid. Keep them
  // private to their original account instead of treating them as guest drafts.
  const accountUid = (book) => String(book?.cacheAccountUid || book?.cloudAccountUid || book?.owner_uid || "");
  const canReadBook = (book, uid) => !!book && (accountUid(book)
    ? accountUid(book) === String(uid || "")
    : !!book.local);

  function createSaveQueue({ write, snapshot = (value) => structuredClone(value), key = () => "current", delay = 250, onState = () => {}, onSaved = () => {}, onError = () => {} }) {
    const pending = new Map();
    let active = null, timer = null, revision = 0, lastError = null;
    const state = () => ({ busy: !!(pending.size || active), pending: !!pending.size, inFlight: !!active, error: lastError });
    const report = () => onState(state());
    const clearTimer = () => { clearTimeout(timer); timer = null; };
    function start() {
      clearTimer();
      if (active) return active;
      if (!pending.size) return Promise.resolve();
      const [workKey, work] = pending.entries().next().value;
      pending.delete(workKey);
      // Clone only when a write starts. Fast edits replace one pending value.
      active = Promise.resolve().then(() => {
        work.value = snapshot(work.value);
        return write(work.value);
      }).then(() => {
        lastError = null;
        onSaved(work.value, work.revision);
      }).catch((error) => {
        lastError = error;
        if (!pending.has(workKey)) pending.set(workKey, work);
        onError(error);
        throw error;
      }).finally(() => {
        active = null;
        report();
        if (pending.size && !lastError) schedule(0);
      });
      report();
      return active;
    }
    function schedule(ms = delay) {
      clearTimer();
      timer = setTimeout(() => { start().catch(() => {}); }, ms);
    }
    return {
      enqueue(value) {
        pending.set(key(value), { value, revision: ++revision });
        if (!active) schedule();
        report();
        return revision;
      },
      async flush() {
        clearTimer();
        do { await (active || start()); clearTimer(); } while (pending.size);
      },
      state,
    };
  }
  let promise, database;
  function open() {
    if (database) return Promise.resolve(database);
    if (!promise)
      promise = new Promise((resolve, reject) => {
        const r = indexedDB.open("lp-book-studio-v1", 2);
        r.onupgradeneeded = () => {
          for (const name of ["books", "assets", "cloudSync"])
            if (!r.result.objectStoreNames.contains(name))
              r.result.createObjectStore(name, { keyPath: "id" });
        };
        r.onsuccess = () => {
          database = r.result;
          const opened = database;
          const forget = () => {
            if (database === opened) {
              database = null;
              promise = null;
            }
          };
          opened.onversionchange = () => { opened.close(); forget(); };
          opened.onclose = forget;
          // A blocked upgrade can succeed later after an older tab closes.
          // Replace its rejected promise so retries and cloud promotion recover.
          promise = Promise.resolve(database);
          resolve(database);
        };
        r.onblocked = () => reject(Object.assign(new Error("Save or download a backup of any unfinished work in your other Book Studio tabs, then close them and try again here. Your saved drafts stay on this device."), { code: "storage-blocked" }));
        r.onerror = () => {
          promise = null;
          reject(
            Object.assign(new Error("This browser could not open your saved drafts. Check that browser storage is allowed, then try again. Nothing has been deleted."), { code: "storage-unavailable" }),
          );
        };
      });
    return promise;
  }
  function run(store, mode, method, value) {
    const transact = (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = tx.objectStore(store)[method](value);
        let result;
        req.onsuccess = () => {
          result = req.result;
        };
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(new Error(tx.error?.name === "QuotaExceededError"
          ? "Device storage is full. Download a backup before closing."
          : "This device could not finish saving or opening your draft. Please retry; keep this tab open until your changes are saved."));
        // A browser may abort after a request succeeds, without a request error.
        // Settling on abort keeps autosave/retry from waiting forever.
        tx.onabort = tx.onerror;
      });
    return database ? transact(database) : open().then(transact);
  }
  async function claimSync(id, uid, holder) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("cloudSync", "readwrite"),
        store = tx.objectStore("cloudSync"),
        request = store.get(id);
      let result;
      request.onsuccess = () => {
        const previous = request.result;
        if (previous && previous.uid !== uid) {
          result = { ...previous, blocked: "account" };
          return;
        }
        if (previous?.holder && previous.holder !== holder && previous.expiresAt > Date.now()) {
          result = { ...previous, blocked: "tab" };
          return;
        }
        result = { id, uid, key: "draft:" + id, assets: {}, versions: {}, ...previous, holder, expiresAt: Date.now() + 60000 };
        store.put(result);
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(new Error("Your draft could not be prepared for cloud saving. Please retry."));
      tx.onabort = tx.onerror;
    });
  }
  async function completeCloudDraft(id, book, operation) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["books", "cloudSync"], "readwrite");
      const journal = tx.objectStore("cloudSync"), read = journal.get(id);
      read.onsuccess = () => {
        if (read.result?.holder !== operation.holder || read.result?.uid !== operation.uid) {
          reject(Object.assign(new Error("This book is now saving in another tab. Your draft is safe."), { code: "tab" }));
          tx.abort();
          return;
        }
        tx.objectStore("books").put(book);
        tx.objectStore("books").delete(id);
        journal.put({ ...operation, complete: true, holder: "", expiresAt: 0 });
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error("Your book reached the cloud, but this device could not finish saving. Please retry."));
      tx.onabort = tx.onerror;
    });
  }
  async function putSync(value, holder = value.holder) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("cloudSync", "readwrite"), journal = tx.objectStore("cloudSync"), read = journal.get(value.id);
      read.onsuccess = () => {
        if (read.result?.holder !== holder || read.result?.uid !== value.uid) {
          reject(Object.assign(new Error("This book is now saving in another tab. Your draft is safe."), { code: "tab" }));
          tx.abort();
          return;
        }
        journal.put(value);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error("Your cloud-saving progress could not be saved on this device. Please retry."));
      tx.onabort = tx.onerror;
    });
  }
  const exported = {
    accountUid,
    canReadBook,
    createSaveQueue,
    getBook: async (id, uid) => {
      const book = await run("books", "readonly", "get", id);
      return uid === undefined || canReadBook(book, uid) ? book : undefined;
    },
    putBook: (b) => run("books", "readwrite", "put", b),
    listBooks: async (uid) => {
      const books = await run("books", "readonly", "getAll");
      return uid === undefined ? books : books.filter((book) => canReadBook(book, uid));
    },
    deleteBook: (id) => run("books", "readwrite", "delete", id),
    getAsset: (id) => run("assets", "readonly", "get", id),
    putAsset: (a) => run("assets", "readwrite", "put", a),
    deleteAsset: (id) => run("assets", "readwrite", "delete", id),
    getSync: (id) => run("cloudSync", "readonly", "get", id),
    putSync,
    claimSync,
    completeCloudDraft,
  };
  if (typeof module === "object" && module.exports) module.exports = exported;
  else root.BookStorage = exported;
})(typeof window === "object" ? window : globalThis);
