const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const credits = require('../static/js/credit-utils.js');

const costs = {
  lecture_notes: { category: 'lecture', instant: 8, overnight: 4 },
  slides_extraction: { category: 'slides', instant: 2, overnight: 1 },
  interview_transcription: { category: 'interview', instant: 10, overnight: 5 },
  interview_extra: { category: 'slides', instant: 2, overnight: 1 },
  text_combine: { category: 'lecture', instant: 8, overnight: 4 },
  audio_transcription: { category: 'interview', instant: 10, overnight: 5 },
  tools_extraction: { category: 'slides', instant: 2, overnight: null },
  tools_transcription: { category: 'interview', instant: 10, overnight: null },
  voice_note: { category: 'interview', instant: 10, overnight: null },
  regenerate_study_tools: { category: 'slides', instant: 2, overnight: null },
  interview_coding: { category: 'slides', instant: 2, overnight: null }
};
function profile(overrides = {}) {
  return { uid: 'one', credits_version: 2, credits: 12, credit_costs: structuredClone(costs), ...overrides };
}
function snapshot(overrides = {}) { return credits.parseProfile(profile(overrides), 'one'); }

test('zero is a valid unified balance and public activation cannot downgrade it', () => {
  const account = snapshot({ credits: 0 });
  assert.equal(account.scheme, 2);
  assert.equal(account.balance, 0);
  assert.equal(credits.parsePublicConfig({ bundles: {} }).scheme, 1);
  assert.equal(credits.quote(account, [{ action: 'lecture_notes' }]).needed, 8);
  assert.equal(credits.quote(account, [{ action: 'lecture_notes' }]).sufficient, false);
});

test('legacy balances retain their original units without conversion', () => {
  const account = credits.parseProfile({ credits: {
    lecture_standard: 1, lecture_extended: 2, slides: 3,
    interview_short: 4, interview_medium: 5, interview_long: 6
  }});
  assert.deepEqual(account.categories, { lecture: 3, slides: 3, interview: 15 });
  assert.equal(account.balance, 21);
  assert.equal(credits.quote(account, [{ action: 'lecture_notes' }]), null);
});

