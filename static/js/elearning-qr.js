(function (root) {
  'use strict';

  /* Compact QR Code SVG generator (Byte mode, ECC Level L, Versions 1–8, up to 192 UTF-8 bytes). */
  var EXP = new Array(512);
  var LOG = new Array(256);
  (function initGF() {
    var x = 1;
    for (var i = 0; i < 255; i += 1) {
      EXP[i] = x;
      LOG[x] = i;
      x = (x << 1) ^ (x & 128 ? 0x11d : 0);
    }
    for (var j = 255; j < 512; j += 1) EXP[j] = EXP[j - 255];
  })();

  function gfMul(a, b) {
    return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];
  }

  function rsGenerator(degree) {
    var poly = [1];
    for (var i = 0; i < degree; i += 1) {
      var next = new Array(poly.length + 1).fill(0);
      for (var j = 0; j < poly.length; j += 1) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(data, ecCount) {
    var gen = rsGenerator(ecCount);
    var res = data.concat(new Array(ecCount).fill(0));
    for (var i = 0; i < data.length; i += 1) {
      var factor = res[i];
      if (factor !== 0) {
        for (var j = 0; j < gen.length; j += 1) {
          res[i + j] ^= gfMul(gen[j], factor);
        }
      }
    }
    return res.slice(data.length);
  }

  // Version specs for ECC Level L: [dataCodewords, ecPerBlock, blocks, alignPositions]
  var SPECS = {
    1: [19, 7, 1, []],
    2: [34, 10, 1, [6, 18]],
    3: [55, 15, 1, [6, 22]],
    4: [80, 20, 1, [6, 26]],
    5: [108, 26, 1, [6, 30]],
    6: [136, 18, 2, [6, 34]],
    7: [156, 20, 2, [6, 22, 38]],
    8: [194, 24, 2, [6, 24, 42]],
  };

  function toUtf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(str));
    var out = [];
    for (var i = 0; i < str.length; i += 1) out.push(str.charCodeAt(i) & 0xff);
    return out;
  }

  function buildMatrix(text) {
    var bytes = toUtf8Bytes(String(text || ''));
    var ver = 1;
    while (ver <= 8 && bytes.length + 2 > SPECS[ver][0]) ver += 1;
    if (ver > 8) ver = 8;
    var spec = SPECS[ver];
    var totalData = spec[0];
    var ecPerBlock = spec[1];
    var numBlocks = spec[2];
    var align = spec[3];

    var bits = [];
    function pushBits(val, len) {
      for (var i = len - 1; i >= 0; i -= 1) bits.push((val >> i) & 1);
    }
    pushBits(4, 4); // Byte mode
    pushBits(Math.min(bytes.length, totalData - 2), 8);
    for (var i = 0; i < Math.min(bytes.length, totalData - 2); i += 1) pushBits(bytes[i], 8);
    pushBits(0, Math.min(4, totalData * 8 - bits.length));
    while (bits.length % 8 !== 0) bits.push(0);
    var codewords = [];
    for (var b = 0; b < bits.length; b += 8) {
      var cw = 0;
      for (var k = 0; k < 8; k += 1) cw = (cw << 1) | bits[b + k];
      codewords.push(cw);
    }
    var pad = [0xec, 0x11];
    var pi = 0;
    while (codewords.length < totalData) {
      codewords.push(pad[pi % 2]);
      pi += 1;
    }

    var blockSize = Math.floor(totalData / numBlocks);
    var dataBlocks = [];
    var ecBlocks = [];
    for (var bl = 0; bl < numBlocks; bl += 1) {
      var chunk = codewords.slice(bl * blockSize, (bl + 1) * blockSize);
      dataBlocks.push(chunk);
      ecBlocks.push(rsEncode(chunk, ecPerBlock));
    }
    var finalBytes = [];
    for (var d = 0; d < blockSize; d += 1) {
      for (var b1 = 0; b1 < numBlocks; b1 += 1) finalBytes.push(dataBlocks[b1][d]);
    }
    for (var e = 0; e < ecPerBlock; e += 1) {
      for (var b2 = 0; b2 < numBlocks; b2 += 1) finalBytes.push(ecBlocks[b2][e]);
    }

    var size = ver * 4 + 17;
    var grid = Array.from({ length: size }, function () { return new Array(size).fill(0); });
    var fixed = Array.from({ length: size }, function () { return new Array(size).fill(false); });

    function setMod(r, c, dark, isFixed) {
      if (r < 0 || c < 0 || r >= size || c >= size) return;
      grid[r][c] = dark ? 1 : 0;
      if (isFixed) fixed[r][c] = true;
    }

    function finder(r0, c0) {
      for (var r = -1; r <= 7; r += 1) {
        for (var c = -1; c <= 7; c += 1) {
          var inSq = r >= 0 && r <= 6 && c >= 0 && c <= 6;
          var dark = inSq && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
          setMod(r0 + r, c0 + c, dark, true);
        }
      }
    }
    finder(0, 0);
    finder(0, size - 7);
    finder(size - 7, 0);

    for (var t = 8; t < size - 8; t += 1) {
      setMod(6, t, t % 2 === 0, true);
      setMod(t, 6, t % 2 === 0, true);
    }

    for (var ai = 0; ai < align.length; ai += 1) {
      for (var aj = 0; aj < align.length; aj += 1) {
        var ar = align[ai];
        var ac = align[aj];
        if (fixed[ar][ac]) continue;
        for (var dr = -2; dr <= 2; dr += 1) {
          for (var dc = -2; dc <= 2; dc += 1) {
            setMod(ar + dr, ac + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1, true);
          }
        }
      }
    }

    // Reserve format info (ECC L + mask 0 => 0x77c4)
    var fmt = 0x77c4;
    for (var f = 0; f < 15; f += 1) {
      var bit = ((fmt >> f) & 1) === 1;
      if (f < 6) setMod(f, 8, bit, true);
      else if (f < 8) setMod(f + 1, 8, bit, true);
      else setMod(size - 15 + f, 8, bit, true);

      if (f < 8) setMod(8, size - f - 1, bit, true);
      else if (f < 9) setMod(8, 15 - f, bit, true);
      else setMod(8, 15 - f - 1, bit, true);
    }
    setMod(size - 8, 8, true, true);

    // Reserve version info for v7+
    if (ver >= 7) {
      var vBits = ver === 7 ? 0x07c94 : 0x085bc;
      for (var vi = 0; vi < 18; vi += 1) {
        var vb = ((vBits >> vi) & 1) === 1;
        setMod(Math.floor(vi / 3), size - 11 + (vi % 3), vb, true);
        setMod(size - 11 + (vi % 3), Math.floor(vi / 3), vb, true);
      }
    }

    // Place data bits with mask 0 ((r + c) % 2 === 0)
    var bitIdx = 0;
    var totalBits = finalBytes.length * 8;
    var dirUp = true;
    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col -= 1;
      for (var step = 0; step < size; step += 1) {
        var row = dirUp ? (size - 1 - step) : step;
        for (var dx = 0; dx < 2; dx += 1) {
          var c2 = col - dx;
          if (fixed[row][c2]) continue;
          var dataBit = bitIdx < totalBits ? ((finalBytes[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1) : 0;
          bitIdx += 1;
          var masked = ((row + c2) % 2 === 0) ? (dataBit ^ 1) : dataBit;
          grid[row][c2] = masked;
        }
      }
      dirUp = !dirUp;
    }
    return grid;
  }

  function createSvgElement(text) {
    var grid = buildMatrix(text);
    var size = grid.length;
    var margin = 4;
    var total = size + margin * 2;
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + total + ' ' + total);
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
        if (grid[r][c]) {
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
