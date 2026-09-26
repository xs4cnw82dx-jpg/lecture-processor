const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const M = require("../static/js/book-model.js");

const theme = (variant = "corner", mode = "light") => ({
  id: "xped",
  variant,
  mode,
});
const luminance = (hex) =>
  [1, 3, 5]
    .map((i) => {
      const s = parseInt(hex.slice(i, i + 2), 16) / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    })
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a, b) =>
  (Math.max(luminance(a), luminance(b)) + 0.05) /
  (Math.min(luminance(a), luminance(b)) + 0.05);

test("xPED exposes the verified six named brand colors and real available font weights", () => {
  assert.deepEqual(
    new Set(M.xped.colors.map((c) => c.color)),
    new Set(["#062940", "#007ACC", "#1FE4A9", "#76F6CF", "#FFD617", "#FFFFFF"]),
  );
  assert.ok(M.xped.colors.every((c) => c.name));
  assert.deepEqual(M.fontWeights("Nohemi"), [700]);
  assert.deepEqual(M.fontWeights("General Sans"), [400, 700]);
  assert.equal(M.fontSupportsItalic("Nohemi"), false);
  assert.equal(M.fontSupportsItalic("General Sans"), false);
  assert.equal(M.fontSupportsItalic("Nunito"), true);
});

test("all four cover pairs are distinct, preserve original logo bytes and use self-contained artwork", () => {
  const looks = new Set();
  for (const { id: variant } of M.xped.variants) {
    for (const role of ["front", "back"]) {
      const p = M.coverPreview(variant, "light", role),
        svg = M.svg(p);
      assert.equal(p.role, role);
      assert.equal(p.items.length, 2);
      assert.equal(p.items[0].type, "text");
      assert.equal(p.items[0].style.font, "Nohemi");
      assert.match(svg, /data-theme-artwork="xped"/);
      assert.ok(
        !svg.includes("http://") ||
          svg.includes('xmlns="http://www.w3.org/2000/svg"'),
      );
      assert.ok(
        !svg.includes('href="/static') && !svg.includes('href="https:'),
      );
      const mark = svg.match(
        /data-xped-mark="(white|navy)" href="data:image\/png;base64,([^"]+)"/,
      );
      assert.ok(mark, "Logo is embedded in print/offline SVG");
      assert.deepEqual(
        Buffer.from(mark[2], "base64"),
        fs.readFileSync(
          path.join(
            __dirname,
            "../static/brand/books/xped/mark-" + mark[1] + ".png",
          ),
        ),
      );
      if (["shapes", "minimal"].includes(variant))
        assert.equal(mark[1], "white");
      looks.add(svg.match(/<g data-theme-artwork[\s\S]+?<\/g>/)[0]);
    }
  }
  assert.ok(
    looks.size >= 7,
    "Cover and back artwork form four distinct coordinated pairs",
  );
});

test("applying and reapplying xPED keeps all existing content and custom styling", () => {
  const b = M.book("story");
  const custom = M.object("text", {
    name: "My title",
    text: "Keep my words",
    x: 29,
    y: 45,
    w: 97,
    h: 61,
    styleName: "heading",
    style: { ...M.baseStyle, font: "Andika", color: "#974422", weight: 400 },
    runs: [
      {
        text: "Keep my words",
        style: { ...M.baseStyle, font: "Comic Neue", color: "#7d3150" },
      },
    ],
  });
  const customTable = M.object("table", {
    tableStyle: "custom",
    fill: "#eecccc",
    stroke: "#aa1133",
    style: { ...M.baseStyle, font: "Andika", color: "#550022" },
  });
  const customFlow = M.object("flow", {
    fill: "#aaccbb",
    stroke: "#226677",
    steps: ["One", "Two"],
  });
  b.pages[0].items = [custom];
  b.pages[1].items.push(customTable, customFlow);
  const before = M.clone([custom, customTable, customFlow]);
  M.applyXpedTheme(b, "corner");
  assert.deepEqual(custom, before[0]);
  assert.deepEqual(customTable, before[1]);
  assert.deepEqual(customFlow, { ...before[2], flowStyle: "custom" });
  const after = JSON.stringify(b);
  M.applyXpedTheme(b, "corner");
  assert.equal(
    JSON.stringify(b),
    after,
    "Applying the same preset never adds objects or changes styling again",
  );
  M.applyXpedTheme(b, "minimal", "dark");
  assert.deepEqual(custom, before[0]);
  assert.deepEqual(customTable, before[1]);
  assert.equal(b.pages[0].items.length, 1);
});

