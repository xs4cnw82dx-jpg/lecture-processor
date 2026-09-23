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
        flowDirection: "vertical",
        flowShape: "rounded",
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
    if (arrangement === "fold") {
      const order = pages.slice(0, -1).map((_, i) => i);
      while ((order.length + 1) % 4) order.push(null);
      order.push(pages.length - 1);
      const n = order.length,
        result = [];
      for (let i = 0; i < n / 4; i++)
        result.push(
          [order[n - 1 - i * 2], order[i * 2]],
          [order[i * 2 + 1], order[n - 2 - i * 2]],
        );
      return result;
    }
    const pairs = [[null, 0]];
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
        insertionStyle = o.style;
      const before = [],
        after = [];
      o.runs.forEach((r) => {
        const stop = at + r.text.length;
        if (at <= start && stop >= start) insertionStyle = r.style;
        if (at < start)
          before.push({
            text: r.text.slice(0, start - at),
            style: { ...r.style },
          });
        if (stop > old.length - end)
          after.push({
            text: r.text.slice(Math.max(0, old.length - end - at)),
            style: { ...r.style },
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
        if (last && JSON.stringify(last.style) === JSON.stringify(r.style))
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
      o.runs && o.runs.length ? o.runs : [{ text: o.text, style: o.style }];
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
      const s = { ...baseStyle, ...run.style };
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
    for (let i = 0; i < chars.length; ) {
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
            const s = p.style,
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
  function objectSvg(o, assets, options = {}) {
    if (o.hidden || (options.editable && nativeEligible(o))) return "";
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
        ch = h / rows;
      body = `<defs><clipPath id="table-${o.id}"><rect x=".2" y=".2" width="${w - 0.4}" height="${h - 0.4}" rx="${o.tableRounded !== false ? 3 : 0}"/></clipPath></defs><g clip-path="url(#table-${o.id})">`;
      body += cells
        .map((row, r) =>
          Array.from({ length: cols }, (_, c) => {
            const header = r === 0 && o.tableHeader !== false;
            const cellObj = {
              ...o,
              w: Math.max(0.2, cw - 4),
              h: ch - 3,
              text: row[c] || "",
              runs: [],
              style: { ...o.style, weight: header ? 700 : o["style"].weight },
            };
            return `<svg x="${c * cw}" y="${r * ch}" width="${cw}" height="${ch}" viewBox="0 0 ${cw} ${ch}" overflow="hidden"><rect width="${cw}" height="${ch}" fill="#ffffff"/><rect width="${cw}" height="${ch}" fill="${esc(o.fill)}" opacity="${header ? 1 : o.tableStriped !== false && r % 2 === 0 ? 0.28 : 0}"/><rect width="${cw}" height="${ch}" fill="none" stroke="${esc(o.stroke)}" stroke-width="${o.strokeWidth}"/><g transform="translate(2 1.5)">${textSvg(cellObj)}</g></svg>`;
          }).join(""),
        )
        .join("");
      body += `</g><rect x="${o.strokeWidth / 2}" y="${o.strokeWidth / 2}" width="${Math.max(0.2, w - o.strokeWidth)}" height="${Math.max(0.2, h - o.strokeWidth)}" rx="${o.tableRounded !== false ? 3 : 0}" fill="none" stroke="${esc(o.stroke)}" stroke-width="${o.strokeWidth}"/>`;
    }
    if (o.type === "flow") {
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
            style: { ...o.style, align: "center" },
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
          return `<g transform="translate(${x} ${y})"><rect x=".3" y=".3" width="${Math.max(0.2, bw - 0.6)}" height="${Math.max(0.2, bh - 0.6)}" rx="${shape}" fill="${esc(o.fill)}" stroke="${esc(o.stroke)}" stroke-width="${o.strokeWidth}"/><svg width="${bw}" height="${bh}" viewBox="0 0 ${bw} ${bh}" overflow="hidden"><g transform="translate(4 ${Math.max(1.5, (bh - textH) / 2)})">${textSvg(text)}</g></svg>${i < n - 1 ? `<path d="${arrow}" stroke="${esc(o.stroke)}" stroke-width="${Math.max(0.4, o.strokeWidth)}" stroke-linejoin="round" stroke-linecap="round" fill="none"/>` : ""}</g>`;
        })
        .join("");
    }
    return `<g data-object="${esc(o.id)}" transform="translate(${o.x} ${o.y}) rotate(${o.rotation} ${w / 2} ${h / 2})" opacity="${o.opacity}"><rect width="${w}" height="${h}" fill="transparent"/>${body}</g>`;
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
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(p.title)}"><defs>${options.fonts ? "<style>" + options.fonts + "</style>" : ""}<clipPath id="page-${p.id}"><rect width="${W}" height="${H}"/></clipPath></defs><rect width="${W}" height="${H}" fill="${bg}"/>${pattern}<desc>${esc(
      p.items
        .filter((o) => o.type === "text" && !o.hidden)
        .map((o) =>
          o.runs.length ? o.runs.map((r) => r.text).join("") : o.text,
        )
        .join(" "),
    )}</desc><g aria-hidden="true" clip-path="url(#page-${p.id})">${p.items.map((o) => objectSvg(o, assets, options)).join("")}</g>${options.guides ? `<rect x="10" y="10" width="${W - 20}" height="${H - 20}" fill="none" stroke="#818cf8" stroke-width=".3" stroke-dasharray="2 2" pointer-events="none"/>` : ""}</svg>`;
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
      i.style +
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
      return {
        font: one(
          s.font,
          ["Nunito", "Andika", "Playpen Sans", "Fraunces", "Comic Neue"],
          "Nunito",
        ),
        size: clamp(s.size || 18, 6, 160),
        weight: clamp(s.weight || 400, 100, 1000),
        color: hex(s.color, "#263343"),
        italic: !!s.italic,
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
          style: style(o.style),
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
          flowDirection: one(
            o.flowDirection,
            ["horizontal", "vertical"],
            "horizontal",
          ),
          flowShape: one(o.flowShape, ["rounded", "pill", "square"], "rounded"),
          arrowHead: one(o.arrowHead, ["none", "end", "both"], "end"),
          arrowLine: one(o.arrowLine, ["solid", "dashed"], "solid"),
          styleName: one(o.styleName, ["heading", "body", "caption"], ""),
        });
        next.runs = arr(o.runs, 500).map((r) => ({
          text: text(r.text, 12000),
          style: style(r.style),
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
        style: text(illustration.style),
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
          palette: arr(m.palette, 12).map((c) => hex(c, "#4f46e5")),
          styles: Object.fromEntries(
            ["heading", "body", "caption"].map((k) => [
              k,
              style((m.styles || next.styles)[k]),
            ]),
          ),
          illustration: {
            style: text(i.style),
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
