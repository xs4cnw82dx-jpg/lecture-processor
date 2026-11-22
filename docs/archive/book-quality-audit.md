# Book Studio quality audit — 26 September 2026

This release restores the original blue/mint On the Route river and removes non-editable print placeholders from the editing canvas. Necessary blank halves remain in the landscape A4 export preview. Three parallel audits covered rendering, interaction and persistence; a second review checked their integration.

## Implemented fixes

1. Restore the original flowing blue/mint river on both route covers, without the unwanted yellow dots. Default logos sit clear of the river; custom logo positions remain intact.
2. Hide nonexistent facing-page placeholders in the editor. The last odd interior page is an ordinary editable single page, matching the sidebar.
3. Clicking either facing page immediately updates its active outline, sidebar selection and page settings.
4. Indicate both visible pages in the sidebar while distinguishing the active page.
5. Keep the active thumbnail in view without scrolling the whole editor.
6. Preserve object selection when navigation reaches the first or last page.
7. Preserve direct text editing and the caret during resizing, including crossing the phone layout breakpoint.
8. Return keyboard focus to the live page after finishing direct text editing.
9. Stop stale inspector fields from retaining arrow-key input after clicking the canvas; use fresh page geometry after a field's blur redraw so snapping remains correct.
10. Group book-title changes into one undo step, and synchronize the title field and browser title on undo/redo.
11. Allow temporarily empty numeric fields without resizing objects to zero or distorting images; restore valid values on blur.
12. Synchronize both image-size fields with the aspect lock and clamp one common scale against both server size limits. Drag resizing preserves the same proportions.
13. Respect locked drawings when erasing.
14. Refuse drawing on pages already at the object limit before creating an invalid pending save.
15. Avoid empty undo entries for blocked object/page creation, duplication and deletion.
16. Exclude hidden objects from grouped canvas selection/movement.
17. Keep the toolbar's selected tool accurate after Escape, choosing a drawing tool and adding a new object.
18. Prevent editing, duplication, deletion and pasted imports through shortcuts in reading mode.
19. Require a horizontal touch gesture to turn a page; ordinary mouse drags and vertical touches do not navigate.
20. Preserve browser shortcuts by limiting Add page's Shift+N shortcut to the unmodified combination.
21. Add arrow/Home/End navigation and a single tab stop to the Settings/Layers tablist without nudging selected objects.
22. Bind drawing, dragging, line bends and page furniture to their initiating pointer so a second touch cannot hijack or finish the interaction.
23. Reuse unchanged thumbnail SVGs instead of redrawing every page on each edit.
24. Invalidate cached text layouts after later font downloads, not only initial font loading.
25. Update only changed dynamic layout rules during manipulation and remove stale selection rules.
26. Cancel duplicate queued stage redraws after direct text editing.
27. Measure rotated objects correctly in print-safe and binding-edge warnings.
28. Calculate image-resolution warnings from the actual contain/crop/spread geometry.
29. Warn about clipped text inside tables and story steps in both the inspector and print checks.
30. Preserve emoji sequences, combining accents and pasted Windows-style line breaks in the shared text renderer.
31. Honor line spacing applied to rich-text runs; flatten mixed-spacing text in editable Word where native text boxes cannot reproduce it.
32. Reuse measured table/step text layouts rather than measuring each cell twice.
33. Validate current and saved-version cover/spread/deleted-page structures before accepting them.
34. Recover current pages crowded out by old abandoned records in cloud reads, history, backups and account exports; prune newly abandoned current documents while retaining saved versions.
35. Hide trashed books from collaborators and show them again on restoration.
36. Release a revoked edit link's editing turn immediately and guard against concurrent reacquisition.
37. Enforce the comment limit and page existence transactionally during simultaneous writes.
38. Protect images newly captured by a concurrently saved version from removal.
39. Reject aborted browser-storage writes promptly, show a recoverable error and reopen unexpectedly closed storage connections.

40. Keep the picker open with a readable error for invalid hex entries instead of silently discarding them; accept three-digit shorthand colors.
41. Close the picker cleanly at keyboard Tab boundaries and return focus to its trigger.
42. Keep a spectrum drag attached to its initiating pointer; a second touch cannot interrupt it.
43. Position and size the picker within the visible mobile viewport when the keyboard opens or the viewport pans.

## Validation

Validation passed: **728 backend tests, 159 client tests, 73 browser tests without retries, 16 smoke checks, Python/JavaScript lint, generated assets, secret scan and repository hygiene**. The Functions audit passes the required high-severity threshold; three pre-existing moderate findings remain outside this change.

Regression coverage is in `e2e/books-quality.spec.js`, `e2e/books-storage-failures.spec.js`, the picker quality tests, `tests/test_book_quality_audit.py`, the existing book suites, and the model/xPED unit suites.

A separate signed-in demonstration book was created without changing the user's existing books: **xPED — River and page quality demo**. Verified route covers, both facing-page selections, an odd third interior page, direct editing, Unicode, automatic cloud save and reload. Exported faithful Word, editable Word and PDF; inspected all four sheets of each. PDF sheets are 297 × 210 mm; Word uses landscape A4 (16838 × 11906 twips). Editable Word contains five native text boxes.

The bundled LibreOffice renderer substitutes fonts that are not installed in its environment, and does not reproduce the emoji in native Word text. Faithful Word/PDF reproduce the browser artwork and fonts. Native Microsoft Word on macOS/Windows was not retested in this round. The export screen continues to offer the xPED font downloads and font-installation guidance.

The signed-in color-picker check also exercised invalid hex feedback, a real spectrum drag, clicking the trigger to dismiss, and restoring the original paper with one Undo. Final automated counts and deployed verification are recorded in [PR #174](https://github.com/xs4cnw82dx-jpg/lecture-processor/pull/174).