test("xPED interior modes, artwork toggle and new pages retain the brand independently", () => {
  const b = M.book();
  M.applyXpedTheme(b, "route", "dark");
  const p = M.pageForBook(b);
  assert.equal(p.background, "#062940");
  assert.deepEqual(p.decoration, theme("route", "dark"));
  assert.equal(p.items.length, 0);
  assert.match(M.svg(p), /data-xped-corner="blue"/);
  assert.match(M.svg(p), /data-xped-corner="yellow"/);
  p.themeArtwork = false;
  assert.ok(!M.svg(p).includes("data-theme-artwork"));
  assert.deepEqual(p.decoration, theme("route", "dark"));
  b.pages[1].themeArtwork = false;
  M.applyXpedTheme(b, "route", "light");
  assert.equal(b.pages[1].themeArtwork, false);
  assert.equal(M.pageForBook(b).background, "#FFFFFF");
  assert.equal(M.pageForBook(M.book()).decoration, null);
});

test("interior motifs alternate by current page order through add, reorder, copy, delete and restore", () => {
  const b = M.book();
  M.applyXpedTheme(b, "corner", "light");
  b.pages.splice(-1, 0, M.pageForBook(b), M.pageForBook(b));
  b.pages[2].decoration.mode = "dark";
  b.pages[2].background = "#062940";
  const original = M.clone(b.pages[2]);
  const assertAlternates = (pages) => {
    const before = JSON.stringify(pages);
    pages
      .filter((p) => p.role === "page")
      .forEach((p, i) => {
        const options = M.pageRenderOptions(p, pages);
        assert.equal(options.interiorIndex, i);
        const svg = M.svg(p, {}, options);
        if (p.themeArtwork !== false) {
          assert.ok(
            svg.includes(`data-interior-side="${i % 2 ? "right" : "left"}"`),
          );
          assert.equal(
            svg.includes("translate(148.5 0) scale(-0.037 0.037)"),
            i % 2 === 1,
          );
        }
      });
    assert.equal(
      JSON.stringify(pages),
      before,
      "Rendering parity does not change saved page data",
    );
  };
  assertAlternates(b.pages);
  [b.pages[1], b.pages[2]] = [b.pages[2], b.pages[1]];
  assertAlternates(b.pages);
  assert.deepEqual(
    b.pages[1],
    original,
    "Reordering retains that page's mode and decoration",
  );
  const copy = { ...M.clone(b.pages[2]), id: M.id() };
  b.pages.splice(2, 0, copy);
  assertAlternates(b.pages);
  const [removed] = b.pages.splice(1, 1);
  assertAlternates(b.pages);
  b.pages.splice(3, 0, removed);
  assertAlternates(b.pages);
  b.pages[2].themeArtwork = false;
  assertAlternates(b.pages);
  assert.equal(
    M.pageRenderOptions(b.pages[3], b.pages).interiorIndex,
    2,
    "A hidden motif does not remove a page from the alternating sequence",
  );
});

test("print, version and restored page order control mirroring while cover designs remain unchanged", () => {
  const b = M.book();
  M.applyXpedTheme(b, "minimal", "dark");
  const snapshot = M.clone(b.pages),
    second = snapshot[2];
  [b.pages[1], b.pages[2]] = [b.pages[2], b.pages[1]];
  assert.equal(M.pageRenderOptions(second, snapshot).interiorIndex, 1);
  assert.equal(M.pageRenderOptions(second, b.pages).interiorIndex, 0);
  const print = M.svg(
    second,
    {},
    { ...M.pageRenderOptions(second, snapshot), economy: true },
  );
  assert.match(print, /data-interior-side="right"/);
  assert.match(print, /translate\(148\.5 0\) scale\(-1 1\)/);
  for (const p of [b.pages[0], b.pages.at(-1)]) {
    assert.deepEqual(M.pageRenderOptions(p, b.pages), {});
    assert.equal(
      M.svg(p),
      M.svg(p, {}, { interiorIndex: 1 }),
      "Cover design does not depend on interior position",
    );
  }
  const restored = M.readBackup(b);
  const svg = M.svg(
    restored.pages[2],
    {},
    M.pageRenderOptions(restored.pages[2], restored.pages),
  );
  assert.match(svg, /data-interior-side="right"/);
  assert.ok(
    !Object.hasOwn(restored.pages[2], "interiorIndex"),
    "Parity remains derived, not persisted",
  );
});

