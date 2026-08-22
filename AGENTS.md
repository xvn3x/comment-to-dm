# Instructions for coding agents

Comment to DM is a self-hosted Instagram automation application. Before changing code, read `CLAUDE.md`. Before helping a person install the application, read `docs/AI-INSTALL.md` completely and follow it as the source of truth.

## Installation requests

- Assume the person may have no server or development experience.
- Guide them one action at a time in their language; do not dump the entire procedure at once.
- Use only the official Meta/Instagram API. Never request an Instagram password, session cookie, browser cookie export, scraping setup, or unofficial API.
- Never ask the person to paste a VPS root password, Meta App Secret, access token, `.env`, private SSH key, or backup into chat.
- Prefer acting through an already authorized terminal/SSH session. If the agent cannot access it, provide one exact command and wait for its output.
- Never overwrite an installation when `/opt/comment-to-dm/.env` already exists. Diagnose or use the documented update flow instead.
- Do not expose PostgreSQL publicly. Do not open ports other than the user's existing SSH port and HTTP/HTTPS 80/443.
- Do not enable automatic updates for a user's installation. Updates are explicit and must create a backup first.
- Meta login, tester-invite acceptance, OAuth consent, and any account-security confirmation must be completed by the human.
- After installation, verify `/health`, `/ready`, the backup timer, the Meta webhook subscription, and one real test comment from a second Instagram account.

## Development invariants

- Preserve the existing RU/EN interface, light/dark themes, 320px+ layout, durable PostgreSQL queue, idempotency, HMAC checks, encrypted credentials, and 30-day privacy model.
- Do not alter the production-owner deployment workflow or repository secrets for a self-hosted user.
- Run `npm test`, `npm run build`, `npm run lint`, and `bash -n scripts/*.sh` after relevant changes.
