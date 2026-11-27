# Changelog

## Unreleased

- `/operator` is easier to read: no squeezed three-column fields, and each module gets its own
  full-width section with what it does in plain words (stage 1 trait change, stats, the talent
  stages 2 and 3 improve, from the EN game data) and the DragonGJY rating and recommended stage
  spelled out. The "Module pros and cons" button lists pros and cons as bullets.
- Fewer commands: `/coin` and `/choose` are now `/roll coin` and `/roll choose` (dice is `/roll dice`);
  `/module` became the "Module pros and cons" button on `/operator`; `/links` is `/help command: links`;
  `/voice` is `/music voice`.
- `/story` autocompletes stories and events and shows who speaks in each chapter.
- `/operator` for an NPC also shows their story appearances (lines and stories).
- `/farm` understands tier names (Orirock Cube, Integrated Device) and says when a material is
  best bought from event shops.
- Optional daily story index refresh (`PRTS_STORY_REFRESH_CMD`), re-read without a restart.
- Automatic posts: each server picks a channel with `/events announce` for new stories, and
  events or headhunting banners when they start and a day before they end. The event list is
  now `/events schedule`.

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
