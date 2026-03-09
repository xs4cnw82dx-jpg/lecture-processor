const test = require('node:test');
const assert = require('node:assert/strict');

const studyLibraryUtils = require('../static/js/study-library-utils.js');

test('buildFolderItemsForSidebar keeps built-ins first and preserves pinned order', () => {
  const items = studyLibraryUtils.buildFolderItemsForSidebar({
    folders: [
      { folder_id: 'folder-b', name: 'Folder B' },
      { folder_id: 'folder-a', name: 'Folder A' },
      { folder_id: 'folder-c', name: 'Folder C' },
    ],
    pinnedFolderIds: ['folder-c', 'folder-a', 'missing-folder'],
    allFolderId: '',
    interviewFolderId: '__interviews__',
  });

  assert.deepEqual(items.map((item) => item.folder_id), [
    '',
    '__interviews__',
    'folder-c',
    'folder-a',
    'folder-b',
  ]);
  assert.equal(items[2].is_pinned, true);
  assert.equal(items[4].is_pinned, false);
});

test('filterStudyPacks matches folder and search filters consistently', () => {
  const packs = [
    { study_pack_id: 'pack-1', folder_id: 'folder-a', title: 'Biology Intro', course: 'BIO101', mode: 'study' },
    { study_pack_id: 'pack-2', folder_id: 'folder-b', title: 'Interview Practice', subject: 'Hiring', mode: 'interview' },
    { study_pack_id: 'pack-3', folder_id: 'folder-a', title: 'Organic Chemistry', subject: 'Chemistry', mode: 'study' },
  ];

  assert.deepEqual(studyLibraryUtils.filterStudyPacks(packs, {
    searchQuery: 'chem',
    selectedFolderId: 'folder-a',
    allFolderId: '',
    interviewFolderId: '__interviews__',
  }).map((pack) => pack.study_pack_id), ['pack-3']);

  assert.deepEqual(studyLibraryUtils.filterStudyPacks(packs, {
    searchQuery: '',
    selectedFolderId: '__interviews__',
    allFolderId: '',
    interviewFolderId: '__interviews__',
  }).map((pack) => pack.study_pack_id), ['pack-2']);
});

test('buildStudyPacksUrl uses the default limit and encodes cursors', () => {
  assert.equal(studyLibraryUtils.buildStudyPacksUrl(''), '/api/study-packs?limit=50');
  assert.equal(
    studyLibraryUtils.buildStudyPacksUrl('cursor with spaces', { limit: 25 }),
    '/api/study-packs?limit=25&after=cursor%20with%20spaces'
  );
});

test('mergeStudyPackPage appends only unseen study packs', () => {
  const merged = studyLibraryUtils.mergeStudyPackPage(
    [
      { study_pack_id: 'pack-1', title: 'One' },
      { study_pack_id: 'pack-2', title: 'Two' },
    ],
    [
      { study_pack_id: 'pack-2', title: 'Updated Two' },
      { study_pack_id: 'pack-3', title: 'Three' },
      { study_pack_id: '', title: 'Ignored' },
    ]
  );

  assert.deepEqual(merged, [
    { study_pack_id: 'pack-1', title: 'One' },
    { study_pack_id: 'pack-2', title: 'Two' },
    { study_pack_id: 'pack-3', title: 'Three' },
  ]);
});

test('buildStudyPackExportItems shows source exports only when source outputs exist', () => {
  const lectureItems = studyLibraryUtils.buildStudyPackExportItems({
    mode: 'lecture-notes',
    has_source_slides: true,
    has_source_transcript: false,
  });

  const slideMd = lectureItems.find((item) => item.kind === 'source-slides-md');
  const transcriptDocx = lectureItems.find((item) => item.kind === 'source-transcript-docx');

  assert.equal(slideMd.visible, true);
  assert.equal(slideMd.label, 'Slide Extract (.md)');
  assert.equal(transcriptDocx.visible, false);

  const interviewItems = studyLibraryUtils.buildStudyPackExportItems({
    mode: 'interview',
    has_source_slides: false,
    has_source_transcript: true,
  });

  const interviewTranscriptMd = interviewItems.find((item) => item.kind === 'source-transcript-md');
  assert.equal(interviewTranscriptMd.visible, true);
  assert.equal(interviewTranscriptMd.label, 'Interview Transcript (.md)');
});
