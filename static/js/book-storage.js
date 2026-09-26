(function (root) {
  "use strict";
  let promise, database;
  function open() {
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
          database.onversionchange = () => {
            database.close();
            database = null;
            promise = null;
          };
          resolve(database);
        };
        r.onblocked = () => reject(new Error("Close other Book Studio tabs, then reload to finish updating device storage. Your drafts are safe."));
        r.onerror = () =>
          reject(
            new Error(
              "This browser could not save your draft. Download a backup before closing.",
            ),
          );
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
        tx.onerror = () =>
          reject(
            new Error(
              "Device storage is full. Download a backup before closing.",
            ),
          );
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
  root.BookStorage = {
    getBook: (id) => run("books", "readonly", "get", id),
    putBook: (b) => run("books", "readwrite", "put", b),
    listBooks: () => run("books", "readonly", "getAll"),
    deleteBook: (id) => run("books", "readwrite", "delete", id),
    getAsset: (id) => run("assets", "readonly", "get", id),
    putAsset: (a) => run("assets", "readwrite", "put", a),
    deleteAsset: (id) => run("assets", "readwrite", "delete", id),
    getSync: (id) => run("cloudSync", "readonly", "get", id),
    putSync,
    claimSync,
    completeCloudDraft,
  };
})(window);
