(function (root) {
  'use strict';

  function buildFolderItemsForSidebar(options) {
    var settings = options && typeof options === 'object' ? options : {};
    var folders = Array.isArray(settings.folders) ? settings.folders : [];
    var pinnedFolderIds = Array.isArray(settings.pinnedFolderIds) ? settings.pinnedFolderIds : [];
    var collapsedFolderIds = Array.isArray(settings.collapsedFolderIds) ? settings.collapsedFolderIds.map(function (folderId) {
      return String(folderId || '');
    }) : [];
    var allFolderId = String(settings.allFolderId == null ? '' : settings.allFolderId);
    var interviewFolderId = String(settings.interviewFolderId == null ? '__interviews__' : settings.interviewFolderId);
    var voiceNotesFolderId = String(settings.voiceNotesFolderId == null ? '__voice_notes__' : settings.voiceNotesFolderId);
    var pinnedSet = new Set(pinnedFolderIds.map(function (folderId) { return String(folderId || ''); }).filter(Boolean));
    var collapsedSet = new Set(collapsedFolderIds.filter(Boolean));
    var displayed = new Set();
    var childrenByParent = {};
    var foldersById = {};

    folders.forEach(function (folder) {
      var item = Object.assign({}, folder || {});
      item.folder_id = String(item.folder_id || '');
      if (!item.folder_id) return;
      item.parent_folder_id = String(item.parent_folder_id || '');
      if (item.parent_folder_id === allFolderId) item.parent_folder_id = '';
      item.sort_order = Number(item.sort_order || 0);
      foldersById[item.folder_id] = item;
      childrenByParent[item.parent_folder_id] = childrenByParent[item.parent_folder_id] || [];
      childrenByParent[item.parent_folder_id].push(item);
    });

    Object.keys(childrenByParent).forEach(function (parentId) {
      childrenByParent[parentId].sort(function (left, right) {
        var leftPinned = pinnedSet.has(String(left.folder_id || '')) ? 0 : 1;
        var rightPinned = pinnedSet.has(String(right.folder_id || '')) ? 0 : 1;
        if (leftPinned !== rightPinned) return leftPinned - rightPinned;
        if (left.sort_order !== right.sort_order) return left.sort_order - right.sort_order;
        var leftCreated = Number(left.created_at || 0);
        var rightCreated = Number(right.created_at || 0);
        if (leftCreated !== rightCreated) return rightCreated - leftCreated;
        return String(left.name || '').localeCompare(String(right.name || ''));
      });
    });

    function decorate(folder, depth) {
      var folderId = String(folder.folder_id || '');
      var childCount = (childrenByParent[folderId] || []).length;
      return Object.assign({}, folder, {
        depth: Math.max(0, Number(depth || 0)),
        child_count: childCount,
        is_collapsed: collapsedSet.has(folderId),
        is_pinned: pinnedSet.has(folderId),
        is_builtin: false,
        is_fixed: false,
      });
    }

    function appendChildren(parentId, depth, output) {
      (childrenByParent[parentId] || []).forEach(function (folder) {
        var folderId = String(folder.folder_id || '');
        if (!folderId || displayed.has(folderId)) return;
        displayed.add(folderId);
        var item = decorate(folder, depth);
        output.push(item);
        if (!item.is_collapsed) {
          appendChildren(folderId, depth + 1, output);
        }
      });
    }

    function builtin(folderId, name, metaDefault) {
      return {
        folder_id: folderId,
        name: name,
        course: '',
        subject: '',
        semester: '',
        block: '',
        exam_date: '',
        parent_folder_id: '',
        sort_order: 0,
        depth: 0,
        child_count: (childrenByParent[folderId] || []).length,
        is_collapsed: collapsedSet.has(folderId),
        is_pinned: true,
        is_builtin: true,
        is_fixed: true,
        meta_default: metaDefault,
      };
    }

    function shouldRenderAsTopLevel(folder) {
      var parentId = String(folder && folder.parent_folder_id || '');
      if (parentId === allFolderId) parentId = '';
      if (!parentId) return true;
      if (parentId === interviewFolderId || parentId === voiceNotesFolderId) return false;
      return !foldersById[parentId];
    }

    var output = [
      builtin(allFolderId, 'All Study Packs', 'All packs'),
      builtin(voiceNotesFolderId, 'Voice Notes', 'Quick transcriber notes'),
    ];
    if (!output[1].is_collapsed) appendChildren(voiceNotesFolderId, 1, output);
    var interviews = builtin(interviewFolderId, 'Interviews', 'Interview transcript packs');
    output.push(interviews);
    if (!interviews.is_collapsed) appendChildren(interviewFolderId, 1, output);

    var pinnedFolders = pinnedFolderIds.map(function (folderId) {
      return folders.find(function (folder) {
        return String(folder && folder.folder_id || '') === String(folderId || '');
      }) || null;
    }).filter(Boolean).filter(function (folder) {
      var folderId = String(folder && folder.folder_id || '');
      return folderId && !displayed.has(folderId) && shouldRenderAsTopLevel(folder);
    }).map(function (folder) {
      displayed.add(String(folder.folder_id || ''));
      return decorate(Object.assign({}, folder, { parent_folder_id: String(folder.parent_folder_id || '') }), 0);
    });

    var remaining = folders.filter(function (folder) {
      var folderId = String(folder && folder.folder_id || '');
      return folderId && !displayed.has(folderId) && !pinnedSet.has(folderId) && shouldRenderAsTopLevel(folder);
    }).map(function (folder) {
      displayed.add(String(folder.folder_id || ''));
      return decorate(Object.assign({}, folder, { parent_folder_id: String(folder.parent_folder_id || '') }), 0);
    });

    pinnedFolders.forEach(function (item) {
      output.push(item);
      if (!item.is_collapsed) appendChildren(item.folder_id, item.depth + 1, output);
    });
    remaining.forEach(function (item) {
      output.push(item);
      if (!item.is_collapsed) appendChildren(item.folder_id, item.depth + 1, output);
    });
    return output;
  }

  function getDescendantFolderIds(folders, folderId) {
    var rootId = String(folderId || '');
    var childrenByParent = {};
    (Array.isArray(folders) ? folders : []).forEach(function (folder) {
      var id = String(folder && folder.folder_id || '');
      if (!id) return;
      var parentId = String(folder && folder.parent_folder_id || '');
      childrenByParent[parentId] = childrenByParent[parentId] || [];
      childrenByParent[parentId].push(id);
    });
    var found = [];
    var seen = new Set();
    var stack = (childrenByParent[rootId] || []).slice();
    while (stack.length) {
      var id = stack.pop();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      found.push(id);
      (childrenByParent[id] || []).forEach(function (childId) { stack.push(childId); });
    }
    return found;
  }

  function filterStudyPacks(packs, options) {
    var collection = Array.isArray(packs) ? packs : [];
    var settings = options && typeof options === 'object' ? options : {};
    var searchQuery = String(settings.searchQuery || '').trim().toLowerCase();
    var selectedFolderId = String(settings.selectedFolderId || '');
    var allFolderId = String(settings.allFolderId == null ? '' : settings.allFolderId);
    var interviewFolderId = String(settings.interviewFolderId == null ? '__interviews__' : settings.interviewFolderId);
    var voiceNotesFolderId = String(settings.voiceNotesFolderId == null ? '__voice_notes__' : settings.voiceNotesFolderId);
    var descendantFolderIds = Array.isArray(settings.descendantFolderIds) ? settings.descendantFolderIds.map(function (folderId) {
      return String(folderId || '');
    }) : [];
    var selectedFolderIds = new Set([selectedFolderId].concat(descendantFolderIds).filter(function (folderId) {
      return !!folderId;
    }));

    return collection.filter(function (pack) {
      if (selectedFolderId === interviewFolderId) {
        if (String(pack && pack.mode || '') !== 'interview') return false;
      } else if (selectedFolderId === voiceNotesFolderId) {
        if (String(pack && pack.mode || '') !== 'voice-note') return false;
      } else if (!selectedFolderId || selectedFolderId === allFolderId) {
        if (String(pack && pack.mode || '') === 'voice-note') return false;
      } else if (selectedFolderId && selectedFolderId !== allFolderId && !selectedFolderIds.has(String(pack && pack.folder_id || ''))) {
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

  function getStudyPackIds(packs) {
    return (Array.isArray(packs) ? packs : []).map(function (pack) {
      return String(pack && pack.study_pack_id || '');
    }).filter(Boolean);
  }

  function getPackIdsForDrag(currentSelection, targetPackId) {
    var targetId = String(targetPackId || '');
    var selected = (Array.isArray(currentSelection) ? currentSelection : []).map(function (packId) {
      return String(packId || '');
    }).filter(Boolean);
    if (targetId && selected.indexOf(targetId) >= 0) {
      return selected;
    }
    return targetId ? [targetId] : selected;
  }

  function buildStudyPackSelection(currentSelection, targetPackId, visiblePacks, options) {
    var selected = new Set(Array.isArray(currentSelection) ? currentSelection.map(function (packId) {
      return String(packId || '');
    }).filter(Boolean) : []);
    var settings = options && typeof options === 'object' ? options : {};
    var targetId = String(targetPackId || '');
    if (!targetId) {
      return Array.from(selected);
    }

    var checked = !!settings.checked;
    if (settings.range) {
      var anchorId = String(settings.anchorPackId || '');
      var visibleIds = getStudyPackIds(visiblePacks);
      var anchorIndex = visibleIds.indexOf(anchorId);
      var targetIndex = visibleIds.indexOf(targetId);
      if (anchorIndex >= 0 && targetIndex >= 0) {
        var start = Math.min(anchorIndex, targetIndex);
        var end = Math.max(anchorIndex, targetIndex);
        visibleIds.slice(start, end + 1).forEach(function (packId) {
          if (checked) {
            selected.add(packId);
          } else {
            selected.delete(packId);
          }
        });
        return Array.from(selected);
      }
    }

    if (checked) {
      selected.add(targetId);
    } else {
      selected.delete(targetId);
    }
    return Array.from(selected);
  }

  function buildStudyPackExportItems(pack) {
    var safePack = pack && typeof pack === 'object' ? pack : {};
    var mode = String(safePack.mode || '').trim().toLowerCase();
    var transcriptLabel = mode === 'interview' ? 'Interview Transcript' : (mode === 'voice-note' ? 'Voice Note Transcript' : 'Lecture Transcript');
    var items = [
      { kind: 'flashcards', visible: true, label: 'Flashcards CSV' },
      { kind: 'test', visible: true, label: 'Practice Test CSV' },
      { kind: 'source-slides-md', visible: !!safePack.has_source_slides, label: 'Slide Extract (.md)' },
      { kind: 'source-slides-docx', visible: !!safePack.has_source_slides, label: 'Slide Extract (.docx)' },
      { kind: 'source-transcript-md', visible: !!safePack.has_source_transcript, label: transcriptLabel + ' (.md)' },
      { kind: 'source-transcript-docx', visible: !!safePack.has_source_transcript, label: transcriptLabel + ' (.docx)' },
      { kind: 'pdf-menu', visible: true, label: 'Lecture Notes Pack PDF' },
    ];
    return items;
  }

  function buildStudyPackTitleFromCsvFilename(filename, fallbackTitle) {
    var fallback = String(fallbackTitle || 'Untitled pack').trim() || 'Untitled pack';
    var rawName = String(filename || '').split(/[\\/]/).pop().trim();
    if (!rawName) return fallback;
    var withoutQuery = rawName.split(/[?#]/)[0].trim();
    var withoutExtension = withoutQuery.replace(/\.csv$/i, '').trim();
    if (withoutExtension === withoutQuery) {
      withoutExtension = withoutQuery.replace(/\.[^.]+$/, '').trim();
    }
    var cleaned = withoutExtension
      .replace(/[_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned || fallback;
  }

  var exported = {
    buildFolderItemsForSidebar: buildFolderItemsForSidebar,
    getDescendantFolderIds: getDescendantFolderIds,
    filterStudyPacks: filterStudyPacks,
    buildStudyPacksUrl: buildStudyPacksUrl,
    mergeStudyPackPage: mergeStudyPackPage,
    getStudyPackIds: getStudyPackIds,
    getPackIdsForDrag: getPackIdsForDrag,
    buildStudyPackSelection: buildStudyPackSelection,
    buildStudyPackExportItems: buildStudyPackExportItems,
    buildStudyPackTitleFromCsvFilename: buildStudyPackTitleFromCsvFilename,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }

  root.LectureProcessorStudyLibraryUtils = Object.assign({}, root.LectureProcessorStudyLibraryUtils || {}, exported);
})(typeof window !== 'undefined' ? window : globalThis);
