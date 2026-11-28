// Platform bindings for expeditions published on Lecture Processor.
(function (root) {
  'use strict';
  const host = {
    get auth() { return root.LectureProcessorAuth; },
    get bootstrap() { return root.LectureProcessorBootstrap; },
    get ux() { return root.LectureProcessorUx; },
    get i18n() { return root.LectureI18n; },
    siteTitle: 'Lecture Processor',
    coursePaths(id) {
      const base = '/physio/elearning/' + encodeURIComponent(id);
      return { overview: base + '/edit', edit: base + '/edit', report: base + '/responses' };
    },
    learnerPath(token) { return '/elearning/p/' + encodeURIComponent(token); },
    translatorPath(token) { return '/elearning/translate/' + encodeURIComponent(token); },
  };
  if (typeof module === 'object' && module.exports) module.exports = host;
  else root.ElearningHost = host;
})(typeof window !== 'undefined' ? window : globalThis);
