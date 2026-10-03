# Website visual redesign master plan

Original full audit and plan approved for implementation on 3 October 2026. Read alongside `VISUAL_REDESIGN_PROGRESS.md` before every phase and after context compaction.

I launched **three subagents** and inspected the site in Chrome alongside the templates, styles, and interaction code. **Study Plan should become the design foundation for the whole product**, with layouts adapted to each task.

The biggest problems are inconsistent controls, weak page composition, excessive nested cards, competing actions, oversized introductions, and unfinished loading/error states. Improving general prettiness needs to be a deliberate part of the work.

**This is a plan only; no website code was changed.** We visually inspected the main desktop pages and many expandable flows. States requiring uploads, purchases, new shares, saved edits, or recorded study activity were reviewed in source. Mobile layouts, the populated Book editor, shared-link pages, and the local Physio workspace still need visual verification.

One important detail: **Batch Status already has an uncommitted redesign locally that differs from the live website.** That work should be reviewed and polished rather than duplicated.

---

**1. Shared design language — the foundation for every page**

The reference is [Study Plan’s styling](/Users/jaccovandermeulen/Desktop/lecture-processor/static/css/study-plan.css). Currently, [shared UI](/Users/jaccovandermeulen/Desktop/lecture-processor/static/css/shared-ui.css) and [the app shell](/Users/jaccovandermeulen/Desktop/lecture-processor/static/css/app-shell.css) define competing palettes and surfaces.

- Establish one blue primary/selection color, navy text, blue-gray secondary text, cool pale background, and consistent semantic success/warning/error colors.
- Adopt Study Plan’s rounded controls, softly edged white surfaces, restrained shadows, and clear selected states.
- Standardize typography: page titles, section headings, body copy, field labels, helper text, metadata, and numerical metrics.
- Establish consistent page margins, maximum widths, section spacing, card padding, and alignment. Dense editors should have a deliberate compact variant.
- Reduce unnecessary card nesting. Use whitespace, typography, and separators to establish hierarchy.
- Reserve strong gradients and prominent shadows for a few meaningful focal points.
- Standardize icons: consistent stroke weight, size, alignment, and background treatment. Replace mismatched emoji/Unicode interface icons where appropriate.
- Establish a clear button hierarchy: primary action, secondary action, quiet utility, destructive action.
- Make attractive empty states, stable loading skeletons, and useful error states part of the design system.
- Consolidate existing CSS definitions instead of adding another layer of overrides.

**2. Shared controls, dialogs, and motion**

This directly addresses the selectors and opening/closing behavior you like.

- Create one reusable family of dropdowns, searchable selectors, segmented controls, selection cards, checkboxes, switches, and numeric fields.
- Promote the Study Plan calendar and time controls into shared website-styled components.
- Improve desktop popover positioning so menus open beside their triggering control, remain inside the viewport, and do not cover unrelated fields.
- Use searchable selectors for long lists such as packs, folders, codes, and fonts.
- Standardize hover, pressed, selected, disabled, loading, invalid, and keyboard-focus states.
- Define both opening **and closing** transitions for menus, dialogs, sheets, accordions, and nested options.
- Use restrained motion: approximately 140–160 ms for control feedback, 200–240 ms for menus, and 240–320 ms for larger surfaces.
- Give long dialogs a fixed header and action footer with a scrolling body.
- Make wizard step changes preserve orientation and avoid abrupt size jumps.
- Standardize Escape, outside-click behavior, focus trapping, focus return, and nested-popover handling.
- Respect reduced-motion preferences and keep controls usable with the keyboard.
- Use consistent mobile sheets and safe-area spacing where desktop popovers become impractical.

**3. App navigation, header, and footer**

- Reduce visual competition in the long sidebar, particularly the Create section and expanded extra tools.
- Standardize section spacing, nested indentation, active links, icons, and expanding chevrons.
- Give every page a recognizable title/action arrangement.
- Keep account and credit controls in consistent positions.
- Reserve space during authentication and credit loading to avoid header movement.
- Group account-menu actions into identity, billing, data, and session sections.
- Use red selectively; Sign out should not compete visually with Delete account.
- Harmonize public, application, editor, and admin shells through shared branding and controls.
- Normalize footer spacing, typography, link treatment, and mobile wrapping.

---

**4. Dashboard — `/dashboard`**

