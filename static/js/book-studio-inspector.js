import { M, P, $, esc, field, selectField, toggle, icon, iconButton } from "./book-studio-ui.js";

export function createBookInspector(state, editor) {
  const panelDetails = new Set();
  const liveColorValues = new WeakMap();
  function setInspector(
    open,
    mobile = $("inspector").classList.contains("mobile-open"),
  ) {
    state.inspectorOpen = open;
    $("workspace").classList.toggle("inspector-closed", !open);
    $("inspector").classList.toggle("mobile-open", open && mobile);
    $("page-settings").setAttribute(
      "aria-expanded",
      String(open && (innerWidth > 780 || mobile)),
    );
    editor.saveView();
    requestAnimationFrame(editor.fitStage);
  }
  function showPageNumbers() {
    panelDetails.add("Page numbers");
    state.inspectorTab = "settings";
    setInspector(true, innerWidth <= 780);
    renderInspector();
    const section = $("page-number-controls");
    section.open = true;
    section.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    section.querySelector("input")?.focus({ preventScroll: true });
  }
  function selectedStyle(o) {
    if (!o || !state.selectionRange || state.selectionRange.end <= state.selectionRange.start)
      return o?.style;
    let offset = 0;
    for (const r of o.runs || []) {
      offset += r.text.length;
      if (offset > state.selectionRange.start) return { ...o.style, ...r.style };
    }
    return o.style;
  }
  function renderInspector() {
    if (!state.book) return;
    document.querySelectorAll("[data-tool]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.tool === state.tool)));
    const p = editor.page(),
      source = editor.item(),
      o = source ? { ...source, style: selectedStyle(source) } : null,
      disabled = !editor.editable();
    if (o?.type === "flow") {
      const colors = M.flowAppearance(o, p.background, p.decoration);
      o.fill = colors.fill;
      o.stroke = colors.stroke;
      o.style = { ...o.style, color: colors.ink };
    }
    const panel = $("inspector"),
      scroll = panel.scrollTop,
      focused = document.activeElement;
    const focusField = panel.contains(focused) ? focused.dataset.field : null;
    panel.querySelectorAll("details").forEach((d) => {
      const key = d.querySelector("summary").textContent;
      if (d.open) panelDetails.add(key);
      else panelDetails.delete(key);
    });
    let html = `<div class="book-panel-heading"><h2${state.selected.length === 1 && o ? ' data-user-content' : ''}>${state.selected.length > 1 ? state.selected.length + " objects" : o ? esc(o.name || o.type) : state.furnitureSelection === "logo" ? "xPED logo" : state.furnitureSelection === "number" ? "Page number" : "Page settings"}</h2><button class="icon-btn" id="close-inspector" aria-label="Close settings" title="Close settings">${icon("close")}</button></div>`;
    html += `<div class="book-inspector-tabs" role="tablist" aria-label="Settings sections"><button role="tab" data-panel="settings" tabindex="${state.inspectorTab === "settings" ? "0" : "-1"}" aria-selected="${state.inspectorTab === "settings"}" aria-controls="book-properties">Settings</button><button role="tab" data-panel="layers" tabindex="${state.inspectorTab === "layers" ? "0" : "-1"}" aria-selected="${state.inspectorTab === "layers"}" aria-controls="book-layers">Layers · ${p.items.length}</button></div><div id="book-properties" role="tabpanel" aria-label="Settings" ${state.inspectorTab !== "settings" ? "hidden" : ""}>`;
    if (disabled)
      html +=
        '<p class="book-status-banner">' +
        (state.book.deleted
          ? "Restore this book from your bookshelf to edit it."
          : state.book.local
            ? ""
            : state.book.editor
              ? esc(state.book.editor.name) +
                " is editing. You can read and leave comments."
              : "You are viewing this book.") +
        "</p>";
    if (state.furnitureSelection && editor.furnitureBox()) {
      const box = editor.furnitureBox();
      html += `<h3>${state.furnitureSelection === "logo" ? "xPED logo" : "Page number"}</h3><p class="book-muted book-hint">Drag on the page, or choose an exact position. Arrow keys make small adjustments.</p><div class="book-row">` +
        field("Left (mm)", "furniture.x", +box.x.toFixed(1), "number", 'min="0" step="0.5"') +
        field("Top (mm)", "furniture.y", +box.y.toFixed(1), "number", 'min="0" step="0.5"') + "</div>";
      if (state.furnitureSelection === "logo") html += field("Logo width (mm)", "furniture.w", +box.w.toFixed(1), "number", 'min="8" max="60" step="0.5"');
      html += '<button class="secondary-btn" id="reset-furniture">Reset position</button>';
      if (state.furnitureSelection === "number") panelDetails.add("Page numbers");
    } else if (o) {
      if (o.locked)
        html += `<p class="book-status-banner">This object is locked. Unlock it to make changes.</p><button class="secondary-btn" data-lock="${o.id}">${icon("unlock")} Unlock object</button>`;
      if (o.hidden)
        html += `<p class="book-status-banner">Hidden on the page and in exports.</p><button class="secondary-btn" data-hide="${o.id}">${icon("eye")} Show object</button>`;
      html +=
        '<fieldset class="book-object-fields"' +
        (o.locked ? " disabled" : "") +
        ">";
      html += field("Object name", "name", o.name);
      if (o.type === "text") {
        html += `<label class="book-field"><span>Text <button type="button" class="book-text-link" id="edit-on-page" aria-label="Edit text on page">Edit on page</button></span><textarea id="object-text" maxlength="12000" aria-label="Text">${esc(o.runs && o.runs.length ? o.runs.map((r) => r.text).join("") : o.text)}</textarea></label>`;
        if (M.textLines(o).height > o.h + 0.5)
          html +=
            '<p class="book-warning">This text is taller than its box.</p><button class="secondary-btn" id="fit-text-height">Fit box to text</button>';
        html += selectField("Text style", "styleName", o.styleName, [
          ["", "Custom"],
          ["heading", "Heading"],
          ["body", "Body"],
          ["caption", "Caption"],
        ]);
        html += selectField("Font", "style.font", o["style"].font, M.fontOptions);
        html +=
          '<div class="book-row">' +
          field(
            "Size (pt)",
            "style.size",
            o["style"].size,
            "number",
            'min="6" max="160"',
          ) +
          field("Color", "style.color", o["style"].color, "color") +
          "</div>";
        const weights = M.fontWeights(o["style"].font);
        html += weights
          ? selectField(
              "Thickness",
              "style.weight",
              o["style"].weight,
              weights.map((w) => [
                w,
                w === 300 ? "Light" : w === 400 ? "Regular" : "Bold",
              ]),
            )
          : field(
              "Thickness · " + o["style"].weight,
              "style.weight",
              o["style"].weight,
              "range",
              `min="${o["style"].font === "Nunito" ? 200 : 100}" max="${o["style"].font === "Playpen Sans" ? 800 : o["style"].font === "Fraunces" ? 900 : 1000}" step="10"`,
            );
        html +=
          '<div class="book-segmented">' +
          [
            ["italic", "Italic"],
            ["underline", "Underline"],
            ["highlightOn", "Highlight"],
          ]
            .map(
              ([key, label]) =>
                `<button data-style-toggle="${key}"${key === "italic" && !M.fontSupportsItalic(o["style"].font) ? ' disabled title="This font has no italic style"' : ""} aria-pressed="${o.style[key]}">${label}</button>`,
            )
            .join("") +
          "</div>";
        html += selectField("Alignment", "style.align", o["style"].align, [
          ["left", "Left"],
          ["center", "Center"],
          ["right", "Right"],
        ]);
        html +=
          '<details><summary>Text spacing & effects</summary><div class="book-row">' +
          field(
            "Line spacing",
            "style.lineHeight",
            o["style"].lineHeight,
            "number",
            'min="0.8" max="3" step="0.1"',
          ) +
          field(
            "Letter spacing",
            "style.letterSpacing",
            o["style"].letterSpacing,
            "number",
            'min="-2" max="10" step="0.2"',
          ) +
          "</div>" +
          field(
            "Outline",
            "style.outline",
            o["style"].outline,
            "range",
            'min="0" max="4" step="0.1"',
          ) +
          field(
            "Highlight color",
            "style.highlight",
            o["style"].highlight,
            "color",
          ) +
          '<button class="secondary-btn" id="save-text-style">Update book text style</button></details>';
      }
      if (o.type === "image") {
        html +=
          '<div class="book-segmented">' +
          [
            ["small", "Small"],
            ["medium", "Medium"],
            ["large", "Large"],
            ["fit", "Fit page"],
          ]
            .map(([v, l]) => `<button data-size="${v}">${l}</button>`)
            .join("") +
          "</div>";
        html += toggle("Keep proportions", "aspectLock", o.aspectLock);
        html +=
          '<div class="book-row"><button class="secondary-btn" id="replace-image">Replace</button><button class="secondary-btn" id="illustration-assistant">Illustration prompt</button></div>';
        html += selectField("Image fit", "fit", o.fit, [
          ["contain", "Show whole image"],
          ["cover", "Crop to fill"],
        ]);
        html +=
          "<details><summary>Crop & edges</summary>" +
          field(
            "Horizontal crop",
            "cropX",
            o.cropX,
            "range",
            'min="0" max="100"',
          ) +
          field(
            "Vertical crop",
            "cropY",
            o.cropY,
            "range",
            'min="0" max="100"',
          ) +
          selectField("Mask", "mask", o.mask, [
            ["none", "Rectangle"],
            ["rounded", "Rounded"],
            ["circle", "Oval"],
          ]) +
          field(
            "Soft edges",
            "feather",
            o.feather,
            "range",
            'min="0" max="20"',
          ) +
          "</details>";
        html +=
          '<div class="book-button-stack"><button class="secondary-btn" id="fill-page">Fill page</button><button class="secondary-btn" id="span-pages">' +
          (o.spanId ? "Split spread illustration" : "Span both pages") +
          '</button><button class="ghost-btn" id="download-original">Download original</button></div>';
      }
      if (o.type === "shape")
        html += selectField(
          "Shape",
          "shape",
          o.shape,
          M.shapeOptions.map((s) => [s.value, s.label]),
        );
      if (o.type === "table") {
        html += selectField(
          "Table style",
          "tableStyle",
          o.tableStyle || "paper",
          [
            ["paper", "Match page paper"],
            ["ruled", "Simple ruled lines"],
            ["custom", "Custom colors"],
          ],
        );
        html +=
          '<p class="book-muted book-hint">' +
          (o.tableStyle === "custom"
            ? "Choose your own header, line and text colors. Empty cells keep the page’s paper color."
            : "Colors follow this page’s paper, with gentle shading and readable text.") +
          "</p>";
      }
      if (o.type === "flow" && p.decoration?.id === "xped")
        html += selectField("Step colors", "flowStyle", o.flowStyle || "theme", [
          ["theme", "Match page theme"],
          ["custom", "Custom colors"],
        ]);
      if (
        ["shape", "drawing", "flow"].includes(o.type) ||
        (o.type === "table" && o.tableStyle === "custom")
      )
        html +=
          '<div class="book-row">' +
          field(
            o.type === "table" ? "Shading color" : "Fill",
            "fill",
            o.fill,
            "color",
          ) +
          field("Line", "stroke", o.stroke, "color") +
          "</div>" +
          field(
            "Line thickness",
            "strokeWidth",
            o.strokeWidth,
            "range",
            o.type === "table"
              ? 'min="0.1" max="1.5" step="0.05"'
              : 'min="0.1" max="10" step="0.1"',
          );
      if (o.type === "table" && o.tableStyle !== "custom")
        html += field(
          "Line thickness",
          "strokeWidth",
          o.strokeWidth,
          "range",
          'min="0.1" max="1.5" step="0.05"',
        );
      if (editor.isPath(o)) {
        html += field("Line color", "stroke", o.stroke, "color") +
          field("Line thickness (mm)", "strokeWidth", o.strokeWidth, "range", 'min="0.1" max="10" step="0.1"');
        if (o.type === "arrow") html += selectField("Arrowheads", "arrowHead", o.arrowHead || "end", [
          ["none", "No arrowhead"], ["end", "At the end"], ["both", "Both ends"],
        ]) + (o.arrowHead !== "none" ? field("Arrowhead color", "arrowFill", o.arrowFill || o.stroke, "color") : "");
        html += selectField("Line style", "arrowLine", o.arrowLine || "solid", [["solid", "Solid"], ["dashed", "Dashed"]]) +
          selectField("Bends", "pathMode", o.pathMode || "angular", [["angular", "Sharp corners"], ["smooth", "Smooth curve"]]) +
          '<p class="book-muted book-hint">Drag the points on your line to reshape it. Right-click anywhere along it to add a bend.</p><div class="book-row"><button class="secondary-btn" id="add-path-bend" ' + (P.points(o).length >= 32 ? "disabled" : "") + '>Add bend</button><button class="secondary-btn" id="straighten-path">Straighten</button></div>' +
          '<button class="ghost-btn" id="remove-path-bend" ' + (state.activePathPoint <= 0 || state.activePathPoint >= P.points(o).length - 1 ? 'disabled title="Select a bend point on the page"' : "") + '>Remove selected bend</button>' +
          toggle("Show bend markers", "nodeMarkers", !!o.nodeMarkers);
        if (o.nodeMarkers) html += field("Marker color", "markerColor", o.markerColor || "#ffd617", "color") +
          field("Marker diameter (mm)", "markerDiameter", o.markerDiameter || 3, "range", 'min="2" max="12" step="0.5"');
      }
      if (["table", "flow"].includes(o.type))
        html +=
          '<div id="object-content-warnings" aria-live="polite"></div><div class="book-row">' +
          selectField("Font", "style.font", o["style"].font, M.fontOptions) +
          field(
            "Text size (pt)",
            "style.size",
            o["style"].size,
            "number",
            'min="6" max="160"',
          ) +
          "</div>" +
          (o.type !== "table" || o.tableStyle === "custom"
            ? field("Text color", "style.color", o["style"].color, "color")
            : "");
      if (o.type === "table") {
        const rows = o.cells.length || 1,
          cols = Math.max(1, ...o.cells.map((r) => r.length));
        html += `<h3>Table content</h3><div class="book-table-controls"><span>${rows} rows</span>${iconButton("more", "Add row", `data-table-axis="row" data-delta="1" ${rows >= 8 ? "disabled" : ""}`)}${iconButton("trash", "Remove last row", `data-table-axis="row" data-delta="-1" ${rows <= 1 ? "disabled" : ""}`)}<span>${cols} columns</span>${iconButton("more", "Add column", `data-table-axis="column" data-delta="1" ${cols >= 8 ? "disabled" : ""}`)}${iconButton("trash", "Remove last column", `data-table-axis="column" data-delta="-1" ${cols <= 1 ? "disabled" : ""}`)}</div><div class="book-cell-grid" data-columns="${cols}">${o.cells.map((row, r) => Array.from({ length: cols }, (_, c) => `<input type="text" maxlength="2000" aria-label="Row ${r + 1}, column ${c + 1}" data-cell="${r},${c}" value="${esc(row[c] || "")}" placeholder="Cell ${r + 1}, ${c + 1}">`).join("")).join("")}</div>`;
        html +=
          toggle("Header row", "tableHeader", o.tableHeader !== false) +
          toggle("Alternating rows", "tableStriped", o.tableStriped !== false) +
          toggle("Column lines", "tableColumns", !!o.tableColumns) +
          (o.tableStyle === "ruled"
            ? ""
            : toggle(
                "Rounded corners",
                "tableRounded",
                o.tableRounded !== false,
              ));
      }
      if (o.type === "flow") {
        html +=
          selectField(
            "Direction",
            "flowDirection",
            o.flowDirection || "horizontal",
            [
              ["vertical", "Top to bottom"],
              ["horizontal", "Left to right"],
            ],
          ) +
          selectField("Step shape", "flowShape", o.flowShape || "rounded", [
            ["rounded", "Soft rectangle"],
            ["pill", "Pill"],
            ["square", "Rectangle"],
          ]);
        html += `<h3>Story steps</h3><div class="book-flow-steps">${o.steps.map((t, i) => `<div class="book-flow-step"><span>${i + 1}</span><input aria-label="Step ${i + 1}" data-step="${i}" value="${esc(t)}" maxlength="400">${iconButton("up", "Move step " + (i + 1) + " up", `data-step-move="${i}" ${i === 0 ? "disabled" : ""}`)}${iconButton("trash", "Remove step " + (i + 1), `data-step-remove="${i}" ${o.steps.length <= 1 ? "disabled" : ""}`)}</div>`).join("")}</div><button class="secondary-btn" id="add-flow-step" ${o.steps.length >= 8 ? "disabled" : ""}>${icon("more")} Add step</button>`;
      }
      html +=
        '<h3>Position & size</h3><div class="book-row">' +
        field(
          "Width (mm)",
          "w",
          +o.w.toFixed(1),
          "number",
          'min="1" max="297" step="0.5"',
        ) +
        field(
          "Height (mm)",
          "h",
          +o.h.toFixed(1),
          "number",
          'min="1" max="420" step="0.5"',
        ) +
        '</div><details><summary>Position & rotation</summary><div class="book-row">' +
        field("Left (mm)", "x", +o.x.toFixed(1), "number", 'step="0.5"') +
        field("Top (mm)", "y", +o.y.toFixed(1), "number", 'step="0.5"') +
        "</div>" +
        field(
          "Rotation",
          "rotation",
          o.rotation,
          "range",
          'min="-180" max="180"',
        ) +
        field(
          "Opacity",
          "opacity",
          o.opacity,
          "range",
          'min="0.1" max="1" step="0.05"',
        ) +
        '<div class="book-row"><button class="secondary-btn" id="rotate-object">' +
        icon("rotate") +
        ' Rotate 90°</button><button class="secondary-btn" id="reset-rotation">Reset</button></div></details>';
      html +=
        '<h3>Align to page</h3><div class="book-segmented">' +
        ["left", "center", "right", "top", "middle", "bottom"]
          .map(
            (v) =>
              `<button data-align="${v}" title="Align selection to page ${v}">${v[0].toUpperCase() + v.slice(1)}</button>`,
          )
          .join("") +
        '</div><div class="book-row"><button class="secondary-btn" data-distribute="x" ' +
        (state.selected.length < 3
          ? 'disabled title="Select at least 3 objects"'
          : "") +
        '>Space across</button><button class="secondary-btn" data-distribute="y" ' +
        (state.selected.length < 3
          ? 'disabled title="Select at least 3 objects"'
          : "") +
        '>Space down</button></div><div class="book-row"><button class="secondary-btn" id="duplicate-object">Duplicate</button><button class="ghost-btn book-danger" id="delete-object">Delete</button></div>';
      if (state.selected.length > 1 || o.group)
        html +=
          '<button class="secondary-btn" id="group-objects">' +
          (o.group ? "Ungroup" : "Group selected") +
          "</button>";
      html += "</fieldset>";
    } else {
      html +=
        field("Page title", "page.title", p.title) +
        field(
          "This page’s paper color",
          "page.background",
          p.background,
          "color",
        ) +
        selectField("Paper", "page.texture", p.texture, [
          ["plain", "Plain"],
          ["grain", "Subtle grain"],
          ["lined", "Lined"],
          ["dots", "Dotted"],
          ["grid", "Grid"],
        ]);
      if (p.decoration?.id === "xped")
        html += toggle("Show theme artwork", "page.themeArtwork", p.themeArtwork !== false) +
          toggle("Show xPED logo", "page.showLogo", p.showLogo !== false) +
          '<button class="secondary-btn" data-select-furniture="logo" ' + (p.showLogo === false ? "disabled" : "") + '>Move & resize logo</button>';
      html +=
        '<p class="book-muted book-hint">Paper is the background of this page. It appears in print.</p><button class="secondary-btn" id="apply-paper">Apply paper to all pages</button><h3>Page actions</h3><div class="book-row"><button class="secondary-btn" id="page-earlier" ' +
        (!editor.canMovePage(-1)
          ? 'disabled title="This page cannot move earlier"'
          : "") +
        '>Move earlier</button><button class="secondary-btn" id="page-later" ' +
        (!editor.canMovePage(1)
          ? 'disabled title="This page cannot move later"'
          : "") +
        '>Move later</button></div><div class="book-button-stack"><button class="secondary-btn" id="duplicate-page">Duplicate page</button><button class="secondary-btn" id="duplicate-spread">Duplicate spread</button><button class="ghost-btn book-danger" id="delete-page" ' +
        (p.role !== "page" || state.book.pages.length <= 4
          ? 'disabled title="Keep both covers and at least two inside pages"'
          : "") +
        ">Delete page</button></div>";
    }
    html +=
      '<details class="book-layout-section"><summary>Layout guides</summary><p class="book-muted book-hint">Guides help you arrange the page. They do not print.</p>' +
      toggle("Print-safe margins", "guides", state.guides) +
      toggle("Layout grid · 5 mm", "grid", state.grid) +
      toggle("Center & thirds", "thirds", state.thirds) +
      toggle("Smart snapping", "snap", state.snap) +
      toggle("Rulers · millimeters", "rulers", state.rulers) +
      '<p class="book-muted book-hint">Snap to page centers, thirds, margins and nearby objects. Hold Alt to move freely.</p></details>';
    html +=
      '<details><summary>Book palette & themes</summary><p class="book-muted book-hint">Reusable colors for text, shapes and illustrations. Paper color is set separately.</p><div class="book-palette">' +
      state.book.palette
        .slice(0, state.book.theme?.id === "xped" ? 6 : 4)
        .map(
          (c, i) =>
            `<div>${field(state.book.theme?.id === "xped" ? M.xped.colors[i].name : ["Accent", "Soft", "Warm", "Ink"][i], "palette." + i, c, "color")}<button class="secondary-btn" data-palette="${i}" ${!o || o.locked || o.type === "image" ? 'disabled title="Select text, a shape or a drawing to use this color"' : ""}>Use</button></div>`,
        )
        .join("") +
      '</div><button class="secondary-btn" id="book-themes">Choose a book theme</button></details>';
    const pageNumbers = M.pageNumberOptions(state.book.pageNumbers);
    const numberWeights = M.fontWeights(pageNumbers.font);
    html += '<details id="page-number-controls"><summary>Page numbers</summary>' +
      toggle('Show page numbers', 'pageNumbers.enabled', pageNumbers.enabled) +
      '<p class="book-muted book-hint">Number inside pages from 1. Covers stay unnumbered; moving pages updates the numbers automatically.</p>';
    if (pageNumbers.enabled) {
      html += '<h3>Number position</h3><div class="book-button-stack book-number-positions" role="group" aria-label="Number position">' +
        [['logo', 'Beside logo'], ['center', 'Bottom center'], ['outer', 'Bottom outside edge']].map(([value, label]) => `<button class="secondary-btn" data-number-position="${value}" aria-pressed="${pageNumbers.position === value && !p.numberPlacement}">${label}</button>`).join('') + '</div>' +
        '<p class="book-muted book-hint">Position presets apply to every inside page. Drag a number to adjust just that page.</p>' +
        (p.role === 'page' ? '<button class="secondary-btn" data-select-furniture="number">Move this page number</button>' : '') +
        selectField('Number font', 'pageNumbers.font', pageNumbers.font, M.fontOptions) +
      field('Number size (pt)', 'pageNumbers.size', pageNumbers.size, 'number', 'min="6" max="24" step="1"') +
      (numberWeights ? selectField('Number thickness', 'pageNumbers.weight', pageNumbers.weight, numberWeights.map((weight) => [weight, weight === 700 ? 'Bold' : weight === 400 ? 'Regular' : weight === 300 ? 'Light' : String(weight)])) :
        field('Number thickness', 'pageNumbers.weight', pageNumbers.weight, 'range', `min="${pageNumbers.font === 'Nunito' ? 200 : 100}" max="${pageNumbers.font === 'Playpen Sans' ? 800 : pageNumbers.font === 'Nunito' ? 1000 : 900}" step="10"`)) +
      selectField('Number color', 'pageNumbers.colorMode', pageNumbers.colorMode, [['theme', 'Match the page'], ['custom', 'Custom color']]);
      if (pageNumbers.colorMode === 'custom') html += field('Custom number color', 'pageNumbers.color', pageNumbers.color, 'color');
    }
    html += '</details>';
    if (state.tool !== "select")
      html +=
        "<h3>Drawing</h3>" +
        selectField("Tool", "tool", state.tool, [
          ["select", "Select"],
          ["pen", "Pen"],
          ["pencil", "Pencil"],
          ["highlighter", "Highlighter"],
          ["eraser", "Eraser"],
        ]) +
        field("Color", "brushColor", state.brushColor, "color") +
        field(
          "Thickness",
          "brushWidth",
          state.brushWidth,
          "range",
          'min="0.2" max="6" step="0.1"',
        );
    html += `</div><section id="book-layers" class="book-layers" role="tabpanel" aria-label="Layers" ${state.inspectorTab !== "layers" ? "hidden" : ""}><h3>Layers <span>${p.items.length}</span></h3><p class="book-muted book-hint">Top of the list appears in front.</p>${
      p.items
        .slice()
        .reverse()
        .map(
          (layer, i) =>
            `<div class="book-layer${state.selected.includes(layer.id) ? " selected" : ""}${layer.hidden ? " is-hidden" : ""}"><button data-select-object="${layer.id}" aria-pressed="${state.selected.includes(layer.id)}" title="Select ${esc(layer.name)}">${icon(layer.type)}<span>${esc(layer.name || layer.type)}${layer.hidden ? "<small>Hidden</small>" : layer.locked ? "<small>Locked</small>" : ""}</span></button><div class="book-layer-actions">${iconButton("up", "Move " + layer.name + " forward", `data-layer-up="${layer.id}" ${i === 0 ? "disabled" : ""}`)}${iconButton("down", "Move " + layer.name + " backward", `data-layer-down="${layer.id}" ${i === p.items.length - 1 ? "disabled" : ""}`)}${iconButton(layer.locked ? "lock" : "unlock", (layer.locked ? "Unlock " : "Lock ") + layer.name, `data-lock="${layer.id}" aria-pressed="${layer.locked}"`)}${iconButton(layer.hidden ? "hidden" : "eye", (layer.hidden ? "Show " : "Hide ") + layer.name, `data-hide="${layer.id}" aria-pressed="${layer.hidden}"`)}</div></div>`,
        )
        .join("") ||
      '<p class="book-muted book-hint">Add text, an image or a shape to begin.</p>'
    }</section>`;
    window.BookColorPicker?.close();
    panel.innerHTML = html;
    panel.querySelectorAll("details").forEach((d) => {
      d.open = panelDetails.has(d.querySelector("summary").textContent);
    });
    if (disabled)
      panel
        .querySelectorAll(
          "input,textarea,select,button:not(#close-inspector):not([data-select-object]):not([data-panel])",
        )
        .forEach((e) => {
          if (
            !["guides", "snap", "rulers", "grid", "thirds"].includes(
              e.dataset.field,
            )
          )
            e.disabled = true;
        });
    if (focusField)
      panel
        .querySelector(`[data-field="${focusField}"]`)
        ?.focus({ preventScroll: true });
    window.BookColorPicker?.enhance(panel);
    window.LectureProcessorUx?.enhanceMarkedSelects?.(panel);
    panel.scrollTop = scroll;
    editor.renderContentWarnings();
    editor.selectionToolbar();
  }
  function applyStyle(key, value) {
    const o = editor.item();
    if (!o) return;
    const range = state.selectionRange;
    const length = o.runs?.length
      ? o.runs.reduce((n, r) => n + r.text.length, 0)
      : o.text.length;
    if (
      range &&
      range.end > range.start &&
      !(range.start === 0 && range.end >= length) &&
      o.type === "text"
    ) {
      const runs =
        o.runs && o.runs.length
          ? o.runs
          : [{ text: o.text, style: { ...o.style } }];
      let offset = 0,
        next = [];
      runs.forEach((r) => {
        const end = offset + r.text.length,
          startCut = Math.max(0, range.start - offset),
          endCut = Math.min(r.text.length, range.end - offset);
        if (startCut < endCut) {
          if (startCut)
            next.push({
              text: r.text.slice(0, startCut),
              style: { ...r.style },
            });
          next.push({
            text: r.text.slice(startCut, endCut),
            style: { ...r.style, [key]: value },
          });
          if (endCut < r.text.length)
            next.push({ text: r.text.slice(endCut), style: { ...r.style } });
        } else next.push(r);
        offset = end;
      });
      o.runs = next;
    } else {
      o.style[key] = value;
      if (o.runs)
        o.runs = o.runs.map((r) => ({
          ...r,
          style: { ...r.style, [key]: value },
        }));
    }
  }
  function changeField(input) {
    const name = input.dataset.field;
    if (!name) return;
    if (input.type === "number" && (input.value.trim() === "" || !Number.isFinite(Number(input.value)))) return;
    if (input.type === "color") {
      if (liveColorValues.get(input) === input.value) return;
      liveColorValues.set(input, input.value);
    }
    let value =
      input.type === "checkbox"
        ? input.checked
        : ["range", "number"].includes(input.type)
          ? Number(input.value)
          : input.value;
    if (input.type === "number") {
      value = M.clamp(value, input.min === "" ? -Infinity : Number(input.min), input.max === "" ? Infinity : Number(input.max));
      input.dataset.lastValue = String(value);
    }
    if (
      [
        "guides",
        "snap",
        "rulers",
        "grid",
        "thirds",
        "tool",
        "brushColor",
        "brushWidth",
      ].includes(name)
    ) {
      if (name === "guides") state.guides = value;
      if (name === "snap") state.snap = value;
      if (name === "rulers") state.rulers = value;
      if (name === "grid") state.grid = value;
      if (name === "thirds") state.thirds = value;
      if (name === "tool") state.tool = value;
      if (name === "brushColor") state.brushColor = value;
      if (name === "brushWidth") state.brushWidth = value;
      editor.saveView();
      editor.renderStage();
      if (name === "tool") renderInspector();
      return;
    }
    if (!editor.editCheckpoint(input)) return;
    const o = editor.item();
    if (o?.type === "flow" && o.flowStyle !== "custom" &&
        (["fill", "stroke", "style.color"].includes(name) || (name === "flowStyle" && value === "custom"))) {
      const colors = M.flowAppearance(o, editor.page().background, editor.page().decoration);
      o.fill = colors.fill;
      o.stroke = colors.stroke;
      o["style"].color = colors.ink;
      o.flowStyle = "custom";
      const selector = $("inspector").querySelector('[data-field="flowStyle"]');
      if (selector) selector.value = "custom";
    }
    if (name.startsWith("furniture.")) {
      const box = { ...editor.furnitureBox(), [name.slice(10)]: value };
      editor.placeFurniture(box);
    }
    else if (name.startsWith("page.")) editor.page()[name.slice(5)] = value;
    else if (name.startsWith('pageNumbers.')) {
      if (name === "pageNumbers.position") state.book.pages.forEach((p) => delete p.numberPlacement);
      state.book.pageNumbers = M.pageNumberOptions({ ...M.pageNumberOptions(state.book.pageNumbers), [name.slice(12)]: value });
    }
    else if (name.startsWith("palette."))
      state.book.palette[+name.split(".")[1]] = value;
    else if (o) {
      if (name.startsWith("style.")) {
        const selectionStyle = selectedStyle(o);
        applyStyle(name.slice(6), value);
        if (name === "style.font") {
          const weights = M.fontWeights(value);
          if (weights)
            applyStyle("weight", weights.reduce((closest, weight) => Math.abs(weight - selectionStyle.weight) < Math.abs(closest - selectionStyle.weight) ? weight : closest));
          if (value === "Playpen Sans") {
            applyStyle("weight", Math.min(800, selectionStyle.weight));
          }
          if (!M.fontSupportsItalic(value)) applyStyle("italic", false);
        }
      } else if (name === "styleName") {
        o.styleName = value;
        if (state.book.styles[value]) {
          o.style = M.clone(state.book.styles[value]);
          o.runs = [];
          M.styleObjectForBook(o, state.book, editor.page());
        }
      } else {
        const oldW = o.w,
          oldH = o.h;
        if (
          o.type === "table" &&
          name === "tableStyle" &&
          value === "custom" &&
          o.tableStyle !== "custom"
        ) {
          const colors = M.tableAppearance(o, editor.page().background, editor.page().decoration);
          o.fill = colors.header;
          o.stroke = colors.line;
          o["style"].color = colors.ink;
        }
        if (
          (name === "w" || name === "h") &&
          o.type === "image" &&
          o.aspectLock
        ) {
          const scale = M.clamp(value / o[name], Math.max(0.2 / o.w, 0.2 / o.h), Math.min(297 / o.w, 420 / o.h));
          o.w *= scale;
          o.h *= scale;
          value = o[name];
          input.dataset.lastValue = String(value);
        }
        o[name] = value;
        if (name === "stroke" && o.type === "arrow" && !o.arrowFill) {
          const headColor = $("inspector").querySelector('[data-field="arrowFill"]');
          if (headColor) { headColor.value = value; window.BookColorPicker?.enhance(headColor); }
        }
        if (name === "shape" && value === "pill" && o.w < o.h * 1.6) {
          o.w = Math.min(M.W - 20, o.h * 2.4);
          o.x = M.clamp(o.x, 0, M.W - o.w);
        }
        if (["w", "h"].includes(name))
          o[name] = M.clamp(value, 0.2, name === "w" ? 297 : 420);
        if (["w", "h"].includes(name) && o.type === "image" && o.aspectLock) {
          const otherName = name === "w" ? "h" : "w";
          const otherInput = $("inspector").querySelector(`[data-field="${otherName}"]`);
          if (otherInput) {
            otherInput.value = String(Math.round(o[otherName] * 100) / 100);
            otherInput.dataset.lastValue = otherInput.value;
          }
        }
        if (o.type === "drawing" && ["w", "h"].includes(name))
          o.points = o.points.map((p) => [
            (p[0] * o.w) / oldW,
            (p[1] * o.h) / oldH,
            p[2],
          ]);
      }
    }
    editor.changed(false);
    editor.renderStage();
    editor.schedulePages();
    if (input.tagName === "SELECT" || input.type === "checkbox")
      renderInspector();
  }

  return {
    setInspector, showPageNumbers, selectedStyle, renderInspector, applyStyle,
    changeField,
  };
}
