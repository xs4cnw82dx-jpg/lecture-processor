# Book Studio usability repair

The reported interaction defects are release blockers: direct text editing, reliable selectors, true panel dismissal, click-away behavior, object clipboard, explicit layer controls, pill geometry, a Tools icon, meaningful palette controls, layout grid/snapping, book-oriented tables/diagrams, and discoverable version history.

Additional improvements implemented:

1. Consistent SVG tool icons with accessible names and visible labels.
2. Contextual selection bar with edit, duplicate and delete actions.
3. Heading, body and caption insertion presets.
4. Four coordinated book themes with a preview and explicit application.
5. Palette swatches that apply directly to the selected object.
6. An explicit “Apply paper to all pages” action.
7. Visible coordinates and size feedback while dragging/resizing.
8. Alignment to top, middle and bottom as well as horizontal alignment.
9. Even horizontal/vertical distribution for multiple objects.
10. Marquee selection on empty page space.
11. Clear selected-object count and group/ungroup controls.
12. Rotation in 90-degree steps and reset rotation.
13. Reset zoom plus keyboard zoom shortcuts.
14. Remembered layout-guide and panel preferences on this device.
15. Undo groups for a typing or slider interaction, rather than each keystroke.
16. Locked-object feedback and an explicit unlock action.
17. Hidden-object feedback in the layers list.
18. Disabled boundary actions with an explanation.
19. Keyboard-accessible page reordering and rename controls.
20. Version timestamps, page counts, preview and restore confirmation.
21. Text overflow warnings with a fit-height action.
22. Searchable illustration library and helpful empty state.
23. Loading states that don't briefly claim a cloud book is empty or locally saved.
24. Busy states for asynchronous actions and protection against duplicate submissions.
25. Styled collapsible sections with reduced-motion support.
26. Searchable shortcut reference that distinguishes text editing from object shortcuts.

27. A dedicated Layers tab instead of burying layers beneath long property panels.
28. Save status waits for the actual device write, with a leave-page warning while a write is pending.
29. Unique names for new objects, making their layers easier to identify.
30. Object settings in the selection toolbar, including on narrow screens; switching layers keeps an open settings panel visible.

## Validation

- 647 backend tests, 106 client utility tests and all 35 Playwright browser tests pass locally.
- The nine Book Studio browser journeys cover on-page typing and grouped undo, native dropdown changes, true desktop/mobile dismissal, clipboard copy/paste, pill proportions, layer movement/locking/visibility, center/thirds snapping, guide preferences, table cells and diagram steps, themes, page movement, version preview/restore, image imports, backups, every export variant, reduced motion and narrow screens.
- Python and JavaScript lint, generated-asset checks, repository hygiene, tracked-secret guards and all 16 smoke checks pass.
- Signed-in Chrome: completed the actual Google flow, edited text on the page, changed static font weights, closed/reopened settings, edited a table, uploaded a non-sensitive Mac PNG and saved the book to the account. Continued cloud, export and deployed-site verification is recorded in the PR before delivery.

## Compatibility

Existing books retain their page geometry and content. Older diagrams retain their horizontal direction; new diagrams start vertically to suit a book page. Drawing/print guides are editor overlays and never enter exports. New table, arrow and diagram choices are validated on the server and retained by portable backups.

The original release's Windows Word and physical-printing limitations remain. No paid service or infrastructure change is required.

## Tables that match the paper

Tables now default to **Match page paper**. Their backgrounds inherit the page color, with a lightly shaded header, subtle alternate rows, fine rules and vertically centered text. The renderer adjusts text contrast on light and dark paper. Column lines are optional; **Simple ruled lines** removes the outer box. **Custom colors** remains available for deliberate overrides. Theme changes update the table's matching body font, and the same renderer is used for the editor, thumbnails, version previews and print exports. Existing tables without an explicit style receive the paper-matched appearance without changing their content or geometry.

Additional validation covers colored paper, dark-paper contrast, custom colors, column rules, device reload and backup round trips. All 10 Book Studio browser journeys pass. Hands-on Chrome checks cover warm, green and dark paper plus both paper and ruled styles.