Observed: a large introductory card delays useful information, while similar-looking cards create a flat hierarchy.

- Replace the oversized generic hero with a compact page heading and a useful “Continue studying” area.
- Make the next session or due review the principal action.
- Turn “cards due” into an actionable item.
- Recompose metrics with aligned numbers, smaller units, and quieter supporting text.
- Replace large “Loading…” strings with stable skeletons.
- Use Study Plan-style upcoming-session rows with clear dates, times, and actions.
- Remove duplicated pack names and raw-looking date formatting.
- Improve recent-pack rows with material badges and meaningful metadata; suppress zero-count clutter.
- Balance upcoming/recent sections and their empty states.
- Use consistent Study Plan terminology for Calendar links.

**5. Study Plan — Today**

Preserve the strongest parts: the next-session feature card, calm background, clear tabs, and supporting goal card.

- Refine long session titles and action wrapping.
- Make date/time formatting consistent with the interface language.
- Keep completion, rescheduling, saving, failure, and offline feedback visually coherent.
- Ensure empty, completed-for-today, and multiple-goal states look equally intentional.
- Give secondary actions enough clarity without competing with Start studying.

**6. Study Plan — Schedule**

- Reduce the disproportionate blank height of sparsely populated weeks.
- Improve the balance between navigation, week title, session summary, and actions.
- Make upcoming, completed, skipped, locked, and manual sessions distinguishable beyond color.
- Clarify the relationship between session selection and available actions. The inspected calendar’s help mentions complete/skip, while the opened editor presented Save/Cancel.
- Improve long event titles and dense weeks.
- Keep mobile agenda navigation consistent with desktop week navigation.
- Replace mixed English/Dutch date presentation with an explicit locale convention.

**7. Study Plan — Progress**

Observed: six metric cards form a four-plus-two layout, leaving an awkward empty area.

- Recompose the metrics into a balanced arrangement, such as three by two at the inspected width.
- Establish hierarchy between activity, performance, mastery, and streak metrics.
- Distinguish “no activity yet” from a measured zero performance result.
- Make readiness and mastery easier to interpret together.
- Improve the proportions of the planned/completed and goals sections.
- Reduce the visual prominence of calendar-subscription promotion relative to actual progress.

**8. Study Plan — goal wizard, session editor, and device calendars**

- Preserve the selection-card and field styling.
- Fix the tall exact-times step: its header, close control, and main action should remain reachable while the body scrolls.
- Add search to long study-pack selectors.
- Keep calendar/time popovers anchored and avoid unexpected surrounding scroll movement.
- Clarify selected availability versus instructional copy.
- Give schedule preview, conflicts, insufficient availability, regeneration, and acceptance distinct, polished states.
- Style reschedule and manual-session editing consistently.
- Break calendar subscription instructions into readable provider-specific steps; currently they run together.
- Polish subscription creation, copy-link feedback, existing subscriptions, rotation, revocation, and failure states.

**9. Legacy Planning and Calendar**

`/calendar` and `/stats` redirect to Study Plan’s Schedule and Progress views when v2 is enabled.

- Preserve coherent navigation and titles through those redirects.
- Decide whether the fallback `plan.html` and `calendar.html` remain supported.
- If retained, migrate their date fields, selectors, reminder settings, and session dialogs to the shared system.
- Avoid a separate full redesign of dormant fallback screens.

---

**10. Study Library — `/study`**

This is one of the highest-priority redesigns.

Observed: the global sidebar, large folder column, narrow pack list, and detail workspace compete for space.

- Add a visible page heading and a clear primary creation action.
- Make folder navigation substantially more compact.
- Replace oversized folder cards with concise icon/name/count rows, indentation, and contextual menus.
- Consolidate New Folder, New Subfolder, and Delete into sensible contextual actions.
- Improve the proportions of folder navigation, pack list, and selected content.
- Separate selection checkboxes from opening a pack.
- Standardize hover, selected, bulk-selected, and in-plan states.
- Improve pack title/metadata hierarchy and material badges.
- Add clear breadcrumbs, result counts, no-match states, and loading placeholders.
- Design a purposeful unselected state.
- On mobile, use explicit folder → list → detail navigation.

**11. Selected pack, notes, and fullscreen reading**

