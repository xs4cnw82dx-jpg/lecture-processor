# xPED Book Studio verification — 26 September 2026

## Scope

Four branded cover pairs and light/dark interiors; alternating original and mirrored blue/yellow corner artwork; configurable inside-page numbering; coordinated tables and story steps; real font weights; live color input; resumable automatic account saving; cover-first cut-and-bind Word/PDF output.

## Automated coverage

- Full local checks passed: 695 backend tests, 137 client tests, 47 browser tests, 16 smoke checks, Python/JavaScript lint, generated-asset verification, CSP guards and repository hygiene. Firebase Functions loaded successfully and the required high-severity dependency audit passed (three existing moderate findings remain).
- Theme application preserves existing content, geometry, explicit colors and artwork visibility. Added/duplicated/reordered/deleted/restored pages derive artwork side and numbering from the current order, including version snapshots.
- Color controls are tested with `input` events alone, focus retention, one undo and redo. The final `change` event does not create an extra undo record.
- Cloud promotion tests cover lost creation, asset, content and version responses; account binding; simultaneous tabs; edits during upload; originals, deleted pages and named versions; quotas; stale revisions and revoked permissions.
- Export tests cover numbered 4-, 5-, 8- and 12-page books, exact landscape A4 dimensions, cover on the first left half, each logical page appearing once, and native editable text. Removed fold requests return a refresh message.
- Save ink tests verify readable native Word text without modifying the original book.

## Hands-on browser evidence

Chrome on macOS, signed in through the actual Google sign-in flow against the local app and real account services:

- Created **xPED — Een route vol ideeën** while signed in. The draft automatically became an account book; a title edited during that transition was retained.
- Applied On the Route; reviewed all four front/back design cards. Edited story steps and a table, imported the existing transparent brain/lamp illustration through the file picker, resized/positioned it, and saved a named version.
- Used the native macOS color picker without Enter: 26 successive accessibility increments updated the fill while the picker stayed open. A single Undo restored the original fill. This is a native picker test, not a claim of pointer-drag testing.
- Finished the editing turn, reloaded and confirmed the cloud book, theme, content and illustration persisted.
- Confirmed original top-left and mirrored top-right artwork on facing pages, with upright logos.
- Enabled outside page numbers, changed their size and thickness, then reloaded and confirmed account persistence. The right-hand logo moves inward to leave a clear gap beside the number.
- Downloaded faithful Word, editable Word and PDF through the actual export dialog. The browser download-event hook timed out once although the download itself completed; the UI and the downloaded file confirmed success.

## Export inspection

Rendered and inspected every sheet of light, dark and Save ink editions with the bundled LibreOffice/Poppler tools. All have three landscape A4 sheets: Cover / Blank, Page 1 / Page 2, Back cover / Blank. The faithful Word and PDF preserve the brand typography, table styling, alternating corners, page numbers and transparent illustration. Save ink uses white paper, readable dark text and restrained decoration. Editable Word retains native text boxes and uses the requested font family names; font substitution occurs on machines without the xPED fonts installed. The export dialog provides installable font downloads and explains this requirement.

Visual inspection caught route artwork crossing the default back-cover caption. New Route and Night Expedition covers now place that caption clear of the route, while existing book positions remain unchanged. The demonstration book was adjusted through its position controls. Theme changes also preserve each page's explicit artwork visibility setting.

Local inspection artifacts are in `/tmp/book-xped-export-qa`; these generated QA documents and screenshots are not committed. Windows Word is unavailable in this environment. Interactive macOS Word checking was attempted but its file picker did not respond reliably to the computer-control tool; no user document was edited.
