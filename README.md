# PRTS Discord bot

[![CI](https://github.com/Miuawa/prts-discord-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/Miuawa/prts-discord-bot/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Miuawa/prts-discord-bot?include_prereleases&sort=semver)](https://github.com/Miuawa/prts-discord-bot/releases)
[![License](https://img.shields.io/github/license/Miuawa/prts-discord-bot)](LICENSE)
![Bun](https://img.shields.io/badge/runtime-Bun-black?logo=bun)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)

An unofficial, Arknights-themed Discord bot. Instant commands (operator cards, tier list,
farming, recruitment, music and more) are answered by the bot itself. `/prts` chat goes to an
AI of your choice: a [Claude Code](https://code.claude.com) session on your PC (with a Claude
Pro/Max plan), the Anthropic API, or any OpenAI-compatible model, including one you run
yourself. Extra features, like the roleplay narrator, are optional
[modules](#modules).

> **Unofficial fan project.** Not affiliated with, endorsed by or sponsored by Anthropic,
> Discord, Hypergryph, Studio Montagne or Yostar. No game assets or story text are included;
> game data is fetched at runtime from public community sources. See [NOTICE](NOTICE).

**Documentation:** the [Wiki](https://github.com/Miuawa/prts-discord-bot/wiki) has a guided tour:
[Installation](https://github.com/Miuawa/prts-discord-bot/wiki/Installation),
[Configuration](https://github.com/Miuawa/prts-discord-bot/wiki/Configuration),
[Commands](https://github.com/Miuawa/prts-discord-bot/wiki/Commands),
[Modules](https://github.com/Miuawa/prts-discord-bot/wiki/Modules),
[Troubleshooting](https://github.com/Miuawa/prts-discord-bot/wiki/Troubleshooting) and
[FAQ](https://github.com/Miuawa/prts-discord-bot/wiki/FAQ). This README stays the full reference.

## Features

- **Arknights tools, no AI needed**: `/operator`, `/skin`, `/tier`, `/farm`,
  `/recruit`, `/base`, `/events`, `/enemy`, `/stage`, `/compare`, `/materials`, `/myrtle`, `/wiki`,
  `/story`, `/help`. Every answer is a compact PRTS card with buttons for details: an operator
  card opens its modules, outfits, base skills and materials; long lists get page buttons.
- **Utilities**: `/roll` (dice like `2d6+3`, `4d6kh3`, `d%`; coin toss; pick an option), `/remind`, `/status`.
- **Voice**: `/music` (local files, uploads, anything `yt-dlp` plays, lyrics) and `/music voice`
  (official operator voice lines).
- **Talk to PRTS**: `/prts` and the "Ask PRTS" message command, with Discord pairing and
  allowlist access control.
- **Pick your AI**: `claude-code`, `anthropic`, `openai-compatible` or `auto` (Claude when its
  session is up, another model otherwise).
- **Modules**: add-ons you enable in `.env`, each with its own commands and AI settings.
- Runs on **Linux** (systemd user units) and **Windows** (batch/PowerShell launchers).

## Modules

| Module | What it does | Guide |
|---|---|---|
| `roleplay` | `/rp` and roleplay channels with an AI narrator, player roster, away mode, turn reminders, a narrator kit. Can use its own AI, separate from `/prts`. | [modules/roleplay/README.md](modules/roleplay/README.md) |
| `control` | Desktop tool (Linux): a tray icon and window to start, stop and autostart the bot, the Claude Code narrator and the local model. Not loaded by the bot; install it with its script. | [modules/control/README.md](modules/control/README.md) |

Enable bot modules with `PRTS_MODULES=roleplay` (comma-separated) in `.env` and restart the bot.
Without `PRTS_MODULES`, none are loaded. Desktop modules like `control` are installed
separately and don't go in `PRTS_MODULES`. A module from elsewhere goes into
`modules/<name>/`. To write your own, see [docs/modules.md](docs/modules.md).

## Architecture

```
Discord ──► src/bot.ts ── instant commands, music, access control (always on)
              │   │
              │   ├── modules/<name>/index.ts      optional add-ons (PRTS_MODULES)
              │   │
              │   └── AI turns, per the backend settings:
              │         claude-code ──► WebSocket on 127.0.0.1 ──► src/server.ts ◄─ MCP ─ Claude Code narrator
              │         anthropic ─────► Anthropic Messages API (official SDK)
              │         openai-compatible ► any /v1/chat/completions server
              ▼
           replies posted to Discord
```

| Path | Role |
|---|---|
| `src/bot.ts` | The Discord connection: access control, slash commands, module loading, the bridge for Claude Code, and routing of AI turns. Keeps running when Claude restarts. |
| `src/server.ts` | MCP server Claude Code loads (from `.mcp.json`). Relays Discord events to Claude and its `reply`/`react`/`edit_message`/`fetch_messages`/`download_attachment` calls back to the bot. Connects only when `PRTS_LAUNCHER=1`. |
| `src/ai/` | Backend settings (`config.ts`), the Anthropic and OpenAI-compatible clients (`providers.ts`), history and turn handling for API models (`turns.ts`), the `/prts` prompt (`chat.ts`). |
| `src/modules.ts` | The module interface and loader. |
| `src/ark.ts`, `ark/`, `arkplus.ts` | Arknights commands (game data from the ArknightsAssets GitHub mirror, community sheets, wiki, story reader). `ark.ts` routes them; `ark/` has one file per command plus the shared game data and sheets. |
| `src/equip.ts`, `enemy.ts` | Parsing of module effects and enemy handbook data from the game tables. |
| `src/theme.ts`, `pages.ts`, `common.ts` | The shared PRTS look (colours, header, footer), page buttons for long replies, and shared URLs and helpers. |
| `src/visits.ts` | Visit times for PRTS-style greetings in `/prts`. |
| `src/music.ts`, `lyrics.ts`, `voice.ts` | Music player, lyrics lookup, voice lines. |
| `src/env.ts`, `paths.ts` | Settings loading and shared folder locations. |
| `modules/roleplay/` | The roleplay module, with its narrator kit template. |

The instant commands always answer. When the chosen AI can't answer (for example the Claude
Code narrator isn't running), AI requests get an "offline" notice.

## Requirements

- [Bun](https://bun.sh) 1.1 or newer.
- A Discord application with a bot user.
- One AI, for `/prts` (and modules that use AI):
  - `claude-code`: the [Claude Code CLI](https://code.claude.com/docs/en/quickstart), signed in
    with a Claude Pro/Max plan. Usage counts against that plan.
  - `anthropic`: an Anthropic API key.
  - `openai-compatible`: a local server ([llama.cpp](https://github.com/ggml-org/llama.cpp),
    Ollama, LM Studio, ...) or a cloud API key.
- For music and attachments: `ffmpeg`/`ffprobe`; for links: `yt-dlp`.
- For the Linux narrator service: `tmux`.

## Quick start

```bash
git clone <this repo> prts-bot && cd prts-bot
cp .env.example .env                       # edit settings (see Configuration)
bun install
bun src/bot.ts --dry-run                   # checks the setup without a token
```

Then set up Discord (next section), store the token, choose an AI, and start the bot with
`bun src/bot.ts`, or use the Linux/Windows launchers below.

### 1. Create the Discord app

1. <https://discord.com/developers/applications> → **New Application**.
2. **Bot** → **Reset Token**, copy it. Under **Privileged Gateway Intents**, turn on
   **Message Content Intent**.
3. **Installation** → tick **Guild Install** (scopes `bot`, `applications.commands`) and,
   if you want the commands in DMs and other servers, **User Install** (`applications.commands`).
   Bot permissions: View Channels, Send Messages, Send Messages in Threads, Embed Links,
   Attach Files, Read Message History, Add Reactions, Connect, Speak.
4. Open the install link and add the bot to your server (and "Add to My Apps" for user installs).

### 2. Store the token

Put it in `~/.claude/channels/discord/.env` (outside this folder, so a Claude Code narrator
working here can't read it), with `chmod 600`:

```
DISCORD_BOT_TOKEN=your-token
```

The official Claude Code Discord plugin's `/discord:configure <token>` writes the same file.
`DISCORD_BOT_TOKEN` in the repo `.env` or the real environment also works.

### 3. Allow people

Only users in `allowFrom` of `~/.claude/channels/discord/access.json` can use the bot.
The file format is the one of Anthropic's Discord plugin, so its `/discord:access` skill can
manage it (install with `/plugin install discord@claude-plugins-official` in Claude Code):

1. DM the bot; it answers with a pairing code. In Claude Code run `/discord:access pair <code>`.
2. `/discord:access allow <user-id>` for each friend, `/discord:access policy allowlist`.
3. Optional: `/discord:access group add <channel-id>` so the bot hears @mentions in a channel.

Or write the file yourself:

```json
{ "dmPolicy": "allowlist", "allowFrom": ["<your-user-id>"], "groups": {}, "pending": {} }
```

(Turn on Discord's Developer Mode to copy IDs.)

### 4. Choose the AI for `/prts`

**Claude Code (subscription)**: `PRTS_BACKEND=claude-code` (the default). Start Claude Code
**in the repo root** with `PRTS_LAUNCHER=1` and the development channel flag, so it loads
`src/server.ts` from [`.mcp.json`](.mcp.json):

```bash
PRTS_LAUNCHER=1 claude --model sonnet --dangerously-load-development-channels server:discord
```

Every time it starts, Claude Code asks you to confirm "Loading development channels":
choose **"I am using this for local development"** (one keypress). The launchers below start
it the same way; on Linux, answer the prompt in the tmux session
(`tmux attach -t prts-narrator`). Until you confirm, the narrator is not connected; with
`auto`, the fallback model answers meanwhile. Run `claude` once in the folder first to sign in, trust the folder and enable the
`discord` MCP server (see Troubleshooting).

**Anthropic API**:

```ini
PRTS_BACKEND=anthropic
ANTHROPIC_API_KEY=sk-ant-...      # better in ~/.claude/channels/discord/.env
PRTS_MODEL=claude-sonnet-5-5        # default; claude-opus-5-5 is stronger, claude-haiku-5-5 cheaper
```

**Your own model or another API** (llama.cpp, Ollama, LM Studio, OpenRouter, OpenAI, ...):

```ini
PRTS_BACKEND=openai-compatible
PRTS_BASE_URL=http://127.0.0.1:8081/v1   # Ollama: :11434/v1, LM Studio: :1234/v1
PRTS_MODEL=<model id>
#PRTS_API_KEY=<key, for cloud APIs>
```

The roleplay guide has [step-by-step setups for each of these](modules/roleplay/README.md#3-connect-your-ai);
they work the same for `/prts` with `PRTS_` instead of `RP_`.

## Configuration

Settings come from the real environment, then `<repo>/.env` (or `PRTS_ENV_FILE`), then
`~/.claude/channels/discord/.env`. The first one that sets a variable wins.
[`.env.example`](.env.example) lists them all. Module settings are in each module's README.

| Variable | Default | What it does |
|---|---|---|
| `DISCORD_BOT_TOKEN` | (required) | Bot token. Prefer `~/.claude/channels/discord/.env`. |
| `DISCORD_STATE_DIR` | `~/.claude/channels/discord` | Folder of the token `.env`, `access.json`, `bridge.key`, `inbox/`. Set it in the real environment. |
| `DISCORD_ACCESS_MODE` | (unset) | `static`: read `access.json` once, never write it (pairing off). |
| `PRTS_ENV_FILE` | `<repo>/.env` | Other location for the repo settings file. |
| `PRTS_MODULES` | (empty) | Modules to load, comma-separated folder names under `modules/`. |
| `PRTS_MODULES_DIR` | `<repo>/modules` | Where modules are looked up. |
| `PRTS_BACKEND` | `claude-code` | Who answers `/prts`: `claude-code`, `anthropic`, `openai-compatible`, `auto`. |
| `PRTS_AUTO_FALLBACK` | `openai-compatible` | API backend `auto` uses while no narrator is connected. |
| `PRTS_MODEL` | `claude-sonnet-5-5` (anthropic) / `local` | Model id for the API backend. |
| `PRTS_BASE_URL` | `http://127.0.0.1:8081/v1` | OpenAI-compatible server, up to `/v1`. |
| `PRTS_API_KEY` | (unset) | OpenAI-compatible bearer key. |
| `ANTHROPIC_API_KEY` / `PRTS_ANTHROPIC_API_KEY` | (unset) | Anthropic key. |
| `PRTS_EFFORT` | `medium` | Anthropic effort: `low` to `max`. |
| `PRTS_TEMPERATURE` | `0.7` | OpenAI-compatible temperature (`none` leaves it out). |
| `PRTS_MAX_TOKENS` | 16000 (anthropic) / 1400 | Reply length limit. |
| `PRTS_MAX_TOKENS_FIELD` | `max_tokens` | `max_completion_tokens` for newer OpenAI models. |
| `PRTS_EXTRA_BODY` | `{}` | JSON merged into OpenAI-compatible requests (e.g. `{"chat_template_kwargs":{"enable_thinking":false}}`). |
| `PRTS_LABEL` | backend name | Name of the model in logs and `/status`. |
| `PRTS_VISION` | `auto` | Send image attachments (the message's, and the replied-to message's) to API models: `auto` (and answer from the text if the model rejects images), `on`, `off`. Local models need a vision projector (mmproj) loaded. |
| `PRTS_REFUSAL_FALLBACK` | `off` | Anthropic: `on` re-runs a declined turn on a fallback model chosen by the API. |
| `PRTS_TIMEOUT` | `300` | Seconds to wait for an API model's reply. |
| `PRTS_MAX_IMAGES` | `4` | Images per message for API models (8 MB each at most). |
| `PRTS_PERSONA_FILE` | built-in | Text file with your own `/prts` persona for API backends. |
| `PRTS_AI_HISTORY` | `<cache>/ai-history.json` | Per-channel history for API backends. |
| `PRTS_NARRATOR_MODEL` | `sonnet` | Model the launchers pass to `claude --model`. |
| `PRTS_LAUNCHER` | (unset) | `1` makes `server.ts` connect to the bot. Set only by the narrator launchers. |
| `PRTS_BRIDGE_PORT` | `47823` | Port of the local bridge (127.0.0.1 only). |
| `LLAMA_MODEL` | (required for the unit) | `-hf` model for `linux/systemd/llama-server.service`, e.g. `user/model-GGUF:Q4_K_M`. |
| `LLAMA_HOST`, `LLAMA_PORT` | `127.0.0.1`, `8081` | Where `llama-server` listens. |
| `LLAMA_ARGS` | `-c 32768 --parallel 1 -ngl 99` | Extra `llama-server` flags. |
| `PRTS_DATA_DIR` | `<repo>/data` | Community sheet copies (`sheets/`) and `stories.json`. |
| `PRTS_CACHE_DIR` | `<repo>/cache` | Game data cache, histories, reminders. |
| `PRTS_STORIES_JSON` | `<data>/stories.json` | Optional story index for `/story`. |
| `PRTS_NO_SHEET_REFRESH` | (unset) | `1` stops pulling the community Google Sheets every 6 hours. |
| `PRTS_USER_AGENT` | `PRTS-Discord-bot/1.0 (...)` | User-Agent for wiki, sheets and game data requests. |
| `PRTS_MUSIC_DIR` | `<repo>/music` | Local music library for `/music`. |
| `PRTS_YTDLP`, `PRTS_FFPROBE` | `yt-dlp`, `ffprobe` | Program paths. |

## Running on Linux (systemd user services)

```bash
linux/install.sh                        # renders the units into ~/.config/systemd/user, creates .env
systemctl --user enable --now prts-bot.service
systemctl --user enable --now prts-backup.timer    # nightly backup of settings and saved data
# Only for the claude-code (or auto) backend:
systemctl --user enable --now prts-narrator.service           # Claude Code narrator in tmux
systemctl --user enable --now prts-narrator-restart.timer     # fresh narrator session at 05:00 (confirm its prompt)
# Only for a local model on llama.cpp:
systemctl --user enable --now llama-server.service
loginctl enable-linger "$USER"          # optional: keep running while logged out
```

- `linux/install.sh --no-narrator --no-llama` installs only what an API-only setup needs.
  For a local model, keep the llama unit: it replaces the `llama-server.service` some
  llama.cpp packages ship, which starts without a model on another port. Set `LLAMA_MODEL`
  (and `LLAMA_HOST`, `LLAMA_PORT`) in `.env` first.
  Units of enabled modules (`modules/<name>/linux/systemd/`) are installed too.
- Prefer containers? [docs/docker.md](docs/docker.md) runs the bot in Docker instead (optional;
  the narrator and any local model stay on the host).
- To switch services on and off from the desktop, install the [`control`](modules/control/README.md) module.
- Watch the narrator: `tmux attach -t prts-narrator` (detach with `Ctrl-b d`).
- Logs: `journalctl --user -u prts-bot -f`, `logs/narrator.log`.
- `linux/restart-bot.sh` restarts only the bot; `linux/restart-narrator.sh` saves the chat
  to `logs/` and starts a fresh narrator session.
- Re-run `linux/install.sh` after moving the folder or changing `PRTS_MODULES`.

### Backups

`prts-backup.timer` runs `linux/backup.sh` every night at 03:30 (or at the next login if the PC
was off). It saves what isn't in git: `.env`, `cache/` (reminders, music history, saved links,
roleplay players, announce channels) and the Discord state folder (token, `access.json`,
`bridge.key`), plus PRTS Control's service list. Game data caches and Discord attachments are
left out because they download again.

- Backups go to `~/PRTS-backups/bot/` and the newest 7 are kept. They contain your token, so the
  folder is mode 700 and each file 600; keep them off shared or synced drives. Settings in `.env`:
  `PRTS_BACKUP_DIR`, `PRTS_BACKUP_KEEP`, `PRTS_BACKUP_EXTRA` (more paths) and
  `PRTS_BACKUP_GPG_RECIPIENT` (encrypt every backup to one of your gpg keys).
- Back up now: `systemctl --user start prts-backup.service` (or **Back up now** in PRTS Control,
  which also shows the last result). List: `linux/backup.sh --list`.
- Restore: stop the bot, extract over the same paths, start it again:

  ```bash
  systemctl --user stop prts-bot.service
  tar --zstd -xpf ~/PRTS-backups/bot/prts-bot-<date>.tar.zst -C /
  systemctl --user start prts-bot.service
  ```

  For an encrypted one: `gpg -d <file>.tar.zst.gpg | tar --zstd -xpf - -C /`.

## Running on Windows

> The Windows scripts were adapted for this release but have not been tested on Windows yet.
> Reports and fixes are welcome.

- `windows\start-bot.bat` runs the bot in a restart loop (log in `logs\bot.log`). That's all an
  API-only setup needs.
- `windows\start-narrator.bat` (for `claude-code`) starts the bot hidden in the background,
  then the Claude Code narrator in its window.
- `windows\stop-bot.bat`, `windows\stop-narrator.bat` stop them.
- `powershell -File windows\register-tasks.ps1` registers the narrator watchdog (every 5 min)
  and a fresh narrator session at 05:00.
- After every narrator start (including the watchdog and the 05:00 restart), confirm Claude
  Code's "Loading development channels" prompt in the narrator window.

## Troubleshooting

- **`/prts` stays on "thinking", or "narrative core unavailable"**: the chosen AI isn't
  answering. `/status` shows which backend answers and whether it can be reached. For
  `claude-code`, check that Claude Code was started in the repo root with `PRTS_LAUNCHER=1`
  and `--dangerously-load-development-channels server:discord`.
- **The `discord` MCP server never loads**: Claude Code only starts servers from a project
  `.mcp.json` after you approve them. Approve it when asked, or put
  `{"enabledMcpjsonServers": ["discord"]}` in `.claude/settings.local.json`
  (see [`.claude/settings.local.json.example`](.claude/settings.local.json.example)).
- **Don't** start the narrator with `--channels plugin:discord@claude-plugins-official`: that
  listens to the official plugin, which has none of these slash commands.
- **Claude Code bills an API key instead of your subscription**: `ANTHROPIC_API_KEY` is set in
  its environment. Keep that key only in a `.env` file the bot reads, not in your shell profile.
- **"Not authorized" / "Identity verification failed"**: the user is not in `allowFrom`.
- **Bot exits with code 3**: another copy already holds the bridge port. Stop it first.
- **Plain messages in a server channel are ignored**: the channel needs a `groups` entry in
  `access.json` (and an @mention, unless `requireMention` is false), or must be owned by a
  module (like a roleplay channel).
- **The local model doesn't see images, or llama-server crashes on one**: the model needs its
  vision projector (`llama-server -hf` downloads it when the repo has one; `/props` then shows
  `"vision": true`). On a small GPU it may not fit next to the model: lower the context
  (`-c 24576` instead of 32768 freed enough on an 8 GB card) and add `--image-max-tokens 1024`
  so a photo doesn't become thousands of tokens. `--no-mmproj-offload` (vision on the CPU)
  also avoids the crash, but a photo then takes 30 s to several minutes. `PRTS_VISION=off`
  stops sending images.
- **A module doesn't load**: the log says why (`prts modules: ...`). The folder must be
  `modules/<name>/index.ts` and the name must be in `PRTS_MODULES`.
- **`/tier`, `/farm`, `/base` and module ratings are empty**: the sheet copies are created about 20 s
  after start; check the log for Google errors.
- **Slash commands don't show up**: Discord can take a while after the first registration;
  restart the Discord client.

## Development

```bash
bun run check      # type check, tests (offline, no keys), dry run
bun run format     # Biome formatter
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

- Never commit `.env`, `access.json`, `bridge.key`, `logs/`, `cache/` or your `roleplay-kit/`.
  `.gitignore` covers them; check `git status` before you push.
- Keep the token and API keys outside the repo (`~/.claude/channels/discord/.env`). The bot
  refuses to upload files from the state folder or the repo `.env` through `reply`.
- The bridge listens only on 127.0.0.1 and needs the random key in `bridge.key`.
- Replies can mention users but never `@everyone`, `@here` or roles, whatever text they echo.
- `/music` plays only public links: addresses on the local machine or network are refused.
- In Docker the bot runs non-root on a read-only filesystem with no secrets in the image; see
  [docs/docker.md](docs/docker.md#security).
- Found a vulnerability? See [SECURITY.md](SECURITY.md).
- Discord messages reach the AI as untrusted input. The narrator is told never to change
  access, files or settings because a message asked; keep Claude Code's permission prompts on.

## Support

PRTS is free and stays free. If it's useful to you and you'd like to say thanks, you can
[buy me a coffee on Ko-fi](https://ko-fi.com/miuawa). Tips support my time on the code only;
nothing in the bot is paid or locked.

## Credits

PRTS stands on a lot of other people's work. Nothing from these sources is copied into the
repo: the bot fetches from them at runtime or links to them. Thank you to all of them.

**Arknights**

- [Arknights](https://www.arknights.global) by Hypergryph and Studio Montagne, published
  worldwide by Yostar. The game, its characters, story, art, music and the PRTS name belong
  to them.

**Game data and story**

- [Timo's Arknights story reader](https://arknights.timo.beer): story pages and voice lines
  (`/story` and voice lines).
- [Arknights Terra Wiki](https://arknights.wiki.gg): `/wiki` search and character lookups.
- [ArknightsAssets/ArknightsGamedata](https://github.com/ArknightsAssets/ArknightsGamedata):
  English game data tables (operators, modules, factions, recruitment).
- [yuanyan3060/ArknightsGameResource](https://github.com/yuanyan3060/ArknightsGameResource):
  operator avatars.
- [Myrtle](https://myrtle.moe): player profiles for `/myrtle`, and operator art through its
  asset CDN.

**Community guides** (fan-made Google Sheets)

- [AK Tier List](https://docs.google.com/spreadsheets/d/1E7HmgKWiV8pKpJpvpVzziYxnaQTP01Vtw_PXEdL7XPA/edit) (`/tier`)
- [DragonGJY's module ratings](https://docs.google.com/spreadsheets/d/1A0_0XTAcDDtHkvyAwjTqEEzM8cf5h3E60u23ZVXw4eg/edit) (`/operator` module ratings)
- [PeterYR's farming sheet](https://docs.google.com/spreadsheets/d/1RRiTIYVUNUf-xW8ljAJdYEOuSo23lpjHkPa0-zuC_4k/htmlview) (`/farm`)
- [RIIC base skill guide](https://docs.google.com/spreadsheets/d/1zYc2JU46X0XWmV7s1503bN4feRdOMa1eehrTQ2jGaiE/edit) (`/base`)
- Linked from `/help command: links`: [Penguin Statistics](https://penguin-stats.io),
  [Arknights Toolbox](https://arkntools.app) and
  [TacticalBreakfast's mastery guides](https://docs.google.com/spreadsheets/d/1iJF12O6QOba1dlUVmobwvc1eBZE7FRB6-tKxmZEcG1I/).

**Music and lyrics**

- [yt-dlp](https://github.com/yt-dlp/yt-dlp) finds and streams the audio, and
  [FFmpeg](https://ffmpeg.org) decodes it. Songs come from wherever the link points
  (YouTube, SoundCloud, Bandcamp and so on); Spotify links are matched through Spotify's
  public oEmbed page.
- Lyrics: [LRCLib](https://lrclib.net), [Genius](https://genius.com),
  [Musixmatch](https://www.musixmatch.com) and YouTube Music.

**Software**

- Anthropic's [Claude Code](https://code.claude.com) and its Discord channel plugin, which
  `src/bot.ts` and `src/server.ts` are based on (see [NOTICE](NOTICE)).
- [discord.js](https://discord.js.org) and `@discordjs/voice`, the
  [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk),
  the [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript),
  [Zod](https://zod.dev), opusscript and `@snazzah/davey`, run on [Bun](https://bun.sh).
- Local models: any OpenAI-compatible server, such as
  [llama.cpp](https://github.com/ggml-org/llama.cpp)'s `llama-server`.

Optional extras you add yourself, such as the PRTS Control logo
([modules/control](modules/control/README.md#logo)), stay under their owners' rights.

## License

Apache License 2.0, see [LICENSE](LICENSE). `src/bot.ts` and `src/server.ts` are based on
Anthropic's Claude Code Discord plugin (Apache-2.0); see [NOTICE](NOTICE).
