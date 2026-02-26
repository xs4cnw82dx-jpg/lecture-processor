(function (global) {
  'use strict';

  function parseFilenameFromDisposition(disposition, fallbackName) {
    var value = String(disposition || '');
    var utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match && utf8Match[1]) {
      try { return decodeURIComponent(utf8Match[1].trim()); } catch (_) { return utf8Match[1].trim(); }
    }
    var quotedMatch = value.match(/filename="([^"]+)"/i);
    if (quotedMatch && quotedMatch[1]) return quotedMatch[1].trim();
    var plainMatch = value.match(/filename=([^;]+)/i);
    if (plainMatch && plainMatch[1]) return plainMatch[1].trim();
    return fallbackName;
  }

  function saveBlobAsFile(blob, filename) {
    var url = URL.createObjectURL(blob);
    var anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename || 'download';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }

  function downloadResponseBlob(response, fallbackName) {
    return response.blob().then(function (blob) {
      var filename = parseFilenameFromDisposition(
        response.headers.get('content-disposition') || response.headers.get('Content-Disposition'),
        fallbackName
      );
      saveBlobAsFile(blob, filename || fallbackName);
      return filename || fallbackName;
    });
  }

  global.LectureProcessorDownload = {
    parseFilenameFromDisposition: parseFilenameFromDisposition,
    saveBlobAsFile: saveBlobAsFile,
    downloadResponseBlob: downloadResponseBlob,
  };
})(window);
