/* global require */
(function (root) {
  "use strict";
  const shared =
    root.LectureProcessorVideoOverlayBuilderUtils ||
    (typeof module !== "undefined"
      ? require("./video-overlay-builder-utils.js")
      : {});
  const W = 148.5,
    H = 210,
    PT = 25.4 / 72;
  const id = () =>
    "b" +
    (root.crypto && root.crypto.randomUUID
      ? root.crypto.randomUUID().replace(/-/g, "")
      : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const esc = (value) =>
    String(value == null ? "" : value).replace(
      /[&<>"']/g,
      (ch) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[ch],
    );
  const clamp = (v, a, b) => shared.clampNumber(v, a, b, 0);
  const baseStyle = {
    font: "Nunito",
    size: 18,
    weight: 400,
    color: "#263343",
    italic: false,
    underline: false,
    align: "left",
    lineHeight: 1.4,
    letterSpacing: 0,
    outline: 0,
    highlight: "#fff0b8",
    highlightOn: false,
  };
  const fontOptions = [
    "Nunito",
    "Andika",
    "Playpen Sans",
    "Comic Neue",
    "Fraunces",
    "Nohemi",
    "General Sans",
  ];
  const fontWeights = (font) =>
    ({
      Andika: [400, 700],
      "Comic Neue": [300, 400, 700],
      Nohemi: [700],
      "General Sans": [400, 700],
    })[font] || null;
  const fontSupportsItalic = (font) =>
    !["Playpen Sans", "Nohemi", "General Sans"].includes(font);
  const xped = {
    id: "xped",
    colors: [
      { name: "Blue", color: "#007ACC" },
      { name: "Light mint", color: "#76F6CF" },
      { name: "Yellow", color: "#FFD617" },
      { name: "Navy", color: "#062940" },
      { name: "Mint", color: "#1FE4A9" },
      { name: "White", color: "#FFFFFF" },
    ],
    fonts: { heading: "Nohemi", body: "General Sans" },
    variants: [
      {
        id: "corner",
        name: "xPED Classic",
        description: "Clear white pages and signature blue and yellow corners.",
      },
      {
        id: "route",
        name: "On the Route",
        description:
          "A flowing route, generous white space and small waypoints.",
      },
      {
        id: "shapes",
        name: "Bright Ideas",
        description: "A blue cover with a sunny yellow title panel.",
      },
      {
        id: "minimal",
        name: "Night Expedition",
        description:
          "Deep navy, crisp white lettering and quiet route accents.",
      },
    ],
  };
  const XPED_NAVY = "#062940",
    XPED_BLUE = "#007ACC",
    XPED_MINT = "#1FE4A9",
    XPED_LIGHT_MINT = "#76F6CF",
    XPED_YELLOW = "#FFD617",
    XPED_WHITE = "#FFFFFF";
  function themeInfo(raw) {
    if (!raw || raw.id !== "xped") return null;
    return {
      id: "xped",
      variant: xped.variants.some((v) => v.id === raw.variant)
        ? raw.variant
        : "corner",
      mode: raw.mode === "dark" ? "dark" : "light",
    };
  }
  const colorEqual = (a, b) =>
    typeof a === "string" &&
    typeof b === "string" &&
    a.toLowerCase() === b.toLowerCase();
  const colorRgb = (hex) => {
    const safe = /^#[a-f\d]{6}$/i.test(hex) ? hex : "#fffdf7";
    return [1, 3, 5].map((start) => parseInt(safe.slice(start, start + 2), 16));
  };
  const blendColor = (a, b, amount) =>
    "#" +
    colorRgb(a)
      .map((v, i) =>
        Math.round(v + (colorRgb(b)[i] - v) * amount)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("");
  const luminance = (color) =>
    colorRgb(color)
      .map((v) => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      })
      .reduce((total, v, i) => total + v * [0.2126, 0.7152, 0.0722][i], 0);
  const contrast = (a, b) =>
    (Math.max(luminance(a), luminance(b)) + 0.05) /
    (Math.min(luminance(a), luminance(b)) + 0.05);
  const readable = (paper, preferred = XPED_NAVY) =>
    contrast(paper, preferred) >= 4.5
      ? preferred
      : contrast(paper, XPED_NAVY) >= contrast(paper, XPED_WHITE)
        ? XPED_NAVY
        : XPED_WHITE;
  function pageNumberOptions(raw = {}) {
    raw = raw && typeof raw === "object" ? raw : {};
    const font = fontOptions.includes(raw.font) ? raw.font : "General Sans",
      weights = fontWeights(font),
      desired =
        raw.weight != null &&
        raw.weight !== "" &&
        Number.isFinite(Number(raw.weight))
          ? Number(raw.weight)
          : 400,
      limits = {
        Nunito: [200, 1000],
        "Playpen Sans": [100, 800],
        Fraunces: [100, 900],
      }[font] || [100, 1000];
    return {
      enabled: raw.enabled === true,
      position: ["logo", "center", "outer"].includes(raw.position)
        ? raw.position
        : "logo",
      font,
      size:
        Number.isFinite(Number(raw.size)) && raw.size != null
          ? clamp(Number(raw.size), 6, 24)
          : 9,
      weight: weights
        ? weights.reduce((best, weight) =>
            Math.abs(weight - desired) < Math.abs(best - desired)
              ? weight
              : best,
          )
        : clamp(desired, ...limits),
      colorMode: raw.colorMode === "custom" ? "custom" : "theme",
      color: /^#[a-f\d]{6}$/i.test(raw.color || "") ? raw.color : XPED_NAVY,
    };
  }
  function xpedPaper(role, theme) {
    if (role === "page") return theme.mode === "dark" ? XPED_NAVY : XPED_WHITE;
    return theme.variant === "minimal"
      ? XPED_NAVY
      : theme.variant === "shapes"
        ? XPED_BLUE
        : XPED_WHITE;
  }
  function xpedInk(p, o = null) {
    // The Bright Ideas title panel is yellow; its native text stays dark.
    if (
      p.role !== "page" &&
      p.decoration?.variant === "shapes" &&
      o &&
      o.y >= 36 &&
      o.y + o.h <= 147
    )
      return XPED_NAVY;
    return readable(p.background);
  }
  function page(role = "page") {
    return {
      id: id(),
      title:
        role === "front"
          ? "Front cover"
          : role === "back"
            ? "Back cover"
            : "Untitled page",
      role,
      background: "#fffdf7",
      texture: "plain",
      decoration: null,
      themeArtwork: true,
      items: [],
    };
  }
  function object(type, options = {}) {
    return Object.assign(
      {
        id: id(),
        type,
        name: type[0].toUpperCase() + type.slice(1),
        x: 18,
        y: 28,
        w: 100,
        h: 45,
        rotation: 0,
        opacity: 1,
        locked: false,
        hidden: false,
        group: "",
        style: clone(baseStyle),
        text: type === "text" ? "Your story starts here." : "",
        runs: [],
        fill: "#c9def0",
        stroke: "#4f46e5",
        strokeWidth: 0.6,
        shape: "rounded",
        aspectLock: true,
        fit: "contain",
        cropX: 50,
        cropY: 50,
        mask: "none",
        feather: 0,
        assetId: "",
        originalAssetId: "",
        spanId: "",
        spanSide: "",
        points: [],
        brush: "pen",
        cells: shared.createTableData(2, 2).cells,
        steps: ["First", "Then", "Finally"],
        tableHeader: true,
        tableStriped: true,
        tableRounded: true,
        tableStyle: "paper",
        tableColumns: false,
        flowDirection: "vertical",
        flowShape: "rounded",
        flowStyle: "theme",
        arrowHead: "end",
        arrowLine: "solid",
        styleName: "",
      },
      options,
    );
  }
  function book(template = "blank") {
    const b = {
      id: "local-" + id(),
      schema_version: 1,
      title: "Untitled book",
      folder: "",
      tags: [],
      favorite: false,
      deleted: false,
      local: true,
      revision: 0,
      pages: [page("front"), page(), page(), page("back")],
      deletedPages: [],
      assets: [],
      versions: [],
      palette: ["#4f46e5", "#c9def0", "#f6d6a8", "#263343"],
      theme: null,
      pageNumbers: pageNumberOptions(),
      styles: {
        heading: { ...baseStyle, font: "Fraunces", size: 32, weight: 700 },
        body: { ...baseStyle },
        caption: { ...baseStyle, size: 12 },
      },
      illustration: {
        style: "soft pencil and watercolor",
        characters: "",
        space: "upper third",
        blend: true,
        transparent: true,
      },
      created_at: Date.now() / 1000,
      updated_at: Date.now() / 1000,
    };
    if (template !== "blank") {
      b.pages[0].items.push(
        object("text", {
          text: "A little book of\nbig ideas",
          y: 40,
          h: 65,
          style: { ...b.styles.heading, align: "center" },
          styleName: "heading",
        }),
      );
      b.pages[0].items.push(
        object("text", {
          text: "Made by you",
          y: 165,
          h: 15,
          style: { ...b.styles.caption, align: "center" },
          styleName: "caption",
        }),
      );
      if (template === "journal")
        b.pages.slice(1, -1).forEach((p) => {
          p.texture = "lined";
          p.items.push(
            object("text", {
              text: "Today, I noticed…",
              h: 20,
              style: { ...b.styles.heading, size: 24 },
            }),
          );
        });
      if (template === "story")
        b.pages[1].items.push(
          object("text", {
            text: "Once upon a time…",
            y: 155,
            h: 35,
            style: { ...baseStyle, font: "Andika" },
          }),
        );
      if (template === "explain")
        b.pages[1].items.push(object("flow", { y: 70, w: 112, h: 38 }));
    }
    return b;
  }
  function seedCover(p, b) {
    if (p.role === "page" || p.items.length) return;
    const front = p.role === "front",
      bright = p.decoration?.variant === "shapes",
      routeCaption = !front && ["route", "minimal"].includes(p.decoration?.variant);
    const heading = object("text", {
      name: front ? "Cover title" : "Back cover text",
      text: front
        ? b.title && b.title !== "Untitled book"
          ? b.title
          : "Jouw verhaal\nbegint hier"
        : "Ruimte voor\nnieuwe ideeën.",
      x: bright ? 25 : 17,
      y: front ? 55 : 66,
      w: bright ? 98 : 112,
      h: front ? 75 : 58,
      styleName: "heading",
      style: {
        ...b.styles.heading,
        font: "Nohemi",
        weight: 700,
        size: front ? 32 : 26,
        lineHeight: 1.12,
      },
    });
    heading["style"].color = xpedInk(p, heading);
    const caption = object("text", {
      name: front ? "Cover subtitle" : "Back cover caption",
      text: front
        ? "Een boek om te ontdekken en te delen."
        : "Een volgende stap.\nEen eigen verhaal.",
      x: routeCaption ? 32 : 18,
      y: 158,
      w: routeCaption ? 98 : 110,
      h: 25,
      styleName: "caption",
      style: {
        ...b.styles.caption,
        font: "General Sans",
        weight: 400,
        size: 13,
        lineHeight: 1.45,
      },
    });
    caption["style"].color = xpedInk(p, caption);
    p.items.push(heading, caption);
  }
  function pageForBook(b, role = "page") {
    const p = page(role),
      theme = themeInfo(b?.theme);
    if (theme) {
      p.decoration = theme;
      p.background = xpedPaper(role, theme);
      seedCover(p, b);
    }
    return p;
  }
  function styleObjectForBook(o, b, p) {
    if (!themeInfo(b?.theme) || !themeInfo(p?.decoration)) return o;
    if (["text", "table", "flow"].includes(o.type)) {
      o["style"] = { ...o["style"], color: xpedInk(p, o) };
      if (o.type !== "text") o["style"].font = "General Sans";
      if (!fontSupportsItalic(o["style"].font)) o["style"].italic = false;
      if (o["style"].font === "Nohemi") o["style"].weight = 700;
      else if (o["style"].font === "General Sans")
        o["style"].weight = o["style"].weight >= 600 ? 700 : 400;
    }
    return o;
  }
  function applyXpedTheme(b, variant = "corner", mode = "light") {
    const theme = themeInfo({ id: "xped", variant, mode }),
      previousTheme = themeInfo(b.theme),
      oldPalette = b.palette.slice(),
      oldStyles = clone(b.styles),
      newPalette = xped.colors.map((c) => c.color);
    b.theme = theme;
    b.palette = newPalette;
    for (const name of ["heading", "body", "caption"]) {
      b.styles[name] = {
        ...b.styles[name],
        font: name === "heading" ? "Nohemi" : "General Sans",
        weight: name === "heading" || b.styles[name].weight >= 600 ? 700 : 400,
        italic: false,
        color: mode === "dark" ? XPED_WHITE : XPED_NAVY,
      };
    }
    b.pages.forEach((p) => {
      const previousPage = { ...p };
      p.decoration = clone(theme);
      p.themeArtwork = p.themeArtwork !== false;
      p.background = xpedPaper(p.role, theme);
      p.items.forEach((o) => {
        const oldStyle = o.styleName ? oldStyles[o.styleName] : oldStyles.body,
          named = !!o.styleName,
          oldInk = xpedInk(previousPage, o),
          ink = xpedInk(p, o),
          followsInk =
            colorEqual(o["style"].color, oldStyle.color) ||
            colorEqual(o["style"].color, oldPalette[3]) ||
            (previousTheme && colorEqual(o["style"].color, oldInk));
        const coordinatedFlow =
          o.type === "flow" &&
          o.flowStyle !== "custom" &&
          ((previousTheme && p.decoration) ||
            (colorEqual(o.fill, oldPalette[1]) &&
              colorEqual(o.stroke, oldPalette[0]) &&
              followsInk));
        if (o.type === "flow" && !coordinatedFlow) o.flowStyle = "custom";
        if (
          named ||
          (o.type === "table" && o.tableStyle !== "custom") ||
          coordinatedFlow
        ) {
          const updateStyle = (style) => {
            const changed = { ...style };
            if (style.font === oldStyle.font) {
              changed.font = named
                ? b.styles[o.styleName].font
                : "General Sans";
              changed.weight =
                changed.font === "Nohemi" || style.weight >= 600 ? 700 : 400;
              changed.italic = false;
            }
            if (
              colorEqual(style.color, oldStyle.color) ||
              colorEqual(style.color, oldPalette[3]) ||
              (previousTheme && colorEqual(style.color, oldInk))
            )
              changed.color = ink;
            return changed;
          };
          o["style"] = updateStyle(o["style"]);
          o.runs = (o.runs || []).map((r) => ({
            ...r,
            style: updateStyle(r["style"]),
          }));
        }
        // Explicit custom table and diagram colors remain entirely untouched.
        if (
          (o.type === "table" && o.tableStyle === "custom") ||
          (o.type === "flow" && !coordinatedFlow)
        )
          return;
        if (!["shape", "arrow", "drawing", "table", "flow"].includes(o.type))
          return;
        for (const key of ["fill", "stroke"]) {
          const index = oldPalette.findIndex((c) => colorEqual(c, o[key]));
          if (index >= 0) o[key] = newPalette[index % newPalette.length];
        }
      });
      seedCover(p, b);
    });
    return b;
  }
  function coverPreview(variant = "corner", mode = "light", role = "front") {
    const b = book();
    b.title = "Een nieuw\nperspectief";
    applyXpedTheme(b, variant, mode);
    return clone(
      role === "page"
        ? b.pages[1]
        : role === "back"
          ? b.pages.at(-1)
          : b.pages[0],
    );
  }
  function pageRenderOptions(p, orderedPages = [], pageNumbers) {
    if (p.role !== "page") return {};
    return {
      interiorIndex: Math.max(
        0,
        orderedPages
          .filter((q) => q.role === "page")
          .findIndex((q) => q.id === p.id),
      ),
      ...(pageNumbers === undefined
        ? {}
        : { pageNumbers: pageNumberOptions(pageNumbers) }),
    };
  }
  function spreads(pages, single = false) {
    if (single) return pages.map((p) => [p.id]);
    const result = [[pages[0].id]],
      inside = pages.slice(1, -1);
    for (let i = 0; i < inside.length; i += 2)
      result.push([inside[i].id, inside[i + 1] ? inside[i + 1].id : null]);
    result.push([pages[pages.length - 1].id]);
    return result;
  }
  function imageSize(width, height, preset = "medium") {
    const factor =
      { small: 0.28, medium: 0.5, large: 0.75, fit: 1 }[preset] || 0.5;
    const scale = Math.min(
      (W * factor) / width,
      (H * factor) / height,
      25.4 / 96,
    );
    return {
      w: Math.max(0.2, width * scale),
      h: Math.max(0.2, height * scale),
    };
  }
  function sheetPairs(pages, arrangement) {
    if (arrangement && arrangement !== "cut")
      throw new Error(
        "Fold and staple is no longer available. Refresh this page to export with cut and bind.",
      );
    const pairs = [[0, null]];
    for (let i = 1; i < pages.length - 1; i += 2)
      pairs.push([i, i + 1 < pages.length - 1 ? i + 1 : null]);
    pairs.push([pages.length - 1, null]);
    return pairs;
  }
  function nativeEligible(o) {
    return (
      !o.hidden &&
      o.opacity === 1 &&
      !o.spanId &&
      ((o.type === "text" &&
        !o["style"].outline &&
        !(o.runs || []).some((r) => r["style"].outline)) ||
        (o.type === "shape" && ["square", "circle"].includes(o.shape)))
    );
  }
  // Keep existing formatting on both sides of an edit, including pasted text.
  function replaceText(o, value) {
    const old = o.runs?.length ? o.runs.map((r) => r.text).join("") : o.text;
    value = value.slice(0, 12000);
    if (value === old) return;
    if (o.runs?.length) {
      let start = 0,
        end = 0;
      while (
        start < old.length &&
        start < value.length &&
        old[start] === value[start]
      )
        start++;
      while (
        end < old.length - start &&
        end < value.length - start &&
        old[old.length - 1 - end] === value[value.length - 1 - end]
      )
        end++;
      let at = 0,
        insertionStyle = o["style"];
      const before = [],
        after = [];
      o.runs.forEach((r) => {
        const stop = at + r.text.length;
        if (at <= start && stop >= start) insertionStyle = r["style"];
        if (at < start)
          before.push({
            text: r.text.slice(0, start - at),
            style: { ...r["style"] },
          });
        if (stop > old.length - end)
          after.push({
            text: r.text.slice(Math.max(0, old.length - end - at)),
            style: { ...r["style"] },
          });
        at = stop;
      });
      o.runs = [
        ...before,
        {
          text: value.slice(start, value.length - end),
          style: { ...insertionStyle },
        },
        ...after,
      ].filter((r) => r.text);
      // Avoid exceeding the portable book format's run limit after many edits.
      o.runs = o.runs.reduce((out, r) => {
        const last = out.at(-1);
        if (
          last &&
          JSON.stringify(last["style"]) === JSON.stringify(r["style"])
        )
          last.text += r.text;
        else out.push(r);
        return out;
      }, []);
    }
    o.text = value;
  }
  function bounds(items) {
    const points = items.flatMap((o) => {
      const a = ((o.rotation || 0) * Math.PI) / 180,
        cx = o.x + o.w / 2,
        cy = o.y + o.h / 2;
      return [
        [-o.w / 2, -o.h / 2],
        [o.w / 2, -o.h / 2],
        [o.w / 2, o.h / 2],
        [-o.w / 2, o.h / 2],
      ].map(([x, y]) => [
        cx + x * Math.cos(a) - y * Math.sin(a),
        cy + x * Math.sin(a) + y * Math.cos(a),
      ]);
    });
    if (!points.length) return { x: 0, y: 0, w: 0, h: 0 };
    const x = Math.min(...points.map((p) => p[0])),
      y = Math.min(...points.map((p) => p[1]));
    return {
      x,
      y,
      w: Math.max(...points.map((p) => p[0])) - x,
      h: Math.max(...points.map((p) => p[1])) - y,
    };
  }
  function snapMove(items, delta, others = [], tolerance = 2, grid = false) {
    const box = bounds(items),
      lines = [];
    const result = { ...delta };
    for (const [axis, size, extent] of [
      ["x", "w", W],
      ["y", "h", H],
    ]) {
      const targets = [
        { v: extent / 2, label: "Center" },
        { v: extent / 3, label: "⅓" },
        { v: (extent * 2) / 3, label: "⅔" },
        { v: 10, label: "Margin" },
        { v: extent - 10, label: "Margin" },
      ];
      others
        .filter((o) => !o.hidden)
        .forEach((o) => {
          const q = bounds([o]);
          [0, 0.5, 1].forEach((f) =>
            targets.push({ v: q[axis] + q[size] * f, label: "Aligned" }),
          );
        });
      let best = null;
      for (const t of targets)
        for (const f of [0, 0.5, 1]) {
          const d = t.v - (box[axis] + delta[axis] + box[size] * f);
          if (
            Math.abs(d) <= tolerance &&
            (!best || Math.abs(d) < Math.abs(best.d))
          )
            best = { ...t, d };
        }
      if (best) {
        result[axis] += best.d;
        lines.push({ axis, value: best.v, label: best.label });
      } else if (grid)
        result[axis] =
          Math.round((box[axis] + delta[axis]) / 5) * 5 - box[axis];
    }
    return { delta: result, lines };
  }
  function alignItems(items, direction) {
    if (!items.length) return;
    const axis = ["left", "center", "right"].includes(direction) ? "x" : "y",
      size = axis === "x" ? "w" : "h",
      extent = axis === "x" ? W : H;
    const box = bounds(items),
      offset = ["left", "top"].includes(direction)
        ? 10 - box[axis]
        : ["center", "middle"].includes(direction)
          ? (extent - box[size]) / 2 - box[axis]
          : extent - 10 - box[size] - box[axis];
    items.forEach((o) => (o[axis] += offset));
  }
  function distribute(items, axis) {
    if (items.length < 3) return;
    const size = axis === "x" ? "w" : "h",
      sorted = items
        .slice()
        .sort((a, b) => bounds([a])[axis] - bounds([b])[axis]);
    const all = bounds(sorted),
      gap =
        (all[size] - sorted.reduce((n, o) => n + bounds([o])[size], 0)) /
        (sorted.length - 1);
    let pos = all[axis];
    sorted.forEach((o) => {
      const q = bounds([o]);
      o[axis] += pos - q[axis];
      pos += q[size] + gap;
    });
  }
  let measure;
  function textLines(o) {
    if (!measure && root.document)
      measure = root.document.createElement("canvas").getContext("2d");
    const runs =
      o.runs && o.runs.length ? o.runs : [{ text: o.text, style: o["style"] }];
    const lines = [];
    let line = [],
      width = 0,
      base = 0,
      lineSize = 0;
    function flush() {
      const height = (lineSize || o["style"].size) * PT * o["style"].lineHeight;
      lines.push({
        pieces: line,
        width,
        y: base + (lineSize || o["style"].size) * PT * 0.9,
      });
      base += height;
      line = [];
      width = 0;
      lineSize = 0;
    }
    const chars = [];
    runs.forEach((run) => {
      const s = { ...baseStyle, ...run["style"] };
      if (measure)
        measure.font =
          (s.italic ? "italic " : "") +
          s.weight +
          " " +
          (s.size * 96) / 72 +
          'px "' +
          s.font +
          '"';
      for (const ch of run.text)
        chars.push({
          ch,
          style: s,
          advance:
            (measure
              ? (measure.measureText(ch).width * 25.4) / 96
              : s.size * PT * 0.55) +
            (s.letterSpacing * 25.4) / 96,
        });
    });
    // Wrap whole words across style boundaries; split only a word wider than the box.
    for (let i = 0; i < chars.length;) {
      if (chars[i].ch === "\n") {
        flush();
        i++;
        continue;
      }
      let end = i + 1;
      if (!/\s/.test(chars[i].ch))
        while (end < chars.length && !/\s/.test(chars[end].ch)) end++;
      const word = chars.slice(i, end),
        wordWidth = word.reduce((n, c) => n + c.advance, 0);
      if (width + wordWidth > o.w && line.length && !/\s/.test(word[0].ch))
        flush();
      for (const c of word) {
        if (width + c.advance > o.w && line.length) flush();
        if (!line.length && c.ch === " " && lines.length) continue;
        line.push({ ...c, x: width });
        width += c.advance;
        lineSize = Math.max(lineSize, c["style"].size);
      }
      i = end;
    }
    flush();
    return { lines, height: base };
  }
  function textSvg(o) {
    return textLines(o)
      .lines.map((line) => {
        const offset =
          o["style"].align === "center"
            ? (o.w - line.width) / 2
            : o["style"].align === "right"
              ? o.w - line.width
              : 0;
        return line.pieces
          .map((p) => {
            const s = p["style"],
              x = p.x + offset,
              y = line.y,
              fs = s.size * PT;
            return (
              (s.highlightOn
                ? '<rect x="' +
                  x +
                  '" y="' +
                  (y - fs * 0.9) +
                  '" width="' +
                  p.advance +
                  '" height="' +
                  fs * 1.2 +
                  '" fill="' +
                  esc(s.highlight) +
                  '"/>'
                : "") +
              '<text x="' +
              x +
              '" y="' +
              y +
              '" font-family="' +
              esc(s.font) +
              '" font-size="' +
              fs +
              '" font-weight="' +
              s.weight +
              '" font-style="' +
              (s.italic ? "italic" : "normal") +
              '" text-decoration="' +
              (s.underline ? "underline" : "none") +
              '" fill="' +
              esc(s.color) +
              '" stroke="' +
              esc(s.color) +
              '" stroke-width="' +
              s.outline * 0.15 +
              '" paint-order="stroke" xml:space="preserve">' +
              esc(p.ch) +
              "</text>"
            );
          })
          .join("");
      })
      .join("");
  }
  function tableAppearance(o, paper = "#fffdf7", decoration = null) {
    const rgb = (hex) => {
      const safe = /^#[a-f\d]{6}$/i.test(hex) ? hex : "#fffdf7";
      return [1, 3, 5].map((start) =>
        parseInt(safe.slice(start, start + 2), 16),
      );
    };
    const blend = (a, b, amount) =>
      "#" +
      rgb(a)
        .map((v, i) =>
          Math.round(v + (rgb(b)[i] - v) * amount)
            .toString(16)
            .padStart(2, "0"),
        )
        .join("");
    const luminance = (color) =>
      rgb(color)
        .map((v) => {
          const s = v / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        })
        .reduce((total, v, i) => total + v * [0.2126, 0.7152, 0.0722][i], 0);
    const contrast = (a, b) =>
      (Math.max(luminance(a), luminance(b)) + 0.05) /
      (Math.min(luminance(a), luminance(b)) + 0.05);
    const readable = (background, preferred) =>
      contrast(background, preferred) >= 4.5
        ? preferred
        : contrast(background, "#000000") >= contrast(background, "#ffffff")
          ? "#000000"
          : "#ffffff";
    const kind = ["paper", "ruled", "custom"].includes(o.tableStyle)
      ? o.tableStyle
      : "paper";
    const themed = !!themeInfo(decoration) && kind !== "custom",
      dark = luminance(paper) < 0.22;
    const ink = readable(paper, o["style"].color);
    const header =
      kind === "custom"
        ? o.fill
        : kind === "ruled"
          ? paper
          : blend(
              paper,
              themed ? XPED_BLUE : ink,
              themed ? (dark ? 0.32 : 0.09) : 0.075,
            );
    const stripe = blend(
      paper,
      kind === "custom" ? o.fill : themed ? XPED_MINT : ink,
      kind === "custom" ? 0.18 : themed ? 0.04 : 0.025,
    );
    return {
      kind,
      paper,
      header,
      stripe,
      line:
        kind === "custom"
          ? o.stroke
          : themed
            ? blend(paper, dark ? XPED_LIGHT_MINT : XPED_BLUE, 0.55)
            : blend(paper, ink, 0.23),
      accent: themed ? XPED_YELLOW : null,
      ink: kind === "custom" ? o["style"].color : ink,
      headerInk: kind === "custom" ? o["style"].color : readable(header, ink),
      stripeInk: kind === "custom" ? o["style"].color : readable(stripe, ink),
    };
  }
  function flowAppearance(
    o,
    paper = "#fffdf7",
    decoration = null,
    economy = false,
  ) {
    const themed = !!themeInfo(decoration) && o.flowStyle !== "custom",
      dark = luminance(paper) < 0.22,
      fill = themed
        ? economy
          ? XPED_WHITE
          : blendColor(paper, XPED_BLUE, dark ? 0.3 : 0.08)
        : o.fill,
      stroke = themed
        ? economy
          ? XPED_NAVY
          : dark
            ? XPED_LIGHT_MINT
            : XPED_BLUE
        : o.stroke,
      preferred =
        economy &&
        themeInfo(decoration) &&
        contrast(XPED_WHITE, o["style"].color) < 4.5
          ? XPED_NAVY
          : o["style"].color;
    return {
      kind: themed ? "xped" : "custom",
      fill,
      stroke,
      ink: themed ? readable(fill, preferred) : preferred,
      accent: themed && !economy ? XPED_YELLOW : null,
    };
  }
  function objectSvg(o, assets, options = {}) {
    if (o.hidden || (options.editable && nativeEligible(o))) return "";
    if (options.economy && themeInfo(options.decoration)) {
      const printable = (s) =>
        contrast(XPED_WHITE, s.color) < 4.5 ? { ...s, color: XPED_NAVY } : s;
      o = {
        ...o,
        style: printable(o["style"]),
        runs: (o.runs || []).map((r) => ({
          ...r,
          style: printable(r["style"]),
        })),
      };
    }
    let body = "";
    const w = o.w,
      h = o.h,
      clip = "clip-" + o.id;
    if (o.type === "text") body = textSvg(o);
    if (o.type === "shape") {
      const attrs =
        ' fill="' +
        esc(o.fill) +
        '" stroke="' +
        esc(o.stroke) +
        '" stroke-width="' +
        o.strokeWidth +
        '"';
      const paths = {
        triangle: `${w / 2},0 ${w},${h} 0,${h}`,
        diamond: `${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}`,
        pentagon: `${w / 2},0 ${w},${h * 0.38} ${w * 0.8},${h} ${w * 0.2},${h} 0,${h * 0.38}`,
        parallelogram: `${w * 0.2},0 ${w},0 ${w * 0.8},${h} 0,${h}`,
        "arrow-right": `0,${h * 0.25} ${w * 0.6},${h * 0.25} ${w * 0.6},0 ${w},${h / 2} ${w * 0.6},${h} ${w * 0.6},${h * 0.75} 0,${h * 0.75}`,
      };
      if (o.shape === "circle")
        body = `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${Math.max(0.1, w / 2 - o.strokeWidth)}" ry="${Math.max(0.1, h / 2 - o.strokeWidth)}"${attrs}/>`;
      else if (paths[o.shape])
        body = '<polygon points="' + paths[o.shape] + '"' + attrs + "/>";
      else
        body = `<rect x="${o.strokeWidth / 2}" y="${o.strokeWidth / 2}" width="${Math.max(0.1, w - o.strokeWidth)}" height="${Math.max(0.1, h - o.strokeWidth)}" rx="${o.shape === "pill" ? h / 2 : o.shape === "rounded" ? Math.min(5, h / 4) : 0}"${attrs}/>`;
    }
    if (o.type === "arrow") {
      const head = Math.min(5, h / 2, w / 4),
        end = o.arrowHead || "end";
      body = `<path d="M 1 ${h / 2} H ${w - 1}" fill="none" stroke="${esc(o.stroke)}" stroke-width="${o.strokeWidth}" stroke-linecap="round"${o.arrowLine === "dashed" ? ' stroke-dasharray="3 2"' : ""}/>`;
      if (["end", "both"].includes(end))
        body += `<path d="M ${w - 1 - head} ${h / 2 - head} L ${w - 1} ${h / 2} L ${w - 1 - head} ${h / 2 + head}" fill="none" stroke="${esc(o.stroke)}" stroke-width="${o.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`;
      if (end === "both")
        body += `<path d="M ${1 + head} ${h / 2 - head} L 1 ${h / 2} L ${1 + head} ${h / 2 + head}" fill="none" stroke="${esc(o.stroke)}" stroke-width="${o.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    if (o.type === "image") {
      const a = assets[o.assetId];
      if (a) {
        const imageW = o.spanId ? w * 2 : w,
          start = o.spanSide === "right" ? -w : 0;
        const iw = a.width || 100,
          ih = a.height || 100,
          scale =
            o.fit === "cover"
              ? Math.max(imageW / iw, h / ih)
              : Math.min(imageW / iw, h / ih);
        const dw = iw * scale,
          dh = ih * scale,
          ix = start + (imageW - dw) * (o.cropX / 100),
          iy = (h - dh) * (o.cropY / 100);
        let mask = "";
        if (o.feather)
          mask = `<defs><radialGradient id="fade-${o.id}"><stop offset="${100 - o.feather}%" stop-color="white"/><stop offset="100%" stop-color="black"/></radialGradient><mask id="mask-${o.id}"><rect width="${w}" height="${h}" fill="url(#fade-${o.id})"/></mask></defs>`;
        const clipShape =
          o.mask === "circle"
            ? `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}"/>`
            : `<rect width="${w}" height="${h}" rx="${o.mask === "rounded" ? 4 : 0}"/>`;
        body = `<defs><clipPath id="${clip}">${clipShape}</clipPath></defs>${mask}<g clip-path="url(#${clip})"${o.feather ? ' mask="url(#mask-' + o.id + ')"' : ""}><image href="${esc(a.src)}" x="${ix}" y="${iy}" width="${dw}" height="${dh}" preserveAspectRatio="none"/></g>`;
      } else
        body = `<rect width="${w}" height="${h}" rx="2" fill="#edf0f5"/><text x="4" y="10" font-size="4" fill="#64748b">Image loading…</text>`;
    }
    if (o.type === "drawing") {
      const pts = o.points || [];
      body =
        pts.length === 1
          ? `<circle cx="${pts[0][0]}" cy="${pts[0][1]}" r="${(o.strokeWidth * (o.brush === "highlighter" ? 3 : Math.max(0.3, (pts[0][2] || 0.5) * 1.5))) / 2}" fill="${esc(o.stroke)}" opacity="${o.brush === "highlighter" ? 0.35 : o.brush === "pencil" ? 0.72 : 1}"/>`
          : pts
              .slice(1)
              .map(
                (p, i) =>
                  `<path d="M ${pts[i][0]} ${pts[i][1]} L ${p[0]} ${p[1]}" stroke="${esc(o.stroke)}" stroke-width="${o.strokeWidth * (o.brush === "highlighter" ? 3 : Math.max(0.3, (p[2] || 0.5) * 1.5))}" stroke-linecap="round" opacity="${o.brush === "highlighter" ? 0.35 : o.brush === "pencil" ? 0.72 : 1}"/>`,
              )
              .join("");
    }
    if (o.type === "table") {
      const cells = o.cells?.length
          ? o.cells
          : [
              ["", ""],
              ["", ""],
            ],
        rows = cells.length,
        cols = Math.max(1, ...cells.map((r) => r.length));
      const cw = w / cols,
        ch = h / rows,
        colors = tableAppearance(o, options.paper, options.decoration),
        pad = Math.min(3.5, cw / 6, ch / 4),
        radius = colors.kind !== "ruled" && o.tableRounded !== false ? 2 : 0;
      body = `<g data-table-style="${colors.kind}"><defs><clipPath id="table-${o.id}"><rect width="${w}" height="${h}" rx="${radius}"/></clipPath></defs><g clip-path="url(#table-${o.id})">`;
      body += cells
        .map((row, r) =>
          Array.from({ length: cols }, (_, c) => {
            const header = r === 0 && o.tableHeader !== false,
              striped = !header && o.tableStriped !== false && r % 2 === 0;
            const cellObj = {
              ...o,
              w: Math.max(0.2, cw - pad * 2),
              h: ch - pad * 2,
              text: row[c] || "",
              runs: [],
              style: {
                ...o["style"],
                color: header
                  ? colors.headerInk
                  : striped
                    ? colors.stripeInk
                    : colors.ink,
                weight: header ? 700 : o["style"].weight,
              },
            };
            const fill = header
              ? colors.header
              : o.tableStriped !== false && r % 2 === 0
                ? colors.stripe
                : colors.paper;
            const top = Math.max(pad, (ch - textLines(cellObj).height) / 2);
            return `<svg data-table-cell="${r},${c}" x="${c * cw}" y="${r * ch}" width="${cw}" height="${ch}" viewBox="0 0 ${cw} ${ch}" overflow="hidden"><rect width="${cw}" height="${ch}" fill="${esc(fill)}"/><g transform="translate(${pad} ${top})">${textSvg(cellObj)}</g></svg>`;
          }).join(""),
        )
        .join("");
      for (let r = 1; r < rows; r++)
        body += `<path d="M 0 ${r * ch} H ${w}" fill="none" stroke="${esc(colors.line)}" stroke-width="${o.strokeWidth}"/>`;
      if (colors.accent && o.tableHeader !== false)
        body += `<path data-table-accent="true" d="M 0 ${ch} H ${w}" fill="none" stroke="${options.economy ? colors.line : colors.accent}" stroke-width="${Math.max(0.5, o.strokeWidth)}"/>`;
      if (o.tableColumns)
        for (let c = 1; c < cols; c++)
          body += `<path data-table-column-line="${c}" d="M ${c * cw} 0 V ${h}" fill="none" stroke="${esc(colors.line)}" stroke-width="${o.strokeWidth}"/>`;
      body += `</g>${colors.kind === "ruled" ? "" : `<rect x="${o.strokeWidth / 2}" y="${o.strokeWidth / 2}" width="${Math.max(0.2, w - o.strokeWidth)}" height="${Math.max(0.2, h - o.strokeWidth)}" rx="${radius}" fill="none" stroke="${esc(colors.line)}" stroke-width="${o.strokeWidth}"/>`}</g>`;
    }
    if (o.type === "flow") {
      const colors = flowAppearance(
          o,
          options.paper,
          options.decoration,
          options.economy,
        ),
        { fill, stroke, ink } = colors,
        themed = colors.kind === "xped";
      const steps = o.steps?.length ? o.steps : ["First", "Then", "Finally"],
        n = steps.length,
        vertical = o.flowDirection === "vertical",
        gap = Math.min(8, (vertical ? h : w) / (n * 3)),
        bw = vertical ? w : (w - gap * (n - 1)) / n,
        bh = vertical ? (h - gap * (n - 1)) / n : h;
      body = steps
        .map((t, i) => {
          const x = vertical ? 0 : i * (bw + gap),
            y = vertical ? i * (bh + gap) : 0;
          const text = {
            ...o,
            w: Math.max(0.2, bw - 8),
            text: t,
            runs: [],
            style: { ...o["style"], color: ink, align: "center" },
          };
          const textH = textLines(text).height;
          const shape =
            o.flowShape === "pill"
              ? Math.min(bw, bh) / 2
              : o.flowShape === "square"
                ? 0
                : Math.min(4, bh / 4);
          const arrow = vertical
            ? `M ${bw / 2} ${bh + 1} v ${gap - 2} m -1.5 -1.5 l 1.5 1.5 1.5 -1.5`
            : `M ${bw + 1} ${bh / 2} h ${gap - 2} m -1.5 -1.5 l 1.5 1.5 -1.5 1.5`;
          return `<g data-flow-style="${themed ? "xped" : "custom"}" transform="translate(${x} ${y})"><rect x=".3" y=".3" width="${Math.max(0.2, bw - 0.6)}" height="${Math.max(0.2, bh - 0.6)}" rx="${shape}" fill="${esc(fill)}" stroke="${esc(stroke)}" stroke-width="${o.strokeWidth}"/>${themed && !options.economy ? `<circle cx="${bw - 3}" cy="3" r="1" fill="${XPED_YELLOW}"/>` : ""}<svg width="${bw}" height="${bh}" viewBox="0 0 ${bw} ${bh}" overflow="hidden"><g transform="translate(4 ${Math.max(1.5, (bh - textH) / 2)})">${textSvg(text)}</g></svg>${i < n - 1 ? `<path d="${arrow}" stroke="${esc(stroke)}" stroke-width="${Math.max(0.4, o.strokeWidth)}" stroke-linejoin="round" stroke-linecap="round" fill="none"/>` : ""}</g>`;
        })
        .join("");
    }
    return `<g data-object="${esc(o.id)}" transform="translate(${o.x} ${o.y}) rotate(${o.rotation} ${w / 2} ${h / 2})" opacity="${o.opacity}"><rect width="${w}" height="${h}" fill="transparent"/>${body}</g>`;
  }
  // Exact supplied PNG marks are embedded so reading and print rendering stay offline-capable.
  // Provenance and original files: static/brand/books/xped/.
  const xpedMarks = {
    white:
      "data:image/png;base64,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",
    navy: "data:image/png;base64,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",
  };
  function xpedArtwork(p, options = {}) {
    const design = themeInfo(p.decoration);
    if (!design || p.themeArtwork === false) return "";
    const inside = p.role === "page",
      back = p.role === "back",
      mirrored =
        inside &&
        Number.isInteger(options.interiorIndex) &&
        options.interiorIndex % 2 === 1,
      numbers = pageNumberOptions(options.pageNumbers),
      logoX =
        inside && mirrored && numbers.enabled && numbers.position === "outer"
          ? Math.min(
              126,
              W -
                12 -
                12 -
                4 -
                String(options.interiorIndex + 1).length * numbers.size * PT,
            )
          : 126,
      dark = luminance(p.background) < 0.22,
      mark = (white, x, y, w) =>
        `<image data-xped-mark="${white ? "white" : "navy"}" href="${xpedMarks[white ? "white" : "navy"]}" x="${x}" y="${y}" width="${w}" height="${(w * 112) / 205}" preserveAspectRatio="xMidYMid meet"/>`,
      corner = (scale, mirror = false) =>
        `<g transform="${mirror ? `translate(${W} 0) scale(${-scale} ${scale})` : `scale(${scale})`}"><path data-xped-corner="blue" d="M0 0H550L0 470Z" fill="${XPED_BLUE}"/><path data-xped-corner="yellow" transform="translate(0 273)" d="M0 54L67 0L203 12L197 141L0 310Z" fill="${XPED_YELLOW}"/></g>`;
    let body = "";
    if (options.economy) {
      body =
        `<path d="M10 9H29M10 11H20"${mirrored ? ` transform="translate(${W} 0) scale(-1 1)"` : ""} fill="none" stroke="${XPED_NAVY}" stroke-width=".3"/>` +
        mark(false, inside ? logoX : 109, inside ? 194 : 185, inside ? 12 : 22);
    } else if (inside) {
      body = corner(0.037, mirrored) + mark(dark, logoX, 194, 12);
    } else if (design.variant === "corner") {
      body =
        corner(0.08, back) +
        `<path d="M${back ? -8 : 158} 148 Q${back ? 31 : 107} 185 ${back ? -8 : 158} 230" fill="none" stroke="${XPED_LIGHT_MINT}" stroke-width="11"/>` +
        mark(dark, 109, 185, 22);
    } else if (design.variant === "route") {
      body =
        `<path d="${back ? "M-8 28 C30 46 -10 80 6 111 S-5 158 32 193 L42 216" : "M151 30 C125 73 158 109 142 133 S100 153 119 177 S109 204 81 218"}" fill="none" stroke="${XPED_LIGHT_MINT}" stroke-width="18" stroke-linecap="round"/><path d="${back ? "M-8 28 C30 46 -10 80 6 111 S-5 158 32 193 L42 216" : "M151 30 C125 73 158 109 142 133 S100 153 119 177 S109 204 81 218"}" fill="none" stroke="${XPED_BLUE}" stroke-width="4.5" stroke-linecap="round"/><circle cx="${back ? 27 : 132}" cy="${back ? 189 : 145}" r="5.5" fill="${XPED_YELLOW}"/><path d="M18 32H42" stroke="${XPED_BLUE}" stroke-width="1.1"/>` +
        mark(dark, 18, 185, 22);
    } else if (design.variant === "shapes") {
      body =
        `<path d="M17 38H131V127L113 146H17Z" fill="${XPED_YELLOW}"/><path d="M116 181L144 153L162 168L133 210H109Z" fill="${XPED_LIGHT_MINT}"/>` +
        mark(true, 18, 15, 22);
    } else {
      body =
        corner(0.071, back) +
        `<path d="${back ? "M-7 152 C45 174 52 213 96 207" : "M153 149 C106 151 130 196 88 213"}" fill="none" stroke="${XPED_MINT}" stroke-width=".85" stroke-dasharray="1.5 3"/><circle cx="${back ? 38 : 129}" cy="${back ? 175 : 163}" r="2.6" fill="${XPED_YELLOW}"/>` +
        mark(true, 109, 185, 22);
    }
    return `<g data-theme-artwork="xped" data-cover-variant="${design.variant}" data-paper-mode="${design.mode}"${inside ? ` data-interior-side="${mirrored ? "right" : "left"}"` : ""} pointer-events="none">${body}</g>`;
  }
  function pageNumberSvg(p, options = {}) {
    const numbers = pageNumberOptions(options.pageNumbers);
    if (!numbers.enabled || p.role !== "page") return "";
    const index =
        Number.isInteger(options.interiorIndex) && options.interiorIndex >= 0
          ? options.interiorIndex
          : 0,
      outerLeft = index % 2 === 0,
      x =
        numbers.position === "center"
          ? W / 2
          : numbers.position === "outer"
            ? outerLeft
              ? 12
              : W - 12
            : 121,
      anchor =
        numbers.position === "center"
          ? "middle"
          : numbers.position === "outer" && outerLeft
            ? "start"
            : "end",
      paper = options.economy ? XPED_WHITE : p.background,
      color = options.economy
        ? XPED_NAVY
        : numbers.colorMode === "custom"
          ? numbers.color
          : readable(paper);
    return `<text data-page-number="${index + 1}" x="${x}" y="198.5" text-anchor="${anchor}" font-family="${esc(numbers.font)}" font-size="${numbers.size * PT}" font-weight="${numbers.weight}" fill="${esc(color)}" pointer-events="none">${index + 1}</text>`;
  }
  function svg(p, assets = {}, options = {}) {
    const bg = options.economy ? "#ffffff" : p.background;
    let pattern = "";
    if (!options.economy && p.texture !== "plain") {
      const ink = p.texture === "grain" ? "#968875" : "#a2adbe";
      const marks = {
        lined: '<path d="M0 8 H10"/>',
        grid: '<path d="M0 0H10V10"/>',
        dots: '<circle cx="5" cy="5" r=".25" fill="' + ink + '"/>',
        grain: '<circle cx="2" cy="1" r=".12"/><circle cx="7" cy="8" r=".1"/>',
      };
      pattern = `<defs><pattern id="paper-${p.id}" width="${p.texture === "grain" ? 2 : 10}" height="${p.texture === "grain" ? 2 : 10}" patternUnits="userSpaceOnUse"><g stroke="${ink}" stroke-width=".15" opacity=".28">${marks[p.texture] || ""}</g></pattern></defs><rect width="${W}" height="${H}" fill="url(#paper-${p.id})"/>`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(p.title)}"><defs>${options.fonts ? "<style>" + options.fonts + "</style>" : ""}<clipPath id="page-${p.id}"><rect width="${W}" height="${H}"/></clipPath></defs><rect width="${W}" height="${H}" fill="${bg}"/>${pattern}${xpedArtwork(p, options)}<desc>${esc(
      p.items
        .filter((o) => o.type === "text" && !o.hidden)
        .map((o) =>
          o.runs.length ? o.runs.map((r) => r.text).join("") : o.text,
        )
        .join(" "),
    )}</desc><g aria-hidden="true" clip-path="url(#page-${p.id})">${p.items.map((o) => objectSvg(o, assets, { ...options, paper: bg, decoration: p.decoration })).join("")}</g>${pageNumberSvg(p, options)}${options.guides ? `<rect x="10" y="10" width="${W - 20}" height="${H - 20}" fill="none" stroke="#818cf8" stroke-width=".3" stroke-dasharray="2 2" pointer-events="none"/>` : ""}</svg>`;
  }
  function preserveSpreads(pages) {
    const output = [],
      remaining = pages.slice();
    while (remaining.length) {
      const p = remaining.shift(),
        span = p.items.find((o) => o.spanId);
      if (!span) {
        output.push(p);
        continue;
      }
      const pair = remaining.find((other) =>
        other.items.some((o) => o.spanId === span.spanId),
      );
      if (!pair) {
        output.push(p);
        continue;
      }
      if (output.length % 2 === 0) {
        const blank = page();
        blank.title = "Blank page";
        blank.background = p.background;
        output.push(blank);
      }
      remaining.splice(remaining.indexOf(pair), 1);
      output.push(...(span.spanSide === "left" ? [p, pair] : [pair, p]));
    }
    return output;
  }
  function checks(b) {
    const issues = [];
    b.pages.forEach((p, i) =>
      p.items
        .filter((o) => !o.hidden)
        .forEach((o) => {
          const label =
            (p.role === "page" ? "Page " + i : p.title) +
            ": " +
            (o.name || o.type);
          if (o.type === "text" && textLines(o).height > o.h + 1)
            issues.push(label + " — text extends beyond its box.");
          if (o.x < 8 || o.y < 8 || o.x + o.w > W - 8 || o.y + o.h > H - 8)
            issues.push(label + " — near the paper edge.");
          if (
            p.role === "page" &&
            ((i % 2 === 1 && o.x + o.w > W - 15) || (i % 2 === 0 && o.x < 15))
          )
            issues.push(label + " — close to the binding edge.");
          if (o.type === "image") {
            const a = b.assets.find((a) => a.id === o.assetId);
            if (
              a &&
              Math.min(a.width / (o.w / 25.4), a.height / (o.h / 25.4)) < 150
            )
              issues.push(label + " — may look blurry in print.");
          }
        }),
    );
    return issues;
  }
  function prompt(b, p, o) {
    const i = b.illustration;
    return (
      "Transform the attached sketch into a finished " +
      i["style"] +
      " illustration. Preserve the character’s identity, pose and composition. Use this palette: " +
      b.palette.join(", ") +
      ". " +
      (i.transparent
        ? "Create isolated artwork with a genuinely transparent background."
        : "Match the page background exactly: " +
          p.background +
          ", with softly fading edges.") +
      " " +
      (i.blend
        ? "No frame, paper rectangle, drop shadow or photographed-page effect. "
        : "") +
      "Leave the " +
      i.space +
      " clear for text and keep important details away from the binding edge. Do not include lettering. " +
      (i.characters ? "Character reference: " + i.characters + ". " : "") +
      "Match the attached character references. Intended placement: " +
      (o ? Math.round(o.w) + " × " + Math.round(o.h) : W + " × " + H) +
      " mm."
    );
  }
  function readBackup(raw) {
    const fail = () => {
      throw new Error(
        "This backup contains a page or image that cannot be opened.",
      );
    };
    const arr = (v, n) => {
      if (v === undefined) return [];
      if (!Array.isArray(v) || v.length > n) fail();
      return v;
    };
    const safeId = (v) => {
      if (typeof v !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(v)) fail();
      return v;
    };
    const text = (v, n = 200) => String(v || "").slice(0, n);
    const hex = (v, fallback) =>
      typeof v === "string" && /^#[a-fA-F0-9]{6}$/.test(v) ? v : fallback;
    const one = (v, options, fallback) => (options.includes(v) ? v : fallback);
    function style(s = {}) {
      s = s && typeof s === "object" ? s : {};
      const font = one(s.font, fontOptions, "Nunito");
      return {
        font,
        size: clamp(s.size || 18, 6, 160),
        weight:
          font === "Nohemi"
            ? 700
            : font === "General Sans"
              ? s.weight >= 600
                ? 700
                : 400
              : clamp(s.weight || 400, 100, 1000),
        color: hex(s.color, "#263343"),
        italic: !!s.italic && fontSupportsItalic(font),
        underline: !!s.underline,
        align: one(s.align, ["left", "center", "right"], "left"),
        lineHeight: clamp(s.lineHeight || 1.4, 0.8, 3),
        letterSpacing: clamp(s.letterSpacing, -2, 10),
        outline: clamp(s.outline, 0, 4),
        highlight: hex(s.highlight, "#fff0b8"),
        highlightOn: !!s.highlightOn,
      };
    }
    function cleanPage(p) {
      if (!p || typeof p !== "object") fail();
      const items = arr(p.items, 300).map((o) => {
        if (
          !o ||
          ![
            "text",
            "image",
            "shape",
            "arrow",
            "table",
            "flow",
            "drawing",
          ].includes(o.type)
        )
          fail();
        const next = object(o.type, {
          id: safeId(o.id),
          name: text(o.name, 100),
          x: clamp(o.x, -W, W * 2),
          y: clamp(o.y, -H, H * 2),
          w: clamp(o.w, 0.2, W * 2),
          h: clamp(o.h, 0.2, H * 2),
          rotation: clamp(o.rotation, -360, 360),
          opacity: o.opacity === undefined ? 1 : clamp(o.opacity, 0, 1),
          locked: !!o.locked,
          hidden: !!o.hidden,
          group: o.group ? safeId(o.group) : "",
          style: style(o["style"]),
          text: text(o.text, 12000),
          fill: hex(o.fill, "#c9def0"),
          stroke: hex(o.stroke, "#4f46e5"),
          strokeWidth: clamp(o.strokeWidth, 0, 12),
          shape: one(
            o.shape,
            shared.shapeOptions.map((s) => s.value),
            "rounded",
          ),
          assetId: o.assetId ? safeId(o.assetId) : "",
          originalAssetId: o.originalAssetId ? safeId(o.originalAssetId) : "",
          spanId: o.spanId ? safeId(o.spanId) : "",
          spanSide: one(o.spanSide, ["left", "right"], ""),
          aspectLock: o.aspectLock !== false,
          fit: one(o.fit, ["cover", "contain"], "contain"),
          cropX: clamp(o.cropX ?? 50, 0, 100),
          cropY: clamp(o.cropY ?? 50, 0, 100),
          mask: one(o.mask, ["none", "circle", "rounded"], "none"),
          feather: clamp(o.feather, 0, 20),
          brush: one(o.brush, ["pen", "pencil", "highlighter"], "pen"),
          tableHeader: o.tableHeader !== false,
          tableStriped: o.tableStriped !== false,
          tableRounded: o.tableRounded !== false,
          tableStyle: one(o.tableStyle, ["paper", "ruled", "custom"], "paper"),
          tableColumns: !!o.tableColumns,
          flowDirection: one(
            o.flowDirection,
            ["horizontal", "vertical"],
            "horizontal",
          ),
          flowShape: one(o.flowShape, ["rounded", "pill", "square"], "rounded"),
          flowStyle: one(o.flowStyle, ["theme", "custom"], "theme"),
          arrowHead: one(o.arrowHead, ["none", "end", "both"], "end"),
          arrowLine: one(o.arrowLine, ["solid", "dashed"], "solid"),
          styleName: one(o.styleName, ["heading", "body", "caption"], ""),
        });
        next.runs = arr(o.runs, 500).map((r) => ({
          text: text(r.text, 12000),
          style: style(r["style"]),
        }));
        if (next.runs.reduce((n, r) => n + r.text.length, 0) > 12000) fail();
        next.points = arr(o.points, 3000).map((p) => {
          if (!Array.isArray(p) || p.length < 2) fail();
          return [
            clamp(p[0], 0, W * 2),
            clamp(p[1], 0, H * 2),
            clamp(p[2] ?? 0.5, 0.05, 1),
          ];
        });
        next.cells = arr(o.cells, 8).map((r) =>
          arr(r, 8).map((c) => text(c, 2000)),
        );
        next.steps = arr(o.steps, 8).map((s) => text(s, 400));
        return next;
      });
      if (new Set(items.map((o) => o.id)).size !== items.length) fail();
      return {
        id: safeId(p.id),
        title: text(p.title, 100),
        role: one(p.role, ["front", "page", "back"], "page"),
        background: hex(p.background, "#fffdf7"),
        texture: one(
          p.texture,
          ["plain", "grain", "lined", "dots", "grid"],
          "plain",
        ),
        decoration: themeInfo(p.decoration),
        themeArtwork: p.themeArtwork !== false,
        items,
      };
    }
    if (
      !raw ||
      raw.schema_version !== 1 ||
      !Array.isArray(raw.pages) ||
      raw.pages.length < 4
    )
      fail();
    const next = book(),
      pages = arr(raw.pages, 100).map(cleanPage),
      deletedPages = arr(raw.deletedPages, 100).map(cleanPage);
    if (
      pages[0].role !== "front" ||
      pages.at(-1).role !== "back" ||
      pages.slice(1, -1).some((p) => p.role !== "page")
    )
      fail();
    if (
      new Set(pages.concat(deletedPages).map((p) => p.id)).size !==
      pages.length + deletedPages.length
    )
      fail();
    const illustration = raw.illustration || {};
    Object.assign(next, {
      title: text(raw.title, 140) + " (imported)",
      folder: text(raw.folder, 80),
      tags: arr(raw.tags, 12).map((t) => text(t, 40)),
      theme: themeInfo(raw.theme),
      pageNumbers: pageNumberOptions(raw.pageNumbers),
      palette: arr(raw.palette, 12).map((c) => hex(c, "#4f46e5")),
      pages,
      deletedPages,
      styles: Object.fromEntries(
        ["heading", "body", "caption"].map((k) => [
          k,
          style((raw.styles || {})[k]),
        ]),
      ),
      illustration: {
        style: text(illustration["style"]),
        characters: text(illustration.characters, 2000),
        space: text(illustration.space, 100),
        blend: illustration.blend !== false,
        transparent: illustration.transparent !== false,
      },
    });
    next.assets = arr(raw.assets, 400).map((a) => ({
      id: safeId(a.id),
      name: text(a.name, 180),
      mime: one(a.mime, ["image/png", "image/jpeg", "image/webp"], "image/png"),
    }));
    next.versions = arr(raw.versions, 20).map((v) => {
      const m = v.metadata || {},
        i = m.illustration || {};
      return {
        id: safeId(v.id),
        name: text(v.name, 100),
        created_at: clamp(v.created_at, 0, 99999999999),
        pages: arr(v.pages, 100).map(cleanPage),
        deletedPages: arr(v.deletedPages, 100).map(cleanPage),
        metadata: {
          title: text(m.title || next.title, 150),
          folder: text(m.folder, 80),
          tags: arr(m.tags, 12).map((t) => text(t, 40)),
          theme: themeInfo(m.theme),
          pageNumbers: pageNumberOptions(m.pageNumbers),
          palette: arr(m.palette, 12).map((c) => hex(c, "#4f46e5")),
          styles: Object.fromEntries(
            ["heading", "body", "caption"].map((k) => [
              k,
              style((m.styles || next.styles)[k]),
            ]),
          ),
          illustration: {
            style: text(i["style"]),
            characters: text(i.characters, 2000),
            space: text(i.space, 100),
            blend: i.blend !== false,
            transparent: i.transparent !== false,
          },
        },
      };
    });
    return next;
  }

  const api = {
    W,
    H,
    PT,
    id,
    clone,
    esc,
    clamp,
    baseStyle,
    fontOptions,
    fontWeights,
    fontSupportsItalic,
    xped,
    themeInfo,
    applyXpedTheme,
    pageForBook,
    styleObjectForBook,
    coverPreview,
    pageRenderOptions,
    pageNumberOptions,
    tableAppearance,
    flowAppearance,
    page,
    object,
    book,
    readBackup,
    spreads,
    imageSize,
    sheetPairs,
    preserveSpreads,
    shapeOptions: shared.shapeOptions,
    nativeEligible,
    textLines,
    replaceText,
    bounds,
    snapMove,
    alignItems,
    distribute,
    svg,
    checks,
    prompt,
  };
  if (typeof module !== "undefined") module.exports = api;
  root.BookModel = api;
})(typeof window !== "undefined" ? window : globalThis);
