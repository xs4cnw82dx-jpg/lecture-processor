(function (root) {
  'use strict';

  var SUPPORTED_LANGS = ['nl', 'en', 'de'];

  var LANG_LABELS = {
    nl: 'Nederlands (NL)',
    en: 'English (EN)',
    de: 'Deutsch (DE)',
  };

  var DOMAIN_LABELS = {
    bio: { nl: 'Biologisch', en: 'Biological', de: 'Biologisch' },
    psycho: { nl: 'Psychologisch', en: 'Psychological', de: 'Psychologisch' },
    social: { nl: 'Sociaal', en: 'Social', de: 'Sozial' },
    general: { nl: 'Algemeen', en: 'General', de: 'Allgemein' },
  };

  var UI_STRINGS = {
    nl: {
      courseHighlights: 'Wat je kunt verwachten',
      answerPrivacy: 'Over je antwoorden',
      reflectionAccess: 'De makers van deze cursus kunnen je reflectie lezen.',
      authorAccess: 'De makers ontvangen je voortgang en antwoorden, ook ingevulde tekst, onder een sessiecode.',
      deviceResume: 'Dit apparaat bewaart je antwoorden zodat je later verder kunt gaan.',
      sharedResults: 'Bij vragen met gedeelde resultaten kunnen anderen groepsuitkomsten zien.',
      sharedWords: 'Woorden die je aan een gedeelde woordenwolk toevoegt, zijn voor andere deelnemers zichtbaar.',
      progress: 'Voortgang',
      station: 'station',
      returnHome: 'Terug naar startpagina',
      smallText: 'Kleinere tekst',
      defaultText: 'Standaardtekst',
      largeText: 'Grotere tekst',
      language: 'Taal',
      close: 'Sluiten',
      feedbackFailed: 'Versturen is niet gelukt. Probeer het opnieuw.',
      storageUnavailable: 'Je browser kan de voortgang op dit apparaat niet bewaren.',
      unavailable: 'Deze xPEDitie is niet beschikbaar',
      retry: 'Opnieuw proberen',
      startExpedition: 'Start de xPEDitie',
      continueExpedition: 'Verder met je xPEDitie',
      routeTitle: 'Jouw xPEDitieroute',
      routeButton: 'Route',
      minutes: 'min',
      stations: 'stations',
      stepOf: 'Stap {cur} van {total}',
      back: 'Vorige',
      next: 'Volgende',
      finish: 'Afronden & samenvatting',
      myth: 'Fabel',
      fact: 'Feit',
      rightLead: 'Klopt helemaal',
      wrongMythLead: 'Veel mensen denken dit — zo zit het eigenlijk',
      yourAnswer: 'Jouw keuze',
      peerResults: 'Zo antwoordden anderen (anoniem)',
      responsesCount: '{n} reacties',
      addWordPlaceholder: 'Typ een woord en druk op Enter…',
      addWordBtn: 'Toevoegen',
      load: 'Draaglast',
      resource: 'Draagkracht',
      bio: 'Biologisch',
      psycho: 'Psychologisch',
      social: 'Sociaal',
      customGoalPlaceholder: 'Of voeg je eigen kleine stap toe…',
      addGoal: 'Toevoegen',
      sourcesDefault: 'Wetenschappelijke bronnen & meer lezen',
      transcriptDefault: 'Bekijk samenvatting / transcript',
      savedAutomatically: 'Je voortgang wordt automatisch op dit apparaat bewaard — je kunt gerust pauzeren.',
      milestoneTitle: 'Station afgerond!',
      milestoneNext: 'Door naar het volgende station',
      milestoneNextPreview: 'Volgende: {title} (~{min} min)',
      milestonePause: 'Even pauzeren · terug naar route',
      summaryTitle: 'Jouw persoonlijke xPEDitie-samenvatting',
      summarySubtitle: 'Bewaar of print jouw balans, inzichten en mini-plan (ook handig voor bij je fysiotherapeut).',
      printSummary: 'Print / Bewaar als PDF',
      restart: 'Terug naar startpagina',
      replayFresh: 'Opnieuw beginnen',
      myReflections: 'Mijn reflecties',
      myMiniPlan: 'Mijn kleine stappen',
      myBalance: 'Mijn Draagkracht & Draaglast',
      myInsights: 'Belangrijkste inzichten',
      readingComfort: 'Leescomfort',
      textSize: 'Tekstgrootte',
      themeMode: 'Weergave',
      themeWarm: 'Warm zand',
      themeContrast: 'Hoog contrast',
      stepCommentBtn: 'Opmerking bij deze stap',
      stepCommentTitle: 'Review-opmerking voor deze stap',
      stepCommentPlaceholder: 'Bijv. tekst duidelijker maken, medische nuance of ontwerp-tip…',
      stepCommentSend: 'Opmerking opslaan',
      stepCommentSent: 'Opmerking opgeslagen bij deze stap!',
      revealHint: 'Beantwoord de vraag hierboven om het vervolg te zien.',
      pilotTitle: 'Help ons verbeteren (korte testfeedback)',
      pilotClarity: 'Hoe duidelijk vond je deze module? (1–5)',
      pilotEngagement: 'Hoe prettig en betrokken voelde de vormgeving? (1–5)',
      pilotComment: 'Wat viel op of kan nog beter?',
      pilotSubmit: 'Verstuur feedback',
      pilotThanks: 'Bedankt! Je feedback helpt ons onderzoek enorm.',
      pausedFallback: 'Deze module is tijdelijk gepauzeerd.',
      notFound: 'Deze link bestaat niet of is niet meer actief.',
      hotspotListLabel: 'Kies een punt om te bekijken:',
      up: 'Omhoog',
      down: 'Omlaag',
    },
    en: {
      courseHighlights: 'What to expect',
      answerPrivacy: 'About your answers',
      reflectionAccess: 'Course authors can read your reflection.',
      authorAccess: 'Course authors receive your progress and answers, including written responses, under a session ID.',
      deviceResume: 'This device stores your answers so you can return later.',
      sharedResults: 'Other learners can see group results for questions where sharing is enabled.',
      sharedWords: 'Words you add to a shared word cloud are visible to other learners.',
      progress: 'Progress',
      station: 'station',
      returnHome: 'Return to the start page',
      smallText: 'Smaller text',
      defaultText: 'Default text',
      largeText: 'Larger text',
      language: 'Language',
      close: 'Close',
      feedbackFailed: 'Feedback could not be sent. Please try again.',
      storageUnavailable: 'Your browser cannot save progress on this device.',
      unavailable: 'This expedition is unavailable',
      retry: 'Try again',
      startExpedition: 'Start the xPEDitie',
      continueExpedition: 'Continue your xPEDitie',
      routeTitle: 'Your xPEDitie route',
      routeButton: 'Route',
      minutes: 'min',
      stations: 'stations',
      stepOf: 'Step {cur} of {total}',
      back: 'Back',
      next: 'Next',
      finish: 'Finish & summary',
      myth: 'Myth',
      fact: 'Fact',
      rightLead: 'Spot on',
      wrongMythLead: 'Many people think this — here is how it actually works',
      yourAnswer: 'Your choice',
      peerResults: 'How others answered (anonymous)',
      responsesCount: '{n} responses',
      addWordPlaceholder: 'Type a word and press Enter…',
      addWordBtn: 'Add',
      load: 'Load',
      resource: 'Resources',
      bio: 'Biological',
      psycho: 'Psychological',
      social: 'Social',
      customGoalPlaceholder: 'Or add your own small step…',
      addGoal: 'Add',
      sourcesDefault: 'Scientific sources & further reading',
      transcriptDefault: 'View video summary / transcript',
      savedAutomatically: 'Your progress is saved automatically on this device — feel free to take a break.',
      milestoneTitle: 'Station completed!',
      milestoneNext: 'Continue to next station',
      milestoneNextPreview: 'Up next: {title} (~{min} min)',
      milestonePause: 'Take a break · back to route',
      summaryTitle: 'Your personal xPEDitie summary',
      summarySubtitle: 'Save or print your balance, insights, and mini-plan (helpful to share with your physio).',
      printSummary: 'Print / Save as PDF',
      restart: 'Return to start page',
      replayFresh: 'Start over',
      myReflections: 'My reflections',
      myMiniPlan: 'My small steps',
      myBalance: 'My Load & Resources Balance',
      myInsights: 'Key takeaways',
      readingComfort: 'Reading comfort',
      textSize: 'Text size',
      themeMode: 'Appearance',
      themeWarm: 'Warm sand',
      themeContrast: 'High contrast',
      stepCommentBtn: 'Comment on this step',
      stepCommentTitle: 'Reviewer note for this step',
      stepCommentPlaceholder: 'E.g. wording nuance, clinical note, or layout feedback…',
      stepCommentSend: 'Save note',
      stepCommentSent: 'Note saved for this step!',
      revealHint: 'Answer the question above to reveal the takeaway.',
      pilotTitle: 'Help us improve (quick pilot feedback)',
      pilotClarity: 'How clear was this module? (1–5)',
      pilotEngagement: 'How engaging did the design feel? (1–5)',
      pilotComment: 'What stood out or could be improved?',
      pilotSubmit: 'Submit feedback',
      pilotThanks: 'Thank you! Your feedback directly helps our thesis research.',
      pausedFallback: 'This module is temporarily paused.',
      notFound: 'This link could not be found or is no longer active.',
      hotspotListLabel: 'Select a point to explore:',
      up: 'Up',
      down: 'Down',
    },
    de: {
      courseHighlights: 'Was dich erwartet',
      answerPrivacy: 'Über deine Antworten',
      reflectionAccess: 'Die Kursverantwortlichen können deine Reflexion lesen.',
      authorAccess: 'Die Kursverantwortlichen erhalten deinen Fortschritt und deine Antworten einschließlich eigener Texte unter einer Sitzungskennung.',
      deviceResume: 'Deine Antworten werden auf diesem Gerät gespeichert, damit du später weitermachen kannst.',
      sharedResults: 'Bei Fragen mit freigegebenen Ergebnissen können andere Teilnehmende Gruppenergebnisse sehen.',
      sharedWords: 'Wörter, die du zu einer geteilten Wortwolke hinzufügst, sind für andere Teilnehmende sichtbar.',
      progress: 'Fortschritt',
      station: 'Station',
      returnHome: 'Zur Startseite',
      smallText: 'Kleinere Schrift',
      defaultText: 'Standardschrift',
      largeText: 'Größere Schrift',
      language: 'Sprache',
      close: 'Schließen',
      feedbackFailed: 'Das Feedback konnte nicht gesendet werden. Bitte erneut versuchen.',
      storageUnavailable: 'Dieser Browser kann den Fortschritt auf diesem Gerät nicht speichern.',
      unavailable: 'Diese Expedition ist nicht verfügbar',
      retry: 'Erneut versuchen',
      startExpedition: 'xPEDition starten',
      continueExpedition: 'xPEDition fortsetzen',
      routeTitle: 'Deine xPEDitionsroute',
      routeButton: 'Route',
      minutes: 'Min.',
      stations: 'Stationen',
      stepOf: 'Schritt {cur} von {total}',
      back: 'Zurück',
      next: 'Weiter',
      finish: 'Abschließen & Übersicht',
      myth: 'Mythos',
      fact: 'Fakt',
      rightLead: 'Genau richtig',
      wrongMythLead: 'Viele Menschen denken das — so funktioniert es wirklich',
      yourAnswer: 'Deine Wahl',
      peerResults: 'So haben andere geantwortet (anonym)',
      responsesCount: '{n} Antworten',
      addWordPlaceholder: 'Wort eingeben und Enter drücken…',
      addWordBtn: 'Hinzufügen',
      load: 'Belastung',
      resource: 'Ressourcen',
      bio: 'Biologisch',
      psycho: 'Psychologisch',
      social: 'Sozial',
      customGoalPlaceholder: 'Oder eigenen kleinen Schritt hinzufügen…',
      addGoal: 'Hinzufügen',
      sourcesDefault: 'Wissenschaftliche Quellen & weiterlesen',
      transcriptDefault: 'Zusammenfassung / Transkript anzeigen',
      savedAutomatically: 'Dein Fortschritt wird automatisch auf diesem Gerät gespeichert — mach gerne eine Pause.',
      milestoneTitle: 'Station abgeschlossen!',
      milestoneNext: 'Weiter zur nächsten Station',
      milestoneNextPreview: 'Als Nächstes: {title} (~{min} Min.)',
      milestonePause: 'Kurze Pause · zurück zur Route',
      summaryTitle: 'Deine persönliche xPEDitions-Übersicht',
      summarySubtitle: 'Speichere oder drucke deine Balance, Erkenntnisse und deinen Mini-Plan.',
      printSummary: 'Drucken / Als PDF speichern',
      restart: 'Zur Startseite',
      replayFresh: 'Neu starten',
      myReflections: 'Meine Reflexionen',
      myMiniPlan: 'Meine kleinen Schritte',
      myBalance: 'Meine Belastungs-Balance',
      myInsights: 'Wichtigste Erkenntnisse',
      readingComfort: 'Lesekomfort',
      textSize: 'Textgröße',
      themeMode: 'Ansicht',
      themeWarm: 'Warmer Sand',
      themeContrast: 'Hoher Kontrast',
      stepCommentBtn: 'Kommentar zu diesem Schritt',
      stepCommentTitle: 'Review-Notiz für diesen Schritt',
      stepCommentPlaceholder: 'Z.B. Formulierung, fachlicher Hinweis oder Design-Feedback…',
      stepCommentSend: 'Notiz speichern',
      stepCommentSent: 'Notiz für diesen Schritt gespeichert!',
      revealHint: 'Beantworte zuerst die Frage oben, um die Erklärung zu sehen.',
      pilotTitle: 'Hilf uns zu verbessern (kurzes Test-Feedback)',
      pilotClarity: 'Wie verständlich war dieses Modul? (1–5)',
      pilotEngagement: 'Wie ansprechend fandest du das Design? (1–5)',
      pilotComment: 'Was hat dir gefallen oder kann verbessert werden?',
      pilotSubmit: 'Feedback senden',
      pilotThanks: 'Vielen Dank! Dein Feedback hilft unserer Forschung sehr.',
      pausedFallback: 'Dieses Modul ist vorübergehend pausiert.',
      notFound: 'Dieser Link wurde nicht gefunden oder ist nicht mehr aktiv.',
      hotspotListLabel: 'Wähle einen Punkt zum Entdecken:',
      up: 'Hoch',
      down: 'Runter',
    },
  };

  var DEFAULT_GLOSSARY = [
    { id: 'gls_xped', nl: 'xPEDitie Pijn', en: 'xPEDitie Pain', de: 'xPEDition Schmerz' },
    { id: 'gls_load', nl: 'Draaglast', en: 'Load', de: 'Belastung' },
    { id: 'gls_res', nl: 'Draagkracht', en: 'Resources', de: 'Belastbarkeit / Ressourcen' },
    { id: 'gls_nerve', nl: 'Zenuwstelsel', en: 'Nervous system', de: 'Nervensystem' },
    { id: 'gls_alarm', nl: 'Alarmsysteem', en: 'Alarm system', de: 'Alarmsystem' },
  ];

  var XPED_ASSETS = [
    { id: 'wandelaar-kaart', label: 'Expeditie kaart', path: '/static/images/xped/xped-wandelaar-met-kaart.png' },
    { id: 'jan', label: 'Jan', path: '/static/images/xped/xped-jan.png' },
    { id: 'inge', label: 'Inge', path: '/static/images/xped/xped-inge.png' },
    { id: 'esther', label: 'Esther', path: '/static/images/xped/xped-esther.png' },
    { id: 'arts', label: 'Arts & patiënt', path: '/static/images/xped/xped-arts.png' },
    { id: 'wandelen', label: 'Wandelen', path: '/static/images/xped/xped-wandelen.png' },
    { id: 'brein-mascotte', label: 'Brein mascotte', path: '/static/images/xped/xped-brein-mascotte-met-gloeilamp.png' },
    { id: 'icon-brein', label: 'Icon: Brein', path: '/static/images/xped/icon-brein.png' },
    { id: 'icon-lamp', label: 'Icon: Inzicht', path: '/static/images/xped/icon-lamp.png' },
    { id: 'icon-sociaal', label: 'Icon: Sociaal', path: '/static/images/xped/icon-sociaal.png' },
    { id: 'icon-voetstappen', label: 'Icon: Stappen', path: '/static/images/xped/icon-voetstappen.png' },
    { id: 'logo-nl', label: 'xPED Logo', path: '/static/images/xped/logo_nl.svg' },
  ];

  var BLOCK_CATALOG = [
    { type: 'richtext', category: 'content', label: 'Heading & Text', desc: 'Clean readable explanation or story section.' },
    { type: 'video', category: 'content', label: 'YouTube / Vimeo Video', desc: 'Privacy-friendly embed with optional start/end timestamps.' },
    { type: 'image', category: 'content', label: 'Image & Visual', desc: 'Upload photo or pick an official xPED illustration.' },
    { type: 'audio', category: 'content', label: 'Audio Exercise', desc: 'Breathing, pacing, or spoken explanation player.' },
    { type: 'callout', category: 'content', label: 'Key Takeaway', desc: 'Bio / Psycho / Social / Tip highlight card.' },
    { type: 'story', category: 'content', label: 'Patient / Expert Story', desc: 'Authentic quote card with optional portrait.' },
    { type: 'sources', category: 'content', label: 'Scientific Sources', desc: 'Collapsible academic references drawer.' },
    { type: 'mcq', category: 'interactive', label: 'Multiple Choice / Poll', desc: 'Single or multi-select with optional peer stats & feedback.' },
    { type: 'myth_fact', category: 'interactive', label: 'Myth vs. Fact', desc: 'Modern accessible Feit of Fabel reveal card.' },
    { type: 'scale', category: 'interactive', label: 'Confidence Slider', desc: 'Mentimeter-style 0–10 belief or readiness scale.' },
    { type: 'reflection', category: 'interactive', label: 'Open Reflection', desc: 'Written response that course authors can read.' },
    { type: 'wordcloud', category: 'interactive', label: 'Word Cloud', desc: 'Quick 1–3 word associations with optional peer cloud.' },
    { type: 'ranking', category: 'interactive', label: 'Priority Ranking', desc: 'Order personal values, activities, or coping tips.' },
    { type: 'hotspot', category: 'interactive', label: 'Pin on Image', desc: 'Interactive diagram hotspots with text fallback.' },
    { type: 'balance_scale', category: 'xped', label: 'Balance Scale (Waage)', desc: 'Modernized Draagkracht vs. Draaglast interactive scale.' },
    { type: 'bps_triad', category: 'xped', label: 'Biopsychosocial Triad', desc: 'Interactive Bio · Psycho · Sociaal explorer.' },
    { type: 'mini_plan', category: 'xped', label: 'Personal Mini-Plan', desc: 'Action chip selector compiled into printable summary.' },
    { type: 'custom_visual', category: 'xped', label: 'Custom SVG / Animation Slot', desc: 'Reserve a stage for a coding agent SVG/animation or pick a built-in pain animation.' },
  ];

  function uid(prefix) {
    return (prefix || 'el') + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  function loc(nl, en, de) {
    return { nl: nl || '', en: en || '', de: de || '' };
  }

  function getLocalized(map, lang, fallbackLang) {
    if (typeof map === 'string') return map;
    if (!map || typeof map !== 'object') return '';
    var primary = String(map[lang] || '').trim();
    if (primary) return map[lang];
    var fb = fallbackLang || 'nl';
    if (String(map[fb] || '').trim()) return map[fb];
    for (var i = 0; i < SUPPORTED_LANGS.length; i += 1) {
      var candidate = map[SUPPORTED_LANGS[i]];
      if (String(candidate || '').trim()) return candidate;
    }
    return '';
  }

  function bindEditableText(node, placeholder, editable, onInput) {
    if (!editable) return node;
    node.contentEditable = 'plaintext-only';
    node.spellcheck = true;
    node.classList.add('el-inline-edit');
    node.setAttribute('data-placeholder', placeholder || '');
    node.addEventListener('input', function () {
      // Browsers can represent a pasted or inserted line break with <br> or
      // a block. Read its visible separators without replacing the active DOM.
      var text = node.childElementCount ? node.innerText : node.textContent;
      onInput(text === '\n' && !node.textContent ? '' : text);
    });
    return node;
  }

  function setLocalized(map, lang, value) {
    var out = (map && typeof map === 'object') ? Object.assign({ nl: '', en: '', de: '' }, map) : { nl: '', en: '', de: '' };
    out[lang] = String(value || '');
    return out;
  }

  function ui(lang, key, vars) {
    var dict = UI_STRINGS[lang] || UI_STRINGS.nl;
    var text = dict[key] || UI_STRINGS.en[key] || key;
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        text = text.replace('{' + k + '}', String(vars[k]));
      });
    }
    return text;
  }

  function detectBrowserLanguage(enabledLanguages, defaultLang, queryLang, navigatorLangs) {
    var enabled = (Array.isArray(enabledLanguages) && enabledLanguages.length) ? enabledLanguages : SUPPORTED_LANGS;
    var fallback = enabled.indexOf(defaultLang) >= 0 ? defaultLang : enabled[0];
    function match(raw) {
      var low = String(raw || '').trim().toLowerCase();
      if (!low) return '';
      if (enabled.indexOf(low) >= 0) return low;
      var shortCode = low.split(/[-_]/)[0];
      return enabled.indexOf(shortCode) >= 0 ? shortCode : '';
    }
    if (queryLang) {
      var qMatch = match(queryLang);
      if (qMatch) return qMatch;
    }
    var list = Array.isArray(navigatorLangs) ? navigatorLangs : [];
    for (var i = 0; i < list.length; i += 1) {
      var m = match(list[i]);
      if (m) return m;
    }
    return fallback;
  }

  function parseTimestampSeconds(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      var n = Math.floor(raw);
      return (n >= 0 && n <= 86400) ? n : null;
    }
    var text = String(raw).trim().toLowerCase();
    if (!text) return null;
    if (/^\d+$/.test(text)) {
      var secs = parseInt(text, 10);
      return (secs >= 0 && secs <= 86400) ? secs : null;
    }
    var hms = text.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
    if (hms && (hms[1] || hms[2] || hms[3])) {
      var total = (parseInt(hms[1] || '0', 10) * 3600) + (parseInt(hms[2] || '0', 10) * 60) + parseInt(hms[3] || '0', 10);
      return (total >= 0 && total <= 86400) ? total : null;
    }
    var colon = text.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
    if (colon) {
      var t = colon[3] !== undefined
        ? (parseInt(colon[1], 10) * 3600) + (parseInt(colon[2], 10) * 60) + parseInt(colon[3], 10)
        : (parseInt(colon[1], 10) * 60) + parseInt(colon[2], 10);
      return (t >= 0 && t <= 86400) ? t : null;
    }
    return null;
  }

  function parseVideoUrl(rawUrl) {
    var url = String(rawUrl || '').trim();
    if (!url) return { provider: '', videoId: '', embedUrl: '', startSeconds: null };
    var parsed;
    try {
      parsed = new URL(url);
    } catch (_err) {
      return { provider: '', videoId: '', embedUrl: '', startSeconds: null, error: 'Invalid URL' };
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { provider: '', videoId: '', embedUrl: '', startSeconds: null, error: 'Unsupported protocol' };
    }
    var host = parsed.hostname.toLowerCase();
    var startHint = parseTimestampSeconds(parsed.searchParams.get('t') || parsed.searchParams.get('start'));
    var provider = '';
    var videoId = '';
    if (host === 'youtu.be' || host === 'www.youtu.be') {
      var candidate = parsed.pathname.replace(/^\/+/, '').split('/')[0];
      if (/^[a-zA-Z0-9_-]{11}$/.test(candidate)) {
        provider = 'youtube';
        videoId = candidate;
      }
    } else if (/^(?:www\.|m\.)?youtube(?:-nocookie)?\.com$/.test(host)) {
      var yt = '';
      if (parsed.pathname.indexOf('/watch') === 0) {
        yt = parsed.searchParams.get('v') || '';
      } else {
        var segs = parsed.pathname.replace(/^\/+/, '').split('/');
        if (['embed', 'shorts', 'live'].indexOf(segs[0]) >= 0) yt = segs[1] || '';
      }
      if (/^[a-zA-Z0-9_-]{11}$/.test(yt)) {
        provider = 'youtube';
        videoId = yt;
      }
    } else if (/^(?:www\.|player\.)?vimeo\.com$/.test(host)) {
      var vSegs = parsed.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
      var last = vSegs[vSegs.length - 1] || '';
      if (/^\d{5,15}$/.test(last)) {
        provider = 'vimeo';
        videoId = last;
      }
    }
    if (!provider || !videoId) {
      return { provider: '', videoId: '', embedUrl: '', startSeconds: null, error: 'Unsupported video link' };
    }
    var embedUrl = provider === 'youtube'
      ? ('https://www.youtube-nocookie.com/embed/' + videoId)
      : ('https://player.vimeo.com/video/' + videoId);
    return { provider: provider, videoId: videoId, embedUrl: embedUrl, startSeconds: startHint };
  }

  function buildEmbedSrc(videoData, lang) {
    if (!videoData) return '';
    var override = videoData.mediaOverrides && videoData.mediaOverrides[lang];
    var base = (override && override.embedUrl) || videoData.embedUrl || '';
    if (!base) return '';
    if (base.indexOf('youtube-nocookie.com') >= 0) {
      var params = ['rel=0', 'modestbranding=1'];
      if (videoData.startSeconds !== null && videoData.startSeconds !== undefined) {
        params.push('start=' + parseInt(videoData.startSeconds, 10));
      }
      if (videoData.endSeconds !== null && videoData.endSeconds !== undefined) {
        params.push('end=' + parseInt(videoData.endSeconds, 10));
      }
      return base + '?' + params.join('&');
    }
    return base;
  }

  function resolveMediaUrl(mediaRef, overrides, lang, assetUrlBuilder) {
    var chosen = (overrides && overrides[lang] && overrides[lang].kind !== 'none') ? overrides[lang] : mediaRef;
    if (!chosen || chosen.kind === 'none') return '';
    if (chosen.kind === 'xped') return chosen.staticPath || '';
    if (chosen.kind === 'asset' && chosen.assetId && typeof assetUrlBuilder === 'function') {
      return assetUrlBuilder(chosen.assetId);
    }
    return '';
  }

  function createBlock(type) {
    var id = uid('blk');
    var settings = {
      required: false,
      showPeerResults: type === 'mcq' || type === 'scale' || type === 'wordcloud',
      allowMultiple: false,
      saveToSummary: type === 'reflection' || type === 'balance_scale' || type === 'mini_plan',
    };
    var data = {};
    if (type === 'richtext') {
      data = { heading: loc('', '', ''), body: loc('', '', '') };
    } else if (type === 'video') {
      data = { title: loc('', '', ''), url: '', provider: '', videoId: '', embedUrl: '', startSeconds: null, endSeconds: null, caption: loc('', '', ''), transcript: loc('', '', ''), mediaOverrides: {} };
    } else if (type === 'image') {
      data = { media: { kind: 'none', assetId: '', staticPath: '' }, layout: 'full', alt: loc('', '', ''), caption: loc('', '', ''), sideHeading: loc('', '', ''), sideBody: loc('', '', ''), mediaOverrides: {} };
    } else if (type === 'audio') {
      data = { title: loc('', '', ''), description: loc('', '', ''), media: { kind: 'none', assetId: '', staticPath: '' }, transcript: loc('', '', ''), mediaOverrides: {} };
    } else if (type === 'callout') {
      data = { tone: 'tip', title: loc('Belangrijk inzicht', 'Key takeaway', ''), body: loc('', '', '') };
    } else if (type === 'story') {
      data = { speakerName: '', speakerRole: loc('Ervaringsverhaal', 'Patient story', ''), quote: loc('', '', ''), media: { kind: 'xped', assetId: '', staticPath: '/static/images/xped/xped-inge.png' } };
    } else if (type === 'sources') {
      data = { title: loc('Wetenschappelijke bronnen', 'Scientific sources', ''), items: [{ id: uid('src'), citation: loc('', '', ''), url: '' }] };
    } else if (type === 'mcq') {
      data = {
        question: loc('', '', ''),
        subtitle: loc('', '', ''),
        options: [
          { id: uid('opt'), label: loc('Optie 1', 'Option 1', ''), isCorrect: false, feedback: loc('', '', '') },
          { id: uid('opt'), label: loc('Optie 2', 'Option 2', ''), isCorrect: false, feedback: loc('', '', '') },
        ],
        explanation: loc('', '', ''),
      };
    } else if (type === 'myth_fact') {
      data = { statement: loc('', '', ''), correctAnswer: 'myth', explanation: loc('', '', ''), sourceUrl: '', sourceLabel: loc('', '', '') };
    } else if (type === 'scale') {
      data = { question: loc('', '', ''), min: 0, max: 10, minLabel: loc('Helemaal oneens', 'Strongly disagree', ''), maxLabel: loc('Helemaal eens', 'Strongly agree', ''), feedback: loc('', '', '') };
    } else if (type === 'reflection') {
      data = { prompt: loc('', '', ''), placeholder: loc('Schrijf hier je gedachten…', 'Write your thoughts here…', 'Schreib hier deine Gedanken auf…') };
    } else if (type === 'wordcloud') {
      data = { question: loc('', '', ''), placeholder: loc('Bijv. vermoeidheid, hoop, beweging', 'e.g. fatigue, hope, movement', ''), maxWords: 3 };
    } else if (type === 'ranking') {
      data = {
        question: loc('', '', ''),
        items: [
          { id: uid('opt'), label: loc('Item 1', 'Item 1', '') },
          { id: uid('opt'), label: loc('Item 2', 'Item 2', '') },
          { id: uid('opt'), label: loc('Item 3', 'Item 3', '') },
        ],
      };
    } else if (type === 'hotspot') {
      data = {
        title: loc('', '', ''),
        instruction: loc('Klik op een punt in de afbeelding voor uitleg.', 'Tap a point on the image to explore.', ''),
        mode: 'explore',
        media: { kind: 'xped', assetId: '', staticPath: '/static/images/xped/xped-brein-mascotte-met-gloeilamp.png' },
        alt: loc('Illustratie', 'Illustration', ''),
        pins: [
          { id: uid('opt'), label: loc('Punt 1', 'Point 1', ''), detail: loc('', '', ''), x: 35, y: 40 },
          { id: uid('opt'), label: loc('Punt 2', 'Point 2', ''), detail: loc('', '', ''), x: 65, y: 55 },
        ],
      };
    } else if (type === 'balance_scale') {
      data = {
        title: loc('Draagkracht & Draaglast', 'Resources & Load', ''),
        intro: loc('Schuif de balkjes om te zien wat jouw balans op dit moment beïnvloedt.', 'Adjust the sliders to explore what shapes your balance today.', ''),
        loadLabel: loc('Draaglast', 'Load', 'Belastung'),
        resourceLabel: loc('Draagkracht', 'Resources', 'Ressourcen'),
        factors: [
          { id: uid('opt'), label: loc('Slecht slapen / spanning', 'Poor sleep / stress', ''), category: 'load' },
          { id: uid('opt'), label: loc('Over je grenzen gaan', 'Pushing past limits', ''), category: 'load' },
          { id: uid('opt'), label: loc('Rustig bewegen op eigen tempo', 'Gentle paced movement', ''), category: 'resource' },
          { id: uid('opt'), label: loc('Steun uit omgeving & ontspanning', 'Support & relaxation', ''), category: 'resource' },
        ],
        overloadTip: loc('Je draaglast weegt nu zwaarder. Een kleine stap richting herstel of doseren helpt het zenuwstelsel kalmeren.', 'Load currently outweighs resources. One small pacing or recovery step helps calm the nervous system.', ''),
        balancedTip: loc('Mooie balans! Jouw draagkracht geeft ruimte om stap voor stap verder te bouwen.', 'Great balance! Your resources give room to build step by step.', ''),
      };
    } else if (type === 'bps_triad') {
      data = {
        title: loc('Wat speelt allemaal mee bij pijn?', 'What influences pain?', ''),
        intro: loc('Verken de drie pijlers van het biopsychosociale model.', 'Explore the three pillars of the biopsychosocial model.', ''),
        bioTitle: loc('Biologisch', 'Biological', 'Biologisch'),
        bioBody: loc('', '', ''),
        psychoTitle: loc('Psychologisch', 'Psychological', 'Psychologisch'),
        psychoBody: loc('', '', ''),
        socialTitle: loc('Sociaal', 'Social', 'Sozial'),
        socialBody: loc('', '', ''),
      };
    } else if (type === 'mini_plan') {
      data = {
        title: loc('Jouw kleine stap voor deze week', 'Your small step for this week', ''),
        intro: loc('Kies 1 tot 3 haalbare stappen om mee te nemen.', 'Pick 1 to 3 realistic steps to take with you.', ''),
        suggestions: [
          { id: uid('opt'), label: loc('5 minuten rustig wandelen', '5-minute gentle walk', '') },
          { id: uid('opt'), label: loc('Bewust pauzeren vóór de pijn piekt', 'Take a planned pause before pain spikes', '') },
          { id: uid('opt'), label: loc('Met iemand delen wat ik geleerd heb', 'Share one takeaway with someone close', '') },
        ],
        allowCustom: true,
        maxSelect: 3,
      };
    } else if (type === 'custom_visual') {
      data = {
        title: loc('Interactieve visualisatie', 'Interactive visual', 'Interaktive Visualisierung'),
        caption: loc('', '', ''),
        alt: loc('Aangepaste educatieve animatie', 'Custom educational animation', ''),
        agentBrief: 'Create a calm, accessible animated SVG in xPED navy (#062940), blue (#007ACC), mint (#1FE4A9), and warm sand (#F6F1E9) showing how the nervous system alarm dial calms down step by step.',
        slotId: 'visual_' + Math.random().toString(36).slice(2, 7),
        height: 'medium',
        preset: 'placeholder',
        svgMarkup: '',
      };
    }
    return { id: id, type: type, data: data, settings: settings };
  }

  function createStep(titleNl, titleEn) {
    return {
      id: uid('stp'),
      title: loc(titleNl || 'Nieuwe stap', titleEn || 'New step', ''),
      layout: 'focused',
      status: 'empty',
      authorNotes: '',
      blocks: [],
      branching: [],
    };
  }

  function createModule(recipe, index) {
    var num = (index || 0) + 1;
    var mod = {
      id: uid('mod'),
      title: loc('Station ' + num, 'Station ' + num, ''),
      subtitle: loc('', '', ''),
      domain: ['bio', 'psycho', 'social'][index % 3] || 'general',
      estimatedMinutes: 5,
      status: 'empty',
      visibleToLearners: true,
      milestoneMessage: loc('', '', ''),
      steps: [],
    };
    if (recipe === 'myth-buster') {
      var mb1 = createStep('Feit of Fabel?', 'Myth or Fact?');
      var mbMyth = createBlock('myth_fact');
      var mbCallout = createBlock('callout');
      mbCallout.settings.revealAfterAnswer = true;
      mb1.blocks.push(mbMyth, mbCallout);
      var mb2 = createStep('Wat betekent dit voor jou?', 'What does this mean for you?');
      mb2.blocks.push(createBlock('richtext'), createBlock('reflection'));
      mod.steps = [mb1, mb2];
      mod.status = 'draft';
    } else if (recipe === 'video-reflection') {
      var vr1 = createStep('Korte uitlegvideo', 'Short explainer video');
      vr1.blocks.push(createBlock('video'), createBlock('callout'));
      var vr2 = createStep('Even stilstaan', 'Pause & reflect');
      vr2.blocks.push(createBlock('reflection'));
      mod.steps = [vr1, vr2];
      mod.status = 'draft';
    } else if (recipe === 'ask-teach-reflect') {
      var s1 = createStep('1. Prikkelende vraag', '1. Opening question');
      s1.blocks.push(createBlock('myth_fact'));
      var s2 = createStep('2. Uitleg & video', '2. Explanation & video');
      s2.blocks.push(createBlock('video'), createBlock('callout'));
      var s3 = createStep('3. Korte reflectie', '3. Short reflection');
      s3.blocks.push(createBlock('reflection'));
      mod.steps = [s1, s2, s3];
      mod.status = 'draft';
    } else if (recipe === 'pain-science') {
      var ps1 = createStep('Biopsychosociaal overzicht', 'Biopsychosocial overview');
      ps1.blocks.push(createBlock('bps_triad'));
      var ps2 = createStep('Check-in & bronnen', 'Check-in & sources');
      ps2.blocks.push(createBlock('scale'), createBlock('sources'));
      mod.steps = [ps1, ps2];
      mod.status = 'draft';
    } else if (recipe === 'action-balance') {
      var ab1 = createStep('Draagkracht & draaglast', 'Resources & load');
      ab1.blocks.push(createBlock('balance_scale'));
      var ab2 = createStep('Jouw mini-plan', 'Your mini-plan');
      ab2.blocks.push(createBlock('mini_plan'));
      mod.steps = [ab1, ab2];
      mod.status = 'draft';
    } else {
      mod.steps = [createStep('Stap 1', 'Step 1')];
    }
    return mod;
  }

  function createExpeditionPreset(presetKey, title, defaultLang) {
    var lang = defaultLang || 'nl';
    var base = {
      title: title || 'Untitled Expedition',
      defaultLanguage: lang,
      enabledLanguages: ['nl', 'en', 'de'],
      theme: { preset: 'xped-warm-sand', showRouteMap: true },
      startPage: {
        eyebrow: loc('XPEDITIE PIJN', 'XPEDITION PAIN', 'XPEDITION SCHMERZ'),
        title: loc(title || 'xPEDitie Pijn', title || 'xPEDition Pain', ''),
        subtitle: loc(
          'Een rustige, interactieve ontdekkingsreis over hoe pijn werkt en wat jou kan helpen.',
          'A calm, interactive journey to understand how pain works and what can help you.',
          ''
        ),
        heroMedia: { kind: 'xped', assetId: '', staticPath: '/static/images/xped/xped-wandelaar-met-kaart.png' },
        heroMediaOverrides: {},
        heroVideoUrl: '',
        highlights: [
          { id: uid('hl'), text: loc('Korte, overzichtelijke stappen in jouw eigen tempo', 'Short, focused steps at your own pace', '') },
          { id: uid('hl'), text: loc('Interactieve vragen en voorbeelden zonder toetsdruk', 'Interactive questions and examples without exam pressure', '') },
        ],
        ctaLabel: loc('Start de xPEDitie', 'Start the xPEDitie', 'xPEDition starten'),
      },
      glossary: DEFAULT_GLOSSARY.map(function (g) { return Object.assign({}, g); }),
      modules: [],
    };
    if (presetKey === 'bps-skeleton') {
      var mBio = createModule('ask-teach-reflect', 0);
      mBio.title = loc('Station 1: Het zenuwstelsel (Bio)', 'Station 1: The nervous system (Bio)', '');
      mBio.domain = 'bio';
      var mPsy = createModule('pain-science', 1);
      mPsy.title = loc('Station 2: Gedachten & gevoel (Psycho)', 'Station 2: Thoughts & feelings (Psycho)', '');
      mPsy.domain = 'psycho';
      var mSoc = createModule('action-balance', 2);
      mSoc.title = loc('Station 3: Omgeving & balans (Sociaal)', 'Station 3: Environment & balance (Social)', '');
      mSoc.domain = 'social';
      base.modules = [mBio, mPsy, mSoc];
    } else if (presetKey === 'showcase') {
      var mod1 = createModule('ask-teach-reflect', 0);
      mod1.title = loc('Station 1: Feit of Fabel?', 'Station 1: Myth or Fact?', '');
      mod1.steps[0].blocks[0].data.statement = loc(
        'Aanhoudende pijn betekent altijd dat er nog steeds nieuwe weefselschade ontstaat.',
        'Persistent pain always means new tissue damage is still happening.',
        ''
      );
      mod1.steps[0].blocks[0].data.explanation = loc(
        'Fabel — bij chronische pijn raakt het alarmsysteem (zenuwstelsel) vaak extra gevoelig, ook als weefsel al hersteld is.',
        'Myth — with persistent pain, the alarm system (nervous system) can stay extra sensitive even after tissue has healed.',
        ''
      );
      var mod2 = createModule('action-balance', 1);
      mod2.title = loc('Station 2: Jouw balans & plan', 'Station 2: Your balance & plan', '');
      base.modules = [mod1, mod2];
    } else {
      base.modules = [createModule('blank', 0)];
    }
    return base;
  }

  function extractTranslationRows(exp, sourceLang, targetLang) {
    var src = sourceLang || 'nl';
    var tgt = targetLang || 'de';
    var altLang = src === 'nl' ? 'en' : 'nl';
    var rows = [];
    function pushField(key, location, locObj, blockId) {
      if (!locObj || typeof locObj !== 'object') return;
      var srcVal = String(locObj[src] || '');
      var altVal = altLang !== tgt ? String(locObj[altLang] || '') : '';
      var tgtVal = String(locObj[tgt] || '');
      var anyVal = String(locObj.nl || '') + String(locObj.en || '') + String(locObj.de || '');
      if (!anyVal.trim()) return;
      var needsReview = !!(locObj._review && locObj._review[tgt]);
      var status = needsReview ? 'needs_review' : (tgtVal.trim() ? 'translated' : 'untranslated');
      rows.push({
        key: key,
        location: location,
        source: srcVal,
        altSource: altVal && altVal.trim() !== srcVal.trim() ? altVal : '',
        altLang: altLang,
        target: tgtVal,
        status: status,
        locObj: locObj,
        blockId: blockId || '',
      });
    }
    if (exp && exp.startPage) {
      pushField('startPage.eyebrow', 'Start Page · Eyebrow', exp.startPage.eyebrow, '');
      pushField('startPage.title', 'Start Page · Title', exp.startPage.title, '');
      pushField('startPage.subtitle', 'Start Page · Subtitle', exp.startPage.subtitle, '');
      pushField('startPage.ctaLabel', 'Start Page · Button', exp.startPage.ctaLabel, '');
      (exp.startPage.highlights || []).forEach(function (hl, idx) {
        pushField('startPage.highlights.' + hl.id, 'Start Page · Highlight ' + (idx + 1), hl.text, '');
      });
    }
    ((exp && exp.modules) || []).forEach(function (mod, mIdx) {
      var mKey = 'mod.' + mod.id;
      var mLab = 'Station ' + (mIdx + 1);
      pushField(mKey + '.title', mLab + ' · Title', mod.title, '');
      pushField(mKey + '.subtitle', mLab + ' · Subtitle', mod.subtitle, '');
      pushField(mKey + '.milestoneMessage', mLab + ' · Milestone', mod.milestoneMessage, '');
      (mod.steps || []).forEach(function (step, sIdx) {
        var sKey = mKey + '.stp.' + step.id;
        var sLab = mLab + ' · Step ' + (sIdx + 1);
        pushField(sKey + '.title', sLab + ' · Title', step.title, '');
        (step.blocks || []).forEach(function (blk, bIdx) {
          var bKey = sKey + '.blk.' + blk.id;
          var bLab = sLab + ' · ' + blk.type + ' #' + (bIdx + 1);
          var data = blk.data || {};
          Object.keys(data).forEach(function (k) {
            if (blk.type === 'reflection' && k === 'helperNote') return;
            var val = data[k];
            if (val && typeof val === 'object' && !Array.isArray(val) && ('nl' in val && 'en' in val && 'de' in val)) {
              pushField(bKey + '.' + k, bLab + ' · ' + k, val, blk.id);
            } else if (Array.isArray(val)) {
              val.forEach(function (item, iIdx) {
                if (!item || typeof item !== 'object' || !item.id) return;
                Object.keys(item).forEach(function (sk) {
                  var sv = item[sk];
                  if (sv && typeof sv === 'object' && !Array.isArray(sv) && ('nl' in sv && 'en' in sv && 'de' in sv)) {
                    pushField(bKey + '.' + k + '.' + item.id + '.' + sk, bLab + ' · ' + k + ' #' + (iIdx + 1) + ' · ' + sk, sv, blk.id);
                  }
                });
              });
            }
          });
        });
      });
    });
    return rows;
  }

  function extractMediaTranslationRows(exp, targetLang) {
    var tgt = targetLang || 'de';
    var items = [];
    ((exp && exp.modules) || []).forEach(function (mod, mIdx) {
      (mod.steps || []).forEach(function (step, sIdx) {
        (step.blocks || []).forEach(function (blk) {
          if (blk.type === 'video' && blk.data && blk.data.url) {
            var ov = (blk.data.mediaOverrides && blk.data.mediaOverrides[tgt]) || null;
            items.push({
              key: 'mod.' + mod.id + '.stp.' + step.id + '.blk.' + blk.id,
              kind: 'video',
              moduleId: mod.id,
              stepId: step.id,
              blockId: blk.id,
              location: 'Station ' + (mIdx + 1) + ' · Step ' + (sIdx + 1) + ' · Video URL',
              sourceUrl: blk.data.url,
              targetUrl: ov ? (ov.url || '') : '',
              block: blk,
            });
          }
        });
      });
    });
    return items;
  }

  function analyzeStepReadability(step, lang, defaultLang) {
    var words = 0;
    var longSentences = 0;
    var denseBlocks = 0;
    var missingAlt = 0;
    var missingVideoSummary = 0;
    var tips = [];
    if (!step) return { words: 0, seconds: 0, level: 'good', tips: [] };
    var allTexts = [getLocalized(step.title, lang, defaultLang)];
    (step.blocks || []).forEach(function (blk) {
      var d = blk.data || {};
      if (blk.type === 'image' && d.media && d.media.kind !== 'none') {
        if (!getLocalized(d.alt, lang, defaultLang).trim()) missingAlt += 1;
      }
      if (blk.type === 'video' && d.url) {
        if (!getLocalized(d.transcript, lang, defaultLang).trim() && !getLocalized(d.caption, lang, defaultLang).trim()) {
          missingVideoSummary += 1;
        }
      }
      var blockWords = 0;
      Object.keys(d).forEach(function (k) {
        var v = d[k];
        if (v && typeof v === 'object' && ('nl' in v || 'en' in v || 'de' in v)) {
          var txt = getLocalized(v, lang, defaultLang).trim();
          if (txt) {
            allTexts.push(txt);
            blockWords += txt.split(/\s+/).filter(Boolean).length;
          }
        }
      });
      if (blk.type === 'richtext' && blockWords > 90) denseBlocks += 1;
    });
    allTexts.forEach(function (txt) {
      if (!txt) return;
      var wList = txt.split(/\s+/).filter(Boolean);
      words += wList.length;
      txt.split(/[.!?]+/).forEach(function (s) {
        var sw = s.trim().split(/\s+/).filter(Boolean).length;
        if (sw > 22) longSentences += 1;
      });
    });
    if (longSentences > 0) {
      tips.push({ kind: 'warn', text: longSentences + ' sentence' + (longSentences > 1 ? 's exceed' : ' exceeds') + ' 22 words (B1 target: shorter sentences).' });
    }
    if (denseBlocks > 0) {
      tips.push({ kind: 'warn', text: denseBlocks + ' text block' + (denseBlocks > 1 ? 's have' : ' has') + ' >90 words — consider splitting or adding bullet points.' });
    }
    if (missingAlt > 0) {
      tips.push({ kind: 'info', text: missingAlt + ' image' + (missingAlt > 1 ? 's need' : ' needs') + ' alt text for screen readers.' });
    }
    if (missingVideoSummary > 0) {
      tips.push({ kind: 'info', text: missingVideoSummary + ' video' + (missingVideoSummary > 1 ? 's have' : ' has') + ' no caption or transcript summary yet.' });
    }
    if (!tips.length) {
      tips.push({ kind: 'ok', text: 'Great B1 readability — concise sentences and accessible media.' });
    }
    return {
      words: words,
      seconds: Math.max(5, Math.round((words / 150) * 60)),
      level: (longSentences || denseBlocks) ? 'warn' : (missingAlt || missingVideoSummary ? 'info' : 'good'),
      tips: tips,
    };
  }

  function getTranslationStats(rows) {
    var total = rows.length;
    var translated = 0;
    var review = 0;
    rows.forEach(function (r) {
      if (r.status === 'translated') translated += 1;
      else if (r.status === 'needs_review') review += 1;
    });
    return { total: total, translated: translated, review: review, untranslated: total - translated - review };
  }

  // Modern Web Guidance: Safari light-dismiss fallback for <dialog closedby="any">
  function enableDialogLightDismissFallback() {
    if (typeof window === 'undefined' || typeof HTMLDialogElement === 'undefined') return;
    if ('closedBy' in HTMLDialogElement.prototype) return;
    var outside = function (e, dlg) {
      var r = dlg.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    document.querySelectorAll('dialog[closedby="any"]').forEach(function (dlg) {
      var pressedOutside = false;
      dlg.addEventListener('pointerdown', function (e) { pressedOutside = outside(e, dlg); });
      dlg.addEventListener('pointerup', function (e) {
        if (pressedOutside && outside(e, dlg)) dlg.close();
        pressedOutside = false;
      });
    });
  }

  // Modern Web Guidance: Invoker Command copy-button with CommandEvent fallback & VoiceOver deduping
  var _copyTimers = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  var _lastCopyMsg = '';
  function setupCopyButtons() {
    if (typeof document === 'undefined') return;
    function report(button, ok) {
      var tip = button.nextElementSibling;
      if (!tip) return;
      if (_copyTimers) clearTimeout(_copyTimers.get(button));
      button.removeAttribute('data-copied');
      button.removeAttribute('data-failed');
      var msg = ok ? 'Copied' : 'Copy failed';
      if (msg === _lastCopyMsg) msg += '\u00A0';
      _lastCopyMsg = msg;
      tip.textContent = '';
      void button.offsetWidth;
      button.setAttribute(ok ? 'data-copied' : 'data-failed', '');
      requestAnimationFrame(function () { tip.textContent = msg; });
      var timer = setTimeout(function () {
        button.removeAttribute('data-copied');
        button.removeAttribute('data-failed');
        tip.textContent = '';
      }, 2000);
      if (_copyTimers) _copyTimers.set(button, timer);
    }
    async function doCopy(button, target) {
      if (!target) return;
      var text = target.matches('input, textarea') ? target.value : (target.innerText || '').trim();
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        report(button, true);
      } catch (_err) {
        report(button, false);
      }
    }
    if ('CommandEvent' in window) {
      document.addEventListener('command', function (event) {
        if (event.command && event.command.indexOf('--copy') === 0) {
          doCopy(event.source, event.target);
        }
      }, true);
    } else {
      document.addEventListener('click', function (event) {
        var btn = event.target.closest('button[command^="--copy"]');
        if (!btn) return;
        var target = document.getElementById(btn.getAttribute('commandfor'));
        if (target) doCopy(btn, target);
      });
    }
  }

  var api = {
    SUPPORTED_LANGS: SUPPORTED_LANGS,
    LANG_LABELS: LANG_LABELS,
    DOMAIN_LABELS: DOMAIN_LABELS,
    DEFAULT_GLOSSARY: DEFAULT_GLOSSARY,
    XPED_ASSETS: XPED_ASSETS,
    BLOCK_CATALOG: BLOCK_CATALOG,
    uid: uid,
    loc: loc,
    getLocalized: getLocalized,
    setLocalized: setLocalized,
    bindEditableText: bindEditableText,
    ui: ui,
    detectBrowserLanguage: detectBrowserLanguage,
    parseTimestampSeconds: parseTimestampSeconds,
    parseVideoUrl: parseVideoUrl,
    buildEmbedSrc: buildEmbedSrc,
    resolveMediaUrl: resolveMediaUrl,
    createBlock: createBlock,
    createStep: createStep,
    createModule: createModule,
    createExpeditionPreset: createExpeditionPreset,
    extractTranslationRows: extractTranslationRows,
    extractMediaTranslationRows: extractMediaTranslationRows,
    analyzeStepReadability: analyzeStepReadability,
    getTranslationStats: getTranslationStats,
    enableDialogLightDismissFallback: enableDialogLightDismissFallback,
    setupCopyButtons: setupCopyButtons,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.XpedElearningModel = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
