import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Model = require('../static/js/elearning-model.js');

test('detectBrowserLanguage honors query param, browser locales, and enabled fallback', () => {
  assert.equal(Model.detectBrowserLanguage(['nl', 'en', 'de'], 'nl', 'de', ['en-US']), 'de');
  assert.equal(Model.detectBrowserLanguage(['nl', 'en', 'de'], 'nl', '', ['de-DE', 'en-US']), 'de');
  assert.equal(Model.detectBrowserLanguage(['nl', 'en', 'de'], 'nl', '', ['nl-BE']), 'nl');
  assert.equal(Model.detectBrowserLanguage(['nl', 'en'], 'nl', '', ['de-DE', 'fr-FR']), 'nl');
  assert.equal(Model.detectBrowserLanguage(['nl', 'en'], 'nl', '', ['en-GB']), 'en');
});

test('parseVideoUrl handles YouTube watch, short, youtu.be, timestamps, Vimeo, and rejects unsafe URLs', () => {
  const yt1 = Model.parseVideoUrl('https://youtu.be/dQw4w9WgXcQ?t=1m15s');
  assert.equal(yt1.embedUrl, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  assert.equal(yt1.startSeconds, 75);

  const yt2 = Model.parseVideoUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ');
  assert.equal(yt2.embedUrl, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');

  const vm = Model.parseVideoUrl('https://vimeo.com/987654321');
  assert.equal(vm.embedUrl, 'https://player.vimeo.com/video/987654321');

  const bad = Model.parseVideoUrl('javascript:alert(1)');
  assert.equal(bad.embedUrl, '');
  assert.ok(bad.error);
});

test('buildEmbedSrc respects localized video overrides and timestamps', () => {
  const video = {
    embedUrl: 'https://www.youtube-nocookie.com/embed/aaaaaaaaaaa',
    startSeconds: 10,
    endSeconds: 95,
    mediaOverrides: {
      de: { embedUrl: 'https://www.youtube-nocookie.com/embed/bbbbbbbbbbb' },
    },
  };
  assert.equal(
    Model.buildEmbedSrc(video, 'nl'),
    'https://www.youtube-nocookie.com/embed/aaaaaaaaaaa?rel=0&modestbranding=1&start=10&end=95'
  );
  assert.equal(
    Model.buildEmbedSrc(video, 'de'),
    'https://www.youtube-nocookie.com/embed/bbbbbbbbbbb?rel=0&modestbranding=1&start=10&end=95'
  );
});

test('extractTranslationRows and stats report untranslated, translated, and needs_review accurately', () => {
  const exp = Model.createExpeditionPreset('showcase', 'xPED Pilot', 'nl');
  exp.startPage.title.de = 'xPED Pilot DE';
  exp.startPage.title._review = { de: true };
  const rows = Model.extractTranslationRows(exp, 'nl', 'de');
  const stats = Model.getTranslationStats(rows);
  assert.ok(stats.total > 5);
  assert.equal(stats.review, 1);
  assert.ok(stats.untranslated >= 1);
});


test('v3 station recipes, B1 readability coach, glossary, and media translation rows work cleanly', () => {
  const mod = Model.createModule('myth-buster', 0);
  assert.equal(mod.steps.length, 2);
  assert.equal(mod.steps[0].blocks[1].settings.revealAfterAnswer, true);

  const report = Model.analyzeStepReadability({
    title: Model.loc('Test stap', 'Test step', ''),
    blocks: [
      {
        type: 'richtext',
        data: {
          body: Model.loc(
            'Dit is een ontzettend lange zin met veel te veel woorden achter elkaar zodat de B1 leesbaarheidscoach direct een nuttige waarschuwing laat zien voor patiënten met vermoeidheid.',
            '',
            ''
          ),
        },
      },
    ],
  }, 'nl', 'nl');
  assert.equal(report.level, 'warn');
  assert.ok(report.tips.some((t) => t.kind === 'warn'));

  const exp = Model.createExpeditionPreset('showcase', 'xPEDitie Test', 'nl');
  assert.ok(Array.isArray(exp.glossary) && exp.glossary.length >= 4);
  assert.equal(exp.startPage.ctaLabel.nl, 'Start de xPEDitie');
  const rows = Model.extractTranslationRows(exp, 'nl', 'de');
  assert.ok(rows.some((r) => r.altSource && r.altLang === 'en'));
});

test('UX review model helpers: presets, DOI links, readable labels, nested checks, and answers', () => {
  const nlExp = Model.createExpeditionPreset('blank', 'Alleen Nederlands', 'nl');
  assert.equal(nlExp.startPage.title.nl, 'Alleen Nederlands');
  assert.equal(nlExp.startPage.title.en, '');
  assert.equal(nlExp.modules[0].domain, 'general');

  const mod = Model.createModule('ask-teach-reflect', 0);
  assert.equal(mod.steps[0].title.nl.startsWith('1.'), false);
  assert.equal(mod.steps[0].status, 'draft');

  const doi = Model.normalizeCitationLink('10.3174/ajnr.A4173');
  assert.equal(doi.url, 'https://doi.org/10.3174/ajnr.A4173');
  assert.equal(doi.host, 'doi.org');

  assert.equal(Model.hasMeaningfulAnswer(0), true);
  assert.equal(Model.hasMeaningfulAnswer(''), false);
  assert.equal(Model.hasMeaningfulAnswer({ ids: [], custom: [] }), false);
  assert.equal(Model.hasMeaningfulAnswer({ ids: ['s1'], custom: [] }), true);

  const showcase = Model.createExpeditionPreset('showcase', 'Demo', 'nl');
  const rows = Model.extractTranslationRows(showcase, 'nl', 'de');
  assert.equal(rows.some((r) => r.location.includes('balance_scale')), false);
  assert.equal(rows.some((r) => r.location.includes('overloadTip')), false);
  assert.ok(rows.some((r) => r.location.includes('Overload guidance')));

  const check = Model.analyzeStepReadability({
    title: Model.loc('Stap', 'Step', ''),
    blocks: [
      {
        id: 'blk_mcq',
        type: 'mcq',
        data: {
          question: Model.loc('Kies er een', '', ''),
          options: [
            { id: 'o1', label: Model.loc('Een heel lange antwoordoptie die veel meer dan tweeentwintig woorden bevat zodat de schrijfhulp ook geneste antwoordopties controleert voor patienten met weinig energie vandaag', '', '') },
          ],
        },
      },
      {
        id: 'blk_src',
        type: 'sources',
        data: {
          items: [{ id: 's1', citation: Model.loc('Brinjikji W et al. Systematic literature review of imaging features of spinal degeneration in asymptomatic populations AJNR 2015', '', '') }],
        },
      },
    ],
  }, 'nl', 'nl');
  assert.ok(check.writingChecks.some((c) => c.blockId === 'blk_mcq'));
  assert.ok(check.optionalWords > 0);
  assert.equal(check.tips.some((t) => /B1/.test(t.text)), false);
});