test('malformed or ambiguous balances and foreign profile identities are rejected', () => {
  for (const value of [-1, 1.5, true, '12', null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(snapshot({ credits: value }), null);
  }
  assert.equal(snapshot({ uid: 'two' }), null);
  assert.equal(snapshot({ credits_version: 3 }), null);
  assert.equal(snapshot({ credits_version: undefined }), null);
  assert.equal(credits.parseProfile({ credits: { slides: 3 } }), null);
  assert.equal(snapshot({ uid: undefined }).balance, 12);
});

test('missing prices retain a known balance but cannot manufacture a zero quote', () => {
  const account = snapshot({ credit_costs: null });
  assert.equal(account.balance, 12);
  assert.equal(account.costs, null);
  assert.equal(credits.quote(account, [{ action: 'lecture_notes' }]), null);
});

for (const action of Object.keys(costs)) {
  test(`${action} quotes exact configured prices for one and three units`, () => {
    for (const units of [1, 3]) {
      for (const overnight of [false, true]) {
        const quote = credits.quote(snapshot({ credits: 100 }), [{ action, units }], { overnight });
        const rate = overnight && costs[action].overnight !== null ? costs[action].overnight : costs[action].instant;
        assert.equal(quote.needed, units * rate);
        assert.equal(quote.quoted, units * rate);
        assert.equal(quote.sufficient, true);
      }
    }
  });
}

test('mixed interview rows and category exemptions keep separate component charges', () => {
  const components = [
    { action: 'interview_transcription', units: 3 },
    { action: 'interview_extra', units: 3 }
  ];
  for (const overnight of [false, true]) {
    const factor = overnight ? 0.5 : 1;
    assert.equal(credits.quote(snapshot(), components, { overnight }).needed, 36 * factor);
    const interviewExempt = credits.quote(snapshot({ unlimited_credits: { interview: true } }), components, { overnight });
    assert.equal(interviewExempt.needed, 6 * factor);
    assert.equal(interviewExempt.quoted, 36 * factor);
    assert.equal(interviewExempt.available, 12);
    assert.equal(interviewExempt.components[0].exempt, true);
    assert.equal(interviewExempt.components[1].exempt, false);
    assert.equal(credits.quote(snapshot({ unlimited_credits: { slides: true } }), components, { overnight }).needed, 30 * factor);
    assert.equal(credits.quote(snapshot({ credits: 0, unlimited_credits: { slides: true, interview: true } }), components, { overnight }).sufficient, true);
  }
  assert.equal(credits.quote(snapshot({ unlimited_credits: { interview: 'true' } }), components).needed, 36);
});

test('a changed server table is used without modifying constants or source profiles', () => {
  const payload = profile();
  payload.credit_costs.interview_transcription = { category: 'interview', instant: 14, overnight: 7 };
  payload.credit_costs.interview_extra = { category: 'slides', instant: 4, overnight: 2 };
  const account = credits.parseProfile(payload);
  payload.credit_costs.interview_extra.instant = 100;
  assert.equal(credits.quote(account, [{ action: 'interview_transcription' }, { action: 'interview_extra', units: 2 }]).needed, 22);
  assert.equal(credits.quote(account, [{ action: 'interview_transcription' }, { action: 'interview_extra', units: 2 }], { overnight: true }).needed, 11);
});

test('invalid prices, unknown actions and unsafe arithmetic never become affordable quotes', () => {
  for (const rate of [-1, '8', 0.5, true, Number.MAX_SAFE_INTEGER + 1]) {
    const table = structuredClone(costs);
    table.lecture_notes.instant = rate;
    assert.equal(credits.quote(snapshot({ credit_costs: table }), [{ action: 'lecture_notes' }]), null);
  }
  for (const units of [-1, '2', 0.5, null, true, Number.MAX_SAFE_INTEGER]) {
    assert.equal(credits.quote(snapshot(), [{ action: 'lecture_notes', units }]), null);
  }
  assert.equal(credits.quote(snapshot(), [{ action: 'missing' }]), null);
  assert.equal(credits.quote(snapshot(), []), null);
  assert.equal(credits.quote(snapshot(), [{ action: 'interview_extra', units: 0 }]).needed, 0);
  const table = { free: { category: 'slides', instant: Number.MAX_SAFE_INTEGER, overnight: null } };
  assert.equal(credits.quote(snapshot({ credit_costs: table }), [{ action: 'free' }, { action: 'free' }]), null);
});

test('cache envelopes bind units to one user and reject old category or corrupt shapes', () => {
  const account = snapshot();
  const cached = credits.encodeCache('one', account, 1234);
  assert.deepEqual(credits.decodeCache(cached, 'one'), cached);
  assert.equal(credits.decodeCache(cached, 'two'), null);
  assert.equal(credits.decodeCache({ total: 12, textExtraction: 12 }, 'one'), null);
  assert.equal(credits.decodeCache({ ...cached, schema: 2 }, 'one'), null);
  assert.equal(credits.decodeCache({ ...cached, receivedAt: -1 }, 'one'), null);
  account.balance = 99;
  account.costs.lecture_notes.instant = 99;
  assert.equal(cached.snapshot.balance, 12);
  assert.equal(cached.snapshot.costs.lecture_notes.instant, 8);
  const read = credits.decodeCache(cached, 'one');
  read.snapshot.balance = 30;
  assert.equal(cached.snapshot.balance, 12);
  assert.equal(credits.decodeCache({ ...cached, snapshot: { scheme: 1, balance: 12, categories: { lecture: 1, slides: 2, interview: 3 } } }, 'one'), null);
});

test('public prices validate independently of authenticated account units', () => {
  assert.deepEqual(credits.parsePublicConfig({ credit_scheme: 2, action_costs: costs, free_signup_credits: 12 }), { scheme: 2, costs, freeSignupCredits: 12 });
  assert.equal(credits.parsePublicConfig({ credit_scheme: 3 }), null);
  assert.equal(credits.parsePublicConfig({}), null);
  assert.equal(credits.parsePublicConfig({ credit_scheme: 2, free_signup_credits: '12' }).freeSignupCredits, null);
});

test('credit and rejection copy distinguish singular, plural and invalid amounts', () => {
  assert.equal(credits.formatCredits(1), '1 credit');
  assert.equal(credits.formatCredits(1200), '1,200 credits');
  assert.equal(credits.formatCredits('1'), '');
  assert.equal(credits.formatInsufficient({ needed: 1, available: 0 }), 'Not enough credits. This needs 1 credit; 0 are available.');
  assert.equal(credits.formatInsufficient({ needed: '1', available: 0 }), null);
});

test('live language changes format balances and rejection amounts in the page locale', () => {
  const context = { localStorage: { getItem: () => '{}' } };
  context.window = context;
  vm.createContext(context);
  for (const file of ['i18n-catalog.js', 'i18n-supplement.js', 'i18n-dynamic.js', 'i18n-dynamic-learning.js', 'i18n-dynamic-tools.js', 'i18n.js', 'credit-utils.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/js', file), 'utf8'), context);
  }
  const helper = context.LectureProcessorCreditUtils;
  assert.equal(helper.formatCredits(1200), '1,200 credits');
  context.LectureI18n.setLanguage('nl');
  assert.equal(helper.formatCredits(1200), '1.200 credits');
  assert.equal(helper.formatInsufficient({ needed: 1, available: 0 }), 'Niet genoeg credits. Nodig: 1 credit; beschikbaar: 0.');
  context.LectureI18n.setLanguage('en');
  assert.equal(helper.formatInsufficient({ needed: 14, available: 12 }), 'Not enough credits. This needs 14 credits; 12 are available.');
});
