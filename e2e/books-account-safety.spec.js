const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const M = require("../static/js/book-model.js");

async function setup(page, { missingAsset = false } = {}) {
  const state = { denied: new Set(), historyMissing: false, books: new Map() };
  for (const uid of ["alice", "bob"]) {
    const source = M.book("story");
    const book = { ...source, id: uid + "-book", title: uid + " private book", local: false, owner_uid: uid, role: "owner", revision: 1, page_ids: source.pages.map((p) => p.id), editor: null };
    const assets = missingAsset && uid === "alice" ? [{ id: "missing-image", name: "image.png", ready: true, width: 1, height: 1 }] : [];
    if (assets.length) source.pages[0].items.push(M.object("image", { assetId: "missing-image" }));
    state.books.set(book.id, { book, pages: source.pages, assets });
  }
  await page.route("**/static/js/firebase-bootstrap.js", (route) => route.fulfill({
    contentType: "text/javascript",
    body: `(() => {
      const makeUser = uid => uid ? {uid,displayName:uid,email:uid+'@example.com',getIdToken:async()=>uid} : null;
      let callback;
      const saved = sessionStorage.getItem('book-audit-user');
      const auth={currentUser:makeUser(saved === null ? 'alice' : saved),onAuthStateChanged(fn){callback=fn;queueMicrotask(()=>fn(auth.currentUser));}};
      window.changeBookTestAccount=async(uid)=>{auth.currentUser=makeUser(uid);sessionStorage.setItem('book-audit-user',uid||'');await callback(auth.currentUser);};
      window.LectureProcessorBootstrap={getAuth:()=>auth};
    })();`,
  }));
  await page.route(/\/static\/js\/book-studio(?:\.min)?\.js(?:\?.*)?$/, (route) => route.fulfill({
    contentType: "text/javascript", body: fs.readFileSync("static/js/book-studio.js", "utf8"),
  }));
  await page.route("**/api/books**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const uid = (request.headers().authorization || "").replace("Bearer ", "");
    const reply = (json, status = 200) => route.fulfill({ status, json });
    if (path === "/api/books") return reply({ books: [...state.books.values()].filter((entry) => entry.book.owner_uid === uid).map((entry) => entry.book), storage_available: true });
    const [, , , id, suffix] = path.split("/"), entry = state.books.get(id);
    if (!entry || entry.book.owner_uid !== uid || state.denied.has(id)) return reply({ error: "You do not have access to this book." }, 403);
    if (suffix === "assets") return reply({ error: "This image is no longer available." }, 404);
    if (suffix === "history") return state.historyMissing ? reply({ error: "This version is no longer available." }, 404) : reply({ versions: [] });
    if (suffix === "revision") return reply({ book: entry.book });
    if (suffix === "lease") {
      const body = request.postDataJSON();
      entry.book.editor = body.action === "release" ? null : { name: uid, expires_at: Date.now() / 1000 + 60 };
      return reply({ lease_token: "lease-" + id });
    }
    if (request.method() === "PUT") {
      const body = request.postDataJSON();
      Object.assign(entry.book, body.metadata, { revision: entry.book.revision + 1 });
      return reply({ revision: entry.book.revision });
    }
    return reply(entry);
  });
  return state;
}

