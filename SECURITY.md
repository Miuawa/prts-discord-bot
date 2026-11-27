# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub's
[security advisories](https://github.com/Miuawa/prts-discord-bot/security/advisories/new),
not in a public issue. Describe what an attacker could do and how to reproduce it.
I will answer as soon as I can and credit you in the changelog if you like.

## Supported versions

Only the latest release gets fixes.

## What PRTS protects

- The Discord token and API keys live outside the repo (`~/.claude/channels/discord/.env`)
  and are never sent to the AI or uploaded through `reply`.
- Only allowlisted users (`access.json`) can use the bot; the Claude Code bridge listens on
  127.0.0.1 only and needs the random key in `bridge.key`.
- Discord messages reach the AI as untrusted input.
- Replies never ping `@everyone`, `@here` or roles, and `/music` refuses links to the local
  machine or network.
