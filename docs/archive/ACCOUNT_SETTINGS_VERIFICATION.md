# Account settings and Workout review — 7 October 2026

Independent review found and parent fixed:

- A delayed Firebase token could dispatch a preference write for an account after switching accounts. The request now checks the captured account generation before fetching; stale GET/PUT responses remain ignored.
- Falsy non-object JSON payloads bypassed preferences validation. The endpoint now requires an actual object.
- The language select lacked the marker enabling the site's custom selector. The Settings selector now uses that shared control.
- A delayed Workout session login could set an old admin cookie after an account switch. The shared shell request path now guards identity before sending and clears the admin cookie when a login response arrives for an obsolete session.

## Automated checks

- `tests/test_account_preferences.py`: **12 passed**. Authentication, defaults, persistence, UID isolation, partial updates preserving output language/favorites, invalid types/values, deleting account protection, storage failures, and non-admin denial for session login, Workout API and cookie-protected page.
- `e2e/settings.spec.js`: account preference navigation/reload; save rollback/retry; initial load recovery; late GET/PUT/token account switch; sign-out controls; custom language selector; admin Workout navigation/session/cookie handling; desktop/mobile overflow and appearance. **11 settings scenarios passed** with the real translation catalog, including the Dutch settings heading and zero browser errors. Both delayed Workout session edge cases passed.
- Python and JavaScript correctness lint passed for these new tests.

## Render inspection

Inspected `/tmp/settings-tests/settings-1440-light.png`, `settings-1440-dark.png`, `settings-390-light.png`, and `settings-390-dark.png`. Consistent rounded controls/surfaces, readable hierarchy, comfortable responsive wrapping, and no horizontal overflow. The selector and appearance toggle fit mobile without covering helper text. Dark appearance preserves clear surface separation and text contrast.

All tests used isolated preview servers with temporary storage, mocked accounts and fake APIs. No real preferences, cookies, user data or external services were changed. Parent owns generated assets, full integration and release.

## Translation content safety

Independent source audit found actual notes, quiz/Write answers, Dashboard cards, user titles, filenames and Workout/Book content surfaces missing from the translation boundary. Added precise content selectors and shared selector propagation; the translation owner added conditional user-content markers for mixed UI/user titles in Planner, Dashboard and Book. Unmatched strings keep their original whitespace. Returning to English also restores translated labels copied into custom selectors. Theme/save events with unchanged language no longer trigger a full page translation scan.

`e2e/i18n-content-safety.spec.js`: **7 passed** with the real catalog and actual page/API fixtures. Collision strings Save, Today, Overview and Settings remain unchanged as note text, quiz prompts/options/explanations, correct-answer comparison, Write prompts/answers, flashcards, folder/pack names, Dashboard due card text and batch titles. Builder native and enhanced folder options remain intact across language changes. Nearby interface controls still translate.

Runtime and shared-control sources frozen after the passing safety run; parent owns the final build/full-suite validation.

Final representative captures are committed in `docs/redesign-evidence/settings-dark-desktop.png` and `settings-dutch-mobile.png`. The parent inspected both: dark surfaces, custom selector and animated switch are consistent with Study Plan; Dutch copy remains readable at 390px.
