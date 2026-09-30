const test = require("node:test");
const assert = require("node:assert/strict");
const Storage = require("../static/js/book-storage.js");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test("account drafts and legacy recovery copies are private, anonymous drafts remain available", () => {
  const books = [
    { id: "anonymous", local: true },
    { id: "pending", local: true, cloudAccountUid: "alice" },
    { id: "local-recovery-old", local: true, owner_uid: "alice" },
    { id: "cloud", local: false, owner_uid: "alice" },
    { id: "collaborator", local: true, cacheAccountUid: "alice", owner_uid: "owner" },
    { id: "unknown-cloud", local: false },
  ];
  const visible = (uid) => books.filter((book) => Storage.canReadBook(book, uid)).map((book) => book.id);
  assert.deepEqual(visible(""), ["anonymous"]);
  assert.deepEqual(visible("bob"), ["anonymous"]);
  assert.deepEqual(visible("alice"), ["anonymous", "pending", "local-recovery-old", "cloud", "collaborator"]);
  assert.deepEqual(visible("owner"), ["anonymous"]);
});

test("rapid edits clone and write only the latest value when explicitly flushed", async () => {
  const writes = [];
  let clones = 0;
  const queue = Storage.createSaveQueue({
    delay: 10000,
    snapshot: (value) => { clones++; return structuredClone(value); },
    write: async (value) => writes.push(value),
  });
  const book = { text: "" };
  for (let i = 1; i <= 100; i++) { book.text = String(i); queue.enqueue(book); }
  assert.equal(clones, 0);
  assert.equal(queue.state().busy, true);
  await queue.flush();
  assert.deepEqual(writes, [{ text: "100" }]);
  assert.equal(clones, 1);
  assert.equal(queue.state().busy, false);
});

test("one in-flight write is followed by the newest edit before flush resolves", async () => {
  const started = deferred(), held = deferred(), writes = [], saved = [];
  let simultaneous = 0, maxSimultaneous = 0;
  const queue = Storage.createSaveQueue({
    delay: 10000,
    write: async (value) => {
      maxSimultaneous = Math.max(maxSimultaneous, ++simultaneous);
      writes.push(value);
      if (writes.length === 1) { started.resolve(); await held.promise; }
      simultaneous--;
    },
    onSaved: (_, revision) => saved.push(revision),
  });
  queue.enqueue({ text: "first" });
  const flushing = queue.flush();
  await started.promise;
  queue.enqueue({ text: "second" });
  queue.enqueue({ text: "latest" });
  held.resolve();
  await flushing;
  assert.deepEqual(writes, [{ text: "first" }, { text: "latest" }]);
  assert.deepEqual(saved, [1, 3]);
  assert.equal(maxSimultaneous, 1);
  assert.equal(queue.state().busy, false);
});

test("failed saves stay dirty and retry the newest revision without losing another owner's draft", async () => {
  const writes = [], errors = [];
  let fail = true;
  const queue = Storage.createSaveQueue({
    delay: 10000, key: (value) => value.owner,
    write: async (value) => {
      if (fail) throw new Error("Device storage is full");
      writes.push(value);
    },
    onError: (error) => errors.push(error.message),
  });
  queue.enqueue({ owner: "alice", text: "retained" });
  await assert.rejects(queue.flush(), /storage is full/);
  assert.equal(queue.state().busy, true);
  assert.equal(queue.state().error.message, "Device storage is full");
  queue.enqueue({ owner: "bob", text: "new account" });
  fail = false;
  await queue.flush();
  assert.deepEqual(writes, [{ owner: "alice", text: "retained" }, { owner: "bob", text: "new account" }]);
  assert.equal(queue.state().error, null);
  assert.equal(queue.state().busy, false);
  assert.deepEqual(errors, ["Device storage is full"]);
});

test("a failed old write never replaces edits queued while that write was running", async () => {
  const started = deferred(), held = deferred(), writes = [];
  let first = true;
  const queue = Storage.createSaveQueue({
    delay: 10000,
    write: async (value) => {
      if (first) { first = false; started.resolve(); await held.promise; throw new Error("aborted"); }
      writes.push(value);
    },
  });
  queue.enqueue({ text: "old" });
  const firstFlush = queue.flush();
  await started.promise;
  queue.enqueue({ text: "newest" });
  held.resolve();
  await assert.rejects(firstFlush, /aborted/);
  await queue.flush();
  assert.deepEqual(writes, [{ text: "newest" }]);
});