test("new text matches light covers and dark interiors without synthetic font styles", () => {
  const b = M.book();
  M.applyXpedTheme(b, "corner", "dark");
  const add = (p) =>
    M.styleObjectForBook(
      M.object("text", {
        styleName: "heading",
        style: { ...b.styles.heading, weight: 400, italic: true },
      }),
      b,
      p,
    );
  assert.equal(add(b.pages[0]).style.color, "#062940");
  assert.equal(add(b.pages[1]).style.color, "#FFFFFF");
  assert.equal(add(b.pages[1]).style.weight, 700);
  assert.equal(add(b.pages[1]).style.italic, false);
});

test("xPED paper tables use restrained brand accents and accessible light and dark ink", () => {
  const o = M.object("table", {
    style: { ...M.baseStyle, font: "General Sans", color: "#062940" },
  });
  for (const paper of ["#FFFFFF", "#062940", "#007ACC", "#efe9cd"]) {
    const colors = M.tableAppearance(o, paper, theme());
    assert.equal(colors.paper, paper);
    assert.equal(colors.accent, "#FFD617");
    assert.ok(contrast(colors.paper, colors.ink) >= 4.5);
    assert.ok(contrast(colors.header, colors.headerInk) >= 4.5);
    assert.ok(contrast(colors.stripe, colors.stripeInk) >= 4.5);
    const p = {
      ...M.page(),
      background: paper,
      decoration: theme(),
      items: [o],
    };
    assert.match(M.svg(p), /data-table-accent="true"/);
  }
  o.tableStyle = "custom";
  o.fill = "#bbccaa";
  o.stroke = "#415533";
  assert.equal(M.tableAppearance(o, "#FFFFFF", theme()).header, "#bbccaa");
  assert.equal(M.tableAppearance(o, "#FFFFFF", theme()).line, "#415533");
  assert.equal(M.tableAppearance(o, "#FFFFFF", theme()).accent, null);
});

test("coordinated story steps follow xPED but custom colors remain visible", () => {
  const b = M.book();
  const o = M.object("flow", {
    fill: b.palette[1],
    stroke: b.palette[0],
    style: { ...b.styles.body },
  });
  b.pages[1].items.push(o);
  M.applyXpedTheme(b, "corner", "dark");
  assert.equal(o.flowStyle, "theme");
  assert.equal(o.style.font, "General Sans");
  assert.equal(o.style.color, "#FFFFFF");
  let svg = M.svg(b.pages[1]);
  assert.match(svg, /data-flow-style="xped"/);
  assert.match(svg, /stroke="#76F6CF"/);
  const visible = M.flowAppearance(
    o,
    b.pages[1].background,
    b.pages[1].decoration,
  );
  assert.ok(svg.includes(`fill="${visible.fill}"`));
  assert.ok(svg.includes(`stroke="${visible.stroke}"`));
  assert.ok(contrast(visible.fill, visible.ink) >= 4.5);
  o.flowStyle = "custom";
  o.fill = "#884499";
  svg = M.svg(b.pages[1]);
  assert.match(svg, /data-flow-style="custom"/);
  assert.match(svg, /fill="#884499"/);
});

test("save ink prints dark designs on white with dark text and no heavy decorations", () => {
  const b = M.book();
  M.applyXpedTheme(b, "minimal", "dark");
  b.pages[1].items.push(M.object("flow", { style: { ...b.styles.body } }));
  for (const p of [b.pages[0], b.pages[1]]) {
    const svg = M.svg(p, {}, { economy: true });
    assert.ok(svg.includes('fill="#ffffff"'));
    assert.ok(!svg.includes("data-xped-corner"));
    assert.ok(svg.includes('data-xped-mark="navy"'));
    assert.ok(!svg.includes('fill="#FFFFFF" stroke="#FFFFFF"'));
  }
});

test("theme metadata, decorations, fonts and hidden artwork survive backups and versions", () => {
  const b = M.book();
  M.applyXpedTheme(b, "shapes", "dark");
  b.pages[1].themeArtwork = false;
  b.pages[1].items.push(
    M.object("flow", {
      flowStyle: "custom",
      style: {
        ...M.baseStyle,
        font: "General Sans",
        weight: 900,
        italic: true,
      },
    }),
  );
  b.versions = [
    {
      id: M.id(),
      name: "Before edits",
      created_at: 1234,
      pages: M.clone(b.pages),
      metadata: { theme: b.theme, styles: b.styles },
    },
  ];
  const restored = M.readBackup(b);
  assert.deepEqual(restored.theme, b.theme);
  assert.deepEqual(restored.pages[1].decoration, b.theme);
  assert.equal(restored.pages[1].themeArtwork, false);
  assert.equal(restored.pages[1].items[0].flowStyle, "custom");
  assert.equal(restored.pages[1].items[0].style.weight, 700);
  assert.equal(restored.pages[1].items[0].style.italic, false);
  assert.equal(restored.pages[0].items[0].style.font, "Nohemi");
  assert.equal(restored.pages[0].items[0].style.weight, 700);
  assert.deepEqual(restored.versions[0].metadata.theme, b.theme);
  assert.equal(restored.versions[0].pages[1].themeArtwork, false);
});

