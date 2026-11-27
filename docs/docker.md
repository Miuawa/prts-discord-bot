# Running PRTS in Docker (optional)

The usual way to run PRTS on Linux is the systemd user service (`linux/install.sh`, see the
main README). Docker is an alternative for people who prefer containers or run PRTS on a
server. It runs **only the Discord bot**. These stay outside the container:

- **The Claude Code narrator** (`claude-code` backend): it needs your Claude login and runs on
  the host as before (`prts-narrator.service` or `windows\start-narrator.bat`). It connects to
  the bot's bridge on `127.0.0.1:47823`, which the container publishes on the host's loopback
  only.
- **A local model** (llama.cpp, llama-swap, Ollama): it needs the GPU and stays on the host.
  The container reaches it at `http://host.docker.internal:<port>/v1`.
- **Backups** (`linux/backup.sh`): they run on the host and read the same mounted folders.

## Start

Requires Docker with Compose v2. Stop the systemd bot first: only one PRTS bot can run, and
the second one finds the bridge port taken.

```bash
systemctl --user disable --now prts-bot.service
docker compose up -d --build
docker compose logs -f
```

To go back: `docker compose down`, then `systemctl --user enable --now prts-bot.service`.
After a `git pull`, run `docker compose up -d --build` again.

## What is mounted

Nothing private is in the image. `.dockerignore` lets only `package.json`, `bun.lock`,
`tsconfig.json`, `src/` and `modules/` into the build, and never `.env`, keys or tokens.
Everything else is mounted when the container starts:

| Host | Container | Access |
|---|---|---|
| `.env` | `/app/.env` | read-only |
| `~/.claude/channels/discord/` (token, `access.json`, `bridge.key`) | `/state` | read-write |
| `cache/` | `/app/cache` | read-write |
| `data/` | `/app/data` | read-write |
| `music/` | `/app/music` | read-only |

Paths and the roleplay kit go in `compose.override.yaml`, which git ignores. Start from
`docker/compose.override.example.yaml`:

```bash
cp docker/compose.override.example.yaml compose.override.yaml
```

Settings you can put in the shell or in `.env` for compose itself: `PRTS_UID` / `PRTS_GID`
(default 1000, should be your own `id -u` / `id -g`), `PRTS_DISCORD_STATE_DIR`,
`PRTS_DOCKER_MUSIC_DIR`, `PRTS_BRIDGE_PORT` (host side) and `PRTS_DOCKER_STORY_REFRESH_CMD`.

## Local model

Point the bot at the host instead of `127.0.0.1`, in `.env` or `compose.override.yaml`:

```ini
PRTS_BASE_URL=http://host.docker.internal:8081/v1
```

The model server must listen where containers can reach it: on the Docker bridge address
(`172.17.0.1`) or on all addresses. A server bound only to `127.0.0.1` can't be reached from
a container. If yours listens on all addresses, keep your firewall closed to the LAN.

## Story index refresh

`PRTS_STORY_REFRESH_CMD` usually runs a Python script from the roleplay kit on the host. It is
off in the container (`PRTS_DOCKER_STORY_REFRESH_CMD` is empty by default). Either run the
refresh on the host on a timer, or set `PRTS_DOCKER_STORY_REFRESH_CMD` to a command that works
inside the container (the image has `python3`; mount what the script needs).

## Security

How the container is locked down, and why:

- **Not root.** The bot runs as your user id (`user:` in `compose.yaml`), so files it writes in
  the mounted folders stay yours and it can't change anything else. The code in the image is
  owned by root and read-only to it.
- **Read-only filesystem** (`read_only: true`). Only `/tmp` (a 512 MB tmpfs) and the mounted
  folders above can be written. `.env` and `music/` are mounted read-only.
- **No capabilities, no privilege escalation** (`cap_drop: [ALL]`,
  `no-new-privileges`), plus a process limit (`pids_limit: 256`) and a memory limit (2 GB).
- **No secrets in the image.** The token, `access.json` and `bridge.key` are only in the
  mounted state folder. `docker history prts-bot:local` shows no settings.
- **Only the bridge is published, and only on `127.0.0.1`.** Other machines on your network
  can't reach it. The bridge also needs the random key from `bridge.key`, and the bot compares
  it in constant time. Inside the container it listens on its own interface
  (`PRTS_BRIDGE_HOST=0.0.0.0`), so the port can be published; don't set that variable for the
  systemd service.
- **Own network.** The bot runs on its own Docker network (`prts`), not the default bridge, so
  other containers can't reach the bridge.
- **Pinned versions.** Bun (`BUN_VERSION`) and yt-dlp (`YTDLP_VERSION`) are pinned in the
  `Dockerfile`; `bun install --frozen-lockfile` installs exactly `bun.lock`. Rebuild to pick
  up Debian security updates for ffmpeg and Python.
- **Logs are capped** at 3 × 10 MB. They can contain Discord messages only when
  `PRTS_LOG_CHATS=1`.

Things Docker itself doesn't protect against:

- Being in the `docker` group is the same as having root on the host. Add only accounts you
  trust to it, or use rootless Docker.
- The mounted state folder holds the bot token. Anyone who can read it (or `docker exec` into
  the container) can use the token. Keep the folder mode 700 and the files 600.
- Discord messages still reach the AI as untrusted input. The container limits what the bot
  process can touch, but the narrator on the host runs with your permissions; keep Claude Code's
  permission prompts on.

## Troubleshooting

- **The container restarts and the log says the bridge port is in use, or `docker compose up`
  says the port is already allocated:** the systemd bot (or another copy) is running. Stop it.
- **Permission denied on `cache/`, `data/` or the state folder:** `PRTS_UID` / `PRTS_GID`
  don't match the owner of those folders. Set them to your `id -u` / `id -g`.
- **The narrator can't connect:** check `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:47823/`
  prints `403` (up, key needed). `docker compose ps` should say `healthy`.
- **No answers from the local model:** see "Local model" above. From inside the container:
  `docker compose exec bot bun -e "console.log((await fetch('http://host.docker.internal:8081/v1/models')).status)"`.