- Compact the pack summary so the actual material appears sooner.
- Give Learn a stable primary position.
- Present metadata as readable information, with editing behind an intentional action.
- Consolidate the overlapping export/download entry points.
- Keep share/edit/export secondary and destructive actions in overflow menus.
- Use shared tabs and selectors.
- Improve notes typography, reading width, headings, lists, tables, images, and code blocks.
- Refine the highlighting toolbar: grouped swatches, clear active tool, quiet disabled actions, and unobtrusive save feedback.
- Remove irrelevant generic advice from packs where it does not apply.
- Make fullscreen reading preserve toolbar conventions, scroll position, and return context.
- Design missing content, failed autosave, deleted packs, and unavailable audio states.

**12. Study Pack Builder — `/study-pack-builder`**

Observed: the fullscreen builder feels visually separate, and a tiny picture preview occupies excessive vertical space.

- Harmonize its header, navigation rail, forms, buttons, and background.
- Use consistent product terminology instead of switching between pack/deck language.
- Replace browser-native folder/import selectors with shared controls.
- Keep metadata forms at a comfortable width and group optional details.
- Keep Save, save status, and Exit consistently accessible.
- Add collapsed summaries or navigation for large card/question collections.
- Replace the oversized picture section with compact attachment previews and aligned controls.
- Improve front/back field sizing and card numbering.
- Give questions clear answer-option structure and correct-answer selection.
- Standardize inline validation and explanation fields.
- Improve CSV upload guidance, append/replace selection, preview, per-file results, and error recovery.
- Clarify when imports save automatically versus when Save Pack is required.
- Use the same editing components in the inline Library editor.
- Polish the unsaved-exit dialog.

**13. Study session setup**

Observed: mode selection is buried, some option grids leave empty quadrants, and Algorithm styling introduces another palette.

- Lead with choosing a study mode and starting.
- Reuse Study Plan selection cards and segmented navigation.
- Make layouts work deliberately with one, two, three, or four available modes.
- Standardize mode names across setup and the session itself.
- Simplify mastery summaries and reduce competing decorative indicators.
- Replace rainbow algorithm tiles with restrained semantic styling and readable contrast.
- Place advanced settings behind clear disclosure.
- Explain disabled/inapplicable settings beside the control.
- Keep the primary action visible and avoid asking users to choose the same mode twice.
- Replace stale Planning terminology.

**14. Flashcards, practice tests, Write, and Match**

These active-session states were source-reviewed rather than exercised.

- Standardize session header, pack context, progress, fullscreen, exit, and completion screens.
- **Flashcards:** consistent card proportions, long-text handling, image sizing, front/back cues, restrained flip motion, grading controls, Peek, and card-list styling.
- **Practice tests:** comfortable question width, consistent answer rows, clear selected/correct/incorrect states, explanations, and next-question placement.
- **Write:** aligned prompt/input/actions, clear Check versus Reveal behavior, and structured expected/actual-answer feedback.
- **Match:** consistent tile dimensions, clear selection/match/error states, readable timer, and polished results/replay/history.
- Design empty, no-eligible-items, resumed, offline-save, and failed-save states.
- Preserve context when returning to Library or Study Plan.

**15. Study pictures, audio, folders, and sharing**

- Give picture viewers the shared dialog, close control, loading frame, and motion.
- Standardize the audio player’s playback, progress, speed, download, and unavailable-audio states.
- Ensure floating audio controls cannot cover content.
- Unify folder creation/editing forms and validation.
- Use a consistent privacy selection control in sharing dialogs.
- Clearly distinguish saved sharing state from pending changes.
- Polish link creation, copy feedback, errors, and unavailable/revoked states.
- Standardize confirmation dialogs and reserve destructive styling for the final destructive action.

**16. Interview coding workspace**

Source-reviewed.

- Make the transcript the primary reading area and the code manager the supporting panel.
- Simplify the toolbar and move Reset into overflow.
- Use a shared searchable code selector.
- Improve selection, quotation-comment, code-color, and applied-code presentation.
- Keep category colors separate from action/status colors.
- Design AI draft, accept/reject, merge, delete, undo, export, and save feedback coherently.
- Include usable empty, loading, and failed states.

**17. Shared study — `/shared/<token>`**

Source-reviewed.

