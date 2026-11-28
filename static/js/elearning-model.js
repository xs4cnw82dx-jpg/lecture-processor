(function (root) {
  'use strict';

  var uiText = root.Xped && root.Xped.i18n ? root.Xped.i18n.t : function (message) { return message; };
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
      consentHeading: 'Jouw gegevens',
      consentChoiceRequired: 'Kies een van de twee opties om verder te gaan.',
      courseHighlights: 'Wat je kunt verwachten',
      answerPrivacy: 'Over je antwoorden',
      reflectionAccess: 'De makers van deze cursus kunnen je reflectie lezen.',
      consentCohort: 'Bij je gedeelde antwoorden staat je groep: {group}.',
      consentChangeNote: 'Je keuze geldt vanaf nu. De makers houden de antwoorden die je al hebt gedeeld.',
      consentDetails: 'Wat deel ik nog meer als ik ja kies?',
      consentTitle: "Maar eerst dit nog even…",
      consentIntro: "Je kunt de hele expeditie volgen, welke keuze je ook maakt.",
      consentQuestion: "Wil je je antwoorden delen met de cursusmakers?",
      consentShare: "Ja, ik deel mijn antwoorden",
      consentPrivate: "Nee, ik houd mijn antwoorden privé",
      consentPrivateNote: "Je nieuwe antwoorden en je verdere voortgang blijven bij jou.",
      consentFeedback: "Ook feedback die je instuurt, kunnen de makers lezen.",
      changeConsent: "Mijn keuze voor gegevens delen wijzigen",
      authorAccess: 'De makers ontvangen je voortgang en antwoorden, ook ingevulde tekst, onder een sessiecode.',
      authorAccessWithTime: 'De makers ontvangen je voortgang, hoe lang je actief bent per stap en je antwoorden, ook ingevulde tekst, onder een sessiecode.',
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
      wrongMythLead: 'Toelichting',
      yourAnswer: 'Jouw keuze',
      correctChoice: 'Juist antwoord',
      incorrectChoice: 'Onjuist antwoord',
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
      summarySubtitle: 'Hieronder vind je wat je uit deze xPEDitie meeneemt.',
      summaryEmpty: 'Je hebt deze xPEDitie afgerond.',
      copySummary: 'Kopieer tekst',
      summaryCopied: 'Tekst gekopieerd.',
      summaryCopyManual: 'Selecteer en kopieer de tekst hieronder.',
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
      hotspotUnselected: 'Kies een punt op de afbeelding om uitleg te bekijken.',
      checkAnswers: 'Controleer antwoorden',
      allCorrect: 'Alle juiste antwoorden gekozen!',
      partialCorrect: 'Je hebt een deel goed — bekijk de toelichting hieronder.',
      notChosenYet: 'Nog niet gekozen',
      chooseMidpoint: 'Kies midden ({n})',
      wordsRemaining: '{n} van {max} woorden toegevoegd',
      wordsLimitReached: 'Maximum van {max} woorden bereikt — verwijder eerst een woord om een nieuw woord toe te voegen.',
      removeWord: 'Verwijder "{word}"',
      goalsSelectedCount: '{n} van {max} gekozen',
      goalsLimitReached: 'Maximum van {max} stappen bereikt — deselecteer eerst een stap om deze toe te voegen.',
      movedItem: '{label} verplaatst naar positie {pos} van {total}',
      sourcesBar: 'Bron',
      openSource: 'Open bron ({host})',
      up: 'Omhoog',
      down: 'Omlaag',
    },
    en: {
      consentHeading: 'Your information',
      consentChoiceRequired: 'Choose one of the two options to continue.',
      courseHighlights: 'What to expect',
      answerPrivacy: 'About your answers',
      reflectionAccess: 'Course authors can read your reflection.',
      consentCohort: 'Shared answers include your group: {group}.',
      consentChangeNote: 'Your choice applies from now on. The authors keep any answers you already shared.',
      consentDetails: 'What else is included if I choose to share?',
      consentTitle: "Before we begin…",
      consentIntro: "You can take the whole course with either choice.",
      consentQuestion: "Would you like to share your answers with the course authors?",
      consentShare: "Yes, share my answers",
      consentPrivate: "No, keep my answers private",
      consentPrivateNote: "Your new answers and further progress stay with you.",
      consentFeedback: "The authors can also read any feedback you send.",
      changeConsent: "Change my sharing choice",
      authorAccess: 'Course authors receive your progress and answers, including written responses, under a session ID.',
      authorAccessWithTime: 'Course authors receive your progress, how long you are active on each step and your answers, including written responses, under a session ID.',
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
      wrongMythLead: 'Explanation',
      yourAnswer: 'Your choice',
      correctChoice: 'Correct answer',
      incorrectChoice: 'Incorrect answer',
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
      summarySubtitle: 'Here’s what you’re taking away from this expedition.',
      summaryEmpty: 'You’ve completed this expedition.',
      copySummary: 'Copy text',
      summaryCopied: 'Text copied.',
      summaryCopyManual: 'Select and copy the text below.',
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
      hotspotUnselected: 'Choose a point on the image to read its explanation.',
      checkAnswers: 'Check answers',
      allCorrect: 'All correct answers selected!',
      partialCorrect: 'You got part of it — check the explanation below.',
      notChosenYet: 'Not chosen yet',
      chooseMidpoint: 'Choose midpoint ({n})',
      wordsRemaining: '{n} of {max} words added',
      wordsLimitReached: 'Limit of {max} words reached — remove a word first to add another.',
      removeWord: 'Remove "{word}"',
      goalsSelectedCount: '{n} of {max} selected',
      goalsLimitReached: 'Limit of {max} steps reached — deselect one first to add this.',
      movedItem: 'Moved {label} to position {pos} of {total}',
      sourcesBar: 'Source',
      openSource: 'Open source ({host})',
      up: 'Up',
      down: 'Down',
    },
    de: {
      consentHeading: 'Ihre Daten',
      consentChoiceRequired: 'Wählen Sie eine der beiden Optionen, um fortzufahren.',
      courseHighlights: 'Was dich erwartet',
      answerPrivacy: 'Über deine Antworten',
      reflectionAccess: 'Die Kursverantwortlichen können deine Reflexion lesen.',
      consentCohort: 'Bei deinen geteilten Antworten steht deine Gruppe: {group}.',
      consentChangeNote: 'Deine Wahl gilt ab jetzt. Bereits geteilte Antworten bleiben beim Kursteam.',
      consentDetails: 'Was wird außerdem geteilt, wenn ich zustimme?',
      consentTitle: "Bevor es losgeht…",
      consentIntro: "Du kannst den gesamten Kurs mit beiden Optionen durchlaufen.",
      consentQuestion: "Möchtest du deine Antworten mit dem Kursteam teilen?",
      consentShare: "Ja, meine Antworten teilen",
      consentPrivate: "Nein, meine Antworten bleiben privat",
      consentPrivateNote: "Deine neuen Antworten und dein weiterer Fortschritt bleiben bei dir.",
      consentFeedback: "Das Kursteam kann auch dein eingesendetes Feedback lesen.",
      changeConsent: "Meine Auswahl zur Datenfreigabe ändern",
      authorAccess: 'Die Kursverantwortlichen erhalten deinen Fortschritt und deine Antworten einschließlich eigener Texte unter einer Sitzungskennung.',
      authorAccessWithTime: 'Die Kursverantwortlichen erhalten deinen Fortschritt, deine aktive Zeit pro Schritt und deine Antworten einschließlich eigener Texte unter einer Sitzungskennung.',
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
      wrongMythLead: 'Erläuterung',
      yourAnswer: 'Deine Wahl',
      correctChoice: 'Richtige Antwort',
      incorrectChoice: 'Falsche Antwort',
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
      summarySubtitle: 'Hier findest du, was du aus dieser Expedition mitnimmst.',
      summaryEmpty: 'Du hast diese Expedition abgeschlossen.',
      copySummary: 'Text kopieren',
      summaryCopied: 'Text kopiert.',
      summaryCopyManual: 'Markiere und kopiere den folgenden Text.',
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
      hotspotUnselected: 'Wähle einen Punkt auf dem Bild, um die Erklärung zu lesen.',
      checkAnswers: 'Antworten prüfen',
      allCorrect: 'Alle richtigen Antworten gewählt!',
      partialCorrect: 'Ein Teil stimmt — schau dir die Erklärung unten an.',
      notChosenYet: 'Noch nicht gewählt',
      chooseMidpoint: 'Mitte wählen ({n})',
      wordsRemaining: '{n} von {max} Wörtern hinzugefügt',
      wordsLimitReached: 'Limit von {max} Wörtern erreicht — entferne zuerst ein Wort, um ein neues hinzuzufügen.',
      removeWord: '„{word}“ entfernen',
      goalsSelectedCount: '{n} von {max} gewählt',
      goalsLimitReached: 'Limit von {max} Schritten erreicht — wähle zuerst einen ab, um diesen hinzuzufügen.',
      movedItem: '{label} auf Position {pos} von {total} verschoben',
      sourcesBar: 'Quelle',
      openSource: 'Quelle öffnen ({host})',
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
    {
      id: 'wandelaar-kaart',
      label: 'Expeditie kaart',
      path: '/static/images/xped/xped-wandelaar-met-kaart.png',
      alt: {
        nl: 'Een wandelaar met rugzak, kaart en wandelstok.',
        en: 'A hiker carries a backpack, a map and a walking stick.',
        de: 'Eine Person wandert mit Rucksack, Karte und Stock.',
      },
      previousAlt: {
        nl: 'Illustratie van een wandelaar met rugzak die een routekaart vasthoudt',
        en: 'Illustration of a hiker with a backpack holding a route map',
        de: 'Illustration einer wandernden Person mit Rucksack und Routenkarte',
      },
    },
    {
      id: 'jan',
      label: 'Jan',
      path: '/static/images/xped/xped-jan.png',
      alt: {
        nl: 'Drie mensen verkennen de route. Een van hen kijkt vanuit een rolstoel door een verrekijker.',
        en: 'Three people explore a route. One looks through binoculars from a wheelchair.',
        de: 'Drei Menschen erkunden den Weg. Eine Person im Rollstuhl schaut durch ein Fernglas.',
      },
      previousAlt: {
        nl: 'Portretillustratie van Jan uit de xPEDitie Pijn-verhalen',
        en: 'Portrait illustration of Jan from the xPEDitie Pain stories',
        de: 'Porträtillustration von Jan aus den xPEDition-Schmerz-Geschichten',
      },
    },
    {
      id: 'inge',
      label: 'Inge',
      path: '/static/images/xped/xped-inge.png',
      alt: {
        nl: 'Een oudere vrouw leest in een leunstoel. Haar wandelstokken en een kat zijn dichtbij.',
        en: 'An older woman reads in an armchair with her walking poles and a cat nearby.',
        de: 'Eine ältere Frau liest im Sessel. Ihre Gehstöcke und eine Katze sind in der Nähe.',
      },
      previousAlt: {
        nl: 'Portretillustratie van Inge uit de xPEDitie Pijn-verhalen',
        en: 'Portrait illustration of Inge from the xPEDitie Pain stories',
        de: 'Porträtillustration von Inge aus den xPEDition-Schmerz-Geschichten',
      },
    },
    {
      id: 'esther',
      label: 'Esther',
      path: '/static/images/xped/xped-esther.png',
      alt: {
        nl: 'Een moeder ligt op haar rug en speelt vliegtuigje met haar kind.',
        en: 'A mother lies on her back and lifts her child into the air to play aeroplane.',
        de: 'Eine Mutter liegt auf dem Rücken und spielt mit ihrem Kind Flieger.',
      },
      previousAlt: {
        nl: 'Portretillustratie van Esther uit de xPEDitie Pijn-verhalen',
        en: 'Portrait illustration of Esther from the xPEDitie Pain stories',
        de: 'Porträtillustration von Esther aus den xPEDition-Schmerz-Geschichten',
      },
    },
    {
      id: 'arts',
      label: 'Arts & patiënt',
      path: '/static/images/xped/xped-arts.png',
      alt: {
        nl: 'Een arts en een patiënt staan naast elkaar in gesprek.',
        en: 'A clinician and a patient stand side by side in conversation.',
        de: 'Eine Ärztin und ein Patient stehen nebeneinander im Gespräch.',
      },
      previousAlt: {
        nl: 'Illustratie van een zorgverlener in gesprek met een patiënt',
        en: 'Illustration of a clinician talking with a patient',
        de: 'Illustration einer Fachperson im Gespräch mit einer Patientin oder einem Patienten',
      },
    },
    {
      id: 'wandelen',
      label: 'Wandelen',
      path: '/static/images/xped/xped-wandelen.png',
      alt: {
        nl: 'Twee volwassenen wandelen met een kind op de schouders. Een van de wandelaars draagt een beenprothese.',
        en: 'Two adults walk with a child riding on shoulders. One walker wears a leg prosthesis.',
        de: 'Zwei Erwachsene gehen spazieren, ein Kind sitzt auf den Schultern. Eine Person trägt eine Beinprothese.',
      },
      previousAlt: {
        nl: 'Illustratie van iemand die rustig buiten wandelt langs een pad',
        en: 'Illustration of a person walking calmly along an outdoor path',
        de: 'Illustration einer Person beim ruhigen Spaziergang auf einem Weg',
      },
    },
    {
      id: 'brein-mascotte',
      label: 'Brein mascotte',
      path: '/static/images/xped/xped-brein-mascotte-met-gloeilamp.png',
      alt: {
        nl: 'Illustratie van het xPED-brein met een brandende gloeilamp voor inzicht',
        en: 'Illustration of the xPED brain character holding a lit lightbulb for insight',
        de: 'Illustration der xPED-Gehirnfigur mit einer leuchtenden Glühbirne',
      },
    },
    {
      id: 'icon-brein',
      label: 'Icon: Brein',
      path: '/static/images/xped/icon-brein.png',
      alt: {
        nl: 'Pictogram van een brein als symbool voor het zenuwstelsel',
        en: 'Brain icon representing the nervous system',
        de: 'Gehirn-Symbol für das Nervensystem',
      },
    },
    {
      id: 'icon-lamp',
      label: 'Icon: Inzicht',
      path: '/static/images/xped/icon-lamp.png',
      alt: {
        nl: 'Pictogram van een gloeilamp als symbool voor een inzicht',
        en: 'Lightbulb icon representing an insight',
        de: 'Glühbirnen-Symbol für eine Erkenntnis',
      },
    },
    {
      id: 'icon-sociaal',
      label: 'Icon: Sociaal',
      path: '/static/images/xped/icon-sociaal.png',
      alt: {
        nl: 'Pictogram van mensen samen als symbool voor sociale steun',
        en: 'People icon representing social support',
        de: 'Personen-Symbol für soziale Unterstützung',
      },
    },
    {
      id: 'icon-voetstappen',
      label: 'Icon: Stappen',
      path: '/static/images/xped/icon-voetstappen.png',
      alt: {
        nl: 'Pictogram van voetstappen als symbool voor kleine haalbare stappen',
        en: 'Footsteps icon representing small achievable steps',
        de: 'Fußspuren-Symbol für kleine machbare Schritte',
      },
    },
    {
      id: 'logo-nl',
      label: 'xPED Logo',
      path: '/static/images/xped/logo_nl.svg',
      alt: {
        nl: 'Logo van xPEDitie Pijn',
        en: 'xPEDitie Pain logo',
        de: 'Logo von xPEDition Schmerz',
      },
    },
    {
      id: 'samen-op-route', academyOnly: true,
      label: 'Samen op pad', labels: { nl: 'Samen op pad', de: 'Gemeinsam unterwegs', en: 'Travelling together' },
      path: '/static/images/xped/academy-together.webp',
      alt: { nl: 'Twee wandelaars volgen een gestippelde route.', de: 'Zwei Wandernde folgen einem gepunkteten Weg.', en: 'Two walkers follow a dotted trail.' },
    },
    {
      id: 'rustmoment', academyOnly: true,
      label: 'Rustmoment', labels: { nl: 'Rustmoment', de: 'Ruhepause', en: 'A moment of rest' },
      path: '/static/images/xped/academy-rest.webp',
      alt: { nl: 'Een persoon zit met gekruiste benen.', de: 'Eine Person sitzt im Schneidersitz.', en: 'A person sits cross-legged.' },
    },
    {
      id: 'eerste-stappen', academyOnly: true,
      label: 'Eerste stappen', labels: { nl: 'Eerste stappen', de: 'Erste Schritte', en: 'First steps' },
      path: '/static/images/xped/academy-steps.webp',
      alt: { nl: 'Een spoor van mintgroene voetstappen.', de: 'Eine Spur mintgrüner Fußabdrücke.', en: 'A trail of mint-green footprints.' },
    },
  ];

  var BLOCK_CATEGORIES = [
    { key: 'explain', label: uiText('Explain & illustrate') },
    { key: 'ask', label: uiText('Ask a question') },
    { key: 'pain_tools', label: uiText('Pain education tools') },
    { key: 'advanced', label: uiText('Advanced') },
  ];

  var BLOCK_CATALOG = [
    { type: 'richtext', category: 'explain', label: uiText('Heading & Text'), desc: uiText('Clean readable explanation or story section.'), aliases: ['tekst', 'alinea', 'kop', 'uitleg', 'paragraph', 'text', 'absatz', 'überschrift'] },
    { type: 'video', category: 'explain', label: uiText('YouTube / Vimeo Video'), desc: uiText('Privacy-friendly embed with optional start/end timestamps.'), aliases: ['filmpje', 'youtube', 'vimeo', 'clip', 'uitlegvideo', 'erklärvideo'] },
    { type: 'image', category: 'explain', label: uiText('Image & Visual'), desc: uiText('Upload photo or pick an official xPED illustration.'), aliases: ['afbeelding', 'foto', 'illustratie', 'plaatje', 'bild', 'grafik', 'picture'] },
    { type: 'audio', category: 'explain', label: uiText('Audio Exercise'), desc: uiText('Breathing, pacing, or spoken explanation player.'), aliases: ['geluid', 'ademhaling', 'ontspanning', 'luisteren', 'podcast', 'atmung', 'hörbeitrag'] },
    { type: 'callout', category: 'explain', label: uiText('Key Takeaway'), desc: uiText('Bio / Psycho / Social / Tip highlight card.'), aliases: ['tip', 'inzicht', 'kader', 'samenvatting', 'hinweis', 'merksatz', 'highlight'] },
    { type: 'story', category: 'explain', label: uiText('Patient / Expert Story'), desc: uiText('Authentic quote card with optional portrait.'), aliases: ['verhaal', 'citaat', 'ervaring', 'patiënt', 'quote', 'case', 'geschichte', 'zitat'] },
    { type: 'sources', category: 'explain', label: uiText('Scientific Sources'), desc: uiText('Collapsible academic references drawer.'), aliases: ['bronnen', 'bron', 'referentie', 'literatuur', 'doi', 'citation', 'references', 'quellen'] },
    { type: 'mcq', category: 'ask', label: uiText('Multiple Choice / Poll'), desc: uiText('Single or multi-select with optional peer stats & feedback.'), aliases: ['meerkeuze', 'peiling', 'poll', 'quiz', 'vraag', 'umfrage', 'auswahlfrage'] },
    { type: 'myth_fact', category: 'ask', label: uiText('Myth vs. Fact'), desc: uiText('Modern accessible Feit of Fabel reveal card.'), aliases: ['feit', 'fabel', 'stelling', 'waar', 'onwaar', 'mythos', 'fakt', 'statement'] },
    { type: 'scale', category: 'ask', label: uiText('Confidence Slider'), desc: uiText('Mentimeter-style 0–10 belief or readiness scale.'), aliases: ['schaal', 'schuifbalk', 'slider', 'score', 'cijfer', 'skala', 'regler'] },
    { type: 'reflection', category: 'ask', label: uiText('Open Reflection'), desc: uiText('Written response that course authors can read.'), aliases: ['reflectie', 'open vraag', 'schrijven', 'gedachten', 'reflexion', 'freitext'] },
    { type: 'wordcloud', category: 'ask', label: uiText('Word Cloud'), desc: uiText('Quick 1–3 word associations with optional peer cloud.'), aliases: ['woordenwolk', 'associatie', 'kernwoorden', 'wortwolke', 'tags'] },
    { type: 'ranking', category: 'ask', label: uiText('Priority Ranking'), desc: uiText('Order personal values, activities, or coping tips.'), aliases: ['rangschikken', 'volgorde', 'prioriteit', 'sortieren', 'rangfolge'] },
    { type: 'hotspot', category: 'ask', label: uiText('Pin on Image'), desc: uiText('Interactive diagram hotspots with text fallback.'), aliases: ['hotspot', 'pin', 'aanwijzen', 'diagram', 'kaart', 'bildpunkte'] },
    { type: 'balance_scale', category: 'pain_tools', label: uiText('Balance Scale (Waage)'), desc: uiText('Modernized Draagkracht vs. Draaglast interactive scale.'), aliases: ['weegschaal', 'draagkracht', 'draaglast', 'balans', 'waage', 'belastung', 'ressourcen'] },
    { type: 'bps_triad', category: 'pain_tools', label: uiText('Biopsychosocial Triad'), desc: uiText('Interactive Bio · Psycho · Sociaal explorer.'), aliases: ['bps', 'biopsychosociaal', 'driehoek', 'pijlers', 'biopsychosozial'] },
    { type: 'mini_plan', category: 'pain_tools', label: uiText('Personal Mini-Plan'), desc: uiText('Action chip selector compiled into printable summary.'), aliases: ['actieplan', 'doel', 'kleine stap', 'mini-plan', 'plan', 'ziel', 'schritte'] },
    { type: 'custom_visual', category: 'advanced', label: uiText('Custom SVG / Animation Slot'), desc: uiText('Reserve a stage for a coding agent SVG/animation or pick a built-in pain animation.'), aliases: ['svg', 'animatie', 'custom', 'visualisatie', 'agent', 'animation', 'grafikslot'] },
  ];

  var HOTSPOT_PIN_COLORS = [
    { hex: '#0072CE', label: uiText('xPED Blue'), text: '#FFFFFF' },
    { hex: '#062940', label: uiText('Deep Navy'), text: '#FFFFFF' },
    { hex: '#009C67', label: uiText('Emerald Mint'), text: '#FFFFFF' },
    { hex: '#C98A00', label: uiText('Warm Amber'), text: '#FFFFFF' },
    { hex: '#D63B4F', label: uiText('Coral Red'), text: '#FFFFFF' },
    { hex: '#5C4CE6', label: uiText('Indigo'), text: '#FFFFFF' },
  ];

  function pinTextColor(hex) {
    if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return '#ffffff';
    var channels = hex.slice(1).match(/../g).map(function (v) {
      var s = parseInt(v, 16) / 255;
      return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    var luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    return luminance > 0.179 ? '#000000' : '#ffffff';
  }

  var SCALE_ANCHOR_PRESETS = [
    {
      id: 'agreement',
      label: uiText('Agreement (0–10)'),
      min: 0,
      max: 10,
      minLabel: { nl: 'Helemaal oneens', en: 'Strongly disagree', de: 'Stimme gar nicht zu' },
      maxLabel: { nl: 'Helemaal eens', en: 'Strongly agree', de: 'Stimme voll zu' },
    },
    {
      id: 'confidence',
      label: uiText('Confidence (0–10)'),
      min: 0,
      max: 10,
      minLabel: { nl: 'Geen vertrouwen', en: 'Not confident at all', de: 'Gar kein Vertrauen' },
      maxLabel: { nl: 'Volledig vertrouwen', en: 'Completely confident', de: 'Volles Vertrauen' },
    },
    {
      id: 'readiness',
      label: uiText('Readiness to try (0–10)'),
      min: 0,
      max: 10,
      minLabel: { nl: 'Nog niet klaar', en: 'Not ready yet', de: 'Noch nicht bereit' },
      maxLabel: { nl: 'Helemaal klaar om te starten', en: 'Ready to start', de: 'Bereit loszulegen' },
    },
    {
      id: 'impact',
      label: uiText('Daily impact (0–10)'),
      min: 0,
      max: 10,
      minLabel: { nl: 'Geen invloed', en: 'No impact', de: 'Kein Einfluss' },
      maxLabel: { nl: 'Grote invloed', en: 'Major impact', de: 'Starker Einfluss' },
    },
  ];

  var EXPEDITION_TEMPLATES = {
    blank: {
      key: 'blank',
      label: uiText('Clean Blank Canvas (1 empty station)'),
      stations: 1,
      steps: 1,
      minutes: 5,
      summary: uiText('Start from scratch with one neutral station and one blank step.'),
      outline: [uiText('Station 1 · Blank starter step')],
    },
    'bps-skeleton': {
      key: 'bps-skeleton',
      label: uiText('Biopsychosocial 3-Station Skeleton (Bio · Psycho · Social)'),
      stations: 3,
      steps: 7,
      minutes: 15,
      summary: uiText('Three pre-structured BPS stations with opening question, video, triad, balance scale, and mini-plan.'),
      outline: [
        uiText('Station 1 (Bio) · Opening question, video & reflection'),
        uiText('Station 2 (Psycho) · BPS overview, slider & sources'),
        uiText('Station 3 (Social) · Balance scale & mini-plan'),
      ],
    },
    showcase: {
      key: 'showcase',
      label: uiText('xPED Showcase Example (2 stations with sample blocks)'),
      stations: 2,
      steps: 5,
      minutes: 10,
      summary: uiText('Ready-to-preview pilot with a filled Myth vs. Fact, explainer step, balance scale, and mini-plan.'),
      outline: [
        uiText('Station 1 · Myth vs. Fact, video & reflection'),
        uiText('Station 2 · Balance scale & personal mini-plan'),
      ],
    },
  };

  var FIELD_LABELS = {
    'summaryTitle': uiText('Title'), 'summaryIntro': uiText('Introduction'), 'summaryPlanHeading': uiText('Mini-plan heading'), 'summaryClosing': uiText('Closing text'),
    heading: uiText('Heading'),
    body: uiText('Body text'),
    title: uiText('Title'),
    subtitle: uiText('Subtitle'),
    caption: uiText('Caption'),
    transcript: uiText('Transcript'),
    alt: uiText('Image description (alt text)'),
    sideHeading: uiText('Side panel heading'),
    sideBody: uiText('Side panel text'),
    description: uiText('Description'),
    speakerRole: uiText('Speaker role'),
    speakerName: uiText('Speaker name'),
    agentBrief: uiText('Designer brief'),
    quote: uiText('Quote'),
    question: uiText('Question'),
    explanation: uiText('Explanation'),
    statement: uiText('Statement'),
    sourceLabel: uiText('Source label'),
    minLabel: uiText('Low end label'),
    maxLabel: uiText('High end label'),
    feedback: uiText('Feedback'),
    prompt: uiText('Prompt'),
    placeholder: uiText('Input placeholder'),
    helperNote: uiText('Helper note'),
    instruction: uiText('Instruction'),
    intro: uiText('Introduction'),
    loadLabel: uiText('Load side label'),
    resourceLabel: uiText('Resources side label'),
    overloadTip: uiText('Overload guidance'),
    balancedTip: uiText('Balanced guidance'),
    bioTitle: uiText('Biological heading'),
    bioBody: uiText('Biological explanation'),
    psychoTitle: uiText('Psychological heading'),
    psychoBody: uiText('Psychological explanation'),
    socialTitle: uiText('Social heading'),
    socialBody: uiText('Social explanation'),
    options: uiText('Option'),
    items: uiText('Item'),
    pins: uiText('Pin'),
    factors: uiText('Factor'),
    suggestions: uiText('Suggestion'),
    label: uiText('Label'),
    detail: uiText('Detail'),
    citation: uiText('Reference'),
  };

  function getBlockMeta(type) {
    for (var i = 0; i < BLOCK_CATALOG.length; i += 1) {
      if (BLOCK_CATALOG[i].type === type) return BLOCK_CATALOG[i];
    }
    return { type: type, category: 'explain', label: type || 'Block', desc: '', aliases: [] };
  }

  function normalizeCitationLink(raw) {
    var text = String(raw || '').trim();
    if (!text) return { url: '', label: '', host: '' };
    var doiMatch = text.match(/^(?:doi:\s*)?(10\.\d{4,9}\/\S+)$/i);
    if (doiMatch) {
      var doi = doiMatch[1];
      return { url: 'https://doi.org/' + doi, label: 'DOI: ' + doi, host: 'doi.org' };
    }
    try {
      var parsed = new URL(text);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { url: '', label: '', host: '' };
      var host = (parsed.hostname || '').replace(/^www\./, '');
      var label = host === 'doi.org' ? ('DOI: ' + parsed.pathname.replace(/^\/+/, '')) : host;
      return { url: parsed.href, label: label, host: host };
    } catch (_e) {
      return { url: '', label: '', host: '' };
    }
  }

  function hasMeaningfulAnswer(val) {
    if (val === null || val === undefined) return false;
    if (typeof val === 'number') return Number.isFinite(val);
    if (typeof val === 'boolean') return true;
    if (typeof val === 'string') return val.trim().length > 0;
    if (Array.isArray(val)) return val.length > 0;
    if (typeof val === 'object') {
      if (Array.isArray(val.ids) || Array.isArray(val.custom)) {
        return ((val.ids && val.ids.length) || 0) + ((val.custom && val.custom.length) || 0) > 0;
      }
      return Object.keys(val).length > 0;
    }
    return false;
  }

  function balanceScore(raw) {
    if (typeof raw !== 'number' && !(typeof raw === 'string' && raw.trim())) return null;
    var score = Number(raw);
    return Number.isFinite(score) ? Math.max(0, Math.min(3, Math.round(score))) : null;
  }

  function normalizeMiniPlanAnswer(raw, suggestions) {
    var list = Array.isArray(suggestions) ? suggestions : [];
    var validIds = new Set(list.map(function (item) { return item.id; }));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return {
        ids: Array.from(new Set(Array.isArray(raw.ids) ? raw.ids.filter(function (id) { return validIds.has(id); }) : [])),
        custom: Array.from(new Set(Array.isArray(raw.custom) ? raw.custom.filter(function (item) { return typeof item === 'string' && item.trim(); }) : [])),
      };
    }
    var ids = new Set();
    var custom = new Set();
    (Array.isArray(raw) ? raw : []).forEach(function (entry) {
      var text = String(entry || '').trim();
      if (!text) return;
      if (validIds.has(text)) { ids.add(text); return; }
      var matches = list.filter(function (item) {
        return SUPPORTED_LANGS.some(function (code) { return (item.label?.[code] || '').trim() === text; });
      });
      if (matches.length === 1) ids.add(matches[0].id);
      else custom.add(text);
    });
    return { ids: Array.from(ids), custom: Array.from(custom) };
  }

  function deriveStepContentState(step) {
    if (!step) return 'empty';
    var explicit = step.status || '';
    var hasBlocks = Array.isArray(step.blocks) && step.blocks.length > 0;
    if (!hasBlocks) return explicit === 'review' || explicit === 'ready' ? explicit : 'empty';
    if (explicit === 'ready' || explicit === 'review' || explicit === 'draft') return explicit;
    return 'draft';
  }

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

  // Academy uses formal German in learner-facing guidance, including the author preview.
  var ACADEMY_LEARNER_DE = {
    courseHighlights: 'Was Sie erwartet',
    answerPrivacy: 'Über Ihre Antworten',
    reflectionAccess: 'Das Kursteam kann Ihre Reflexion lesen.',
    consentCohort: 'Ihre geteilten Antworten werden der Gruppe {group} zugeordnet.',
    consentChangeNote: 'Ihre Wahl gilt ab jetzt. Bereits geteilte Antworten bleiben beim Kursteam.',
    consentIntro: 'Sie können die gesamte Expedition unabhängig von Ihrer Wahl durchlaufen.',
    consentQuestion: 'Möchten Sie Ihre Antworten mit dem Kursteam teilen?',
    consentPrivateNote: 'Ihre neuen Antworten und Ihr weiterer Fortschritt bleiben auf diesem Gerät.',
    consentFeedback: 'Das Kursteam kann auch die Rückmeldungen lesen, die Sie einsenden.',
    authorAccess: 'Das Kursteam erhält Ihren Fortschritt und Ihre Antworten einschließlich eigener Texte unter einer Sitzungskennung.',
    deviceResume: 'Ihre Antworten werden auf diesem Gerät gespeichert, damit Sie später fortfahren können.',
    sharedWords: 'Wörter, die Sie zu einer geteilten Wortwolke hinzufügen, sind für andere Teilnehmende sichtbar.',
    routeTitle: 'Ihre Expeditionsroute',
    yourAnswer: 'Ihre Auswahl',
    savedAutomatically: 'Ihr Fortschritt wird automatisch auf diesem Gerät gespeichert. Sie können jederzeit eine Pause machen.',
    summaryTitle: 'Ihre Expedition im Überblick',
    summarySubtitle: 'Hier sehen Sie, was Sie aus der Expedition mitnehmen.',
    summaryEmpty: 'Sie haben diese Expedition abgeschlossen.',
    summaryCopyManual: 'Markieren und kopieren Sie den folgenden Text.',
    revealHint: 'Beantworten Sie zuerst die Frage oben, um die Erklärung zu sehen.',
    pilotTitle: 'Wie war der Pilotkurs für Sie?',
    pilotEngagement: 'Wie ansprechend fanden Sie die Gestaltung? (1–5)',
    pilotComment: 'Was hat Ihnen gefallen? Was können wir verbessern?',
    pilotThanks: 'Vielen Dank für Ihre Rückmeldung.',
    hotspotListLabel: 'Wählen Sie einen Punkt.',
    hotspotUnselected: 'Wählen Sie einen Punkt auf dem Bild, um die Erklärung zu lesen.',
    partialCorrect: 'Ein Teil ist richtig. Lesen Sie die Erklärung unten.',
    wordsLimitReached: 'Sie haben {max} Wörter hinzugefügt. Entfernen Sie zuerst ein Wort, um ein neues einzutragen.',
    goalsLimitReached: 'Sie haben {max} Schritte ausgewählt. Wählen Sie zuerst einen ab, um einen weiteren hinzuzufügen.'
  };

  function ui(lang, key, vars) {
    var dict = UI_STRINGS[lang] || UI_STRINGS.nl;
    var formal = root.Xped?.i18n && lang === 'de' && ACADEMY_LEARNER_DE[key];
    var text = formal || dict[key] || UI_STRINGS.en[key] || key;
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
      data = { media: { kind: 'none', assetId: '', staticPath: '' }, layout: 'full', align: 'center', focalX: 50, focalY: 50, alt: loc('', '', ''), caption: loc('', '', ''), sideHeading: loc('', '', ''), sideBody: loc('', '', ''), mediaOverrides: {} };
    } else if (type === 'audio') {
      data = { title: loc('', '', ''), description: loc('', '', ''), media: { kind: 'none', assetId: '', staticPath: '' }, transcript: loc('', '', ''), mediaOverrides: {} };
    } else if (type === 'callout') {
      data = { tone: 'tip', title: loc('Belangrijk inzicht', 'Key takeaway', ''), body: loc('', '', '') };
    } else if (type === 'story') {
      data = { speakerName: '', speakerRole: loc('Ervaringsverhaal', 'Patient story', ''), quote: loc('', '', ''), media: { kind: 'xped', assetId: '', staticPath: '/static/images/xped/xped-inge.png' } };
    } else if (type === 'sources') {
      data = { title: loc('Bron', 'Source', 'Quelle'), items: [{ id: uid('src'), citation: loc('', '', ''), url: '' }] };
    } else if (type === 'mcq') {
      data = {
        question: loc('', '', ''),
        subtitle: loc('', '', ''),
        graded: false,
        checkMode: 'immediate',
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
        alt: Object.assign({}, XPED_ASSETS[6].alt),
        pins: [
          { id: uid('opt'), label: loc('Punt 1', 'Point 1', ''), detail: loc('', '', ''), x: 35, y: 40, color: '#0072CE' },
          { id: uid('opt'), label: loc('Punt 2', 'Point 2', ''), detail: loc('', '', ''), x: 65, y: 55, color: '#009C67' },
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
      domain: 'general',
      estimatedMinutes: 5,
      status: 'empty',
      visibleToLearners: true,
      milestoneMessage: loc('', '', ''),
      steps: [],
    };
    function draftedStep(titleNl, titleEn, blocks) {
      var st = createStep(titleNl, titleEn);
      st.blocks = blocks || [];
      st.status = st.blocks.length ? 'draft' : 'empty';
      return st;
    }
    if (recipe === 'myth-buster') {
      var mbMyth = createBlock('myth_fact');
      var mbCallout = createBlock('callout');
      mbCallout.settings.revealAfterAnswer = true;
      mod.steps = [
        draftedStep('Feit of Fabel?', 'Myth or Fact?', [mbMyth, mbCallout]),
        draftedStep('Wat betekent dit voor jou?', 'What does this mean for you?', [createBlock('richtext'), createBlock('reflection')]),
      ];
      mod.status = 'draft';
    } else if (recipe === 'video-reflection') {
      mod.steps = [
        draftedStep('Korte uitlegvideo', 'Short explainer video', [createBlock('video'), createBlock('callout')]),
        draftedStep('Even stilstaan', 'Pause & reflect', [createBlock('reflection')]),
      ];
      mod.status = 'draft';
    } else if (recipe === 'ask-teach-reflect') {
      mod.steps = [
        draftedStep('Prikkelende vraag', 'Opening question', [createBlock('myth_fact')]),
        draftedStep('Uitleg & video', 'Explanation & video', [createBlock('video'), createBlock('callout')]),
        draftedStep('Korte reflectie', 'Short reflection', [createBlock('reflection')]),
      ];
      mod.status = 'draft';
    } else if (recipe === 'pain-science') {
      mod.steps = [
        draftedStep('Biopsychosociaal overzicht', 'Biopsychosocial overview', [createBlock('bps_triad')]),
        draftedStep('Check-in & bronnen', 'Check-in & sources', [createBlock('scale'), createBlock('sources')]),
      ];
      mod.status = 'draft';
    } else if (recipe === 'action-balance') {
      mod.steps = [
        draftedStep('Draagkracht & draaglast', 'Resources & load', [createBlock('balance_scale')]),
        draftedStep('Jouw mini-plan', 'Your mini-plan', [createBlock('mini_plan')]),
      ];
      mod.status = 'draft';
    } else {
      mod.steps = [createStep('Stap 1', 'Step 1')];
    }
    return mod;
  }

  function createExpeditionPreset(presetKey, title, defaultLang, options) {
    var lang = SUPPORTED_LANGS.indexOf(defaultLang) >= 0 ? defaultLang : 'nl';
    var cleanTitle = title || 'Untitled Expedition';
    var startTitle = loc('', '', '');
    startTitle[lang] = cleanTitle;
    var base = {
      title: cleanTitle,
      defaultLanguage: lang,
      enabledLanguages: ['nl', 'en', 'de'],
      theme: { preset: 'xped-warm-sand', showRouteMap: true },
      startPage: {
        eyebrow: loc('XPEDITIE PIJN', 'XPEDITION PAIN', 'XPEDITION SCHMERZ'),
        title: startTitle,
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
    if (options?.academy) {
      var coverId = { 'bps-skeleton': 'rustmoment', showcase: 'eerste-stappen' }[presetKey] || 'samen-op-route';
      base.startPage.heroMedia.staticPath = XPED_ASSETS.find(function (asset) { return asset.id === coverId; }).path;
    }
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
      mod1.domain = 'bio';
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
      mod2.domain = 'social';
      base.modules = [mod1, mod2];
    } else {
      base.modules = [createModule('blank', 0)];
    }
    return base;
  }

  function extractTranslationRows(exp, sourceLang, targetLang) {
    var src = sourceLang || 'nl';
    var tgt = targetLang || 'de';
    var altLang = SUPPORTED_LANGS.find(function (lang) { return lang !== src && lang !== tgt; });
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
      ['summaryTitle', 'summaryIntro', 'summaryPlanHeading', 'summaryClosing'].forEach(function (key) {
        pushField('startPage.' + key, 'Completion · ' + FIELD_LABELS[key], exp.startPage[key], '');
      });
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
          var bMeta = getBlockMeta(blk.type);
          var bLab = sLab + ' · ' + bMeta.label + ' #' + (bIdx + 1);
          var data = blk.data || {};
          Object.keys(data).forEach(function (k) {
            if (blk.type === 'reflection' && k === 'helperNote') return;
            var fLab = FIELD_LABELS[k] || k.replace(/([a-z])([A-Z])/g, '$1 $2');
            var val = data[k];
            if (val && typeof val === 'object' && !Array.isArray(val) && ('nl' in val && 'en' in val && 'de' in val)) {
              pushField(bKey + '.' + k, bLab + ' · ' + fLab, val, blk.id);
            } else if (Array.isArray(val)) {
              val.forEach(function (item, iIdx) {
                if (!item || typeof item !== 'object' || !item.id) return;
                Object.keys(item).forEach(function (sk) {
                  var sv = item[sk];
                  if (sv && typeof sv === 'object' && !Array.isArray(sv) && ('nl' in sv && 'en' in sv && 'de' in sv)) {
                    var sfLab = FIELD_LABELS[sk] || sk;
                    pushField(bKey + '.' + k + '.' + item.id + '.' + sk, bLab + ' · ' + fLab + ' ' + (iIdx + 1) + ' · ' + sfLab, sv, blk.id);
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
    var optionalWords = 0;
    var writingChecks = [];
    var accessibilityChecks = [];
    if (!step) {
      return {
        words: 0,
        optionalWords: 0,
        seconds: 0,
        level: 'good',
        writingChecks: [],
        accessibilityChecks: [],
        tips: [],
      };
    }

    function countWords(txt) {
      return String(txt || '').trim().split(/\s+/).filter(Boolean).length;
    }

    function inspectText(txt, blockId, fieldKey, blockLabel, isOptional) {
      var clean = String(txt || '').trim();
      if (!clean) return 0;
      var w = countWords(clean);
      if (isOptional) {
        optionalWords += w;
        return w;
      }
      words += w;
      var longCount = 0;
      clean.split(/[.!?]+/).forEach(function (s) {
        if (countWords(s) > 22) longCount += 1;
      });
      if (longCount > 0) {
        writingChecks.push({
          kind: 'warn',
          group: 'writing',
          blockId: blockId || '',
          fieldKey: fieldKey || '',
          text: (blockLabel ? blockLabel + ': ' : '') + longCount + ' sentence' + (longCount > 1 ? 's exceed' : ' exceeds') + ' 22 words — consider shortening for easier reading.',
        });
      }
      return w;
    }

    inspectText(getLocalized(step.title, lang, defaultLang), '', 'title', 'Step title', false);

    (step.blocks || []).forEach(function (blk, idx) {
      var d = blk.data || {};
      var bLabel = getBlockMeta(blk.type).label + ' #' + (idx + 1);
      if ((blk.type === 'image' || blk.type === 'hotspot') && d.media && d.media.kind !== 'none') {
        if (!getLocalized(d.alt, lang, defaultLang).trim()) {
          accessibilityChecks.push({
            kind: 'info',
            group: 'accessibility',
            blockId: blk.id,
            fieldKey: 'alt',
            text: bLabel + ' needs an image description (alt text) for screen readers.',
          });
        }
      }
      if (blk.type === 'video' && d.url) {
        if (!getLocalized(d.transcript, lang, defaultLang).trim() && !getLocalized(d.caption, lang, defaultLang).trim()) {
          accessibilityChecks.push({
            kind: 'info',
            group: 'accessibility',
            blockId: blk.id,
            fieldKey: 'transcript',
            text: bLabel + ' has no caption or transcript summary yet.',
          });
        }
      }
      if (blk.type === 'audio' && d.media && d.media.kind !== 'none') {
        if (!getLocalized(d.transcript, lang, defaultLang).trim()) {
          accessibilityChecks.push({
            kind: 'info',
            group: 'accessibility',
            blockId: blk.id,
            fieldKey: 'transcript',
            text: bLabel + ' has no transcript for learners who cannot listen with sound.',
          });
        }
      }
      var blockWords = 0;
      Object.keys(d).forEach(function (k) {
        if (k === 'alt' || k === 'placeholder' || k === 'helperNote') return;
        var isOptional = (blk.type === 'sources' && k === 'items')
          || (k === 'transcript' && (blk.type === 'video' || blk.type === 'audio'));
        var v = d[k];
        if (v && typeof v === 'object' && !Array.isArray(v) && ('nl' in v || 'en' in v || 'de' in v)) {
          blockWords += inspectText(getLocalized(v, lang, defaultLang), blk.id, k, bLabel, isOptional);
        } else if (Array.isArray(v)) {
          v.forEach(function (item) {
            if (!item || typeof item !== 'object') return;
            ['label', 'detail', 'feedback', 'citation'].forEach(function (sk) {
              var sv = item[sk];
              if (sv && typeof sv === 'object' && ('nl' in sv || 'en' in sv || 'de' in sv)) {
                blockWords += inspectText(getLocalized(sv, lang, defaultLang), blk.id, k, bLabel, isOptional);
              }
            });
          });
        }
      });
      if (blk.type === 'richtext' && blockWords > 90) {
        writingChecks.push({
          kind: 'warn',
          group: 'writing',
          blockId: blk.id,
          fieldKey: 'body',
          text: bLabel + ' has ' + blockWords + ' words (>90) — consider splitting into shorter paragraphs or bullets.',
        });
      }
    });

    var tips = writingChecks.concat(accessibilityChecks);
    if (!tips.length) {
      tips.push({
        kind: 'ok',
        group: 'writing',
        blockId: '',
        fieldKey: '',
        text: 'Writing & accessibility checks look good — concise sentences and media descriptions are in place.',
      });
    }
    return {
      words: words,
      optionalWords: optionalWords,
      seconds: Math.max(5, Math.round((words / 150) * 60)),
      level: writingChecks.length ? 'warn' : (accessibilityChecks.length ? 'info' : 'good'),
      writingChecks: writingChecks,
      accessibilityChecks: accessibilityChecks,
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
        if (pressedOutside && outside(e, dlg) && dlg.getAttribute('closedby') === 'any') dlg.close();
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

  // Merge independent edits by stable object ID. A collision needs the author's decision.
  function mergeCourseEdits(base, local, latest) {
    var conflicts = [];
    function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
    function merge(before, ours, theirs, path) {
      if (same(ours, before) || same(ours, theirs)) return theirs;
      if (same(theirs, before)) return ours;
      var values = [before, ours, theirs];
      if (values.every(Array.isArray) && values.every(function (list) {
        return list.every(function (entry) { return entry && typeof entry.id === 'string'; });
      })) {
        var lists = values.map(function (list) { return list.map(function (item) { return item.id; }); });
        var ids = merge(lists[0], lists[1], lists[2], path + '.order');
        var maps = values.map(function (list) { return new Map(list.map(function (item) { return [item.id, item]; })); });
        // A deletion on one side and an edit on the other is a conflict too.
        var allIds = new Set(lists.flat());
        var items = new Map();
        allIds.forEach(function (id) {
          items.set(id, merge(maps[0].get(id), maps[1].get(id), maps[2].get(id), path + '.' + id));
        });
        return ids.map(function (id) { return items.get(id); });
      }
      if (values.every(function (v) { return v && typeof v === 'object' && !Array.isArray(v); })) {
        var fields = [];
        new Set(values.flatMap(Object.keys)).forEach(function (key) {
          var value = merge(before[key], ours[key], theirs[key], path ? path + '.' + key : key);
          if (value !== undefined) fields.push([key, value]);
        });
        return Object.fromEntries(fields);
      }
      conflicts.push(path);
      return ours;
    }
    var expedition = merge(base, local, latest, '');
    return { expedition: expedition, conflicts: conflicts };
  }

  // Share the Studio domain model across deployments; links stay on their data-owning site.
  function coursePaths(id) {
    var component = encodeURIComponent(id);
    var academy = !!(root.Xped && root.Xped.bootstrap);
    var base = (academy ? '/expedities/' : '/physio/elearning/') + component;
    return {
      overview: academy ? base : base + '/edit',
      edit: base + (academy ? '/bewerken' : '/edit'),
      report: base + (academy ? '/resultaten' : '/responses'),
    };
  }

  function learnerPath(token) {
    return ((root.Xped && root.Xped.bootstrap) ? '/start/' : '/elearning/p/') + encodeURIComponent(token);
  }

  var api = {
    coursePaths: coursePaths,
    learnerPath: learnerPath,
    mergeCourseEdits: mergeCourseEdits,
    SUPPORTED_LANGS: SUPPORTED_LANGS,
    LANG_LABELS: LANG_LABELS,
    DOMAIN_LABELS: DOMAIN_LABELS,
    DEFAULT_GLOSSARY: DEFAULT_GLOSSARY,
    XPED_ASSETS: XPED_ASSETS,
    BLOCK_CATEGORIES: BLOCK_CATEGORIES,
    BLOCK_CATALOG: BLOCK_CATALOG,
    HOTSPOT_PIN_COLORS: HOTSPOT_PIN_COLORS,
    pinTextColor: pinTextColor,
    SCALE_ANCHOR_PRESETS: SCALE_ANCHOR_PRESETS,
    EXPEDITION_TEMPLATES: EXPEDITION_TEMPLATES,
    FIELD_LABELS: FIELD_LABELS,
    getBlockMeta: getBlockMeta,
    normalizeCitationLink: normalizeCitationLink,
    hasMeaningfulAnswer: hasMeaningfulAnswer,
    balanceScore: balanceScore,
    normalizeMiniPlanAnswer: normalizeMiniPlanAnswer,
    deriveStepContentState: deriveStepContentState,
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
