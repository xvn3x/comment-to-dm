# Security

## Reporting a vulnerability

Do not publish access tokens, App Secrets, passwords, backups, raw production logs, or proof-of-concept exploits in a public issue. Use GitHub private vulnerability reporting in the repository **Security** tab. If that form is unavailable, open an issue containing no exploit or secret and ask the maintainer for a private contact channel.

## What the application protects

- Instagram passwords are never collected. Authorization uses the official Meta OAuth flow.
- Every installation generates independent admin, session, encryption, webhook and database secrets from the operating system cryptographic random source. Production refuses known placeholders, malformed encryption keys and weak generated-secret substitutes.
- Meta App Secrets and Instagram access tokens are encrypted with AES-256-GCM before database storage. Each encrypted value uses a new random nonce and an authentication tag.
- Webhook payloads are accepted only after `X-Hub-Signature-256` verification in live mode. Meta deauthorization and data-deletion callbacks require a valid signed request. OAuth state is random, expires after ten minutes and is consumed once.
- The admin session uses a signed, HTTP-only, secure, same-site `__Host-` cookie. Authenticated state-changing requests require the exact configured origin. API responses containing account data are marked `no-store`.
- Login attempts are rate-limited. Request bodies are limited to 1 MiB. Raw headers, OAuth codes, access tokens, App Secrets and tracking tokens are not written to application request logs.
- Comment text and DM conversations are not retained. Technical event IDs, delivery results and configured replies are retained for up to 30 days. Optional follower gates keep only the scoped interaction required for the configured workflow.
- PostgreSQL has no published host port. The application container is non-root, read-only, has no Linux capabilities and cannot gain new privileges. The database is isolated on an internal Docker network.
- Docker build context excludes `.env`, private keys, database dumps, archives and Git metadata. Production Docker images and third-party GitHub Actions are referenced by immutable digests/commits.
- Backups are mode `0600` inside a mode `0700` directory. Verification and restoration reject unexpected, duplicate and non-regular archive members before reading any data.
- New VPS installations enable Ubuntu unattended security updates. A reviewed SSH key-only policy is provided but is never applied automatically before a separate key-authenticated session has succeeded.

## Trust boundaries and limitations

No self-hosted application can protect secrets from every administrator of the machine that runs it.

- A person with VPS `root` access, Docker access, access to the hosting control panel, or access to a downloaded backup can recover runtime secrets. Docker group membership must be treated as root-equivalent.
- A backup intentionally contains both the database and `.env`; that is required for recovery. Its filesystem permissions prevent access by ordinary server users, but it is not independently encrypted. Encrypt any copy before placing it in cloud storage, email or messenger.
- Malware or a hostile browser extension on the administrator's computer may steal an active session or data displayed in the browser.
- A compromised GitHub maintainer account or a malicious release can change application code. Self-hosted updates therefore require an explicit annotated release tag and create a backup, but users still need to trust the selected release and repository owner.
- Meta can revoke tokens, change permissions, limit sending, disable an account or return incomplete events. Using the official API reduces policy risk but cannot eliminate platform-side restrictions.
- Encryption at rest does not help if an attacker obtains both the encrypted database and `ENCRYPTION_KEY` from `.env`.

## Operator responsibilities

1. Use Ubuntu security updates, SSH keys and a firewall that exposes only SSH, HTTP and HTTPS. Disable SSH password login after confirming key access.
2. Protect the VPS provider account and GitHub account with unique passwords and MFA. Never share the deploy private key.
3. Keep `/opt/comment-to-dm/.env` at mode `0600`; never paste it into chat, an issue, a screenshot or a repository.
4. Keep `/var/backups/comment-to-dm` at mode `0700`. Store off-server copies only in an encrypted location and verify a recent backup before an update.
5. Install and update from an announced `vX.Y.Z` release tag. Do not point `update-vps.sh` at a branch or an untrusted fork.
6. Enter the Instagram password only on an official Meta/Instagram page. Comment to DM never needs it.
7. Revoke the Instagram authorization and rotate affected secrets immediately if `.env`, a backup, a session cookie, App Secret or token may have leaked.

## Automated checks

CI runs unit security regressions, shell archive tests, TypeScript build, ESLint and immutable deployment configuration checks. Dependabot monitors npm packages, GitHub Actions and Docker base images. A clean automated scan is useful evidence, not a guarantee that no vulnerability exists.
