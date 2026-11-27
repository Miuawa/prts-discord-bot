# Changelog

## 0.2.3 (2026-11-28)

### New
- Nightly backups: `linux/backup.sh` with `prts-backup.timer` (03:30) saves `.env`, `cache/` and the
  Discord state folder to `~/PRTS-backups/bot/` (private, newest 7 kept, optional gpg encryption).
  `linux/install.sh` installs the units; PRTS Control shows the last backup and has Back up now.
- Optional Docker setup (`Dockerfile`, `compose.yaml`, `docs/docker.md`): non-root, read-only,
  no capabilities, no secrets in the image, bridge published on 127.0.0.1 only. systemd stays
  the default. `PRTS_BRIDGE_HOST` sets the bridge address (Docker only).

### Security
- The bridge key is compared in constant time.

## 0.2.2 (2026-11-28)

### Changed
- `src/ark.ts` (about 2,900 lines) is split into one file per command under `src/ark/` (`roll`, `operator`,
  `tier`, `farm`, `recruit`, `wiki`, `story`, `base`, `skin`, `myrtle`, `help`), plus shared `definitions`,
  `data`, `sheets`, `helpers` and `autocomplete`. `src/ark.ts` routes commands, buttons and menus to them.
  No change in behaviour: every command, card, button and /help entry is the same.

## 0.2.1 (2026-11-28)

### Security
- Replies can no longer ping `@everyone`, `@here` or roles, whatever text they echo.
- `/music` refuses links to the local machine or private network addresses.

### Changed
- `/compare` has Operator 1 | Compare | Operator 2 tabs; `/roll` explains only the notation a roll
  uses, and `/roll coin` takes `heads:` for a weighted coin.
- Shared URLs and helpers live in `src/common.ts`; `PRTS_GAMEDATA_URL` can point at a mirror.
- GitHub: README badges, issue and pull request templates, `SECURITY.md`.

## 0.2.0 (2026-11-28)

A big readability and PRTS-styling update, a new `/enemy` command, and fewer commands overall.

### New
- `/enemy`: an enemy's handbook entry from the EN game data: class, type, stats with the stronger
  stage levels, abilities, immunities, the portrait from its wiki page (hand-checked where the wiki
  is ambiguous), and buttons to switch between variants ('Emperor's Blade', Pursuer, Halberd Breaker).
- `/stage` lists the stage's enemies; `/tier operator:` shows the sheet's written assessment and
  rating history; `/myrtle showcase` previews grids and tier lists.
- Page buttons (◀ 1/N ▶) for long replies: `/tier`, `/myrtle inventory`, `/music queue`, `/music list`.
- `/prts` answers in the in-game PRTS voice, with greetings and a self-verification `/status`.

### One PRTS look
- Every reply is a card with a "PRTS · <module>" header, PRTS red, and the PRTS footer; amber only
  for warnings. No narrow three-column fields anywhere.
- `/operator` is a compact wiki-style profile (class, trait, summons, how to get, tier, alternates)
  with buttons: Modules (one module per page, plain-word effects, community review), Outfits,
  Base skills, Materials, and link buttons.
- `/compare` has Operator 1 | Compare | Operator 2 tabs with tier, modules and verdicts;
  `/materials` switches goals with buttons; `/skin` has an outfit menu; `/help` has a command menu.
- `/base`, `/wiki`, `/status`, `/remind` and the `/rp` cards read in plain words.

### Changed
- `/recruit` takes one comma-separated tags option with autocomplete; `/roll` explains its dice
  notation, takes a reason, and the coin can be weighted.
- `/events` splits 6★ and 5★ rate-ups for every banner type; `/farm` names new material families
  from the sheet itself.
- Roleplay: each channel has its own session; turn reminders ping only players who wrote there;
  someone with no character gets a "join or OOC" card instead of a stuck wait.
- Fewer commands: `/coin` and `/choose` are `/roll coin|choose`, `/module` is a button on
  `/operator`, `/links` is `/help command: links`, `/voice` is `/music voice`, `/myrtle enemies` is a
  line in `/myrtle profile`, `/rp status` is part of `/rp channels`.
- Automatic posts: `/events announce` picks a channel for new stories, events and banners;
  `/story` autocompletes and shows who speaks; optional daily story index refresh.

### Fixed
- `/stage` showed raw IDs for operator rewards; `/compare` showed raw branch IDs; 3★ operators had
  no art; `/myrtle enemies` crashed on unnamed enemies; `/base` team lists swallowed workers.

### For developers
- `src/theme.ts` (shared look), `src/pages.ts` (page buttons), `src/equip.ts` and `src/enemy.ts`
  (game data parsing); `tests/help.test.ts` fails when a command is missing from `/help`.

## 0.1.0 (unreleased)

First public version.

- Standalone Discord bot (`src/bot.ts`) with instant Arknights commands: `/operator`, `/tier`,
  `/module`, `/farm`, `/recruit`, `/base`, `/skin`, `/events`, `/stage`, `/compare`,
  `/materials`, `/myrtle`, `/wiki`, `/story`, `/links`, `/help`, dice (`/roll`, `/coin`,
  `/choose`) and reminders (`/remind`).
- Voice-channel music player (`/music`, with lyrics) and operator voice lines (`/voice`).
- `/prts` and the "Ask PRTS" message command, with pairing and allowlist access control from
  Anthropic's Claude Code Discord plugin.
- AI backends: `claude-code` (a Claude Code session through the MCP bridge, `src/server.ts`),
  `anthropic` (Messages API, official SDK), `openai-compatible` (llama.cpp, Ollama, LM Studio,
  OpenRouter, OpenAI, ...) and `auto`. API models also get image attachments (vision),
  falling back to text when a model has no vision.
- Add-on modules (`src/modules.ts`, `PRTS_MODULES`), with the roleplay module in
  `modules/roleplay/`: `/rp`, roleplay channels, away mode, turn reminders, a narrator kit,
  and its own AI settings (`RP_*`).
- PRTS Control (`modules/control/`), a Linux tray app to start, stop and autostart the PRTS
  services, with a configurable service list.
- systemd user units for Linux (`linux/`) and launch scripts for Windows (`windows/`).
- `bun src/bot.ts --dry-run` and `--help`; offline tests (`bun test`); CI with type check,
  format check, tests and dry runs.
