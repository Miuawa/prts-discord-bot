# Changelog

## Unreleased

- `/enemy` shows the character portrait for enemies with a wiki character page (Jesselton
  Williams, Yurodstvo, Patriot...), with buttons for their other looks and a Character page link.
- `/myrtle enemies` is gone: enemy handbook progress is now a line in `/myrtle profile`, and enemy
  details are `/enemy`.
- New `/enemy`: an enemy's handbook entry (class, type, stats with the stronger stage levels,
  abilities, immunities) from the EN game data, with a link to its wiki enemy page.
- `/operator` Modules view shows one module per page, with a button per module and an Effects /
  Community review switch, instead of every module in one long embed.
- `/operator` profile reads like the wiki infobox: class, branch, position, faction, trait, summons,
  tags, how to get, tier and alternate versions, plus Amiya's forms.
- One PRTS look for every reply: a "PRTS · <module>" header (Operator Archives, Combat Records,
  Materials Planning, ...), the same colours and footer, and fewer emoji. No more narrow
  three-column fields (`/stage`, `/compare`, `/skin`, `/myrtle`, `/base`, the music panel).
- Buttons and menus for details: `/materials` switches goals with buttons and groups materials by
  tier, `/skin` has an outfit picker, `/help` has a command menu, `/operator` gains a Materials
  button, and `/stage` and `/myrtle` links are link buttons. Pressed from a private reply they
  switch it in place; pressed on a public message they answer privately.
- Fixes: `/stage` showed a raw ID for operator rewards, `/compare` showed raw branch IDs and ran
  the legend into the table.
- `/operator` is a compact card again: profile, a one-line list of modules with their rating, and
  buttons for details shown privately. **Modules** explains each module in plain words (stage 1
  trait change, stats, the talent stages 2 and 3 improve, from the EN game data, plus the DragonGJY
  verdict), with a further **Community pros and cons** button. **Outfits** and **Base skills** show
  what `/skin` and `/base` show. Wiki, Myrtle, story and voice links are link buttons.
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