test("account switch and signout remove private content while preserving owner-only recovery", async ({ page }) => {
  await setup(page);
  await page.goto("/books/alice-book");
  await expect(page.locator("#book-title")).toBeEnabled();
  await page.evaluate(async () => {
    const anonymous = window.BookModel.book(); anonymous.title = "Anonymous local book";
    await window.BookStorage.putBook(anonymous);
    const pending = window.BookModel.book(); pending.title = "Alice pending draft"; pending.cloudAccountUid = "alice";
    await window.BookStorage.putBook(pending);
    const legacy = window.BookModel.book(); legacy.id = "local-recovery-legacy"; legacy.title = "Alice legacy recovery"; legacy.owner_uid = "alice";
    await window.BookStorage.putBook(legacy);
  });
  await page.locator("#book-title").fill("Alice newest unsaved private words");
  await page.evaluate(() => window.changeBookTestAccount("bob"));
  await expect(page.locator("#workspace")).toBeHidden();
  await expect(page.locator("#book-title")).toHaveValue("");
  await expect(page.locator("#book-spread")).toBeEmpty();
  await expect(page.locator("#inspector")).toBeEmpty();
  await expect(page.locator("#dialog-content")).toBeEmpty();
  await expect(page.locator("body")).not.toContainText("Alice newest unsaved private words");
  await page.getByRole("tab", { name: "On this device", exact: true }).click();
  await expect(page.locator(".book-card")).toHaveCount(1);
  await expect(page.locator(".book-card")).toContainText("Anonymous local book");
  const recovery = await page.evaluate(async () => (await window.BookStorage.listBooks("alice")).find((book) => book.title === "Alice newest unsaved private words (recovered draft)"));
  expect(recovery.cacheAccountUid).toBe("alice");
  await page.evaluate(() => window.changeBookTestAccount(null));
  await expect(page.locator(".book-card")).toHaveCount(1);
  await page.evaluate(() => window.changeBookTestAccount("alice"));
  await expect(page.getByRole("button", { name: "Open Alice newest unsaved private words (recovered draft)", exact: true })).toBeVisible();
});

test("revoked access clears an open book and keeps unsaved work in owner-scoped recovery", async ({ page }) => {
  const state = await setup(page);
  await page.goto("/books/alice-book");
  await expect(page.locator("#book-title")).toBeEnabled();
  await page.locator("#book-title").fill("Retain these edits");
  state.denied.add("alice-book");
  await expect(page.locator("#workspace")).toBeHidden({ timeout: 10000 });
  await expect(page.getByRole("alert")).toContainText("You do not have access");
  await expect(page.locator("#book-spread")).toBeEmpty();
  await expect(page.locator("#export")).toBeHidden();
  const books = await page.evaluate(() => window.BookStorage.listBooks("alice"));
  expect(books.some((book) => book.local && book.title === "Retain these edits (recovered draft)")).toBe(true);
});

test("missing images and versions do not revoke access to the rest of a book", async ({ page }) => {
  const state = await setup(page, { missingAsset: true });
  await page.goto("/books/alice-book");
  await expect(page.locator("#book-title")).toBeEnabled();
  await expect(page.locator("#workspace")).toBeVisible();
  state.historyMissing = true;
  await page.getByRole("button", { name: "Version history", exact: true }).click();
  await expect(page.locator("#book-toast")).toContainText("version is no longer available");
  await expect(page.locator("#workspace")).toBeVisible();
  await expect(page.locator("#book-title")).toHaveValue("alice private book");
});

test("an old account's delayed error body cannot clear the next account's book", async ({ page }) => {
  const state = await setup(page);
  await page.addInitScript(() => {
    const fetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await fetch(...args);
      if (window.holdBookError && String(args[0]).endsWith("/revision") && !response.ok) {
        return { ok: false, status: response.status, json: async () => {
          window.bookErrorPending = true;
          await new Promise((resolve) => { window.releaseBookError = resolve; });
          return response.json();
        } };
      }
      return response;
    };
  });
  await page.goto("/books/alice-book");
  await expect(page.locator("#book-title")).toBeEnabled();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await page.evaluate(() => { window.holdBookError = true; });
  state.denied.add("alice-book");
  await expect.poll(() => page.evaluate(() => !!window.bookErrorPending), { timeout: 10000 }).toBe(true);
  await page.evaluate(() => window.changeBookTestAccount("bob"));
  await page.getByRole("button", { name: "Open bob private book", exact: true }).click();
  await expect(page.locator("#book-title")).toHaveValue("bob private book");
  await page.evaluate(() => window.releaseBookError());
  await expect(page.locator("#workspace")).toBeVisible();
  await expect(page.locator("#book-title")).toHaveValue("bob private book");
  await expect(page.getByRole("alert")).toHaveCount(0);
});