- Use the same reading typography, material badges, surfaces, and header conventions.
- Add navigation between notes, flashcards, and questions.
- Improve front/back and question/answer hierarchy.
- Give shared folders compact pack navigation and mobile list/detail behavior.
- Make audio exclusion a quiet contextual note.
- Design private, expired, unavailable, empty, and failed-preview states.
- Verify large shares and long notes rather than only short examples.

---

**18. Lecture Notes — `/lecture-notes`**

Observed: oversized gradient headings, nested cards, repeated instructions, and expanded sections with uneven columns.

- Replace the marketing-sized introduction with a compact workspace header.
- Organize the page around title → sources → options → action.
- Balance slides and audio source areas.
- Compress repeated required/upload/drop/browse instructions.
- Standardize selected-file rows, metadata, replacement/removal, validation, and drag-over feedback.
- Present upload/import/record as coherent audio-source choices.
- Reuse Voice Notes recording and playback conventions.
- Move detailed troubleshooting into secondary help.
- Consolidate language, study-tool choices, and quantities into a well-aligned settings area.
- Show readiness and credit cost near the primary action.
- Design importing, processing, safe-to-leave, failure, retry, and billing feedback consistently.
- Polish results tabs, notes typography, flashcard/test previews, exports, and “process another” transitions.

**19. Slides Extraction — `/slides-extraction`**

Shared implementation; variant reviewed in source.

- Use a purposeful single-source composition.
- Keep optional study tools secondary.
- Explain outputs once, with consistent selection controls.
- Cover replacement, validation, extraction progress, language, optional outputs, and exports.
- Ensure progress/results wording fits slides extraction.

**20. Interview Transcription — `/interview-transcription`**

Shared implementation; variant reviewed in source.

- Use an audio-first layout and the shared audio-source controls.
- Present summary and structured headings as clear optional additions.
- Place incremental cost beside those choices.
- Improve timestamp, speaker, transcript, summary, and section hierarchy.
- Make exports and the transition into interview coding coherent.
- Remove lecture-specific wording from this flow.

**21. Batch Processing and Instant Batch — all ten variants**

Includes lecture, slides, interview, audio transcription, and text-combine variants under `/batch_mode…` and `/instant_batch_mode…`.

- Reduce the oversized boxed heading.
- Make mode and processing-speed choices compact and understandable.
- Replace the large defaults section with aligned controls and expandable advanced settings.
- Use one selection language instead of green recommendations competing with purple choices.
- Make each row scannable: title, source completeness, files, inherited/custom settings, and contextual actions.
- Show general guidance once; show row-specific help only when relevant.
- Reduce repeated warning and import text.
- Keep aggregate readiness, cost, and submission controls clear.
- **Lecture:** balanced slides/audio sources.
- **Slides:** remove unused audio layout.
- **Interview:** compact audio and optional-output controls.
- **Audio transcription:** focused source/transcript options.
- **Text combine:** clearly distinguish slide text from transcript text and indicate pair completeness.
- **Instant processing:** use the same layout while presenting live per-row progress.
- Cover incomplete rows, failed imports, insufficient credits, partial success, individual downloads, and ZIP output.

**22. Batch Status — `/batch_status` and batch details**

- Start with the existing local redesign, including its unified list, tabs, filters, and detail route.
- Apply the shared header, tabs, badges, filter controls, spacing, and button hierarchy.
- Make status/progress/results easy to scan.
- Keep archive and utility actions secondary.
- Replace blank loading tables with skeletons and explicit empty/no-match states.
- Give waiting, active, partial, completed, failed, and archived states clear semantics.
- Compose detail pages around summary, progress, and individual results.
- Make expired/missing audio a contextual result state.
- Preserve content during refresh failures and provide visible recovery.
- Verify narrow-screen rows, long filenames, and large batches.

**23. Voice Notes — `/voice-notes`**

Observed: mint tabs, purple actions, a heavily shadowed navigation bar, prominent Delete buttons, and conflicting audio availability feedback.

- Use Study Plan tabs and reduce the navigation shadow.
- Make the recording timer/status the visual center.
- Give Record/Pause/Stop clear state-dependent hierarchy.
- Keep import secondary.
- Improve library card/row title, date, tag, and status hierarchy.
- Move destructive actions into overflow.
- Make detail views prioritize audio and transcript.
- Reconcile unavailable-audio messages with the Download Audio control.
- Consolidate stacked retention/error notices.
- Improve transcript reading width, highlighting controls, and export actions.
- Replace native settings selects with shared controls.
- Design offline, pending sync, processing, failed transcription, archive, share, and generated-study-tool states.

