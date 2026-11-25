# Roleplay module

An add-on for the PRTS Discord bot that turns it into a roleplay narrator. Players write
in a roleplay channel (or use `/rp act`), and an AI narrator answers with the next scene and
choices for each player. The core bot works without this module; nothing here is loaded
unless you enable it.

**What it adds**

- `/rp act | ooc | join | recap`: in-character actions, out-of-character notes, joining with a
  character, story recaps. These go to the AI.
- Roleplay channels: `/rp setchannel`, `/rp removechannel`, `/rp channels`, `/rp pause`,
  `/rp resume`, `/rp status`. In an active roleplay channel, allowlisted players just write,
  no @mention needed.
- `/rp players` (the roster), `/rp afk` (the narrator plays your character while you are away),
  `/rp reminders` (nudge players who haven't acted yet).
- A narrator kit (`kit/`): your rules (`CLAUDE.md`), the player table, character profiles,
  non-canon notes and story logs.
- Its own AI settings (`RP_*`), so roleplay can use a different AI than `/prts`.

## 1. Install and enable

The module ships with the bot in `modules/roleplay/`. If you got it separately, put the folder
there so that `modules/roleplay/index.ts` exists. It needs no extra packages.

In the repo's `.env`:

```ini
PRTS_MODULES=roleplay
RP_OWNER_IDS=<your Discord user id>     # who may manage roleplay channels
```

Restart the bot. `bun src/bot.ts --dry-run` should now list `/rp` and say `modules: roleplay`.
To turn it off again, remove `roleplay` from `PRTS_MODULES` and restart: `/rp` disappears
from Discord and from `/help`.

## 2. Set up the narrator kit

```bash
cp -r modules/roleplay/kit roleplay-kit     # git ignores roleplay-kit/
```

Then edit `roleplay-kit/`:

- `CLAUDE.md`: the narrator's rules. Keep the section headings ("Narrator voice", "Narrator
  personality", "Turn flow with two or more players", "Turn format", "Local model notes"): API
  models get exactly those sections. Fill in the **Players** table
  (`| Discord username | Plays |`), or let players use `/rp join` and add them.
- `characters/<Name>.md`: one profile per character (see `characters/README.md`). Write them
  yourself; don't paste game scripts.
- `noncanon/characters/<Name>.md`: what your stories invented about a character.
- `story-log/`: one file per story. The narrator adds each turn.

Then in Discord, in the channel you want: `/rp setchannel`. Players need to be allowed to use
the bot (`allowFrom` in `access.json`, see the main README).

## 3. Connect your AI

`RP_BACKEND` picks who narrates. Every `RP_*` setting you leave out falls back to the core
`PRTS_*` one, so roleplay and `/prts` can share one AI or use different ones.

| `RP_BACKEND` | Who narrates | Cost |
|---|---|---|
| `claude-code` | A Claude Code session on your PC (the "narrator"), through the bot's bridge. It reads your kit, keeps the story log and can look things up. | Your Claude Pro/Max plan |
| `anthropic` | Claude through the Anthropic API, called by the bot. | Pay per token |
| `openai-compatible` | Any OpenAI-style server: your own model (llama.cpp, Ollama, LM Studio, vLLM, KoboldCpp) or a cloud API (OpenRouter, OpenAI, Groq, ...). | Free locally / per token |
| `auto` | `claude-code` while the narrator session is connected, else `RP_AUTO_FALLBACK`. | |

API backends get no tools: the module builds their prompt from your kit (rules, roster,
profiles of the characters in play, the end of the story log, and the channel history) and
posts the reply. Their in-character turns are added to the story log under
`### <time> · PRTS (<label>)`.

### Claude Code (Pro/Max subscription)

```ini
RP_BACKEND=claude-code
```

1. Install the [Claude Code CLI](https://code.claude.com/docs/en/quickstart) and sign in with
   your Claude account.
2. Add a line with only `@roleplay-kit/CLAUDE.md` at the end of the repo's `CLAUDE.md`, so the
   narrator loads your rules.
3. Start the narrator: `linux/install.sh` + `systemctl --user enable --now prts-narrator.service`
   (Linux) or `windows\start-narrator.bat` (Windows). See the main README.
   Confirm Claude Code's "Loading development channels" prompt each time it starts.

The narrator answers everything that goes to `claude-code`, so it also answers `/prts` unless
you set `PRTS_BACKEND` to something else. To use Claude only for roleplay:
`PRTS_BACKEND=openai-compatible` (or `anthropic`) and `RP_BACKEND=claude-code`.

Don't put `ANTHROPIC_API_KEY` in your shell profile when you use the subscription: Claude Code
would then bill the API key. Use `RP_ANTHROPIC_API_KEY` in a `.env` file instead (next section).

### Anthropic API (API key)

```ini
RP_BACKEND=anthropic
RP_ANTHROPIC_API_KEY=sk-ant-...          # better: in ~/.claude/channels/discord/.env
RP_MODEL=claude-sonnet-5-5                 # default; claude-opus-5-5 is stronger, claude-haiku-5-5 cheaper
RP_EFFORT=medium                         # low | medium | high | xhigh | max
```

Get a key at <https://platform.claude.com>. The module sends the system prompt with prompt
caching on. `RP_REFUSAL_FALLBACK=on` re-runs a turn Claude declines on a fallback model
chosen by the API (off by default). `RP_MAX_TOKENS` (default 16000) includes the model's
thinking, so keep it roomy. Lower `RP_EFFORT` for faster, cheaper turns.

### llama.cpp (`llama-server`, local)

```ini
RP_BACKEND=openai-compatible
RP_BASE_URL=http://127.0.0.1:8081/v1
RP_LABEL=my local model
# Qwen3-style models think by default and can spend the whole budget on it:
RP_EXTRA_BODY={"chat_template_kwargs":{"enable_thinking":false}}
```

For images, the model needs its vision projector (mmproj; `-hf` downloads it when the repo has
one). Add `--image-max-tokens 1024` so photos stay small. If llama-server crashes on an image
because the GPU is full, lower the context (`-c 24576`) rather than moving the projector to the
CPU (`--no-mmproj-offload`), which makes each photo take 30 s or more.

Run it yourself (`llama-server -hf <user>/<model>-GGUF:<quant> --port 8081 -c 32768`) or use the
included unit: set `LLAMA_MODEL` in `.env`, then `linux/install.sh` and
`systemctl --user enable --now llama-server.service`.

### Ollama (local)

```ini
RP_BACKEND=openai-compatible
RP_BASE_URL=http://127.0.0.1:11434/v1
RP_MODEL=<model you pulled, e.g. from `ollama list`>
```

Ollama's default context is short; raise it (for example `OLLAMA_CONTEXT_LENGTH=16384`, or
`num_ctx` in a Modelfile) so the kit, profiles and history fit.

### LM Studio (local)

```ini
RP_BACKEND=openai-compatible
RP_BASE_URL=http://127.0.0.1:1234/v1
RP_MODEL=<model id shown in LM Studio's server tab>
```

Start the local server in LM Studio (Developer tab) and load a model with enough context.

### OpenRouter and other cloud APIs

```ini
RP_BACKEND=openai-compatible
RP_BASE_URL=https://openrouter.ai/api/v1
RP_API_KEY=<your key>                    # better: in ~/.claude/channels/discord/.env
RP_MODEL=<provider>/<model>
```

The same works for any provider with an OpenAI-style `/chat/completions` endpoint: change
`RP_BASE_URL`, `RP_API_KEY` and `RP_MODEL`. For OpenAI's newer models, also set
`RP_MAX_TOKENS_FIELD=max_completion_tokens`, and `RP_TEMPERATURE=none` if the model rejects
a temperature.

### Mixing: Claude when it's up, your model otherwise

```ini
RP_BACKEND=auto
RP_AUTO_FALLBACK=openai-compatible
RP_BASE_URL=http://127.0.0.1:8081/v1
```

The history is shared, so a switch mid-scene keeps the thread. `/status` shows who answers
right now.

## Choosing a model

- The prompt is large: rules, roster, up to five profiles (about 4,500 characters each), the
  end of the story log and up to about 26,000 characters of channel history. Plan for
  **16k-32k tokens of context**; with less, trim your profiles or lower `RP_PROFILE_CHARS`
  and `RP_STORY_TAIL_CHARS`.
- Small local models (7-9B) follow the rules less strictly. The most common mistake is
  writing lines for other players' characters; the prompt forbids it, but expect to correct
  it now and then. 14B+ models, or Claude, do much better.
- Replies are limited to `RP_MAX_TOKENS` (default 1400 for OpenAI-compatible models). Raise
  it if turns get cut off ("Output truncated").

## All settings

| Setting | Default | Meaning |
|---|---|---|
| `RP_BACKEND` | `PRTS_BACKEND` | `claude-code`, `anthropic`, `openai-compatible` or `auto` |
| `RP_AUTO_FALLBACK` | `PRTS_AUTO_FALLBACK` / `openai-compatible` | API backend for `auto` while no narrator is connected |
| `RP_MODEL` | `PRTS_MODEL` / `claude-sonnet-5-5` (anthropic) | Model id |
| `RP_BASE_URL` | `PRTS_BASE_URL` / `http://127.0.0.1:8081/v1` | OpenAI-compatible server, up to `/v1` |
| `RP_API_KEY` | `PRTS_API_KEY` | OpenAI-compatible bearer key |
| `RP_ANTHROPIC_API_KEY` | `ANTHROPIC_API_KEY` | Anthropic key |
| `RP_EFFORT` | `medium` | Anthropic effort |
| `RP_TEMPERATURE` | `0.7` | OpenAI-compatible temperature (`none` to leave it out) |
| `RP_MAX_TOKENS` | 16000 (anthropic) / 1400 | Reply length limit |
| `RP_MAX_TOKENS_FIELD` | `max_tokens` | `max_completion_tokens` for newer OpenAI models |
| `RP_EXTRA_BODY` | `{}` | JSON merged into OpenAI-compatible requests |
| `RP_LABEL` | backend name | Name in logs, `/status` and the story log |
| `RP_VISION` | `PRTS_VISION` / `auto` | Send image attachments to API models (`auto`, `on`, `off`) |
| `RP_OWNER_IDS` | (nobody) | Discord user IDs that may manage roleplay channels and reminders |
| `RP_CHANNEL_IDS` | | Channel IDs registered as roleplay channels on the first run |
| `RP_KIT_DIR` | `<repo>/roleplay-kit` | The narrator kit |
| `RP_STORY_LOG` | newest file | Story-log file for API-model turns |
| `RP_PROFILE_CHARS`, `RP_STORY_TAIL_CHARS` | 4500, 3500 | Prompt size budget for API models |
| `RP_CHARACTERS_DIR`, `RP_NONCANON_DIR`, `RP_STORY_DIR` | `characters`, `noncanon/characters`, `story-log` | Folders inside the kit, for kits with another layout |
| `RP_NARRATOR_PROFILE` | `Narrator` | Character profile that sets the narrator's voice for API models |
| `RP_BACKUP_DIR` | `~/PRTS-backups` | Where the backup scripts put kit archives |

## Backups

The kit is the only copy of your story. `linux/backup.sh` (here) archives `story-log/`,
`noncanon/`, `characters/`, `rp-channels.json` and `CLAUDE.md`, keeping the newest 14. With
`roleplay` in `PRTS_MODULES`, `linux/install.sh` (in the repo root) also installs
`prts-rp-backup.timer` (04:30 daily); enable it with
`systemctl --user enable --now prts-rp-backup.timer`. On Windows, schedule
`windows\backup.ps1` (here) with Task Scheduler.

## Troubleshooting

- **`/rp` doesn't appear**: `PRTS_MODULES` must contain `roleplay`; check the bot log for
  `prts modules: loaded "roleplay"`. Discord can take a minute to show new commands.
- **Plain messages get no answer**: the channel must be a roleplay channel (`/rp status`), not
  paused, and the player must be in `allowFrom`.
- **"Narrative core unavailable"**: the API backend could not be reached. `/status` shows the
  backend and whether it answers; check `RP_BASE_URL` (it must end in `/v1`) and the key.
- **Offline notice with `claude-code`**: the narrator session isn't connected. Use `auto` with
  a fallback, or start the narrator.
- **The narrator ignores my rules (Claude Code)**: the `@roleplay-kit/CLAUDE.md` line is
  missing from the repo's `CLAUDE.md`, or the kit isn't at `roleplay-kit/`.
- **Only some players are listed by `/rp players`**: the Players table must start with the
  header `| Discord username | Plays |`, then a separator row, then one row per player.

## Splitting it out

The module only uses `src/modules.ts` (its interface) and `src/paths.ts` from the bot, so the
folder can live in its own repository and be copied or cloned into `modules/roleplay/`.
See `docs/modules.md` for the interface.
