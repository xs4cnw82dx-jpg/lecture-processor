(function (root) {
  'use strict';

  function buildFolderItemsForSidebar(options) {
    var settings = options && typeof options === 'object' ? options : {};
    var folders = Array.isArray(settings.folders) ? settings.folders : [];
    var pinnedFolderIds = Array.isArray(settings.pinnedFolderIds) ? settings.pinnedFolderIds : [];
    var allFolderId = String(settings.allFolderId == null ? '' : settings.allFolderId);
    var interviewFolderId = String(settings.interviewFolderId == null ? '__interviews__' : settings.interviewFolderId);
    var pinnedSet = new Set(pinnedFolderIds.map(function (folderId) { return String(folderId || ''); }).filter(Boolean));

    var pinnedFolders = pinnedFolderIds.map(function (folderId) {
      return folders.find(function (folder) {
        return String(folder && folder.folder_id || '') === String(folderId || '');
      }) || null;
    }).filter(Boolean).map(function (folder) {
      return Object.assign({}, folder, { is_pinned: true, is_builtin: false, is_fixed: false });
    });

    var remaining = folders.filter(function (folder) {
      return !pinnedSet.has(String(folder && folder.folder_id || ''));
    }).map(function (folder) {
      return Object.assign({}, folder, { is_pinned: false, is_builtin: false, is_fixed: false });
    });

    return [
      {
        folder_id: allFolderId,
        name: 'All Study Packs',
        course: '',
        subject: '',
        semester: '',
        block: '',
        exam_date: '',
        is_pinned: true,
        is_builtin: true,
        is_fixed: true,
        meta_default: 'All packs',
      },
      {
        folder_id: interviewFolderId,
        name: 'Interviews',
        course: '',
        subject: '',
        semester: '',
        block: '',
        exam_date: '',
        is_pinned: true,
        is_builtin: true,
        is_fixed: true,
        meta_default: 'Interview transcript packs',
      },
    ].concat(pinnedFolders, remaining);
  }

  function filterStudyPacks(packs, options) {
    var collection = Array.isArray(packs) ? packs : [];
    var settings = options && typeof options === 'object' ? options : {};
    var searchQuery = String(settings.searchQuery || '').trim().toLowerCase();
    var selectedFolderId = String(settings.selectedFolderId || '');
    var allFolderId = String(settings.allFolderId == null ? '' : settings.allFolderId);
    var interviewFolderId = String(settings.interviewFolderId == null ? '__interviews__' : settings.interviewFolderId);

    return collection.filter(function (pack) {
      if (selectedFolderId === interviewFolderId) {
        if (String(pack && pack.mode || '') !== 'interview') return false;
      } else if (selectedFolderId && selectedFolderId !== allFolderId && String(pack && pack.folder_id || '') !== selectedFolderId) {
        return false;
      }

      if (!searchQuery) return true;

      var haystack = [
        pack && pack.title,
        pack && pack.course,
        pack && pack.subject,
        pack && pack.semester,
        pack && pack.block,
      ].join(' ').toLowerCase();

      return haystack.indexOf(searchQuery) >= 0;
    });
  }

  function buildStudyPacksUrl(afterCursor, options) {
    var settings = options && typeof options === 'object' ? options : {};
    var basePath = String(settings.basePath || '/api/study-packs');
    var limit = parseInt(settings.limit, 10);
    var safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 50;
    var params = ['limit=' + encodeURIComponent(String(safeLimit))];
    if (afterCursor) {
      params.push('after=' + encodeURIComponent(String(afterCursor)));
    }
    return basePath + '?' + params.join('&');
  }

  function mergeStudyPackPage(currentPacks, incomingPacks) {
    var existing = {};
    var merged = [];

    (Array.isArray(currentPacks) ? currentPacks : []).forEach(function (pack) {
      var packId = String(pack && pack.study_pack_id || '');
      if (!packId || existing[packId]) return;
      existing[packId] = true;
      merged.push(pack);
    });

    (Array.isArray(incomingPacks) ? incomingPacks : []).forEach(function (pack) {
      var packId = String(pack && pack.study_pack_id || '');
      if (!packId || existing[packId]) return;
      existing[packId] = true;
      merged.push(pack);
    });

    return merged;
  }

  var exported = {
    buildFolderItemsForSidebar: buildFolderItemsForSidebar,
    filterStudyPacks: filterStudyPacks,
    buildStudyPacksUrl: buildStudyPacksUrl,
    mergeStudyPackPage: mergeStudyPackPage,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }

  root.LectureProcessorStudyLibraryUtils = Object.assign({}, root.LectureProcessorStudyLibraryUtils || {}, exported);
})(typeof window !== 'undefined' ? window : globalThis);