---

**24. Tools Overview — `/tools`**

Observed: an undifferentiated wall of equally emphasized cards.

- Group tools by purpose: capture/transcribe, extract/read, bulk processing, and creative tools.
- Establish clearer primary versus occasional tools.
- Standardize icons, description length, baseline alignment, and card proportions.
- Make single-file versus batch choices understandable.
- Show cost requirements consistently.
- Use deliberate responsive grouping and consistent hover/focus behavior.

**25. General Transcriber — `/general-transcriber`**

Observed: a large blank output panel dominates before any input is provided.

- Rebalance the initial composition around adding a source.
- Replace the empty output rectangle with a useful placeholder.
- Expand the transcript area when content exists.
- Simplify upload and retention guidance.
- Remove internal implementation wording such as “same audio prompt.”
- Standardize file rows, language selection, readiness, and cost.
- Polish long transcripts, copy/download feedback, progress, errors, and retry.

**26. Lecture Downloader — `/lecture-downloader`**

Observed: the main form is narrow while a large explanatory panel repeats format descriptions.

- Give URL input and format selection the main space.
- Replace repeated explanations with concise option descriptions.
- Improve wrapping and selected-format styling.
- Keep technical troubleshooting secondary.
- Make completed downloads useful result cards.
- Design invalid URLs, expired playlists, authentication issues, processing, failed downloads, and completion.

**27. Document Reader — `/document-reader`**

- Put source selection before advanced/question controls.
- Use the shared disclosure and upload components.
- Improve selected-document presentation.
- Give results a readable hierarchy and typography.
- Replace the blank output area with a purposeful initial state.
- Polish processing, errors, copy, export, and long-content scrolling.

**28. Image Reader — `/image-reader`**

Source-reviewed variant.

- Use a polished thumbnail collection with clear add/remove actions.
- Explain the image limit near the collection.
- Make upload progress and per-image errors contextual.
- Keep optional questions secondary.
- Present extracted content clearly and consistently with Document Reader.

**29. URL Reader — `/url-reader`**

Source-reviewed variant.

- Give the URL field enough visual space.
- Keep public-page/support guidance concise.
- Distinguish invalid URLs from inaccessible pages.
- Use the same analysis/result/export layout as the other readers.
- Handle long page titles and extracted content gracefully.

**30. Book Studio — `/books`, book editor, and shared books**

The bookshelf was visually inspected; editor and sharing states were source-reviewed.

- Keep expressive book content while harmonizing the surrounding interface with the application.
- Improve navigation/account continuity.
- Polish shelf tabs, search, sort, covers, metadata, and loading/empty states.
- Distinguish local, cloud, shared, favorite, and trash states consistently.
- Standardize compact editor toolbars, iconography, inspector panels, and selected tools.
- Unify font, size, color, alignment, layers, image, drawing, shape, path, and table controls.
- Clearly distinguish object settings from page/book settings.
- Polish page thumbnails, add/reorder/delete, spreads, zoom, reading view, and page navigation.
- Include new-book setup, themes, details, assets, history, comments, and recovery dialogs.
- Unify sharing roles, links, copy/revoke, and inaccessible-book presentation.
- Improve export choices, print warnings, previews, progress, and failures.
- Make saving, offline, edit ownership, conflicts, and recovery visible without overwhelming the editor.

**31. Video Overlay Builder — `/video-overlay-builder`**

Observed: crowded top controls, empty side panels, and irrelevant table fields visible before a table is selected.

- Create a recognizable compact editor header.
- Group project actions and save status.
- Separate project navigation, slides, overlays, and contextual settings.
- Show controls only when relevant to the selected object.
- Give the canvas greater visual prominence.
- Make the empty workspace instructive.
- Group zoom/navigation/preview controls coherently.
- Separate recording/output controls from everyday editing.
- Standardize selection, drag/resize, timing fields, and inspector forms.
- Include import validation, save errors, reset/delete confirmations, recording states, and export feedback.

---

**32. Landing page — `/`**

