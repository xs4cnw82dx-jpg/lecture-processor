const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../static/js/book-model.js");
const Sync = require("../static/js/book-cloud-sync.js");
const clone = (value) => structuredClone(value);

function fixture() {
  const book = M.book("story"), operations = new Map(), books = new Map(), assets = new Map();
  const remote = { book: null, pages: [], assets: [], versions: [], creates: 0, puts: 0 };
  let account = "owner", intercept = async () => {};
  const storage = {
    async getSync(id) { return clone(operations.get(id)); },
    async putSync(op, holder = op.holder) {
      if (operations.get(op.id)?.holder !== holder) throw Object.assign(new Error("This book is now saving in another tab."), { code: "tab" });
      operations.set(op.id, clone(op));
    },
    async claimSync(id, uid, holder) {
      const op = operations.get(id);
      if (op && op.uid !== uid) return { ...clone(op), blocked: "account" };
      if (op?.holder && op.holder !== holder && op.expiresAt > Date.now()) return { ...clone(op), blocked: "tab" };
      const next = { id, uid, key: "draft:" + id, assets: {}, versions: {}, ...clone(op || {}), holder, expiresAt: Date.now() + 60000 };
      operations.set(id, clone(next));
      return next;
    },
    async getAsset(id) { return assets.get(id); },
    async putAsset(asset) { assets.set(asset.id, asset); },
    async completeCloudDraft(id, result, op) {
      books.set(result.id, clone(result));
      books.delete(id);
      operations.set(id, { ...clone(op), complete: true, holder: "", expiresAt: 0 });
    },
  };
  books.set(book.id, book);
  const request = async (url, options = {}, uid) => {
    assert.equal(uid, "owner");
    const method = options.method || "GET";
    const body = typeof options.body === "string" ? JSON.parse(options.body) : options.body;
    await intercept("before", { url, method, body });
    let result;
    if (url === "/api/books") {
      if (!remote.book) {
        remote.creates++;
        remote.book = { ...Sync.metadata(body), id: "cloud-book", owner_uid: uid, revision: 1, page_ids: body.pages.map((p) => p.id), deleted_page_ids: [] };
        remote.pages = clone(body.pages);
      }
      result = { book: clone(remote.book) };
    } else if (url.endsWith("/lease")) result = { lease_token: "lease" };
    else if (url.endsWith("/assets")) {
      const key = body.get("idempotency_key");
      let asset = remote.assets.find((a) => a.key === key);
      if (!asset) {
        asset = { id: "remote-" + remote.assets.length, name: body.get("image").name, ready: true, key };
        remote.assets.push(asset);
      }
      result = { asset: clone(asset) };
    } else if (url.endsWith("/history")) {
      if (!remote.versions.some((v) => v.idempotency_key === body.idempotency_key)) remote.versions.push(clone(body));
      result = { ok: true };
    } else if (method === "PUT") {
      assert.equal(body.base_revision, remote.book.revision);
      remote.puts++;
      remote.pages = clone(body.pages);
      Object.assign(remote.book, body.metadata, { page_ids: body.page_ids, deleted_page_ids: body.deleted_page_ids, revision: remote.book.revision + 1 });
      result = { revision: remote.book.revision };
    } else result = clone(remote);
    await intercept("after", { url, method, body });
    return result;
  };
  return {
    book, books, assets, operations, remote, storage,
    setAccount: (value) => { account = value; },
    intercept: (fn) => { intercept = fn; },
    sync(holder = "tab-one") { return Sync.create({ storage, request, holder, session: holder, accountMatches: (uid) => uid === account }); },
    addImage(id) {
      const asset = { id, name: id + ".png", local: true, width: 20, height: 20 };
      assets.set(id, { ...asset, blob: new Blob(["image " + id], { type: "image/png" }) });
      book.assets.push(asset);
      return asset;
    },
  };
}

test("promotion preserves current edits, originals, deleted pages and named versions", async () => {
  const f = fixture();
  f.addImage("sketch"); f.addImage("finished");
  f.book.pages[1].items.push(M.object("image", { assetId: "finished", originalAssetId: "sketch" }));
  f.book.deletedPages.push({ ...M.page(), id: "deleted", items: [M.object("image", { assetId: "sketch" })] });
  f.book.versions.push({ id: "first-version", name: "Original draft", pages: clone(f.book.pages), deletedPages: clone(f.book.deletedPages), metadata: Sync.metadata(f.book) });
  let edited = false;
  f.intercept(async (phase, call) => {
    if (!edited && phase === "after" && call.url.endsWith("/assets")) {
      edited = true;
      f.book.title = "The edit made during an upload";
      f.book.pages[1].items[0].text = "The newest words";
    }
  });
  const result = await f.sync().sync(f.book, "owner");
  assert.equal(result.book.local, false);
  assert.equal(f.remote.book.title, "The edit made during an upload");
  assert.deepEqual(f.remote.book.deleted_page_ids, ["deleted"]);
  assert.equal(f.remote.pages[1].items[0].text, "The newest words");
  assert.equal(f.remote.pages[1].items.at(-1).originalAssetId, "remote-0");
  assert.equal(f.remote.pages[1].items.at(-1).assetId, "remote-1");
  assert.equal(f.remote.versions[0].pages[1].items.at(-1).originalAssetId, "remote-0");
  assert.equal(f.remote.assets.length, 2);
  assert.equal(f.books.has(f.book.id), false);
  assert.equal(f.books.get("cloud-book").title, f.remote.book.title);
});

