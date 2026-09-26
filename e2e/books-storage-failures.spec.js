const { test, expect } = require("@playwright/test");
const path = require("node:path");

async function loadStorage(page) {
  await page.route("**/book-storage-audit", (route) => route.fulfill({
    contentType: "text/html", body: "<!doctype html><title>Book storage recovery</title>",
  }));
  await page.goto("/book-storage-audit");
  await page.addScriptTag({ path: path.resolve("static/js/book-storage.js") });
}

test("an aborted save settles, preserves the previous draft and can be retried", async ({ page }) => {
  await loadStorage(page);
  const result = await page.evaluate(async () => {
    await window.BookStorage.putBook({ id: "draft", title: "The saved story" });
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = transaction.apply(this, args);
      const objectStore = tx.objectStore.bind(tx);
      tx.objectStore = function (name) {
        const store = objectStore(name), put = store.put.bind(store);
        store.put = function (...values) {
          const request = put(...values);
          // This produces only a transaction abort: the request itself succeeds.
          request.addEventListener("success", () => tx.abort());
          return request;
        };
        return store;
      };
      return tx;
    };
    const outcome = await Promise.race([
      window.BookStorage.putBook({ id: "draft", title: "Interrupted story" })
        .then(() => "Unexpected success", (error) => error.message),
      new Promise((resolve) => setTimeout(() => resolve("Save never settled"), 1000)),
    ]);
    IDBDatabase.prototype.transaction = transaction;
    const beforeRetry = await window.BookStorage.getBook("draft");
    await window.BookStorage.putBook({ id: "draft", title: "The retried story" });
    return { outcome, beforeRetry, afterRetry: await window.BookStorage.getBook("draft") };
  });
  expect(result.outcome).toContain("Please retry");
  expect(result.outcome).not.toContain("full");
  expect(result.beforeRetry.title).toBe("The saved story");
  expect(result.afterRetry.title).toBe("The retried story");
});

test("an unexpectedly closed storage connection reopens without losing saved drafts", async ({ page }) => {
  await loadStorage(page);
  const result = await page.evaluate(async () => {
    const open = indexedDB.open.bind(indexedDB);
    let database, opens = 0;
    indexedDB.open = function (...args) {
      opens++;
      const request = open(...args);
      request.addEventListener("success", () => { database = request.result; });
      return request;
    };
    await window.BookStorage.putBook({ id: "draft", title: "Still safe" });
    database.close();
    database.dispatchEvent(new Event("close"));
    const book = await window.BookStorage.getBook("draft");
    return { title: book.title, opens };
  });
  expect(result).toEqual({ title: "Still safe", opens: 2 });
});
