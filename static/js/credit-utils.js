(function (root) {
  'use strict';

  var categories = ['lecture', 'slides', 'interview'];
  var legacyFields = ['lecture_standard', 'lecture_extended', 'slides', 'interview_short', 'interview_medium', 'interview_long'];
  function record(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
  function units(value) { return Number.isSafeInteger(value) && value >= 0; }
  function exemptions(value) {
    var source = record(value) ? value : {};
    return { lecture: source.lecture === true, slides: source.slides === true, interview: source.interview === true };
  }
  function parseCosts(value) {
    if (!record(value)) return null;
    var names = Object.keys(value);
    if (!names.length) return null;
    var result = {};
    for (var name of names) {
      var cost = value[name];
      if (!/^[a-z][a-z_]*$/.test(name) || !record(cost) || !categories.includes(cost.category)
        || !units(cost.instant) || !(cost.overnight === null || units(cost.overnight))) return null;
      result[name] = { category: cost.category, instant: cost.instant, overnight: cost.overnight };
    }
    return result;
  }
  function parseProfile(payload, expectedUid) {
    if (!record(payload)) return null;
    if (expectedUid && payload.uid != null && payload.uid !== expectedUid) return null;
    var credits = payload.credits;
    var unlimited = exemptions(payload.unlimited_credits || (record(credits) ? credits.unlimited : null));
    if (payload.credits_version === 2) {
      if (!units(credits)) return null;
      return { scheme: 2, balance: credits, categories: null, unlimited: unlimited, costs: parseCosts(payload.credit_costs) };
    }
    if (payload.credits_version != null && payload.credits_version !== 1) return null;
    if (!record(credits) || !legacyFields.every(function (field) { return units(credits[field]); })) return null;
    var balances = {
      lecture: credits.lecture_standard + credits.lecture_extended,
      slides: credits.slides,
      interview: credits.interview_short + credits.interview_medium + credits.interview_long
    };
    var total = balances.lecture + balances.slides + balances.interview;
    if (!units(total)) return null;
    return { scheme: 1, balance: total, categories: balances, unlimited: unlimited, costs: null };
  }
  function parsePublicConfig(payload) {
    if (!record(payload)) return null;
    if (payload.credit_scheme === 2) {
      return {
        scheme: 2, costs: parseCosts(payload.action_costs),
        freeSignupCredits: units(payload.free_signup_credits) ? payload.free_signup_credits : null
      };
    }
    if ((payload.credit_scheme != null && payload.credit_scheme !== 1) || !record(payload.bundles)) return null;
    return { scheme: 1, costs: null, freeSignupCredits: null };
  }
  function cloneSnapshot(value) {
    if (!record(value) || !units(value.balance)) return null;
    var unlimited = exemptions(value.unlimited);
    if (value.scheme === 2 && value.categories === null) {
      return { scheme: 2, balance: value.balance, categories: null, unlimited: unlimited, costs: parseCosts(value.costs) };
    }
    if (value.scheme !== 1 || !record(value.categories)) return null;
    var balances = {};
    var total = 0;
    for (var category of categories) {
      if (!units(value.categories[category])) return null;
      balances[category] = value.categories[category];
      total += balances[category];
    }
    if (!units(total) || total !== value.balance) return null;
    return { scheme: 1, balance: total, categories: balances, unlimited: unlimited, costs: null };
  }
  function quote(snapshot, components, options) {
    var current = cloneSnapshot(snapshot);
    if (!current || current.scheme !== 2 || !current.costs || !Array.isArray(components) || !components.length) return null;
    var quoted = 0;
    var needed = 0;
    var detail = [];
    for (var component of components) {
      if (!record(component) || typeof component.action !== 'string'
        || !Object.prototype.hasOwnProperty.call(current.costs, component.action)) return null;
      var count = component.units === undefined ? 1 : component.units;
      if (!units(count)) return null;
      var cost = current.costs[component.action];
      var rate = options && options.overnight === true && cost.overnight !== null ? cost.overnight : cost.instant;
      var amount = rate * count;
      var exempt = current.unlimited[cost.category] === true;
      var charged = exempt ? 0 : amount;
      if (!units(amount) || !units(quoted + amount) || !units(needed + charged)) return null;
      quoted += amount;
      needed += charged;
      detail.push({ action: component.action, category: cost.category, unitCost: rate, units: count, quoted: amount, charged: charged, exempt: exempt });
    }
    return { quoted: quoted, needed: needed, available: current.balance, sufficient: current.balance >= needed, components: detail };
  }
  function encodeCache(uid, snapshot, receivedAt) {
    var current = cloneSnapshot(snapshot);
    if (typeof uid !== 'string' || !uid || !units(receivedAt) || !current) return null;
    return { schema: 1, uid: uid, receivedAt: receivedAt, snapshot: current };
  }
  function decodeCache(value, expectedUid) {
    if (!record(value) || value.schema !== 1 || typeof expectedUid !== 'string' || !expectedUid || value.uid !== expectedUid) return null;
    return encodeCache(value.uid, value.snapshot, value.receivedAt);
  }
  function locale() {
    if (root.LectureI18n && typeof root.LectureI18n.locale === 'function') return root.LectureI18n.locale();
    return root.document && root.document.documentElement.lang === 'nl' ? 'nl-NL' : 'en-GB';
  }
  function number(value) { return new Intl.NumberFormat(locale(), { maximumFractionDigits: 0 }).format(value); }
  function translate(key, params) {
    var result = root.LectureI18n && typeof root.LectureI18n.t === 'function' ? root.LectureI18n.t(key, params) : key;
    Object.keys(params).forEach(function (name) { result = result.replaceAll('{' + name + '}', String(params[name])); });
    return result;
  }
  function formatCredits(amount) {
    if (!units(amount)) return '';
    return translate(amount === 1 ? '{count} credit' : '{count} credits', { count: number(amount) });
  }
  function formatInsufficient(payload) {
    if (!record(payload) || !units(payload.needed) || !units(payload.available)) return null;
    return translate('Not enough credits. This needs {needed}; {available} are available.', {
      needed: formatCredits(payload.needed), available: number(payload.available)
    });
  }
  var api = {
    parseProfile: parseProfile, parsePublicConfig: parsePublicConfig, quote: quote,
    encodeCache: encodeCache, decodeCache: decodeCache,
    formatCredits: formatCredits, formatInsufficient: formatInsufficient
  };
  root.LectureProcessorCreditUtils = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
