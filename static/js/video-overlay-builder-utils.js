(function (root) {
  'use strict';

  var SUPPORTED_ANIMATIONS = {
    none: true,
    fade: true,
    rise: true,
    scale: true,
    wipe: true
  };

  function clampNumber(value, min, max, fallbackValue) {
    var parsed = Number(value);
    var fallback = Number(fallbackValue);
    if (!Number.isFinite(parsed)) parsed = Number.isFinite(fallback) ? fallback : min;
    if (parsed < min) return min;
    if (parsed > max) return max;
    return parsed;
  }

  function clampInteger(value, min, max, fallbackValue) {
    return Math.round(clampNumber(value, min, max, fallbackValue));
  }

  function normalizeText(value, fallbackValue) {
    var text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return text || String(fallbackValue || '').trim();
  }

  function normalizeAnimation(value) {
    var safeValue = String(value || '').trim().toLowerCase();
    return SUPPORTED_ANIMATIONS[safeValue] ? safeValue : 'rise';
  }

  function createTableData(rows, cols) {
    var rowCount = clampInteger(rows, 1, 8, 3);
    var colCount = clampInteger(cols, 1, 8, 3);
    var cells = [];
    for (var rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      var row = [];
      for (var colIndex = 0; colIndex < colCount; colIndex += 1) {
        row.push(rowIndex === 0 ? ('Column ' + String(colIndex + 1)) : '');
      }
      cells.push(row);
    }
    return {
      cells: cells,
      rowCount: rowCount,
      colCount: colCount
    };
  }

  function normalizeTableData(tableData) {
    var source = tableData && typeof tableData === 'object' ? tableData : {};
    var sourceCells = Array.isArray(source.cells) ? source.cells : [];
    var rowCount = clampInteger(source.rowCount || sourceCells.length, 1, 8, 3);
    var firstRow = Array.isArray(sourceCells[0]) ? sourceCells[0] : [];
    var colCount = clampInteger(source.colCount || firstRow.length, 1, 8, 3);
    var fallback = createTableData(rowCount, colCount);
    var cells = [];

    for (var rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      var sourceRow = Array.isArray(sourceCells[rowIndex]) ? sourceCells[rowIndex] : [];
      var row = [];
      for (var colIndex = 0; colIndex < colCount; colIndex += 1) {
        var fallbackCell = fallback.cells[rowIndex][colIndex];
        row.push(String(sourceRow[colIndex] == null ? fallbackCell : sourceRow[colIndex]));
      }
      cells.push(row);
    }

    return {
      cells: cells,
      rowCount: rowCount,
      colCount: colCount
    };
  }

  function resizeTableData(tableData, rows, cols) {
    var normalized = normalizeTableData(tableData);
    var nextRows = clampInteger(rows, 1, 8, normalized.rowCount);
    var nextCols = clampInteger(cols, 1, 8, normalized.colCount);
    var fallback = createTableData(nextRows, nextCols);
    var cells = [];

    for (var rowIndex = 0; rowIndex < nextRows; rowIndex += 1) {
      var row = [];
      for (var colIndex = 0; colIndex < nextCols; colIndex += 1) {
        var oldRow = normalized.cells[rowIndex] || [];
        row.push(String(oldRow[colIndex] == null ? fallback.cells[rowIndex][colIndex] : oldRow[colIndex]));
      }
      cells.push(row);
    }

    return {
      cells: cells,
      rowCount: nextRows,
      colCount: nextCols
    };
  }

  function normalizeOverlayItem(item) {
    var source = item && typeof item === 'object' ? item : {};
    var type = String(source.type || 'text').trim().toLowerCase();
    if (['text', 'table', 'image', 'flow'].indexOf(type) < 0) type = 'text';
    return Object.assign({}, source, {
      type: type,
      x: clampNumber(source.x, 0, 96, 8),
      y: clampNumber(source.y, 0, 90, 10),
      w: clampNumber(source.w, 8, 96, 42),
      h: clampNumber(source.h, 8, 92, type === 'table' ? 28 : 24),
      delay: clampNumber(source.delay, 0, 600, 0),
      duration: clampNumber(source.duration, 0.1, 10, 0.55),
      animation: normalizeAnimation(source.animation),
      title: normalizeText(source.title, type === 'table' ? 'Table' : 'Overlay')
    });
  }

  function buildAnimationSchedule(items, slideDuration) {
    var maxDelay = Math.max(0, Number(slideDuration || 0));
    return (Array.isArray(items) ? items : []).map(function (item, index) {
      var normalized = normalizeOverlayItem(item);
      return {
        id: String(normalized.id || ('item-' + index)),
        delayMs: Math.round(clampNumber(normalized.delay, 0, maxDelay || 600, 0) * 1000),
        durationMs: Math.round(clampNumber(normalized.duration, 0.1, 10, 0.55) * 1000),
        animation: normalized.animation,
        order: index
      };
    }).sort(function (left, right) {
      if (left.delayMs !== right.delayMs) return left.delayMs - right.delayMs;
      return left.order - right.order;
    });
  }

  function summarizeItem(item) {
    var normalized = normalizeOverlayItem(item);
    if (normalized.type === 'table') {
      var tableData = normalizeTableData(normalized.table);
      return tableData.rowCount + ' x ' + tableData.colCount + ' table';
    }
    if (normalized.type === 'flow') {
      var steps = Array.isArray(normalized.steps) ? normalized.steps.length : 0;
      return Math.max(1, steps) + ' flow step' + (Math.max(1, steps) === 1 ? '' : 's');
    }
    if (normalized.type === 'image') return 'Image overlay';
    return 'Text overlay';
  }

  var exported = {
    buildAnimationSchedule: buildAnimationSchedule,
    clampInteger: clampInteger,
    clampNumber: clampNumber,
    createTableData: createTableData,
    normalizeAnimation: normalizeAnimation,
    normalizeOverlayItem: normalizeOverlayItem,
    normalizeTableData: normalizeTableData,
    resizeTableData: resizeTableData,
    summarizeItem: summarizeItem
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }

  root.LectureProcessorVideoOverlayBuilderUtils = Object.assign(
    {},
    root.LectureProcessorVideoOverlayBuilderUtils || {},
    exported
  );
})(typeof window !== 'undefined' ? window : globalThis);
