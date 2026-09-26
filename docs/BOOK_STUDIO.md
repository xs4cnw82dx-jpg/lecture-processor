# Book Studio

Book Studio is available from **Tools → Book Studio** (`/books`). It creates half-A4 illustrated books without changing the video builder. The editors share shape choices, table creation and bounded geometry helpers.

## Using a book

Start with a blank sketchbook, picture book, journal or visual explanation. The cover and back cover stand alone; the inside pages appear in facing pairs. The bottom navigation always provides first, previous, next and last, page selection, Add page, Fit book/Fit page and zoom. Small screens show one page and put page, history and book actions under More. Page settings open with the settings button.

Drop PNG, JPEG or WebP illustrations onto either visible page, paste an image, or use Image. The original is retained. Imports start within half the page width and height, with proportions locked. Small/Medium/Large/Fit page, corner handles and millimeter dimensions provide resizing; cropping, Fill page and Span both pages are explicit choices. Linked spreads move together; choose Split illustration before separating them.

Use the inspector for fonts, thickness, selected-text formatting, reusable heading/body/caption styles, shape colors, drawing tools, paper, guides, layers and grouping. Playpen Sans has no italic face. Andika and Comic Neue expose supported static weights; variable fonts expose a slider. The illustration assistant copies an editable prompt and links to ChatGPT, where references and generated results are transferred by the user.

**Book palette & themes → Choose a book theme → xPED** offers xPED Classic, On the Route, Bright Ideas and Night Expedition, each with front/back previews. Inside pages start white and can switch to navy. The original blue/yellow corner alternates from top left to mirrored top right across inside pages and can be hidden per page. The pattern follows the current page order, including after reordering or restoring a version. New pages inherit the theme; duplicated and restored pages keep their own treatment. Tables and Story steps follow the paper with coordinated colors unless Custom colors is selected. Applying a theme preserves existing content, positioning and explicit custom colors. The six named brand colors, Nohemi Bold and General Sans Regular/Bold are bundled locally with provenance and licensing information. These fonts expose only their real weights and no synthetic italics.

**Page numbers** adds optional numbering beside the logo, at the bottom center or at the bottom outside edge. Numbers start at 1 on the first inside page; covers stay unnumbered. Font, size, thickness and automatic or custom color apply throughout the book and to exports.

Color pickers update the canvas as the spectrum moves. One continuous picker interaction is one undo step; the picker keeps focus. Palette swatches update immediately, while **Use** applies a swatch to the selected object.

Arrow keys turn spreads, or nudge a selected object. Alt+arrow turns with a selection. Home/End go to the covers, Shift+N adds a page, Cmd/Ctrl+Z undoes and Cmd/Ctrl+Shift+Z redoes. Text inputs retain normal cursor shortcuts. Reduced motion disables page-turn animation.

## Saving and collaboration

Local drafts and pending changes are stored in IndexedDB, separately from video projects. Signed-in creation, copies and backup imports automatically save to the account. Opening an older device-only draft, or signing in with one open, uploads that draft; unopened drafts stay on the device. Guests continue saving locally. The library separates cloud ownership, invitations, local drafts and trash, and pending uploads appear in My books. Book details provides title, folder, tags, favorite and duplication. Named versions and deleted pages appear under History.

Account uploads are resumable and bound to the account that started them. Retrying creation, images or named versions uses an idempotency key, so a lost response does not create duplicates or count storage twice. IndexedDB retains the recovery draft until all images, original sketch references, deleted pages, versions and current edits have transferred. Account switching pauses an unfinished transfer instead of assigning it to another account. Offline and failed saves show their state and a Retry control; reconnecting resumes eligible transfers. Shared books keep their owner, and a recovery draft never overwrites a newer cloud revision automatically.

Cloud books use Firebase authentication and Firestore via Flask. No direct browser Firestore access is added. Supabase stores private image originals and previews. The browser receives assets only through authorized app endpoints; server credentials never enter generated HTML or JavaScript.

The owner grants verified-email memberships or expiring/revocable view/edit links. Viewers may comment; editors may export. Guest link sessions have names and signed scoped access. Link tokens are stored as SHA-256 hashes. Owners alone change access, trash books or force an editing takeover. Account export includes owned books and their assets; account deletion revokes links, removes owned data/assets and removes that account's comments/memberships without deleting collaborators' books.