- Replace the generic oversized gradient introduction with a more deliberate composition.
- Use actual product imagery/previews to connect the public site to the polished application.
- Refine headline width, wrapping, typography, and background decoration.
- Establish a clearer CTA hierarchy and consistent destination labels.
- Make feature sections visually distinct through useful content rather than repeated generic cards.
- Harmonize lower-page sections and spacing.
- Design the mobile hero and navigation intentionally.

**33. Features — `/features`**

- Reduce repetitive hero/card patterns.
- Organize around the real user journey.
- Use current interface examples for processing and study modes.
- Standardize preview tabs, badges, and icons.
- Refine the time calculator’s controls, assumptions, and result hierarchy.
- Improve comparison-table readability and mobile treatment.
- Reduce repeated gradients and prominent CTA shadows.
- Check that feature descriptions match the current product.

**34. Help Center — `/helpcenter`**

- Replace the huge multiline introduction with a compact title and useful topic navigation.
- Make instructions easier to scan.
- Include all major topics in the local navigation.
- Standardize step spacing, lists, links, and informational callouts.
- Distinguish requirements, instructions, billing, and troubleshooting.
- Improve reading width and mobile navigation.

**35. FAQ — `/FAQ`, with `/faq` redirect**

- Use a compact heading and short introduction.
- Adopt shared accordions with consistent row height, chevrons, expanded state, and motion.
- Constrain answer width.
- Group questions by topic.
- Preserve focus and orientation when expanding answers.
- Harmonize supporting help links and calls to action.

**36. Privacy and Terms — `/privacy`, `/terms`**

- Restore shared public branding/navigation around the reading experience.
- Use a restrained title/date/document header.
- Improve section navigation, heading scale, paragraph rhythm, and lists.
- Standardize links, focus states, mobile margins, and print presentation.
- Keep legal wording changes separate from the visual redesign.

---

**37. Sign-in, signup, reset, and onboarding**

- Use the shared modal shell, fields, blue actions, and close controls.
- Reduce decorative height so forms fit smaller screens.
- Fix password guidance crowding the visibility button.
- Move requirements into helper text beneath the field.
- Animate transitions between sign-in, signup, and reset without abrupt jumps.
- Polish field errors, form errors, pending submission, provider sign-in, and reset confirmation.
- Preserve the user’s originating task through authentication.
- Restyle language onboarding with shared selection cards.
- Standardize custom-language reveal and validation.
- Apply the same treatment to daily-goal dialogs.

**38. Buy Credits, pricing overlay, history, and payment return**

- Remove excessive nested panels.
- Clarify credit categories before emphasizing prices.
- Align prices, units, descriptions, and comparison information.
- Reduce competition between six purchase buttons and repeated Best Value badges.
- Harmonize pricing typography and colors.
- Show relevant balances near purchase choices.
- Reuse one catalog presentation across the page and overlay.
- Fix signed-in loading states that briefly suggest the user must sign in.
- Polish purchase-history rows, empty states, loading, errors, and retries.
- Design persistent payment-success, pending, canceled, and failed-confirmation states.
- Keep mobile comparisons and badges legible.

**39. Account menu, export, and deletion**

- Improve menu grouping and action hierarchy.
- Use shared selection rows in data-export dialogs.
- Make export categories and formats easy to understand.
- Keep omission/retention explanations concise and contextual.
- Show export progress, success, and retry within the dialog.
- Use consistent destructive confirmation styling for account deletion.
- Ensure long dialogs, nested overlays, and keyboard navigation work coherently.

---

**40. Admin — `/admin`**

Observed: overlapping deployment values, a crowded wrapping action bar, and an orphan metric card.

- Fix long deployment values overlapping labels.
- Simplify top actions into primary refresh, export utilities, and account/navigation actions.
- Align time filters and section navigation.
- Recompose the eleven metrics into a deliberate hierarchy.
- Separate operational health from business analytics.
- Standardize charts, legends, labels, and empty states.
- Improve tables: column sizing, row rhythm, numeric alignment, status labels, and responsive handling.
- Remove redundant raw status combinations such as `failed · FAILED`.
- Improve credit-management search, selected-user summary, fields, toggles, and feedback.
- Harmonize calculators, analyzers, prompt inventory, recent jobs, and purchase tables.
- Keep maintenance/destructive actions distinct and contextual.

**41. Workout — `/admin/workout`**

Observed: a separate purple identity, excessive desktop whitespace, colliding progress labels, and a partly clipped setup action.

