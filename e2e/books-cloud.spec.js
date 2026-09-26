const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const M = require("../static/js/book-model.js");
const Sync = require("../static/js/book-cloud-sync.js");

async function setupCloud(page, options = {}) {
  const state = { books: new Map(), keys: new Map(), creates: 0, puts: 0, failCreate: options.failCreate || 0 };
  await page.route("**/static/js/firebase-bootstrap.js", (route) => route.fulfill({
    contentType: "text/javascript",
    body: `(() => {
      const makeUser = uid => uid ? {uid,displayName:'Book Author',email:uid+'@example.com',getIdToken:async()=>uid} : null;
      let callback;
      const auth={currentUser:makeUser(sessionStorage.getItem('book-test-user') || ${options.guest ? "null" : "'owner'"}),
        onAuthStateChanged(fn){callback=fn;queueMicrotask(()=>fn(auth.currentUser));},
        async signInWithPopup(){auth.currentUser=makeUser('owner');sessionStorage.setItem('book-test-user','owner');await callback(auth.currentUser);return {user:auth.currentUser};}};
      window.LectureProcessorBootstrap={getAuth:()=>auth};
      window.firebase={auth:{GoogleAuthProvider:class{}}};
    })();`,
  }));
  // Exercise authored source while other agents regenerate the production bundle separately.
  await page.route(/\/static\/js\/book-studio(?:\.min)?\.js(?:\?.*)?$/, (route) => route.fulfill({
    contentType: "text/javascript", body: fs.readFileSync("static/js/book-studio.js", "utf8"),
  }));
  await page.route("**/api/books**", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const body = method === "GET" ? null : request.postDataJSON();
    const reply = (json, status = 200) => route.fulfill({ status, json });
    if (url.pathname === "/api/books") {
      if (method === "GET") return reply({ books: [...state.books.values()].map((entry) => entry.book), storage_available: true });
      const key = body.idempotency_key;
      let id = state.keys.get(key);
      if (!id) {
        id = "cloud-" + ++state.creates;
        state.keys.set(key, id);
        state.books.set(id, {
          book: { ...Sync.metadata(body), id, schema_version: 1, revision: 1, role: "owner", owner_uid: "owner", creation_key: key, page_ids: body.pages.map((p) => p.id), deleted_page_ids: [], updated_at: Date.now() / 1000, deleted: false, editor: null },
          pages: body.pages, assets: [], versions: [],
        });
      }
      if (state.failCreate) { state.failCreate--; return route.abort("failed"); }
      return reply({ book: state.books.get(id).book }, 201);
    }
    const [, , , id, suffix] = url.pathname.split("/");
    const entry = state.books.get(id);
    if (!entry) return reply({ error: "This book is unavailable." }, 404);
    if (suffix === "lease") {
      entry.book.editor = body.action === "release" ? null : { name: "Book Author", expires_at: Date.now() / 1000 + 60 };
      return reply({ lease_token: "lease-" + id });
    }
    if (suffix === "revision") return reply({ book: entry.book });
    if (suffix === "history") {
      if (method === "GET") return reply({ versions: entry.versions });
      entry.versions.push({ ...body, id: body.idempotency_key || "version" });
      return reply({ ok: true });
    }
    if (method === "PUT") {
      if (body.base_revision !== entry.book.revision) return reply({ error: "A newer version is available." }, 409);
      state.puts++;
      Object.assign(entry.book, body.metadata, { page_ids: body.page_ids, deleted_page_ids: body.deleted_page_ids, revision: entry.book.revision + 1 });
      const byId = new Map(entry.pages.map((p) => [p.id, p]));
      body.pages.forEach((p) => byId.set(p.id, p));
      entry.pages = [...byId.values()];
      return reply({ revision: entry.book.revision });
    }
    return reply({ book: entry.book, pages: url.searchParams.has("cover") ? [entry.pages.find((p) => p.id === entry.book.page_ids[0])] : entry.pages, assets: entry.assets });
  });
  return state;
}
async function newBook(page) {
  await page.getByRole("button", { name: "＋ New book", exact: true }).click();
  await page.getByRole("button", { name: "Picture book A little room for a big adventure.", exact: true }).click();
  await expect(page.locator("#workspace")).toBeVisible();
}
async function seedDraft(page, book) {
  await page.evaluate(async (source) => {
    await window.BookStorage.putBook(source);
  }, book);
}

