(function (root) {
  "use strict";
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  function hexToHsv(hex) {
    const rgb = hex.replace("#", "").match(/.{2}/g).map((part) => parseInt(part, 16) / 255);
    const [r, g, b] = rgb, max = Math.max(...rgb), min = Math.min(...rgb), delta = max - min;
    let hue = 0;
    if (delta) {
      if (max === r) hue = ((g - b) / delta) % 6;
      else if (max === g) hue = (b - r) / delta + 2;
      else hue = (r - g) / delta + 4;
      hue = (hue * 60 + 360) % 360;
    }
    return { h: hue, s: max ? delta / max : 0, v: max };
  }
  function hsvToHex({ h, s, v }) {
    const hue = ((h % 360) + 360) % 360;
    const c = clamp(v, 0, 1) * clamp(s, 0, 1), x = c * (1 - Math.abs((hue / 60) % 2 - 1)), m = clamp(v, 0, 1) - c;
    const rgb = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
    return "#" + rgb.map((part) => Math.round((part + m) * 255).toString(16).padStart(2, "0")).join("");
  }
  if (typeof module === "object" && module.exports) {
    module.exports = { hexToHsv, hsvToHex };
    return;
  }
  const doc = root.document, records = new Set(), byInput = new WeakMap();
  let serial = 0, popup, popupRule, active = null, observer, emitting = false, dragging = false;
  const colorSheet = () => [...doc.styleSheets].find((entry) => entry.href?.includes("book-color-picker.css"));
  function rule(selector) { return { selector, values: {}, current: null }; }
  function removeRule(entry) {
    const sheet = colorSheet();
    if (!sheet || !entry?.current) return;
    const index = [...sheet.cssRules].indexOf(entry.current);
    if (index >= 0) sheet.deleteRule(index);
    entry.current = null;
  }
  function setCss(entry, values) {
    const sheet = colorSheet();
    if (!sheet || !entry || Object.entries(values).every(([key, value]) => entry.values[key] === value)) return;
    Object.assign(entry.values, values);
    removeRule(entry);
    const body = Object.entries(entry.values).map(([key, value]) => key + ":" + value).join(";");
    const index = sheet.insertRule(entry.selector + "{" + body + "}", sheet.cssRules.length);
    entry.current = sheet.cssRules[index];
  }
  function sync(record) {
    if (!record.input.isConnected) return;
    const value = record.input.value.toLowerCase();
    if (record.trigger.disabled !== record.input.disabled) record.trigger.disabled = record.input.disabled;
    if (record.value.textContent !== value.toUpperCase()) record.value.textContent = value.toUpperCase();
    record.rule ||= rule("#" + record.trigger.id);
    setCss(record.rule, { "--book-color-swatch": value });
    record.lastValue = value;
    if (active?.record === record && !emitting && active.lastValue !== value) {
      active.lastValue = value;
      active.hsv = hexToHsv(value);
      paint();
    }
  }
  function clean() {
    for (const record of records) {
      if (!record.input.isConnected || !record.trigger.isConnected) {
        if (active?.record === record) close(false);
        removeRule(record.rule);
        records.delete(record);
      } else {
        if (active?.record === record && record.input.disabled) close(false);
        if (record.lastValue !== record.input.value.toLowerCase() || record.trigger.disabled !== record.input.disabled) sync(record);
      }
    }
  }
  function position() {
    if (!active || !popup || dragging) return;
    popupRule ||= rule("#book-color-popover");
    setCss(popupRule, { "--book-color-max-height": "calc(100dvh - 24px)" });
    const trigger = active.record.trigger.getBoundingClientRect(), box = popup.getBoundingClientRect();
    let left = clamp(trigger.right - box.width, 12, Math.max(12, innerWidth - box.width - 12));
    const below = trigger.bottom + 8, above = trigger.top - box.height - 8;
    let top;
    if (below + box.height <= innerHeight - 12) top = below;
    else if (above >= 12) top = above;
    else if (trigger.left - box.width - 8 >= 12) {
      left = trigger.left - box.width - 8;
      top = clamp(trigger.top, 12, Math.max(12, innerHeight - box.height - 12));
    } else if (trigger.right + box.width + 8 <= innerWidth - 12) {
      left = trigger.right + 8;
      top = clamp(trigger.top, 12, Math.max(12, innerHeight - box.height - 12));
    } else {
      const availableBelow = innerHeight - below - 12, availableAbove = trigger.top - 20;
      const height = Math.max(100, Math.max(availableBelow, availableAbove));
      setCss(popupRule, { "--book-color-max-height": height + "px" });
      top = availableBelow >= availableAbove ? below : Math.max(12, trigger.top - height - 8);
    }
    setCss(popupRule, { "--book-color-left": left + "px", "--book-color-top": top + "px" });
  }
  function paint() {
    if (!active) return;
    const hsv = active.hsv, color = active.record.input.value;
    popupRule ||= rule("#book-color-popover");
    setCss(popupRule, { "--book-color-hue": hsvToHex({ h: hsv.h, s: 1, v: 1 }),
      "--book-color-current": color, "--book-color-x": hsv.s * 100 + "%", "--book-color-y": (1 - hsv.v) * 100 + "%" });
    for (const [name, value] of [["hue", Math.round(hsv.h)], ["saturation", Math.round(hsv.s * 100)], ["brightness", Math.round(hsv.v * 100)]]) {
      popup.querySelector("[data-color-control=" + name + "]").value = value;
      popup.querySelector("[data-color-value=" + name + "]").textContent = value + (name === "hue" ? "°" : "%");
    }
    const hex = popup.querySelector("[data-color-control=hex]");
    if (doc.activeElement !== hex) hex.value = color.toUpperCase();
    popup.querySelector(".book-color-current").setAttribute("aria-label", "Current color " + color.toUpperCase());
  }
  function update() {
    if (!active) return;
    const input = active.record.input, value = hsvToHex(active.hsv);
    if (input.value.toLowerCase() !== value) {
      input.value = value;
      active.lastValue = value;
      emitting = true;
      try { input.dispatchEvent(new Event("input", { bubbles: true })); }
      finally { emitting = false; }
    }
    if (active) { sync(active.record); paint(); }
  }
  function close(restoreFocus = true) {
    if (!active) return;
    const current = active;
    active = null;
    dragging = false;
    current.record.trigger.setAttribute("aria-expanded", "false");
    if (popup.matches(":popover-open")) popup.hidePopover();
    popup.hidden = true;
    const input = current.record.input;
    if (input.value !== current.initial) input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new CustomEvent("book-color-end", { bubbles: true }));
    if (restoreFocus && current.record.trigger.isConnected && !current.record.trigger.disabled) current.record.trigger.focus({ preventScroll: true });
  }
  function createPopup() {
    if (popup) return;
    popup = doc.createElement("div");
    popup.id = "book-color-popover";
    popup.className = "book-color-popover";
    popup.hidden = true;
    popup.setAttribute("role", "dialog");
    popup.setAttribute("aria-labelledby", "book-color-title");
    popup.setAttribute("popover", "manual");
    popup.innerHTML = '<div class="book-color-heading"><h3 id="book-color-title">Choose a color</h3><button type="button" class="icon-btn" data-color-close aria-label="Close color picker">×</button></div><div class="book-color-spectrum" aria-hidden="true"><span class="book-color-point"></span></div><div class="book-color-sliders">' +
      [["hue", "Hue", 359], ["saturation", "Saturation", 100], ["brightness", "Brightness", 100]].map(([name, label, max]) => '<label class="book-color-slider"><span>' + label + '<output data-color-value="' + name + '"></output></span><input type="range" min="0" max="' + max + '" step="1" data-color-control="' + name + '" aria-label="' + label + '"></label>').join("") +
      '</div><div class="book-color-hex-row"><span class="book-color-current" role="img"></span><label><span>Hex color</span><input type="text" data-color-control="hex" maxlength="7" spellcheck="false" autocomplete="off" autocapitalize="characters" aria-describedby="book-color-help"></label></div><p id="book-color-help" class="book-color-help">For example, #4F46E5. Changes appear instantly.</p><button type="button" class="primary-btn book-color-done" data-color-close>Done</button>';
    popup.addEventListener("click", (event) => {
      if (event.target.closest("[data-color-close]")) { event.preventDefault(); close(); }
    });
    popup.addEventListener("input", (event) => {
      if (!active) return;
      const control = event.target.dataset.colorControl;
      if (control === "hex") {
        const raw = event.target.value.trim(), valid = /^#?[a-f\d]{6}$/i.test(raw);
        event.target.setAttribute("aria-invalid", String(!valid));
        if (!valid) return;
        active.hsv = hexToHsv(raw.startsWith("#") ? raw : "#" + raw);
      } else if (control === "hue") active.hsv.h = Number(event.target.value);
      else if (control === "saturation") active.hsv.s = Number(event.target.value) / 100;
      else if (control === "brightness") active.hsv.v = Number(event.target.value) / 100;
      else return;
      update();
    });
    popup.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && event.target.dataset.colorControl === "hex") { event.preventDefault(); close(); }
    });
    const spectrum = popup.querySelector(".book-color-spectrum");
    const point = (event) => {
      if (!active) return;
      const rect = spectrum.getBoundingClientRect();
      active.hsv.s = clamp((event.clientX - rect.left) / rect.width, 0, 1);
      active.hsv.v = 1 - clamp((event.clientY - rect.top) / rect.height, 0, 1);
      update();
    };
    spectrum.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragging = true;
      spectrum.setPointerCapture(event.pointerId);
      point(event);
    });
    spectrum.addEventListener("pointermove", (event) => { if (dragging) point(event); });
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) spectrum.addEventListener(name, () => { dragging = false; });
    doc.addEventListener("pointerdown", (event) => {
      if (active && !popup.contains(event.target) && !active.record.trigger.contains(event.target)) close(false);
    }, true);
    doc.addEventListener("keydown", (event) => {
      if (active && event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); close(); }
    }, true);
    doc.addEventListener("focusin", (event) => {
      if (active && !popup.contains(event.target) && !active.record.trigger.contains(event.target) && event.target !== active.record.input) close(false);
    });
    root.addEventListener("resize", position);
    doc.addEventListener("scroll", (event) => { if (active && !popup.contains(event.target)) position(); }, true);
  }
  function open(record) {
    if (record.input.disabled) return;
    if (active?.record === record) { close(); return; }
    close(false);
    createPopup();
    active = { record, initial: record.input.value, lastValue: record.input.value.toLowerCase(), hsv: hexToHsv(record.input.value) };
    record.trigger.setAttribute("aria-expanded", "true");
    record.input.dispatchEvent(new CustomEvent("book-color-start", { bubbles: true }));
    const parent = record.input.closest("dialog[open]") || doc.body;
    parent.appendChild(popup);
    popup.querySelector("#book-color-title").textContent = record.label;
    const hex = popup.querySelector("[data-color-control=hex]");
    hex.value = record.input.value.toUpperCase();
    hex.removeAttribute("aria-invalid");
    popup.hidden = false;
    if (popup.showPopover) popup.showPopover();
    paint();
    position();
    popup.querySelector("[data-color-control=saturation]").focus({ preventScroll: true });
  }
  function enhance(container = doc) {
    clean();
    const inputs = container.matches?.('input[type="color"]') ? [container] : [...container.querySelectorAll('input[type="color"]')];
    inputs.forEach((input) => {
      const previous = byInput.get(input);
      if (previous && previous.trigger.isConnected) { sync(previous); return; }
      const label = input.getAttribute("aria-label") || input.labels?.[0]?.querySelector("span")?.textContent.trim() || "Color";
      const trigger = doc.createElement("button");
      trigger.type = "button";
      trigger.className = "book-color-trigger";
      trigger.id = "book-color-trigger-" + ++serial;
      trigger.setAttribute("aria-label", "Choose " + label.toLowerCase());
      trigger.setAttribute("aria-haspopup", "dialog");
      trigger.setAttribute("aria-expanded", "false");
      trigger.setAttribute("aria-controls", "book-color-popover");
      trigger.innerHTML = '<span class="book-color-swatch" aria-hidden="true"></span><span class="book-color-value"></span><span class="book-color-chevron" aria-hidden="true">⌄</span>';
      const record = { input, trigger, label, value: trigger.querySelector(".book-color-value"), rule: null };
      input.classList.add("book-color-native");
      input.tabIndex = -1;
      input.setAttribute("aria-hidden", "true");
      input.after(trigger);
      records.add(record);
      byInput.set(input, record);
      input.addEventListener("click", (event) => event.preventDefault());
      input.addEventListener("input", () => sync(record));
      input.addEventListener("change", () => sync(record));
      trigger.addEventListener("click", (event) => { event.preventDefault(); open(record); });
      sync(record);
    });
    if (!observer && doc.body) {
      observer = new MutationObserver(clean);
      observer.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["disabled", "value"] });
    }
  }
  root.BookColorPicker = { enhance, close };
})(typeof window === "object" ? window : globalThis);
