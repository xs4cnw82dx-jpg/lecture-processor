(function (root) {
  'use strict';

  function createSvgElement(text) {
    var code = root.qrcode(0, 'M');
    code.addData(text, 'Byte');
    code.make();
    var size = code.getModuleCount();
    var margin = 4;
    var total = size + margin * 2;
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + total + ' ' + total);
    svg.setAttribute('xmlns', ns);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'QR code for ' + text);
    var bg = document.createElementNS(ns, 'rect');
    bg.setAttribute('width', String(total));
    bg.setAttribute('height', String(total));
    bg.setAttribute('fill', '#ffffff');
    svg.appendChild(bg);
    var pathParts = [];
    for (var r = 0; r < size; r += 1) {
      for (var c = 0; c < size; c += 1) {
        if (code.isDark(r, c)) {
          pathParts.push('M' + (c + margin) + ',' + (r + margin) + 'h1v1h-1z');
        }
      }
    }
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d', pathParts.join(''));
    path.setAttribute('fill', '#062940');
    svg.appendChild(path);
    return svg;
  }

  root.XpedElearningQR = {
    createSvgElement: createSvgElement,
  };
})(typeof window !== 'undefined' ? window : globalThis);
