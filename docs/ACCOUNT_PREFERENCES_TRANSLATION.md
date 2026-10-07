# Interface localization — 7 October 2026

Translation source is frozen for parent integration on `codex/account-preferences-gemini38`.

## Implementation

- Shared `LectureI18n` runtime follows `lp:preferences-changed` and persisted interface preferences. Interface language is independent of AI output language.
- English/Dutch catalogs cover static templates, shell navigation, account controls, public/help/legal pages, creation, learning/planning, tools/editors, administration and Workout. The original Dutch Physio interface has English equivalents. At this checkpoint the combined catalogs contain 3,609 Dutch and 183 English source phrases, before runtime reverse aliases for copied control labels.
- Live additions and accessibility attributes are localized without replacing markup or event handlers. Original source values are retained for language reversal. Bounded counter/summary patterns cover numbered cards/questions, counts, tool search results and creation summaries.
- User and generated content is protected by renderer-specific boundaries and explicit `data-user-content` annotations. This includes identity, filenames, folders, pack/session/book/workout names, study answers, notes, transcripts, editable text and custom selector options. Independent reviewer owns the detailed content-collision checks.
- Date/number presentation uses the selected interface locale in shared display utilities and page-specific calls. Internal ISO date calculations and timezone logic are unchanged.

## Verification

- Five Node tests pass: language/default behavior, bounded patterns, original Dutch Physio translation, and a static-template inventory contract that catches uncatalogued interface copy while excluding brands, units, shortcuts and bounded counts.
- Four isolated Playwright scenarios pass with retries disabled: public navigation/accessibility and reverse switching; live DOM updates and preservation of user content/input/handlers; output-language independence; and Dutch Settings/Planner/Dashboard/Tools/Creation at 1,440px and 390px without horizontal overflow.
- Representative screenshots inspected: Settings desktop/mobile, Planner mobile, Dashboard desktop, Tools mobile and Creation desktop. The Creation screenshot includes its existing output-language onboarding dialog and both its dialog text and underlying page copy are translated.
- Evidence: `/tmp/lp-i18n-final4/localization-Dutch-setting-39b69-tion-fit-desktop-and-mobile/`; final browser log `/tmp/lp-i18n-final4.log`.
- Scoped JavaScript lint and whitespace checks passed. Parent owns regenerated assets, full-suite verification and release.

## Boundaries

No user learning material is translated or rewritten. Arbitrary external/provider diagnostics remain in their original language when they do not match known interface messages. Catalog inventories and representative rendered checks do not assert that every possible data-dependent narrative or diagnostic has been exercised. No real user data, recordings, purchases or external AI calls were used for verification.