- Preserve the useful mobile-oriented structure while adopting shared visual foundations.
- Use intentional desktop layouts rather than a narrow phone column surrounded by empty space.
- Improve Today’s schedule/empty-state composition.
- Make routine previews easier to scan and reduce repeated dominant Start buttons.
- Fix muscle-group labels colliding with progress bars.
- Improve empty charts and metric units.
- Group Settings coherently and keep save actions clear.
- Fix setup-sheet height and action visibility.
- Replace native date controls with the shared calendar.
- Standardize routine/exercise editing, search, timers, plan setup, bodyweight, history, and sharing sheets.
- Replace browser confirmation boxes with shared dialogs.
- Verify logger rows, mobile keyboard behavior, pause/resume, finish/discard, offline drafts, and synchronization feedback.

**42. Workout shares — `/workout-shares/<token>`**

Source-reviewed.

- Use recognizable product branding and typography.
- Improve routine/exercise hierarchy and technique-note readability.
- Align set, repetition, load, rest, and summary values.
- Design mobile and print views.
- Give missing/revoked shares a polished unavailable state.
- Ensure server-generated 404s are as coherent as client-side error states.

**43. Physio launcher — all cloud `/physio…` routes**

The cloud SOAP, RPS, reasoning, knowledge, and cases routes currently render the same launcher.

- Harmonize its green/mint visual identity with the application.
- Improve the relationship between companion status and available action.
- Design checking, connected, unreachable, and blocked states.
- Use the shared disclosure pattern for startup help.
- Investigate the observed Sign in header despite authenticated state elsewhere.
- Make language choices consistent across shell and module.

**44. Local Physio workspace**

Source-reviewed; Chrome blocked access to the local companion during the audit.

- Harmonize the three-pane workspace and define narrower-screen behavior.
- **Knowledge:** prioritize search, region selection, results, and source context.
- **Body map:** refine selected regions and provide keyboard-accessible alternatives.
- **Note reader:** improve text, tables, citations, media, and related navigation.
- **Sources:** make Import → Review → Activate clear, with coherent upload, metadata, preview, and save states.
- **Graph:** improve labels, legend, selection, empty states, and accessible relationship browsing.
- **Cases:** use shared forms instead of native prompts; clarify active case and session context.
- **Deep search:** polish query setup, progress, cancellation, results, and scrolling.
- **Media:** use shared preview dialogs and loading/error treatment.
- Replace separate select/confirmation implementations with shared components.

**45. Error and access states across the site**

- Design not-found, unavailable-share, expired-session, access-denied, server-error, and offline experiences.
- Keep appropriate branding, a short explanation, and a useful next action.
- Preserve existing content when a refresh fails.
- Prevent loading from masquerading as empty, signed-out, or unavailable.
- Make long titles, filenames, emails, hostnames, and translated text safe for the layout.

---

**Implementation order**

| Phase | Work |
|---|---|
| 1 | Fix visible overlaps/clipping and establish shared tokens, controls, dialogs, and motion. |
| 2 | Study Library, selected packs, Builder, Dashboard, and Study Plan refinements. |
| 3 | Session setup and all study modes; Lecture Notes, Batch, and Voice Notes flows. |
| 4 | Readers, transcription/downloader tools, Book Studio, and Video Overlay Builder. |
| 5 | Public pages, authentication, credits/account, Admin, Workout, and Physio. |
| 6 | Full visual and interaction verification across every page and state. |

Each page should be completed through **layout → controls → nested flows → loading/error states → responsive polish**, rather than receiving only a color pass.

**Acceptance criteria for every page**

- Visually coherent with Study Plan.
- A clear focal point and primary action.
- Deliberate spacing and density, without awkward empty areas or unnecessary nested boxes.
- Polished selectors, disclosures, menus, dialogs, and closing transitions.
- Usable populated, empty, loading, error, and long-content states.
- Verified at desktop, smaller laptop, tablet, and mobile widths.
- Reachable actions with mobile keyboards and 200% zoom.
- Keyboard navigation, visible focus, and reduced-motion support.
- Screenshots of important states and checks of the transitions between them.

The largest visible gains will come from **Study Library’s layout, the creation flows’ hierarchy, and a genuinely shared control/dialog system**. Those should establish the standard that the remaining pages follow.
