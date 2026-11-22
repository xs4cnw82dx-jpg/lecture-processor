# Book Studio release QA

## Automated validation

- Full backend suite: 646 tests passed.
- Client utility suite: 102 tests passed, including existing video-builder tests.
- GitHub browser suite: all 30 tests passed, including four Book Studio acceptance journeys covering local recovery, navigation/focus, multiple-image drops, invalid files, ZIP round trips, five export combinations, 390 px layout, reduced motion and pen input.
- Backend lint, JavaScript lint, asset freshness, repository hygiene, secret checks, smoke checks and the existing Functions checks passed.
- After the export-spacing and revoked-access fixes, all 19 focused book backend tests, JavaScript lint and asset checks passed. The final PR checks must also pass before merging.

## Hands-on browser validation

- Completed the actual Chrome Google sign-in flow using the existing account.
- Created **A Little Brain’s Moonlit Idea — Demo** as a cloud book: front cover, four original story pages and back cover.
- Inspected and used two non-sensitive transparent PNG illustrations already in Downloads without modifying their originals. Both uploaded through the actual file picker to private Supabase storage and survived saving, reload and reopening in another tab.
- Verified modest default image sizing, 65 mm proportion-locked resizing, image library reuse, crop controls, soft edges, all five font-family controls, font thickness, an editable circle, page creation and navigation.
- Saved the named cloud version **Complete moonlit story**. Downloaded a portable backup and inspected its version metadata and two original assets.
- A second Chrome tab opened read-only while the first held the lease; owner takeover succeeded.
- In a separate, signed-out browser session, **Moonlight Reader** opened a view link and posted a comment without acquiring the editing lease. An update appeared while preserving the reader's back-cover position and 110% zoom.
- **Moonlight Editor** opened an edit link, waited for the owner to finish, acquired the lease, edited a page title and saved. Owner takeover ended the guest's turn. Fixed stale inspector controls after lease loss.
- Revoked both test links. Reloading the guest book showed the persistent **This book is not available** screen. No demonstration link remains active.
- Reviewed desktop, 757 px and actual 390 × 844 px layouts. At 390 px the document width is exactly 390 px, with no horizontal page overflow. Checked mobile settings, native toggle appearance and reading navigation; reset viewport overrides afterward.

## Word and PDF validation

- Downloaded faithful and editable Word documents in both cut-and-bind and fold-and-staple arrangements, plus PDF, through the actual export dialog.
- Rendered and inspected every sheet of all four Word variants. Fixed editable Word line spacing that inherited the sheet anchor's tiny line height; re-exported and re-rendered both editable variants successfully.
- Opened editable output in Microsoft Word on macOS. Edited a native text box and selected/moved the native circle, then closed without saving test changes.
- Reviewed all four PDF sheets and measured every page at exactly **297 × 210 mm**. Transparent illustrations, front/back half sheets, sequential pairs and booklet padding/order were correct.
- Editable Word may use fallback fonts until the provided licensed fonts are installed; the export dialog explains substitutions and offers the font ZIP. Faithful output retains the browser-rendered appearance.

## Environment and honest limits

- Free Supabase project and private `book-images` bucket configured. Server-only storage settings saved in Render, ready for the merged deployment; no paid upgrade or public bucket policy.
- Finder's accessibility view and selected source file were available, but native coordinate drag repeatedly failed in the Mac control tool before it could reach the browser. The actual Finder-to-browser gesture is therefore **not claimed as manually verified**. Browser acceptance coverage does exercise real drag events with multiple image files, destination-page detection, manageable sizing and grouped undo; actual Mac images were verified through the real file picker.
- Windows Word and physical printing were unavailable and are not claimed as tested.
- Merge, deployment commit and live-site verification are recorded in the PR's delivery comment after deployment, rather than predicted here.
