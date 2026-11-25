# Changelog

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
