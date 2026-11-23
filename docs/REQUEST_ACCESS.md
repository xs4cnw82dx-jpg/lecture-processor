# Request access policies

Authenticated service handlers declare their admission checks with
`access_service.require_user`. The wrapper verifies the Firebase identity once
at entry and passes it to the handler. An explicitly unverified email receives
the same verification response across services. Existing object ownership,
administrator, quota and transaction checks still run where the object is used.

| Entry point | Policy |
| --- | --- |
| Study, planner, voice notes, university tools, new uploads, checkout and purchase history | Require a verified identity and an allowed university email. Handlers that create or edit user data normally use `writes=True`, which declines requests while account deletion is in progress. |
| Owned runtime status, downloads, batch results and temporary import retrieval or release | Use the verified identity to return or clean up an existing user's artifact. The directory allowlist applies when starting the work. The result handler also checks ownership or explicitly requires an administrator. |
| Checkout confirmation and payment webhook | Confirmation checks the signed-in user's allowed email and ownership of the checkout. Fulfillment performs its own transaction and deletion checks. The webhook authenticates Stripe's signature independently. |
| Calendar sync and preferences | Calendar status uses the read policy. Calendar mutations and preference updates enforce account state before saving. Calendar callbacks and asynchronous work check account state again when committing. |
| Account lifecycle and session checks | Export, deletion and session management use their dedicated recent-authentication or revocation checks. Account deletion can resume an existing request. Optional session discovery supports signed-out clients. |
| Admin and private workout tracking | Require administrator identity with token revocation checking. Workout writes also check the account's write status. |
| Book and learning studios | Signed-in collaborators use verified identities and course or book roles. Scoped grants and published reader or learner links support participants without a university account. |
| Public feeds, published shares and signed media links | Use the scoped token or grant for the resource. They do not confer general authenticated access. |

The `writes` flag controls the entry-time account check. Worker, transaction
and conditional-action checks serve different purposes and remain close to the
operation they protect.