test("signed-in new books and copies save to the account without a publishing button", async ({ page }) => {
  const state = await setupCloud(page);
  await page.goto("/books");
  await newBook(page);
  await expect(page.locator("#save-state")).toHaveText("Saved to cloud");
  await expect(page).toHaveURL(/\/books\/cloud-1$/);
  await page.locator("#book-title").fill("An automatically saved story");
  await expect.poll(() => state.books.get("cloud-1").book.title, { timeout: 10000 }).toBe("An automatically saved story");
  await page.getByRole("button", { name: "Book details", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save to my account", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Make a copy", exact: true }).click();
  await expect(page).toHaveURL(/\/books\/cloud-2$/);
  await expect(page.locator("#save-state")).toHaveText("Saved to cloud");
  expect(state.creates).toBe(2);
  await page.reload();
  await expect(page.locator("#book-title")).toHaveValue("An automatically saved story (copy)");
});

test("a lost creation response exposes Retry and resumes the same account book after reload", async ({ page }) => {
  const state = await setupCloud(page, { failCreate: 1 });
  await page.goto("/books");
  await newBook(page);
  await expect(page.locator("#retry-cloud-save")).toBeVisible();
  await expect(page.locator("#save-state")).toContainText("Couldn’t save to cloud");
  await page.locator("#book-title").fill("Words written while saving was unavailable");
  await page.reload();
  await expect(page.locator("#save-state")).toHaveText("Saved to cloud");
  await expect(page).toHaveURL(/\/books\/cloud-1$/);
  expect(state.creates).toBe(1);
  expect(state.books.get("cloud-1").book.title).toBe("Words written while saving was unavailable");
  await expect(page.locator("#retry-cloud-save")).toBeHidden();
});

test("guest drafts automatically upload after sign-in, while unopened drafts stay on the device", async ({ page }) => {
  const state = await setupCloud(page, { guest: true });
  await page.goto("/books");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  const untouched = M.book("blank"); untouched.title = "Keep this unopened draft local";
  await seedDraft(page, untouched);
  await newBook(page);
  await page.locator("#book-title").fill("The guest's story");
  await expect(page.locator("#save-state")).toHaveText("Saved on this device");
  await page.getByRole("button", { name: "Sign in with Google", exact: true }).click();
  await expect(page.locator("#save-state")).toHaveText("Saved to cloud");
  expect(state.creates).toBe(1);
  expect(state.books.get("cloud-1").book.title).toBe("The guest's story");
  expect(await page.evaluate(async (id) => (await window.BookStorage.getBook(id)).local, untouched.id)).toBe(true);
});

test("opening an old device draft saves deleted pages and versions; recovery drafts stay local", async ({ page }) => {
  const state = await setupCloud(page);
  await page.goto("/books");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  const draft = M.book("story"); draft.title = "A device draft";
  draft.deletedPages.push({ ...M.page(), id: "deleted-page", title: "A recoverable page" });
  draft.versions.push({ id: "old-milestone", name: "Earlier version", pages: structuredClone(draft.pages), deletedPages: structuredClone(draft.deletedPages), metadata: Sync.metadata(draft) });
  await seedDraft(page, draft);
  await page.goto("/books/" + draft.id);
  await expect(page.locator("#save-state")).toHaveText("Saved to cloud");
  expect(state.books.get("cloud-1").book.deleted_page_ids).toEqual(["deleted-page"]);
  expect(state.books.get("cloud-1").versions).toHaveLength(1);
  const recovery = M.book(); recovery.id = "local-recovery-special";
  await seedDraft(page, recovery);
  await page.goto("/books/" + recovery.id);
  await expect(page.locator("#save-state")).toHaveText("Saved on this device");
  expect(state.creates).toBe(1);
});

test("signed-in ZIP imports save automatically and a pending account book stays in My books", async ({ page }) => {
  const state = await setupCloud(page);
  await page.goto("/books");
  await newBook(page);
  await expect(page.locator("#save-state")).toHaveText("Saved to cloud");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download backup", exact: true }).click();
  const path = await (await downloaded).path();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("link", { name: "Book Studio library", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  state.failCreate = 1;
  await page.locator("#backup-input").setInputFiles(path);
  await expect(page.locator("#retry-cloud-save")).toBeVisible();
  await page.getByRole("link", { name: "Book Studio library", exact: true }).click();
  await expect(page.getByRole("tab", { name: "My books", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".book-card").filter({ hasText: "Waiting to save to your account" })).toHaveCount(1);
  await page.getByRole("button", { name: /Open .*imported/ }).click();
  await expect(page.locator("#save-state")).toHaveText("Saved to cloud");
  expect(state.creates).toBe(2);
});
