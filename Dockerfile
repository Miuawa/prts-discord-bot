# PRTS Discord bot as a container: an optional alternative to the systemd
# service (linux/install.sh). See docs/docker.md.
#
# Nothing private goes into the image: settings, the token, access.json,
# bridge.key, caches and the roleplay kit are mounted at run time by
# compose.yaml (and .dockerignore keeps them out of the build context).
# The Claude Code narrator and any local model stay on the host.

ARG BUN_VERSION=1.4.5

FROM oven/bun:${BUN_VERSION}-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --no-summary

FROM oven/bun:${BUN_VERSION}-slim
# ffmpeg/ffprobe: music and attachment previews. yt-dlp (pinned, from PyPI in
# its own venv): /music links. Bump YTDLP_VERSION when links stop working.
ARG YTDLP_VERSION=2026.11.23
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates \
 && python3 -m venv /opt/yt-dlp \
 && /opt/yt-dlp/bin/pip install --no-cache-dir --disable-pip-version-check "yt-dlp==${YTDLP_VERSION}" \
 && ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/* /root/.cache

WORKDIR /app
# Code only, owned by root and read-only for the bot user.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
COPY modules ./modules
# Mount points (compose.yaml binds host folders over them).
RUN mkdir -p /app/cache /app/data /app/music /state

ENV NODE_ENV=production \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    DISCORD_STATE_DIR=/state \
    PRTS_CACHE_DIR=/app/cache \
    PRTS_DATA_DIR=/app/data \
    PRTS_MUSIC_DIR=/app/music \
    PRTS_BRIDGE_HOST=0.0.0.0 \
    PRTS_BRIDGE_PORT=47823

# Any non-root id works; compose.yaml sets yours so mounted files keep their owner.
USER 1000:1000
EXPOSE 47823
# The bridge answers 403 without the key: that is enough to know the bot is up.
HEALTHCHECK --interval=60s --timeout=5s --start-period=60s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:47823/').then(r => process.exit(r.status === 403 ? 0 : 1), () => process.exit(1))"]
CMD ["bun", "src/bot.ts"]
