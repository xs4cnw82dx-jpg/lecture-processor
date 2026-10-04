# Creation and checkout polish — 4 October 2026

Owns requirements 2, 6, 7 and 8 in STUDY_FLOW_POLISH_PLAN. Implemented against the supplied credit/checkout and URL/recorder screenshots. No billing changes, external purchases, uploaded user files or generated assets.

## Changes

- Buy Credits category rows use the actual heading/description heights, shared with CSS subgrid on desktop. Removed the fixed 78px description spacer and shortened the heading minimum. Bundle rows remain aligned; tablet/mobile use natural rows.
- Checkout controls reset before page caching and on persisted pageshow. An attempt counter prevents an obsolete response from redirecting a restored page or changing its new checkout state. Returning does not create a new checkout automatically. The Lecture Notes Buy more credits entry navigates to this same page; its dormant legacy modal checkout was left untouched.
- All LMS guidance leads with playing the recording, opening DevTools with Cmd + Option + I (Mac), Ctrl + Shift + I (Windows), or right-click Inspect, then Network → index.m3u8 → copy request URL → import. Explains reloading/playing with Network open if the request was not captured. Removed normal-page-first/failed-page detours.
- Covered Lecture Notes and Interview mode hints, batch row instructions and empty URL errors, Features, FAQ, Help Center, Lecture Downloader and backend empty-import validation copy. Shared server-rendered instructions live in _playlist_import_steps.html; dynamic batch instructions match. Existing access/host constraints remain intact.
- Recorder content now opens with an 18px inset below the disclosure header. Timer/header and action spacing increased; timer uses tabular digits and calmer weight. Padding animates back to zero when closed.
- Batch URL title and explanatory information now each have 16px separation from the preceding control. Playlist steps have readable list spacing.

## Verification

- New e2e/creation-polish.spec.js verifies 1440/1024/390px geometry, actual credit-description/card distance, recorder header/timer separation and full closure, batch URL/help separation, desktop/mobile overflow, platform-specific playlist guidance across public/download pages, and checkout Back recovery through both direct Buy Credits and Lecture Notes entry paths.
- Checkout uses only a mocked local checkout endpoint/page. Verifies real navigation away/back, then explicitly dispatches persisted pagehide/pageshow because the browser automation environment may disable real bfcache. A held obsolete response must not redirect; a fresh click must create a new session successfully. No Stripe request or purchase.
- Combined creation, batch feedback and public presentation browser run: 17 passed. Final creation-only rerun: 6 passed, including complete disclosure-collapse coverage after the final spacing refinement.
- Isolated Python route/template contracts: 47 passed. Import-audio domain checks: 5 passed. ESLint and git diff --check passed.
- Evidence /tmp/study-flow-creation-evidence: credits, open recording/import and batch import at 1440, 1024 and 390. Inspected desktop credits/recorder/batch and mobile recorder/batch/credits captures. Public presentation matrix also checked all existing four widths. No overlap/clipping observed. Screenshots reset scroll position before full-page capture.

## Handoff

Files: static/css/{buy-credits,index,batch-mode,features}.css; static/js/{buy-credits,index-app,index-mode-config,batch-mode,lecture-downloader}.js; templates/{index,features,faq,helpcenter,lecture_downloader,_playlist_import_steps}.html; lecture_processor/domains/upload/import_audio.py (one error-copy change only); e2e/creation-polish.spec.js and the matching text locators in e2e/batch-feedback.spec.js.

Source requests remain compatible: playlist-first guidance does not remove backend support for an otherwise valid supported recording-page URL. Parent owns generated assets, integration and delivery.

## Planned review durability — delegated backend repair

Independent adapter review found a crash window between saving a planned answer and applying its client SRS update. The parent reassigned the narrow backend repair here; the learning owner retains the viewer and adapter.

`planned_review_service.py` prepares canonical card counters, intervals, due-rollup, daily totals and streak writes. `study_run_service._atomic` commits these together with the accepted checkpoint and run receipts, with all Firestore reads preceding writes. Receipts use content identity plus first/retry attempt, so lost responses, retries and unchanged cards moving indexes do not repeat reviews. One stable server counter bucket across all runs preserves the existing free-mode merge format. A fully occupied legacy 32-device map fails safely before writes rather than evicting progress. Notes activity records a study day once after 60 seconds, without counting a question answer.

Checkpoint replies containing pending reviews return canonical `card_states`, `summary` and `streak_data` beside `run`, including receipt replays. The client owner removes the former post-checkpoint SRS mutations and hydrates this response. Unsynchronized local answers still use the adapter's persisted pending queue; only accepted server requests can be durable across device loss.

Verification: 67 isolated tests passed across planned runs, durability, progress rollups and planner API. Final strengthened durability run: 11 passed. Coverage includes commit rollback/retry, lost-response replay through the HTTP route, separate first/retry receipts, 40 runs with one stable counter bucket, concurrent free-mode state merging, notes-only activity, content-index remapping, full-device-map rollback and malformed action fields. Scoped Ruff and whitespace checks passed. Parent owns actual-API browser integration and delivery. No real account data or external services were used.
