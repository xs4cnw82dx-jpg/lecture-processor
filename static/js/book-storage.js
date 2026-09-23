(function (root) {
  "use strict";
  let promise, database;
  function open() {
    if (!promise)
      promise = new Promise((resolve, reject) => {
        const r = indexedDB.open("lp-book-studio-v1", 1);
        r.onupgradeneeded = () => {
          r.result.createObjectStore("books", { keyPath: "id" });
          r.result.createObjectStore("assets", { keyPath: "id" });
        };
        r.onsuccess = () => {
          database = r.result;
          resolve(database);
        };
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
  root.BookStorage = {
    getBook: (id) => run("books", "readonly", "get", id),
    putBook: (b) => run("books", "readwrite", "put", b),
    listBooks: () => run("books", "readonly", "getAll"),
    deleteBook: (id) => run("books", "readwrite", "delete", id),
    getAsset: (id) => run("assets", "readonly", "get", id),
    putAsset: (a) => run("assets", "readwrite", "put", a),
    deleteAsset: (id) => run("assets", "readwrite", "delete", id),
  };
})(window);
