# xPED Academy

The Academy is a standalone deployment of the Studio from this repository. The domain root opens the course library. Learners use published links. The Studio administrator manages author access by verified email. A course invitation grants collaboration on that course.

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
| `LEGAL_CONTACT_EMAIL` | Public Academy privacy and account support mailbox. Defaults to ijacco2004@gmail.com. |
| `XPED_STUDIO_ADMIN_EMAIL` | Verified sign-in email for the Studio administrator. Setting `XPED_STUDIO_ADMIN_UID` pins access to that Firebase UID and takes precedence over the email. |

Enable Google and email/password in Firebase Auth and authorize the Academy hostnames. Use a fresh Firestore database with the server-only rules in `firestore.rules`. The runtime service account needs Firestore data access and read-only Firebase Authentication access. Generate new secrets for each deployment environment and keep the production values in Render.

For local UI verification, run `.venv/bin/python scripts/run_ui_preview.py --academy --port 5114`. This starts the Studio with a synthetic identity and temporary data.
