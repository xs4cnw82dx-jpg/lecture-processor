# xPED Academy

The Academy is a standalone deployment of the Studio from this repository. The domain root opens the author dashboard. Learners use published links. The Studio administrator manages author access by verified email. A course invitation grants collaboration on that course.

## Studio and learner addresses

The Academy library is at `/expedities`. Each course has an overview at `/expedities/<id>`, an editor at `/expedities/<id>/bewerken` and a report at `/expedities/<id>/resultaten`. Authors enter via `/inloggen`. The workspace also has `/resultaten`, `/vertalingen`, `/team` and `/instellingen`.

New learner links use `/start/<token>` and translation invitations use `/vertalen/<token>`. Existing Academy links under `/physio/elearning`, `/elearning/p/` and `/elearning/translate/` redirect on the same host, retaining the token, language and pilot-group query. The former `/signin` and `/account` addresses also redirect.

Courses previously made on Lecture Processor stay on the original service. Authors and learners can keep using their existing Lecture Processor links, including printed QR codes. The Academy uses its own Firebase project and private media storage.

## Production service

Deploy the repository's main branch to a Python web service using the version in `.python-version`. Use these Render settings.

| Setting | Value |
| --- | --- |
| Build command | `pip install -c requirements.constraints.txt -r requirements-academy.txt` |
| Start command | `gunicorn --bind 0.0.0.0:$PORT --workers 1 --threads 4 'lecture_processor.academy:create_app()'` |
| Health check | `/healthz` |

The in-process rate limiter shares state across threads in one worker. The deployment trusts one forwarding proxy, Render. Cloudflare hosts the DNS-only records for the apex and www. Recheck proxy trust before changing this topology.

## Configuration

| Variable | Source |
| --- | --- |
| `PUBLIC_BASE_URL` | Canonical HTTPS origin of the Academy. |
| `FLASK_SECRET_KEY` | A random signing secret generated for this service. |
| `ACADEMY_FIREBASE_PROJECT_ID`, `ACADEMY_FIREBASE_API_KEY`, `ACADEMY_FIREBASE_APP_ID` | Web app configuration from the Academy Firebase project. |
| `ACADEMY_FIREBASE_CREDENTIALS` | Server-only JSON for the Academy runtime service account. A Render secret file referenced by `GOOGLE_APPLICATION_CREDENTIALS` is also supported. |
| `BOOK_STORAGE_URL`, `BOOK_STORAGE_KEY`, `BOOK_STORAGE_BUCKET` | Academy Supabase project URL, server-only key for that project, and private media bucket name. |
| `LEGAL_CONTACT_EMAIL` | Set the public privacy and account support mailbox in the Academy service environment. The privacy page displays it when configured. |
| `XPED_STUDIO_ADMIN_EMAIL` | Verified sign-in email for the Studio administrator. Setting `XPED_STUDIO_ADMIN_UID` pins access to that Firebase UID and takes precedence over the email. |

Enable Google and email/password in Firebase Auth and authorize the Academy hostnames. Use a fresh Firestore database with the server-only rules in `firestore.rules`. The runtime service account needs Firestore data access and read-only Firebase Authentication access. Generate new secrets for each deployment environment and keep the production values in Render.

For local UI verification, run `.venv/bin/python scripts/run_ui_preview.py --academy --port 5114`. This starts the Studio with a synthetic identity and temporary data.

## Studio accounts

The account page at `/instellingen` is available from Settings and Privacy. It exports the signed-in user's account and membership metadata as JSON. Individual course exports remain available from the library. Learners can open shared links without a Studio account.

Account deletion requires a sign-in within five minutes and explicit confirmation. Deleting an author transfers their draft and published expeditions in place to the verified Studio administrator's **Account review** folder. Course IDs, media, learner links, responses and other collaborators remain attached to the course. Previously requested course deletions and incomplete unpublished copies finish cleanup. The departing account loses author and collaboration access, and its folders and upload attribution are removed. A minimal UID tombstone prevents work from restarting. Firebase removes the sign-in with the user's own ID token. The runtime needs only its existing Auth viewer permissions.

The confirmation explains that starting deletion ends author access and blocks editing. Return to the account page and confirm again to resume an interrupted deletion. The browser waits for the server’s retry interval between batches. If the final sign-in removal needs fresh authentication, use **Sign in again** and confirm the deletion again. A Studio administrator must first designate a successor in the Academy service configuration before deleting their own account.