test("unknown decoration data cannot inject markup, external images or new assets", () => {
  const b = M.book();
  b.theme = { id: "custom", svg: "<script>alert(1)</script>" };
  b.pages[1].decoration = {
    id: "xped",
    variant: "https://example.com/image.svg",
    mode: "<svg onload=alert(1)>",
  };
  const restored = M.readBackup(b);
  assert.equal(restored.theme, null);
  assert.deepEqual(restored.pages[1].decoration, theme());
  assert.ok(!JSON.stringify(restored).includes("example.com"));
  assert.ok(!JSON.stringify(restored).includes("<script>"));
  delete b.pages[1].decoration;
  assert.equal(M.readBackup(b).pages[1].decoration, null);
});

for (const n of [4, 5, 8, 12]) {
  test(`cut layout puts the cover first for a numbered ${n}-page book`, () => {
    const pages = Array.from({ length: n }, (_, i) => ({ id: "p" + i }));
    const sheets = M.sheetPairs(pages, "cut");
    assert.deepEqual(sheets[0], [0, null]);
    assert.deepEqual(sheets.at(-1), [n - 1, null]);
    assert.deepEqual(
      sheets.flat().filter((index) => index !== null),
      pages.map((_, i) => i),
    );
    assert.equal(sheets.length, 2 + Math.ceil((n - 2) / 2));
  });
}
test("removed fold layout gives a helpful error instead of silently rearranging pages", () => {
  assert.throws(() => M.sheetPairs(M.book().pages, "fold"), /Refresh/);
});

test("book page numbers default off and validate typography, positions and custom colors", () => {
  assert.deepEqual(M.pageNumberOptions(), {
    enabled: false,
    position: "logo",
    font: "General Sans",
    size: 9,
    weight: 400,
    colorMode: "theme",
    color: "#062940",
  });
  assert.equal(M.book().pageNumbers.enabled, false);
  const invalid = M.pageNumberOptions({
    enabled: "yes",
    position: "<svg>",
    font: "script",
    size: 999,
    weight: 550,
    colorMode: "custom",
    color: "url(bad)",
  });
  assert.equal(invalid.enabled, false);
  assert.equal(invalid.position, "logo");
  assert.equal(invalid.font, "General Sans");
  assert.equal(invalid.size, 24);
  assert.equal(invalid.weight, 400);
  assert.equal(invalid.color, "#062940");
  assert.equal(
    M.pageNumberOptions({ font: "Nohemi", weight: 400 }).weight,
    700,
  );
  assert.equal(
    M.pageNumberOptions({ font: "General Sans", weight: 700 }).weight,
    700,
  );
  assert.equal(
    M.pageNumberOptions({ font: "Playpen Sans", weight: 1000 }).weight,
    800,
  );
  assert.equal(
    M.pageNumberOptions({ font: "Nunito", weight: null, size: null }).weight,
    400,
  );
  assert.equal(M.pageNumberOptions({ size: -1 }).size, 6);
});

test("page numbers count interiors, track order and use the requested footer position", () => {
  const b = M.book();
  M.applyXpedTheme(b, "corner", "light");
  b.pageNumbers = M.pageNumberOptions({
    enabled: true,
    position: "outer",
    font: "Nohemi",
    size: 12,
  });
  const draw = (p, extra = {}) =>
    M.svg(
      p,
      {},
      { ...M.pageRenderOptions(p, b.pages, b.pageNumbers), ...extra },
    );
  assert.ok(!draw(b.pages[0]).includes("data-page-number"));
  assert.ok(!draw(b.pages.at(-1)).includes("data-page-number"));
  assert.match(
    draw(b.pages[1]),
    /data-page-number="1" x="12" y="198.5" text-anchor="start" font-family="Nohemi"/,
  );
  assert.match(
    draw(b.pages[2]),
    /data-page-number="2" x="136.5" y="198.5" text-anchor="end"/,
  );
  assert.match(draw(b.pages[1]), /font-weight="700" fill="#062940"/);
  const first = b.pages[1];
  [b.pages[1], b.pages[2]] = [b.pages[2], b.pages[1]];
  assert.match(draw(first), /data-page-number="2"/);
  b.pageNumbers.position = "center";
  assert.match(
    draw(first),
    /data-page-number="2" x="74.25" y="198.5" text-anchor="middle"/,
  );
  b.pageNumbers.position = "logo";
  first.themeArtwork = false;
  assert.match(
    draw(first),
    /data-page-number="2" x="121" y="198.5" text-anchor="end"/,
  );
  assert.ok(!draw(first).includes("data-theme-artwork"));
  b.pageNumbers.enabled = false;
  assert.ok(!draw(first).includes("data-page-number"));
});

