# Dark appearance — 7 October 2026

Implemented on the shared preferences branch. Read alongside the approved visual redesign and current preferences integration plan. Parent owns account preferences, Settings and release workflow.

## Delivered

- A semantic dark palette in `static/css/theme.css`: deep navy canvas, elevated slate surfaces, quiet borders, readable blue links and distinct success/warning/error states.
- Existing component color declarations across the site use these tokens with their original light colors as fallbacks. Layout, type scale, spacing, user content, images and export artwork are preserved. No inversion/filter treatment and no wholesale specificity overrides.
- Synchronous `theme.js` applies device appearance before paint; validated settings events and cross-tab storage updates change the appearance without replacing the DOM or resetting form fields. Corrupt/blocked storage falls back safely.
- All full-page templates include the shared preferences head, including public, authentication, study, creation, tools, shared views, Admin, Workout and the clinical companion. Actual Settings UI and persistence are parent-owned.
- The Physio launcher forwards only validated theme/language parameters. Only the explicitly marked loopback companion imports them, removes them from the URL, and preserves owner-authorization fragments. Main-site pages never import appearance from arbitrary URLs.
- Voice and Workout service-worker cache generations now include theme, locale catalog/supplement and preference assets. The standalone Workout offline page includes appearance and locale bootstraps. Existing account/API cache restrictions are unchanged.
- Print uses the original light fallbacks; actual editor canvases, document colors and color swatches are excluded from interface recoloring.

## Verification

- **16 isolated browser tests passed** (`e2e/theme.spec.js`): 12 representative routes at 1440px and 390px, no unexpected opaque light panels or horizontal overflow, live theme switching retaining typed inputs, semantic text/background contrast >= 4.5:1, Physio transfer authorized clinical reload with retained appearance, and computed print restoration to light component colors.
- **6 client tests passed** (`tests_js/theme.test.js`): early paint bootstrap, settings events, corrupt/denied storage, account-scoped cross-tab updates, validated local-companion import and rejection of hosted-page imports.
- **17 scoped backend/cache tests passed** (`tests/test_frontend_cache_contracts.py`, `tests/test_workout_api.py`).
- All component light-mode fallbacks were mechanically compared with the original CSS and are identical (ignoring whitespace). All **38 stylesheets parsed without warnings** through esbuild; targeted JS lint and whitespace checks passed.
- Inspected desktop/mobile renders for Study Plan, Library, batch flow, public landing, Settings, Admin, Workout and clinical workspace. Full fixture captures are under `/tmp/dark-mode-final-tests`; additional state captures are under `/tmp/dark-mode-evidence`.
- Admin/Workout additional screenshots use real template markup with synthetic display data, not live accounts. Clinical lifecycle test uses the isolated companion and synthetic owner authorization. No production services, uploads or user data were used.

## Integration handoff

Parent must regenerate registered JS assets, run complete integrated suites, and complete PR/checks/merge/local-main/deployment verification. Dark-mode tests isolate appearance from preference hydration; the parent's Settings tests cover real preference ownership and persistence. The old service-worker cache-version source assertion was updated to the new Voice generation.

## Delegated localization follow-up

Parent assigned the two remaining tools/learning literal inventories after the dark scope froze. `static/js/i18n-dynamic-tools.js` supplies **552 Dutch interface translations** and **8 English translations** for existing Dutch workout feedback. All 240 first-pass messages and 309 second-pass UI messages are covered; 25 actual demo flashcard/question materials were deliberately excluded. Natural Dutch follows the shared glossary (Studieplanning, Studiepakket, Leerkaarten, Collegeaantekeningen). No user content, technical CSV field names, model identifiers or behavior changed. Parent owns asset inclusion and complete localization/integration verification. Targeted lint and source inventory counts pass.

Final Physio regression: all six clinical workflow/browser checks passed with explicit Dutch preference transfer and no retries. Added missing Play/Mute/Unmute translations; audio playback assertions still check actual duration and paused state.
