const M = window.BookModel,
  P = window.BookPathEditor,
  D = window.BookStorage,
  $ = (id) => document.getElementById(id),
  esc = M.esc;
const field = (label, name, value, type = "text", extra = "") =>
  `<label class="book-field"><span>${esc(label)}</span><input type="${type}" data-field="${name}" value="${esc(value)}" data-last-value="${esc(value)}" ${extra}></label>`;
const selectField = (label, name, value, options) =>
  `<label class="book-field"><span>${esc(label)}</span><select data-app-select ${name === "style.font" ? "data-app-select-search" : ""} data-field="${name}">${options
    .map((o) => {
      const v = Array.isArray(o) ? o[0] : o,
        l = Array.isArray(o) ? o[1] : o;
      return `<option value="${esc(v)}"${String(v) === String(value) ? " selected" : ""}>${esc(l)}</option>`;
    })
    .join("")}</select></label>`;
const toggle = (label, name, value) =>
  `<label class="book-switch"><span>${esc(label)}</span><input type="checkbox" class="app-toggle" role="switch" data-field="${name}"${value ? " checked" : ""}></label>`;
const icons = {
  line: '<path d="M3 18 9 8l6 8 6-12"/>',
  select: '<path d="m5 3 14 9-7 1-3 7Z"/>',
  text: '<path d="M4 5h16M12 5v15M8 20h8"/>',
  image:
    '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 4 4 3-3 5 5"/>',
  shape: '<rect x="3" y="5" width="18" height="14" rx="5"/>',
  pen: '<path d="m4 16-1 5 5-1L21 7l-5-5Z M14 4l6 6"/>',
  more: '<path d="M12 4v16M4 12h16"/>',
  undo: '<path d="m8 4-5 5 5 5M3 9h11a6 6 0 0 1 0 12"/>',
  redo: '<path d="m16 4 5 5-5 5M21 9H10a6 6 0 0 0 0 12"/>',
  settings:
    '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/>',
  up: '<path d="m6 14 6-6 6 6M12 8v12"/>',
  down: '<path d="m6 10 6 6 6-6M12 4v12"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3"/>',
  unlock:
    '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0M12 14v3"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  hidden:
    '<path d="m3 3 18 18M10 5c7-1 12 7 12 7a20 20 0 0 1-4 4M6 6a20 20 0 0 0-4 6s3 7 10 7a12 12 0 0 0 5-1"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  trash: '<path d="M3 6h18M8 6V3h8v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
  arrow: '<path d="M3 12h18m-6-6 6 6-6 6"/>',
  table:
    '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M11 3v18"/>',
  flow: '<rect x="5" y="2" width="14" height="6" rx="2"/><rect x="5" y="16" width="14" height="6" rx="2"/><path d="M12 8v8m-3-3 3 3 3-3"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  history: '<path d="M3 4v6h6M3 10a9 9 0 1 1 1 8M12 7v5l4 2"/>',
  rotate: '<path d="M20 4v6h-6M20 10a8 8 0 1 0 0 7"/>',
};
const icon = (name) =>
  `<svg class="book-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icons[name] || icons.shape}</svg>`;
const iconButton = (name, label, attrs = "") =>
  `<button class="icon-btn" aria-label="${esc(label)}" title="${esc(label)}" ${attrs}>${icon(name)}</button>`;

export { M, P, D, $, esc, field, selectField, toggle, icon, iconButton };
