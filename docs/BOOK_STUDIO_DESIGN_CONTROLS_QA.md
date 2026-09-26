# Book Studio design controls — validation

Validated on 26 September 2026.

## Changes checked

- All four xPED front/back cover pairs use restrained compositions with a clear footer. Removed the decorative dots, mint fragments and broad route that crossed the logo.
- Logos can be selected, dragged, resized, positioned numerically, hidden independently of artwork and reset. Page numbers have a visible toolbar entry, three position presets and per-page dragging.
- Lines and arrows support movable points, right-click bend insertion, sharp/smooth paths, dashed strokes, optional colored bend markers and separate arrowhead color. Extending a point beyond its original box preserves the other points, including on rotated paths.
- The in-app color picker supports live spectrum dragging, keyboard sliders, hex input, one-step undo, same-button dismissal, outside dismissal and Escape. Its trigger remains reachable at narrow widths.

## Automated results

- Full Python suite: 714 passed.
- Full JavaScript suite: 151 passed.
- Full minified Playwright suite: 54 passed. After final interaction fixes and an additional mobile picker check, the affected Book Studio suites passed all 9 tests.
- JavaScript lint, Python lint, generated asset checks, first-party CSP guards, secret/file hygiene and whitespace checks passed.
- New backend coverage verifies bounded path data, legacy defaults, cloud round trips, named versions, deleted pages, backups and all three export formats.

## Signed-in browser and export inspection

Used the actual Google sign-in flow in Chrome with the local app connected to the existing cloud backend. Created **xPED — Design controls test**, moved the logo, added a smooth line and a bent dashed arrow with a mint head and optional yellow marker, and selected centered page numbers. Dragged the actual spectrum control and path points. Reloaded the book and confirmed **Saved to cloud** with the content and placements intact.

Downloaded faithful Word, editable Word and PDF through the editor. Rendered both Word files with LibreOffice and the PDF with Poppler, then inspected every sheet. The five logical pages produce four sheets in order: Cover/Blank, 1/2, 3/Blank, Back cover/Blank. PDF sheets measure exactly 297 × 210 mm; DOCX uses landscape A4 (16838 × 11906 twips).

The editable document contains five native text boxes. Lines, arrowheads, markers, logos and numbers retain their shared-renderer appearance. Lines and arrows deliberately export as images in editable Word, disclosed by the export adjustments before download.

The local document renderer does not have the xPED fonts installed, so editable Word inspection shows fallback typography. The editor offers the installable book fonts and explains that requirement. Native Microsoft Word on Windows was not tested in this round; the visual inspection used LibreOffice on macOS. Faithful Word and PDF preserve the exact typography without installing fonts.

Production deployment and the post-merge browser check are recorded in the pull request.
