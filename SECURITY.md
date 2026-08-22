# Security

## Reporting a vulnerability

Do not publish access tokens, App Secrets, passwords, backups, raw production logs, or proof-of-concept exploits in a public issue. Use GitHub's private vulnerability reporting form in the repository **Security** tab. If that form is unavailable, open an issue containing no exploit or secret and ask the maintainer for a private contact channel.

## Security model

- Instagram passwords are never collected. Authorization uses Meta OAuth.
- Meta App Secrets and Instagram access tokens are encrypted with AES-256-GCM before database storage.
- Webhook payloads are accepted only after `X-Hub-Signature-256` verification in live mode.
- Meta deauthorization and data-deletion callbacks require a valid signed request.
- The admin session is an HTTP-only, same-site cookie. Mutating API calls also enforce same-origin requests.
- Comment text and DM conversations are not retained. Optional follower gates keep only the quick-reply interaction ID, scoped sender ID, follower-check status and configured response; delivery data is removed with its event after 30 days.
- PostgreSQL is not exposed outside the Docker network.

## Operator responsibilities

Anyone with root access to the VPS can potentially access runtime secrets. Keep the operating system patched, use SSH keys, restrict firewall ports to SSH/HTTP/HTTPS, protect backups, and never commit `.env`.
