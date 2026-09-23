# Book Studio release QA

## Completed locally

- Full backend suite: 646 tests passed.
- Client utility suite: 102 tests passed, including existing video-builder tests.
- Actual Chrome Google sign-in completed using the existing account.
- Created **A Little Brain’s Moonlit Idea — Demo** as a cloud book: front cover, four story pages, back cover.
- Inspected and used two non-sensitive transparent PNG illustrations already in Downloads, without modifying originals.
- Both illustrations uploaded through the real file picker to private Supabase storage and persisted across reloads.
- Verified modest default image sizing, 65 mm proportion-locked resizing, image library reuse, crop controls, soft edges, Andika/Playpen Sans/Comic Neue/Fraunces/Nunito controls, an editable circle, page creation and navigation.
- Second Chrome tab correctly opened read-only while the first held the lease; owner takeover succeeded.
- Saved a named cloud version, “Complete moonlit story”.
- Desktop visual review confirms the book and bottom navigation fit in the viewport.

## Release gates still in progress

Actual Finder drag, guest handover/revocation, full export render inspection, narrow-screen checks, CI, merge, Render configuration/deployment and post-deployment verification will be recorded here after completion. Windows Word is only claimed if an actual Windows environment is available.
