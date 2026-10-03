# Product presentation repair — verified 4 October 2026

Scope A of PRODUCT_FEEDBACK_REPAIR_PLAN is implemented. No billing changes, generated assets, external service calls or user data mutations were made by this owner.

## Delivered

- Landing removes the two requested hero lines, explicitly explains recording transcription + PDF/PowerPoint extraction + combined structured notes, and uses ordinary numbered steps.
- Features is rebuilt as an editorial product walkthrough: paired sources becoming one note, three processing steps, supported LMS import instructions, a speaker/time-formatted interview example, a same-type batch queue, a practical tools directory, four study modes, Library/Plan context and real export choices. Illustrative samples are labeled. Alternating sections, source-paper layering, transcript rows and compact directories replace the generic repeated cards and decorative pills.
- No universal video/YouTube input claim, semantic grading promise, Tools Beta badge, invented origin story or assumed processing-time saving remains. Write describes configurable text matching accurately. The calculator is a closed animated disclosure with user-adjustable review/correction time; it can show a negative difference.
- Credit category headings are centered. Slides extraction / add-ons labels appear below prices in both catalog variants. The page explains extraction, Voice Notes study generation and interview extras, plus enforced recording/slide size limits. Purchase IDs, dynamic prices, currency, authentication and purchase handlers remain intact.

## Claim audit

| Presentation claim | Implementation evidence |
|---|---|
| Combine extracted slides with a recording transcript | services/prompt_registry.py lecture merge prompt; services/upload_api_service.py lecture pipeline |
| PDF or PowerPoint slides | runtime/core.py ALLOWED_SLIDE_EXTENSIONS = pdf,pptx |
| Brightspace/Kaltura lecture-page or playlist import, subject to access | runtime/core.py import host allowlist; domains/upload/import_audio.py validation; existing index.html guidance |
| Interview timecodes and Onderzoeker / Geïnterviewde labels | services/prompt_registry.py interview transcription prompt |
| Optional summary and sectioned interview transcript | same prompt registry and upload_api_service.py interview_features |
| One processing type per batch, individual/ZIP outputs | services/upload_batch_service.py and batch-mode/status implementation; preview uses three lecture pairs |
| Write uses configurable text comparison | existing study/session matching controls, not semantic answer evaluation |
| Word/Markdown notes, annotated Library PDF, CSV/practice PDFs, batch ZIP/optional combined Word | static/js/study.js export handlers and batch download implementation |
| Lecture and interview credits charge per run | upload_api_service.py deduct_credit / deduct_interview_credit; domains/billing/credits.py consumes legacy standard/extended or short/medium/long fields interchangeably |
| 500 MB recording and 50 MB slide limits, no current duration tier | runtime/core.py MAX_AUDIO_UPLOAD_BYTES / MAX_PDF_UPLOAD_BYTES; upload_api_service.py validates sizes and does not tier by duration |
| One slides credit per extraction run | services/tools_extraction_service.py; upload_api_service.py slides-only branch |
| One slides credit for Voice study-tool generation, either/both outputs | services/voice_note_service.py study_features and deduction |
| One add-on credit per interview extra, two for both | upload_api_service.py interview_features_cost = len(interview_features) |

The old standard/extended and short/medium/long field names do not enforce per-minute or duration pricing. No unlimited-length claim or invented duration limit was added. Deferred batch credit discount is deliberately absent pending the parent's billing decision.

## Verification

- Seven browser tests passed after final copy changes: four viewport matrices (1440, 1024, 768, 390), workflow/sample/calculator interactions, heading alignment/price-label geometry, and the existing shared FAQ/calculator interaction check.
- Across landing, Features and Buy Credits: visible heading, no horizontal overflow, rendered browser-default-control audit. The sample card opens/closes, calculator disclosure opens/closes, values respond to both manual and review estimates, and negative differences remain truthful.
- Four isolated Python tests passed: public branding/CTA contract, runtime pricing catalog IDs/names/prices, calculator labels/focus and readable heading boundary. Updated only changed presentation expectations; dynamic billing data coverage remains.
- ESLint passed for features.js, product-presentation.spec.js and the modified shared-redesign.spec.js. No builds performed.
- Screenshot evidence: /tmp/product-feedback-presentation. Full-page captures for all three routes at all four widths; additional interview and study-mode sections at 1440 and 390. Owner inspected desktop Features/pricing and mobile landing/Features/interview/study/pricing captures. Parent independently inspected desktop hero/interview in Chrome and pricing/mobile captures. No clipping, overlap or unreadable controls observed.

## Ownership handoff

Files: templates/landing.html, templates/features.html, templates/_pricing_catalog.html, templates/buy_credits.html; static/css/features.css, static/css/buy-credits.css; static/js/features.js; e2e/product-presentation.spec.js; Features calculator hunk in e2e/shared-redesign.spec.js; presentation hunks in tests/test_template_accessibility.py and tests/test_route_contract.py.

Remaining integration work belongs to parent: generated assets, full regression suite, pending batch billing decision, delivery and deployed verification. Payment processing was preserved and not re-exercised against Stripe during this visual scope.