test("page numbers follow paper contrast, custom ink and Save ink without changing content", () => {
  const b = M.book();
  M.applyXpedTheme(b, "minimal", "dark");
  const numbers = M.pageNumberOptions({ enabled: true }),
    p = b.pages[1],
    before = JSON.stringify(p);
  const draw = (config, extra = {}) =>
    M.svg(p, {}, { ...M.pageRenderOptions(p, b.pages, config), ...extra });
  assert.match(draw(numbers), /data-page-number="1"[^>]+fill="#FFFFFF"/);
  const custom = { ...numbers, colorMode: "custom", color: "#1FE4A9" };
  assert.match(draw(custom), /data-page-number="1"[^>]+fill="#1FE4A9"/);
  assert.match(
    draw(custom, { economy: true, editable: true }),
    /data-page-number="1"[^>]+fill="#062940"/,
  );
  assert.equal(JSON.stringify(p), before);
});

test("outer right page numbers leave a comfortable gap beside the original logo at every supported size", () => {
  const b = M.book();
  M.applyXpedTheme(b, "corner");
  for (const size of [6, 9, 24]) {
    for (const index of [1, 97]) {
      for (const economy of [false, true]) {
        const svg = M.svg(
          b.pages[2],
          {},
          {
            interiorIndex: index,
            economy,
            pageNumbers: { enabled: true, position: "outer", size },
          },
        );
        const mark = svg.match(
          /<image data-xped-mark="[^"]+"[^>]* x="([\d.]+)"[^>]* width="([\d.]+)"/,
        );
        assert.ok(mark);
        const logoRight = Number(mark[1]) + Number(mark[2]);
        const numberLeftBound =
          M.W - 12 - String(index + 1).length * size * M.PT;
        assert.ok(
          logoRight + 4 <= numberLeftBound + 0.001,
          "A conservative full-em digit width still leaves 4 mm of separation",
        );
        assert.match(svg, /data-page-number="\d+" x="136.5"/);
      }
    }
  }
  const left = M.svg(
    b.pages[1],
    {},
    M.pageRenderOptions(b.pages[1], b.pages, {
      enabled: true,
      position: "outer",
    }),
  );
  assert.match(left, /<image data-xped-mark="[^"]+"[^>]* x="126"/);
});

test("page number preferences survive backup, version restore and old-book defaults", () => {
  const b = M.book();
  b.pageNumbers = M.pageNumberOptions({
    enabled: true,
    position: "center",
    font: "General Sans",
    size: 11,
    weight: 700,
    colorMode: "custom",
    color: "#336688",
  });
  b.versions = [
    {
      id: M.id(),
      name: "Numbered",
      created_at: 1,
      pages: M.clone(b.pages),
      metadata: { pageNumbers: b.pageNumbers, styles: b.styles },
    },
  ];
  const restored = M.readBackup(b);
  assert.deepEqual(restored.pageNumbers, b.pageNumbers);
  assert.deepEqual(restored.versions[0].metadata.pageNumbers, b.pageNumbers);
  delete b.pageNumbers;
  delete b.versions[0].metadata.pageNumbers;
  assert.equal(M.readBackup(b).pageNumbers.enabled, false);
  assert.equal(M.readBackup(b).versions[0].metadata.pageNumbers.enabled, false);
});

test("route back-cover scaffolding clears the decorative route while reapplication preserves positions", () => {
  for (const variant of ["route", "minimal"]) {
    const b = M.book();
    M.applyXpedTheme(b, variant);
    const caption = b.pages
      .at(-1)
      .items.find((o) => o.name === "Back cover caption");
    assert.equal(caption.x, 32);
    assert.equal(caption.w, 98);
    caption.x = 22;
    M.applyXpedTheme(b, variant);
    assert.equal(caption.x, 22);
  }
});
