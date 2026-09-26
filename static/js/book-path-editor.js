(function (root) {
  "use strict";
  const points = (o) => o.pathPoints?.length >= 2 ? o.pathPoints : [[0, .5], [1, .5]];
  function localPoint(o, world) {
    const angle = -(o.rotation || 0) * Math.PI / 180;
    const dx = world.x - o.x - o.w / 2, dy = world.y - o.y - o.h / 2;
    return [dx * Math.cos(angle) - dy * Math.sin(angle) + o.w / 2,
      dx * Math.sin(angle) + dy * Math.cos(angle) + o.h / 2];
  }
  function movePoint(o, index, world) {
    const next = points(o).map((p) => [p[0] * o.w, p[1] * o.h]);
    next[index] = localPoint(o, world);
    const minX = Math.min(...next.map((p) => p[0])), minY = Math.min(...next.map((p) => p[1]));
    const w = Math.max(1, Math.max(...next.map((p) => p[0])) - minX);
    const h = Math.max(1, Math.max(...next.map((p) => p[1])) - minY);
    const dx = minX + w / 2 - o.w / 2, dy = minY + h / 2 - o.h / 2;
    const angle = (o.rotation || 0) * Math.PI / 180;
    return { x: o.x + o.w / 2 + dx * Math.cos(angle) - dy * Math.sin(angle) - w / 2,
      y: o.y + o.h / 2 + dx * Math.sin(angle) + dy * Math.cos(angle) - h / 2,
      w, h, pathPoints: next.map((p) => [(p[0] - minX) / w, (p[1] - minY) / h]) };
  }
  function insertion(o, world) {
    const p = localPoint(o, world), path = points(o);
    let best = null;
    for (let i = 0; i < path.length - 1; i++) {
      const a = [path[i][0] * o.w, path[i][1] * o.h], c = [path[i + 1][0] * o.w, path[i + 1][1] * o.h];
      const dx = c[0] - a[0], dy = c[1] - a[1];
      const t = Math.max(.05, Math.min(.95, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
      const x = a[0] + dx * t, y = a[1] + dy * t, distance = Math.hypot(p[0] - x, p[1] - y);
      if (!best || distance < best.distance) best = { index: i + 1, point: [x / o.w, y / o.h], distance };
    }
    return best;
  }
  const api = { points, localPoint, movePoint, insertion };
  if (typeof module !== "undefined") module.exports = api;
  else root.BookPathEditor = api;
})(typeof window === "undefined" ? globalThis : window);
