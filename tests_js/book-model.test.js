const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../static/js/book-model.js");
test("covers, spreads and odd page placeholder use the physical book model", () => {
  const b = M.book();
  assert.deepEqual(M.spreads(b.pages), [
    [b.pages[0].id],
    [b.pages[1].id, b.pages[2].id],
    [b.pages[3].id],
  ]);
  b.pages.splice(2, 0, M.page());
  assert.equal(M.spreads(b.pages)[2][1], null);
  assert.equal(M.spreads(b.pages, true).length, 5);
  assert.equal(M.W * 2, 297);
  assert.equal(M.H, 210);
});
test("import sizing preserves proportions, fits half-page limits and never enlarges tiny images", () => {
  for (const [w, h] of [
    [4000, 3000],
    [100, 2000],
    [20, 10],
  ]) {
    const s = M.imageSize(w, h);
    assert.ok(s.w <= M.W * 0.5 && s.h <= M.H * 0.5);
    assert.ok(Math.abs(s.w / s.h - w / h) < 0.001);
    assert.ok(s.w <= (w * 25.4) / 96);
  }
  assert.ok(M.imageSize(4000, 3000, "large").w > M.imageSize(4000, 3000).w);
});
test("booklet sheet order remains correct for 4, 8, 12 and odd books", () => {
  for (const n of [4, 8, 12, 7]) {
    const pages = Array.from({ length: n }, M.page);
    const pairs = M.sheetPairs(pages, "fold");
    assert.deepEqual(pairs[0], [n - 1, 0]);
    assert.deepEqual(
      pairs
        .flat()
        .filter((x) => x !== null)
        .sort((a, b) => a - b),
      pages.map((_, i) => i),
    );
    assert.equal(pairs.length % 2, 0);
  }
});
test("page movement keeps linked artwork together with a visible blank when needed", () => {
  const b = M.book();
  const left = b.pages[1],
    right = b.pages[2];
  left.items.push(M.object("image", { spanId: "s", spanSide: "left" }));
  right.items.push(M.object("image", { spanId: "s", spanSide: "right" }));
  b.pages.splice(1, 0, M.page());
  const result = M.preserveSpreads(b.pages);
  assert.equal(result[2].title, "Blank page");
  assert.equal(result[3], left);
  assert.equal(result[4], right);
});
test("SVG safely escapes text and native Word eligibility separates effects", () => {
  const p = M.page();
  p.items.push(M.object("text", { text: "<script> & hello" }));
  const svg = M.svg(p);
  assert.ok(!svg.includes("<script>"));
  assert.ok(svg.includes("&lt;"));
  assert.ok(M.nativeEligible(p.items[0]));
  p.items[0].style.outline = 2;
  assert.ok(!M.nativeEligible(p.items[0]));
});
test("illustration prompt includes dimensions, palette, transparency and text space", () => {
  const b = M.book();
  const prompt = M.prompt(b, b.pages[0], M.object("image", { w: 50, h: 70 }));
  for (const text of [
    "transparent background",
    "No frame",
    "binding edge",
    "50 × 70",
    "upper third",
    b.palette[0],
  ])
    assert.ok(prompt.includes(text));
});

test("backup import rejects executable geometry and strips unknown fields", () => {
  const source = M.book();
  source.pages[0].items.push(
    M.object("text", {
      text: "<img src=x>",
      x: '1" onload="bad()',
      style: { ...M.baseStyle, font: "<script>", color: "url(http://bad)" },
    }),
  );
  source.untrusted = "discard";
  const result = M.readBackup(source);
  assert.equal(result.untrusted, undefined);
  assert.equal(result.pages[0].items[0].x, 0);
  assert.equal(result.pages[0].items[0].style.font, "Nunito");
  assert.ok(!M.svg(result.pages[0]).includes("onload="));
  source.pages[0].id = 'bad" onclick="x';
  assert.throws(() => M.readBackup(source));
});
test("text wraps at word boundaries across runs and reports extended text height", () => {
  const o = M.object("text", {
    text: "small moon rises",
    w: 25,
    style: { ...M.baseStyle, size: 12 },
  });
  const layout = M.textLines(o),
    lines = layout.lines.map((l) =>
      l.pieces
        .map((p) => p.ch)
        .join("")
        .trim(),
    );
  assert.deepEqual(lines, ["small moon", "rises"]);
  o.runs = [
    { text: "hello ", style: o.style },
    { text: "world", style: { ...o.style, outline: 1 } },
  ];
  assert.equal(M.nativeEligible(o), false);
});

