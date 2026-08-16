# Security

## Reporting a vulnerability

Do not publish access tokens, App Secrets, server addresses, logs, or proof-of-concept exploits in a public issue. Contact the repository owner privately once a security contact is published.

## Security model

- Instagram passwords are never collected. Authorization uses Meta OAuth.
- Meta App Secrets and Instagram access tokens are encrypted with AES-256-GCM before database storage.
- Webhook payloads are accepted only after `X-Hub-Signature-256` verification in live mode.
- Meta deauthorization and data-deletion callbacks require a valid signed request.
- The admin session is an HTTP-only, same-site cookie. Mutating API calls also enforce same-origin requests.
- Comment text and DM conversations are not retained. The event log keeps technical identifiers and status for 30 days.
- PostgreSQL is not exposed outside the Docker network.

## Operator responsibilities

Anyone with root access to the VPS can potentially access runtime secrets. Keep the operating system patched, use SSH keys, restrict firewall ports to SSH/HTTP/HTTPS, protect backups, and never commit `.env`.
