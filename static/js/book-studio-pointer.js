import { M, P, $ } from "./book-studio-ui.js";

export function createBookPointerTools(state, editor, inspector) {
  function dragFurniture(event, sheet, kind) {
    editor.selectFurniture(kind);
    const original = editor.furnitureBox(), scale = sheet.getBoundingClientRect().width / M.W;
    if (!original) return;
    const resize = event.target.closest("[data-logo-resize]");
    let moved = false;
    const move = (e) => {
      if (e.pointerId !== event.pointerId) return;
      const delta = { x: (e.clientX - event.clientX) / scale, y: (e.clientY - event.clientY) / scale };
      if (!moved && Math.hypot(delta.x, delta.y) < .5) return;
      if (!moved) { if (!editor.checkpoint()) return; moved = true; }
      let box = { ...original }, lines = [];
      if (resize) box.w += delta.x;
      else {
        let applied = delta;
        if (state.snap && !e.altKey) {
          const result = M.snapMove([{ ...original, rotation: 0 }], delta, editor.page().items, 6 / scale, state.grid);
          applied = result.delta; lines = result.lines;
        }
        box.x += applied.x; box.y += applied.y;
      }
      editor.placeFurniture(box); editor.renderStage(); editor.feedback(lines, editor.furnitureBox());
    };
    const up = (e) => {
      if (e.pointerId !== event.pointerId) return;
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
      editor.feedback(); if (moved) editor.changed();
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
    event.preventDefault();
  }
  function dragPathPoint(event, sheet) {
    const node = event.target.closest("[data-path-point]"), o = editor.page().items.find((x) => x.id === node.dataset.object);
    if (!editor.isPath(o) || o.locked) return;
    state.selected = [o.id]; state.furnitureSelection = ""; state.activePathPoint = +node.dataset.pathPoint;
    const original = M.clone(o), rect = sheet.getBoundingClientRect(), scale = rect.width / M.W;
    let moved = false;
    editor.renderSelection(); inspector.renderInspector();
    const move = (e) => {
      if (e.pointerId !== event.pointerId) return;
      if (!moved && Math.hypot(e.clientX - event.clientX, e.clientY - event.clientY) < 3) return;
      if (!moved) { if (!editor.checkpoint()) return; moved = true; }
      const world = { x: M.clamp((e.clientX - rect.left) / scale, 0, M.W), y: M.clamp((e.clientY - rect.top) / scale, 0, M.H) };
      if (e.shiftKey) {
        world.x = Math.round(world.x / 5) * 5; world.y = Math.round(world.y / 5) * 5;
      }
      Object.assign(o, P.movePoint(original, state.activePathPoint, world)); editor.renderStage();
    };
    const up = (e) => {
      if (e.pointerId !== event.pointerId) return;
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
      if (moved) editor.changed();
      document.querySelector(`[data-path-point="${state.activePathPoint}"]`)?.focus({ preventScroll: true });
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
    event.preventDefault();
  }
  let pathMenuPoint = null;
  function closePathMenu(immediate = false) {
    const menu = $("book-path-menu"); pathMenuPoint = null;
    if (!menu) return;
    menu.inert = true;
    if (immediate || matchMedia("(prefers-reduced-motion: reduce)").matches) { menu.remove(); return; }
    menu.getAnimations().forEach((animation) => animation.cancel());
    menu.animate([{opacity:1,transform:"translateY(0)"},{opacity:0,transform:"translateY(-4px)"}], {duration:140,easing:"ease-in",fill:"forwards"}).finished.then(() => menu.remove()).catch(() => {});
  }
  function addPathBend() {
    const o = editor.item();
    if (!editor.isPath(o) || o.locked || P.points(o).length >= 32 || !editor.checkpoint()) return;
    const pts = P.points(o).map((p) => p.slice());
    let insertion;
    if (pathMenuPoint) {
      const local = P.localPoint(o, pathMenuPoint);
      insertion = M.nearestPathInsertion(o, { x: local[0], y: local[1] });
    }
    else {
      let longest = -1;
      for (let i = 0; i < pts.length - 1; i++) {
        const distance = Math.hypot((pts[i + 1][0] - pts[i][0]) * o.w, (pts[i + 1][1] - pts[i][1]) * o.h);
        if (distance > longest) { longest = distance; insertion = { index: i + 1, point: [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2] }; }
      }
    }
    pts.splice(insertion.index, 0, insertion.point); o.pathPoints = pts;
    state.activePathPoint = insertion.index;
    closePathMenu(); editor.changed();
    document.querySelector(`[data-path-point="${state.activePathPoint}"]`)?.focus({ preventScroll: true });
  }
  function removePathBend() {
    const o = editor.item(), points = editor.isPath(o) && P.points(o);
    if (!points || o.locked || state.activePathPoint <= 0 || state.activePathPoint >= points.length - 1 || !editor.checkpoint()) return;
    o.pathPoints = points.filter((_, i) => i !== state.activePathPoint); state.activePathPoint = -1;
    closePathMenu(); editor.changed();
  }
  function pathContextMenu(event) {
    const node = event.target.closest("[data-object]"), sheet = event.target.closest("[data-page-id]");
    if (!node || !sheet || !editor.editable() || state.reading) return;
    const p = state.book.pages.find((x) => x.id === sheet.dataset.pageId), o = p.items.find((x) => x.id === node.dataset.object);
    if (!editor.isPath(o) || o.locked) return;
    event.preventDefault(); closePathMenu(true);
    state.active = p.id; state.selected = [o.id]; state.furnitureSelection = "";
    state.activePathPoint = event.target.dataset.pathPoint === undefined ? -1 : +event.target.dataset.pathPoint;
    const rect = sheet.getBoundingClientRect(), scale = rect.width / M.W;
    pathMenuPoint = { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale };
    editor.renderSelection(); inspector.renderInspector();
    const menu = document.createElement("div"); menu.id = "book-path-menu"; menu.className = "book-path-menu";
    menu.setAttribute("role", "menu"); menu.setAttribute("aria-label", "Edit line");
    menu.innerHTML = `<button role="menuitem" data-command="add-path-bend" ${P.points(o).length >= 32 ? "disabled" : ""}>Add bend here</button><button role="menuitem" data-command="remove-path-bend" ${state.activePathPoint <= 0 || state.activePathPoint >= P.points(o).length - 1 ? "disabled" : ""}>Remove this bend</button>`;
    document.body.appendChild(menu);
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) menu.animate([{opacity:0,transform:"translateY(-4px)"},{opacity:1,transform:"translateY(0)"}], {duration:180,easing:"ease-out"});
    editor.layoutRule("#book-path-menu", { left: Math.max(8, Math.min(innerWidth - 220, event.clientX)) + "px", top: Math.max(8, Math.min(innerHeight - 120, event.clientY)) + "px" });
    menu.querySelector("button:not(:disabled)")?.focus();
    menu.addEventListener("keydown", (e) => {
      if (["ArrowDown", "ArrowUp"].includes(e.key)) {
        e.preventDefault(); e.stopPropagation();
        const choices = Array.from(menu.querySelectorAll("button:not(:disabled)"));
        choices[(choices.indexOf(document.activeElement) + 1) % choices.length]?.focus();
      }
    });
  }
  function resizePoint(o, delta, corner) {
    let x = o.x,
      y = o.y,
      w = o.w,
      h = o.h;
    const left = corner.includes("w"),
      top = corner.includes("n");
    w = Math.max(2, o.w + (left ? -delta.x : delta.x));
    h = Math.max(2, o.h + (top ? -delta.y : delta.y));
    if (o.aspectLock && o.type === "image") {
      const ratio = o.w / o.h;
      if (Math.abs(delta.x) > Math.abs(delta.y)) h = w / ratio;
      else w = h * ratio;
      const scale = Math.min(1, 297 / w, 420 / h);
      w *= scale; h *= scale;
    }
    if (left) x = o.x + o.w - w;
    if (top) y = o.y + o.h - h;
    return { x, y, w: Math.min(297, w), h: Math.min(420, h) };
  }
  let canvasPointer = null;
  for (const eventName of ["pointerup", "pointercancel"]) document.addEventListener(eventName, (event) => {
    if (event.pointerId === canvasPointer) canvasPointer = null;
  });
  function pointer(event) {
    if (canvasPointer !== null && canvasPointer !== event.pointerId) return;
    if (event.target.closest("#canvas-text-editor")) return;
    if (state.inlineEdit) editor.finishText();
    let sheet = event.target.closest("[data-page-id]");
    if (!sheet || !state.book || event.button > 0) return;
    canvasPointer = event.pointerId;
    const pid = sheet.dataset.pageId;
    sheet.focus({ preventScroll: true });
    // Blurring an inspector field can redraw the page; use its live geometry.
    if (!sheet.isConnected) {
      sheet = $("book-spread").querySelector(`[data-page-id="${pid}"]`);
      if (!sheet) return;
      sheet.focus({ preventScroll: true });
    }
    if (pid !== state.active) {
      state.active = pid;
      state.selected = [];
      state.furnitureSelection = "";
      state.activePathPoint = -1;
      editor.renderPages();
      $("book-spread").querySelectorAll("[data-page-id]").forEach((node) => { node.dataset.active = String(node.dataset.pageId === state.active); });
      inspector.renderInspector();
    }
    if (!editor.editable() || state.reading) {
      const startX = event.clientX;
      const startY = event.clientY;
      sheet.onpointerup = (e) => {
        if (e.pointerId !== event.pointerId) return;
        if (event.pointerType === "touch" && Math.abs(e.clientX - startX) > 60 && Math.abs(e.clientX - startX) > Math.abs(e.clientY - startY) * 1.5) editor.go(e.clientX < startX ? 1 : -1);
        sheet.onpointerup = null;
      };
      return;
    }
    const rect = sheet.getBoundingClientRect(),
      scale = rect.width / M.W,
      start = {
        x: (event.clientX - rect.left) / scale,
        y: (event.clientY - rect.top) / scale,
      };
    const furnitureNode = event.target.closest("[data-furniture]");
    if (furnitureNode && state.tool === "select") return dragFurniture(event, sheet, furnitureNode.dataset.furniture);
    if (event.target.closest("[data-path-point]")) return dragPathPoint(event, sheet);
    state.furnitureSelection = "";
    const objectNode = event.target.closest("[data-object]"),
      handle = event.target.closest("[data-handle]");
    if (state.tool === "eraser") {
      const target =
        objectNode &&
        editor.page().items.find((o) => o.id === objectNode.dataset.object);
      if (target && target.type === "drawing" && !target.locked && editor.checkpoint()) {
        editor.page().items = editor.page().items.filter((o) => o !== target);
        editor.changed();
      }
      return;
    }
    if (["pen", "pencil", "highlighter"].includes(state.tool)) {
      if (editor.page().items.length >= 300) return editor.notify("This page has 300 objects. Add another page to keep drawing.", true);
      if (!editor.checkpoint()) return;
      const p = editor.page(),
        o = M.object("drawing", {
          name:
            state.tool === "pen"
              ? "Pen drawing"
              : state.tool === "pencil"
                ? "Pencil drawing"
                : "Highlight",
          x: 0,
          y: 0,
          w: M.W,
          h: M.H,
          brush: state.tool,
          stroke: state.brushColor,
          strokeWidth: state.brushWidth,
          points: [[start.x, start.y, event.pressure || 0.5]],
        });
      p.items.push(o);
      state.selected = [];
      state.furnitureSelection = "";
      state.activePathPoint = -1;
      const move = (e) => {
      if (e.pointerId !== event.pointerId) return;
        if (o.points.length >= 3000) return;
        const x = M.clamp((e.clientX - rect.left) / scale, 0, M.W),
          y = M.clamp((e.clientY - rect.top) / scale, 0, M.H);
        const last = o.points[o.points.length - 1];
        if (Math.hypot(x - last[0], y - last[1]) < 0.3) return;
        o.points.push([x, y, e.pressure || 0.5]);
        editor.renderStage();
      };
      const up = (e) => {
      if (e.pointerId !== event.pointerId) return;
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        document.removeEventListener("pointercancel", up);
        const xs = o.points.map((p) => p[0]),
          ys = o.points.map((p) => p[1]);
        o.x = Math.min(...xs);
        o.y = Math.min(...ys);
        o.w = Math.max(1, Math.max(...xs) - o.x);
        o.h = Math.max(1, Math.max(...ys) - o.y);
        o.points = o.points.map((p) => [p[0] - o.x, p[1] - o.y, p[2]]);
        editor.changed();
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
      document.addEventListener("pointercancel", up);
      event.preventDefault();
      return;
    }
    if (!objectNode) {
      const before = event.shiftKey ? state.selected.slice() : [];
      state.selected = before;
      state.selectionRange = null;
      editor.renderSelection();
      inspector.renderInspector();
      const sx = event.clientX,
        sy = event.clientY;
      const marquee = document.createElement("div");
      marquee.className = "book-marquee";
      let moved = false;
      const move = (e) => {
      if (e.pointerId !== event.pointerId) return;
        if (event.pointerType === "touch") return;
        if (Math.hypot(e.clientX - sx, e.clientY - sy) < 5) return;
        moved = true;
        if (!marquee.isConnected) sheet.append(marquee);
        const end = {
            x: (e.clientX - rect.left) / scale,
            y: (e.clientY - rect.top) / scale,
          },
          area = {
            x: Math.min(start.x, end.x),
            y: Math.min(start.y, end.y),
            w: Math.abs(start.x - end.x),
            h: Math.abs(start.y - end.y),
          };
        editor.layoutRule(".book-marquee", {
          left: area.x * scale + "px",
          top: area.y * scale + "px",
          width: area.w * scale + "px",
          height: area.h * scale + "px",
        });
        state.selected = [
          ...new Set([
            ...before,
            ...editor.page()
              .items.filter((o) => {
                const q = M.bounds([o]);
                return (
                  !o.locked &&
                  !o.hidden &&
                  q.x < area.x + area.w &&
                  q.x + q.w > area.x &&
                  q.y < area.y + area.h &&
                  q.y + q.h > area.y
                );
              })
              .map((o) => o.id),
          ]),
        ];
        editor.renderSelection();
      };
      const release = (e) => {
        if (e.pointerId !== event.pointerId) return;
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", release);
        document.removeEventListener("pointercancel", release);
        marquee.remove();
        if (
          event.pointerType === "touch" &&
          (start.x < 12 || start.x > M.W - 12) &&
          Math.abs(e.clientX - sx) > 70 &&
          Math.abs(e.clientY - sy) < 70
        )
          editor.go(e.clientX < sx ? 1 : -1);
        else if (moved) inspector.renderInspector();
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", release);
      document.addEventListener("pointercancel", release);
      return;
    }
    const o = editor.page().items.find((x) => x.id === objectNode.dataset.object);
    if (!o) return;
    if (o.locked) {
      state.furnitureSelection = "";
      state.selected = [o.id];
      inspector.setInspector(true);
      editor.renderSelection();
      inspector.renderInspector();
      editor.notify("This object is locked. Use Unlock to edit it.");
      return;
    }
    state.inspectorTab = "settings";
    if (!state.inspectorOpen) inspector.setInspector(true);
    if (event.shiftKey && !handle) {
      state.selected = state.selected.includes(o.id)
        ? state.selected.filter((id) => id !== o.id)
        : state.selected.concat(o.id);
      editor.renderSelection();
      inspector.renderInspector();
      return;
    }
    if (!state.selected.includes(o.id)) state.activePathPoint = -1;
    if (!state.selected.includes(o.id))
      state.selected = o.group
        ? editor.page()
            .items.filter((x) => x.group === o.group && !x.locked && !x.hidden)
            .map((x) => x.id)
        : [o.id];
    state.selectionRange = null;
    editor.renderSelection();
    if (event.detail < 2) inspector.renderInspector();
    const originals = editor.page()
      .items.filter((x) => state.selected.includes(x.id))
      .map(M.clone);
    let moved = false;
    const move = (e) => {
      if (e.pointerId !== event.pointerId) return;
      const delta = {
        x: (e.clientX - event.clientX) / scale,
        y: (e.clientY - event.clientY) / scale,
      };
      if (!moved && Math.hypot(delta.x, delta.y) < 0.5) return;
      if (!moved) {
        editor.checkpoint();
        moved = true;
      }
      const groupBox = M.bounds(originals);
      let applied = delta,
        lines = [];
      if (!handle) {
        applied = {
          x: M.clamp(
            delta.x,
            -groupBox.x - groupBox.w + 4,
            M.W - 4 - groupBox.x,
          ),
          y: M.clamp(
            delta.y,
            -groupBox.y - groupBox.h + 4,
            M.H - 4 - groupBox.y,
          ),
        };
        if (state.snap && !e.altKey) {
          const result = M.snapMove(
            originals,
            applied,
            editor.page().items.filter((x) => !state.selected.includes(x.id)),
            6 / scale,
            state.grid,
          );
          applied = result.delta;
          lines = result.lines;
        }
      }
      originals.forEach((original) => {
        const target = editor.page().items.find((x) => x.id === original.id);
        if (!target) return;
        if (handle) {
          Object.assign(
            target,
            resizePoint(original, delta, handle.dataset.handle),
          );
          if (target.type === "drawing")
            target.points = original.points.map((p) => [
              (p[0] * target.w) / original.w,
              (p[1] * target.h) / original.h,
              p[2],
            ]);
        } else {
          target.x = original.x + applied.x;
          target.y = original.y + applied.y;
        }
      });
      editor.syncLinkedItems();
      editor.renderStage();
      editor.feedback(lines, M.bounds(editor.selectedItems()));
    };
    const up = (e) => {
      if (e.pointerId !== event.pointerId) return;
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
      editor.feedback();
      if (moved) editor.changed();
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
    event.preventDefault();
  }

  return {
    closePathMenu, addPathBend, removePathBend, pathContextMenu, pointer,
  };
}
