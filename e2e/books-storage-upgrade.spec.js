const { test, expect } = require("@playwright/test");
const M = require("../static/js/book-model.js");

test("an older open tab shows a persistent storage message and retry keeps its draft and assets", async ({ page, context }) => {
  const draft = M.book("story");
  draft.title = "The draft from my older tab";
  const legacy = await context.newPage();
  await legacy.route("**/storage-legacy-fixture", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Older Book Studio tab</title>" }));
  await legacy.goto("/storage-legacy-fixture");
  await legacy.evaluate((book) => new Promise((resolve, reject) => {
    const request = indexedDB.open("lp-book-studio-v1", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("books", { keyPath: "id" });
      request.result.createObjectStore("assets", { keyPath: "id" });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      // An already deployed old tab has no versionchange handler; hold it open.
      window.legacyBookDatabase = request.result;
      const transaction = request.result.transaction(["books", "assets"], "readwrite");
      transaction.objectStore("books").put(book);
      transaction.objectStore("assets").put({ id: "original-sketch", blob: new Blob(["original sketch bytes"], { type: "image/png" }) });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    };
  }), draft);
  await page.route("**/static/js/firebase-bootstrap.js", (route) => route.fulfill({
    contentType: "text/javascript",
    body: "window.LectureProcessorBootstrap={getAuth:()=>({currentUser:null,onAuthStateChanged:fn=>queueMicrotask(()=>fn(null))})};",
  }));
  await page.goto("/books/" + draft.id);
  await expect(page.locator("body")).toHaveAttribute("data-ready", "error");
  await expect(page.getByRole("heading", { name: "Another Book Studio tab needs to close", exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Your saved drafts stay on this device");
  await expect(page.locator("#book-loading")).toBeHidden();
  await expect(page.getByRole("button", { name: "＋ New book", exact: true })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Your next idea starts here", exact: true })).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "error");
  await expect(page.getByRole("button", { name: "Reload this tab", exact: true })).toBeVisible();

  await legacy.close();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("#book-title")).toHaveValue(draft.title);
  await expect(page.locator("#save-state")).toHaveText("Saved on this device");
  await expect(page.locator(".book-thumb")).toHaveCount(4);
  await expect(page.getByRole("alert")).toHaveCount(0);
  const retained = await page.evaluate(async (id) => {
    const book = await window.BookStorage.getBook(id);
    const asset = await window.BookStorage.getAsset("original-sketch");
    const claim = await window.BookStorage.claimSync(id, "test-owner", "test-tab");
    return { title: book.title, bytes: await asset.blob.text(), claimed: claim.uid };
  }, draft.id);
  expect(retained).toEqual({ title: draft.title, bytes: "original sketch bytes", claimed: "test-owner" });
});

test("a revoked book keeps its access message visible after fonts load and retry", async ({ page }) => {
  await page.route("**/static/js/firebase-bootstrap.js", (route) => route.fulfill({
    contentType: "text/javascript",
    body: "window.LectureProcessorBootstrap={getAuth:()=>({currentUser:null,onAuthStateChanged:fn=>queueMicrotask(()=>fn(null))})};",
  }));
  let requests = 0;
  await page.route("**/api/books/revoked-book", (route) => {
    requests++;
    return route.fulfill({ status: 403, json: { error: "You do not have access to this book." } });
  });
  await page.goto("/books/revoked-book");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "error");
  await expect(page.getByRole("alert")).toContainText("You do not have access to this book.");
  await expect(page.getByRole("heading", { name: "This book is not available", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to your bookshelf", exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByRole("heading", { name: "Your next idea starts here", exact: true })).toHaveCount(0);
  await expect(page.locator("#book-loading")).toBeHidden();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "error");
  await expect(page.getByRole("alert")).toBeVisible();
  expect(requests).toBe(2);
});