Editing uses a Firestore transaction lease scoped to the user **and browser tab**. It lasts 60 seconds and renews every 20 seconds. Every content write checks the lease token and base revision. Autosaves send changed pages at five-second idle intervals, with one save in flight. Conflict drafts remain local and never overwrite a newer revision automatically. Visible viewers poll revision metadata every five seconds, then fetch changed pages, retaining their current page and zoom. Hidden tabs pause viewing polls. Revision reads are cached for two seconds.

## Printing and Word

Logical pages are 148.5 × 210 mm. Printed sheets are exactly 297 × 210 mm, landscape A4.

* **Cut and bind:** Cover / Blank on the first sheet; sequential inside pairs; back cover on the left with a blank opposite. Print single-sided, cut in the middle, and assemble in the numbered order shown in the preview. Folding is no longer offered; old folding requests receive a refresh message. Omitted arrangement or `cut` remain compatible.
* **Word · exact appearance:** 300 dpi page images, positioned at physical page coordinates.
* **Word · editable text & shapes:** native Word text boxes and rectangles/ovals; other objects/effects are rendered. The dialog lists flattened objects and regular/bold substitutions. Font installation is offered as a licensed ZIP. Word can change wrapping or layering. Changes in Word do not synchronize back.
* **PDF:** the same page renderer and sheet ordering as faithful Word.

Exports freeze the current saved revision and reject generation if the cloud revision changes. Print checks flag overflow, small images, paper edges and binding edges. Guides do not promise borderless output: physical printer margins still apply. The preview shows all sheets, blank halves and center-guide settings. Save ink previews white paper, restrained xPED artwork and dark readable theme text without changing the saved book.

## Deployment configuration

| Variable | Default / purpose |
|---|---|
| `BOOK_STUDIO_ENABLED` | `1`; set `0` to disable book UI/API during maintenance |
| `BOOK_STORAGE_URL` | Supabase project HTTPS URL; required for image uploads |
| `BOOK_STORAGE_KEY` | Server-only Supabase secret/service key; secret environment variable |
| `BOOK_STORAGE_BUCKET` | `book-images`; private bucket |
| `BOOK_IMAGE_MAX_MB` | 10; maximum individual image bytes |
| `BOOK_ASSETS_MAX_MB` | 25; originals plus previews retained per book |
| `BOOK_STORAGE_MAX_MB` | 750; deployment-wide storage budget |
| `BOOK_TRANSFER_MAX_MB` | 4096; monthly transfer safeguard |
| `BOOK_CHATGPT_URL` | `https://chatgpt.com/`; configurable official ChatGPT entry point |

Use a private bucket with 10 MB file limit and PNG/JPEG/WebP types. No public bucket policy is needed. Keep credentials outside Git and browser code. Storage fails visibly if unavailable, over budget or over the provider quota; no disk persistence fallback or paid upgrade is attempted. Supabase's actual current plan allowance is independent of these conservative application limits.

Firestore collections: `books/{id}` metadata/lease; `pages`, `assets`, `comments`, `versions/{id}/pages` subcollections; `book_shares` hashed grants; `book_comments` author cleanup index; `book_usage` storage and transfer accounting. Nested arrays (table cells, drawing points) are wrapped only in the repository adapter because Firestore forbids directly nested arrays. The public JSON remains version 1 with millimeter geometry and asset IDs. Page documents are bounded to 600 KB, 300 objects and 3,000 points per drawing. Limits are 100 pages, 100 books per account, 400 assets and 20 named versions per book. Retained versions share asset bytes; original/preview bytes count once in storage accounting.

Logs record declined status/endpoint, aggregate database operations, export failures and quota counters without book text or images. Storage reservations use transactions and are released only after confirmed cleanup. Interrupted uploads that cannot be cleaned immediately remain visible for retry/removal.

## Validation

Backend tests cover private access, membership, guest revocation, independent comments, concurrent lease acquisition, tab scope, expiry, takeover, stale writes, image validation/budgets, changed pages, named versions, account cleanup, nested-array persistence and Word/PDF imposition. Client tests cover geometry, imposition, linked spreads, text wrapping, safe backup decoding and prompt composition. Browser acceptance tests exercise the actual template, local persistence, keyboard focus, page recovery, multiple drops, file picker, invalid files, backups, all export combinations, responsive layout, reduced motion and pen input.

The release QA record is in `BOOK_STUDIO_QA.md`; do not treat an unrecorded platform or journey as verified.

Font sources and applicable license/provenance files are bundled under `static/fonts/books`. `fflate` is bundled by the normal asset build; its MIT license is in `static/licenses/fflate-LICENSE.txt`.