test("lost create, image, content and version responses resume without duplicate books or assets", async () => {
  for (const target of ["create", "asset", "content", "version"]) {
    const f = fixture();
    f.addImage("drawing");
    f.book.pages[1].items.push(M.object("image", { assetId: "drawing" }));
    f.book.pages.forEach((p) => { p.revision = 17; p.updated_at = 123; p._id = p.id; });
    f.book.versions.push({ id: "milestone", name: "One", pages: clone(f.book.pages), deletedPages: [], metadata: Sync.metadata(f.book) });
    let failed = false;
    f.intercept(async (phase, call) => {
      const matches = target === "create" ? call.url === "/api/books" : target === "asset" ? call.url.endsWith("/assets") : target === "content" ? call.method === "PUT" : call.url.endsWith("/history");
      if (!failed && phase === "after" && matches) { failed = true; throw new Error("Connection interrupted"); }
    });
    await assert.rejects(f.sync().sync(f.book, "owner"), /Connection interrupted/);
    assert.equal(f.books.has(f.book.id), true);
    const result = await f.sync().sync(f.book, "owner");
    assert.equal(result.book.local, false, target);
    assert.equal(f.remote.creates, 1, target);
    assert.equal(f.remote.assets.length, 1, target);
    assert.equal(f.remote.versions.length, 1, target);
  }
});

test("a delayed tab cannot replace another tab's promotion journal after its claim expires", async () => {
  const f = fixture();
  f.intercept(async (phase, call) => {
    if (phase === "after" && call.method === "PUT") {
      const op = f.operations.get(f.book.id);
      f.operations.set(f.book.id, { ...op, holder: "tab-two", expiresAt: Date.now() + 60000 });
    }
  });
  await assert.rejects(f.sync().sync(f.book, "owner"), /another tab/);
  assert.equal(f.operations.get(f.book.id).holder, "tab-two");
  assert.equal(f.books.has(f.book.id), true);
});

test("account changes pause promotion and never attach an old draft to the new user", async () => {
  const f = fixture();
  f.intercept(async (phase, call) => {
    if (phase === "after" && call.url === "/api/books") f.setAccount("other-user");
  });
  await assert.rejects(f.sync().sync(f.book, "owner"), /same account/);
  assert.equal(f.book.local, true);
  assert.equal(f.books.has(f.book.id), true);
  assert.equal(f.remote.puts, 0);
  await assert.rejects(f.sync().sync(f.book, "other-user"), /account that first saved/);
  f.setAccount("owner"); f.intercept(async () => {});
  assert.equal((await f.sync().sync(f.book, "owner")).book.owner_uid, "owner");
  assert.equal(f.remote.creates, 1);
});

test("another tab cannot promote the same draft concurrently", async () => {
  const f = fixture();
  let release, reached;
  const held = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { reached = resolve; });
  f.intercept(async (phase, call) => {
    if (phase === "before" && call.url === "/api/books") { reached(); await held; }
  });
  const pending = f.sync("tab-one").sync(f.book, "owner");
  await started;
  await assert.rejects(f.sync("tab-two").sync(f.book, "owner"), /another tab/);
  release();
  await pending;
  assert.equal(f.remote.creates, 1);
});

test("remote changes after an interrupted save remain protected from an old draft", async () => {
  const f = fixture();
  let interrupted = false;
  f.intercept(async (phase, call) => {
    if (!interrupted && phase === "after" && call.method === "PUT") { interrupted = true; throw new Error("Connection interrupted"); }
  });
  await assert.rejects(f.sync().sync(f.book, "owner"), /Connection interrupted/);
  f.remote.book.title = "A collaborator's newer title";
  f.remote.book.revision++;
  await assert.rejects(f.sync().sync(f.book, "owner"), /newer cloud version/);
  assert.equal(f.remote.book.title, "A collaborator's newer title");
  assert.equal(f.remote.puts, 1);
  assert.equal(f.books.has(f.book.id), true);
});