test("editing rich text preserves the untouched formatting and inherits insertion weight", () => {
  const o = M.object("text", {
    text: "Red fox",
    runs: [
      { text: "Red ", style: { ...M.baseStyle, color: "#aa0000" } },
      { text: "fox", style: { ...M.baseStyle, weight: 700 } },
    ],
  });
  M.replaceText(o, "Red little fox");
  assert.equal(o.runs.map((r) => r.text).join(""), "Red little fox");
  assert.equal(o.runs.at(-1).style.weight, 700);
  assert.equal(o.runs[0].style.color, "#aa0000");
  M.replaceText(o, "Red little owl");
  assert.equal(o.runs.map((r) => r.text).join(""), "Red little owl");
  M.replaceText(o, "");
  assert.equal(o.runs.length, 0);
  assert.equal(o.text, "");
});
test("snapping reaches center and thirds while preserving relative group positions", () => {
  const one = M.object("shape", { x: 20, y: 30, w: 20, h: 20 });
  let r = M.snapMove([one], { x: 18.8, y: 29.5 }, [], 1);
  assert.equal(one.x + r.delta.x + one.w / 2, M.W / 3);
  assert.equal(one.y + r.delta.y + one.h / 2, M.H / 3);
  const two = M.object("shape", { x: 50, y: 30, w: 20, h: 20 });
  r = M.snapMove([one, two], { x: 29.3, y: 0 }, [], 1);
  assert.equal(M.bounds([one, two]).x + r.delta.x + 25, M.W / 2);
  assert.equal(two.x + r.delta.x - (one.x + r.delta.x), 30);
  assert.ok(r.lines.some((l) => l.label === "Center"));
});
test("alignment and distribution include rotated bounds and maintain end objects", () => {
  const objects = [
    M.object("shape", { x: 5, y: 40, w: 20, h: 10, rotation: 90 }),
    M.object("shape", { x: 60, y: 50, w: 10, h: 10 }),
    M.object("shape", { x: 105, y: 60, w: 20, h: 10 }),
  ];
  M.distribute(objects, "x");
  const a = M.bounds([objects[0]]),
    c = M.bounds([objects[1]]),
    z = M.bounds([objects[2]]);
  assert.ok(Math.abs(c.x - a.x - a.w - (z.x - c.x - c.w)) < 0.001);
  M.alignItems(objects, "middle");
  const q = M.bounds(objects);
  assert.ok(Math.abs(q.y + q.h / 2 - M.H / 2) < 0.001);
});
test("table, diagram and arrow options survive portable backup with safe defaults", () => {
  const b = M.book();
  b.pages[1].items.push(
    M.object("table", {
      tableHeader: false,
      tableStriped: false,
      tableRounded: false,
    }),
    M.object("flow", { flowDirection: "vertical", flowShape: "pill" }),
    M.object("arrow", { arrowHead: "both", arrowLine: "dashed" }),
  );
  const restored = M.readBackup(b),
    [table, flow, arrow] = restored.pages[1].items;
  assert.equal(table.tableHeader, false);
  assert.equal(table.tableRounded, false);
  assert.equal(flow.flowDirection, "vertical");
  assert.equal(flow.flowShape, "pill");
  assert.equal(arrow.arrowHead, "both");
  assert.match(M.svg(restored.pages[1]), /stroke-dasharray="3 2"/);
  delete b.pages[1].items[1].flowDirection;
  assert.equal(M.readBackup(b).pages[1].items[1].flowDirection, "horizontal");
});
