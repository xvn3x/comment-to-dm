# Protocol for an AI assistant installing Comment to DM

This document is written for Codex, Claude Code, and other coding agents. The human may have no technical experience. Do not merely summarize this file: lead the human through it one step at a time and verify every completed stage.

## Target result

A single-owner installation on a foreign Ubuntu 24.04 VPS:

- application and embedded worker in Docker;
- PostgreSQL accessible only inside the Docker network;
- HTTPS through Caddy;
- one Instagram Creator or Business account connected through the official Instagram API with Instagram Login;
- daily verified backups;
- no developer access to the operator's Instagram data or credentials.

The current release supports one Instagram account per installation. This is not a shared SaaS deployment.

## Non-negotiable safety rules

1. Never ask the human to send a root password, SSH private key, Meta App Secret, access token, Instagram password, `.env`, or backup through chat.
2. Never use Instagram cookies, scraping, browser automation to imitate the API, or unofficial libraries.
3. Never run the installer over an existing `/opt/comment-to-dm/.env`.
4. Never delete or rebuild a VPS until the human has identified the exact server and explicitly confirmed data loss.
5. Do not expose port 5432. Only the existing SSH port, TCP 80, and TCP 443 are needed. UDP 443 is optional.
6. Do not put production secrets into Git, commands that will be recorded in shared logs, screenshots, or issue reports.
7. Do not automate Meta consent or security checkpoints. Pause and let the human complete them.

## Conversation style

- First state what information is needed and why.
- Ask one or two short questions at a time.
- When the human is looking at a UI, give the exact label to click and wait for a screenshot or confirmation.
- Before any destructive or externally visible action, restate the exact target and consequence.
- Translate technical failures into plain language; keep the raw error available underneath.

## Phase 1 — preflight

Establish these facts without requesting secrets:

1. The VPS belongs to the human and is intended for this installation.
2. Region is outside a jurisdiction/network where Meta is blocked.
3. OS is Ubuntu 24.04 LTS.
4. Resources are at least 2 vCPU, 2 GB RAM, 30 GB disk, one public IPv4.
5. The human can open the provider console or already has an SSH session.
6. Provider firewall allows the existing SSH port plus TCP 80 and 443.
7. The Instagram account is Professional: Creator or Business.

If terminal access is available, inspect read-only first:

```bash
cat /etc/os-release
free -h
df -h /
uname -m
```

Stop if the OS or resources do not meet the requirements. Do not silently adapt the production installer to an untested OS.

## Phase 2 — install

If the agent has an authorized terminal, perform these commands. Otherwise show one command block and wait for the human to report completion.

```bash
sudo apt update
sudo apt install -y git
git clone https://github.com/xvn3x/comment-to-dm.git /tmp/comment-to-dm
cd /tmp/comment-to-dm
sudo bash scripts/install-vps.sh PUBLIC_IP
```

Replace `PUBLIC_IP` with the server's public IPv4. If the human owns a domain already pointed to the server, it may be used instead. Do not require a paid domain: an IP becomes a free hostname such as `203-0-113-10.sslip.io`.

The installer intentionally:

- refuses to overwrite an existing installation;
- installs Docker from Ubuntu 24.04 packages;
- creates `/opt/comment-to-dm` and the unprivileged `commentdm` service user;
- generates independent admin, session, encryption, webhook, database secrets;
- starts PostgreSQL, the application, worker, and Caddy;
- waits for `/ready`;
- enables a daily systemd backup timer.

The admin password appears once. Tell the human to save it locally in a password manager. Do not ask them to send it back.

## Phase 3 — verify the server

Use read-only checks:

```bash
cd /opt/comment-to-dm
sudo docker compose ps
sudo docker compose exec -T app node -e 'fetch("http://127.0.0.1:3000/ready").then(async r => { console.log(await r.text()); process.exit(r.ok ? 0 : 1) })'
sudo systemctl status comment-to-dm-backup.timer --no-pager
sudo ls -lh /var/backups/comment-to-dm
```

Expected `/ready` response:

```json
{"ok":true,"database":true,"worker":true}
```

Open the HTTPS URL printed by the installer and let the human enter the admin password. If HTTPS is not ready, inspect `docker compose logs --tail=100 caddy`; do not disable TLS or switch Meta to HTTP.

## Phase 4 — guide Meta setup

The exact Meta dashboard labels may vary. Work from the values shown in Comment to DM's **Connection / Подключение** screen, not from guessed URLs.

Guide the human through:

1. Create a Meta for Developers app for managing Instagram messaging/content. Choose Business type if asked.
2. Add **Instagram API with Instagram Login**.
3. Add required permissions:
   - `instagram_business_basic`;
   - `instagram_business_manage_comments`;
   - `instagram_business_manage_messages`.
4. Add the Instagram account as an Instagram Tester and have the human accept the invite inside the correct Instagram mobile account.
5. Copy from Comment to DM into Meta:
   - OAuth callback;
   - Deauthorization callback;
   - Data deletion request URL;
   - Privacy policy URL;
   - Webhook callback;
   - masked Webhook verification token using its copy button.
6. Subscribe webhooks at minimum to `comments`, `messages`, and `messaging_postbacks`.
7. If Meta explicitly requires Live/Published status for real webhooks, guide the human through the requirements shown in their dashboard. Do not claim review is universally unnecessary; app roles/testers and public third-party accounts are treated differently by Meta.
8. Let the human copy App ID and App Secret directly between Meta and their own Comment to DM panel. Do not receive the values yourself unless the agent is operating locally in their trusted browser and the human explicitly asked it to fill the form.
9. The human completes Instagram OAuth and consent on the official Meta/Instagram page.

Facebook Page is not required for the Instagram Login flow used by this project. The Instagram account must be Creator or Business.

## Phase 5 — end-to-end test

1. Confirm the Connection screen shows a token, webhook subscription, and worker as ready.
2. Create an active rule limited to one test Reel/Post and one distinctive keyword.
3. Use a second Instagram account to post a new comment. The publication owner must not be the commenter.
4. Verify public reply, Direct delivery if enabled, and the Activity log.
5. If using the follower gate, the second account must voluntarily press the inline postback button before Meta allows the follow check.

Do not reuse an already processed comment to infer failure: idempotency intentionally blocks duplicate execution for the same rule/person/publication.

## Phase 6 — handoff

Explain to the human:

- the app keeps incoming text out of persistent storage and retains technical history for 30 days;
- backups contain production secrets and must stay private;
- a same-VPS backup helps with bad updates but not total VPS loss, so a recent archive should be downloaded periodically;
- their installation does not auto-update from the maintainer's GitHub pushes;
- only announced release tags should be installed.

Update command after a release announcement:

```bash
sudo /opt/comment-to-dm/scripts/update-vps.sh vX.Y.Z
```

The update creates a backup, builds separately, checks `/ready`, and rolls back the app image on failure.

## Troubleshooting boundaries

- For web/worker issues: inspect `docker compose ps` and sanitized `docker compose logs --tail=150 app caddy`.
- For Meta issues: inspect the Connection readiness state, webhook subscriptions, accepted tester role, professional-account type, and a new event in Activity.
- Redact tokens, App Secret, passwords, `.env`, backups, and personal message content before sharing logs.
- Do not “fix” permission errors by making `.env` world-readable or running PostgreSQL on a public port.
