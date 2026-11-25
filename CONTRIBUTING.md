# Contributing

Thanks for helping. This is a small hobby project, so keep changes focused.

1. Fork, then make a branch for your change.
2. `bun install`, then before you push:
   ```bash
   bun run format      # Biome formatter
   bun run check       # type check, offline tests, dry run (no token or keys needed)
   ```
3. Open a pull request that says what changed and how you tested it
   (for bot features: which slash commands you tried on a test server).

Where things go:
- Core features in `src/`. Features that not every bot needs belong in a module
  (`modules/<name>/`, see [docs/modules.md](docs/modules.md)); the core must not depend on any module.
- Tests in `tests/` (or a module's folder). They must run offline: mock `fetch`, never use real keys.

Rules:
- Never commit tokens, API keys, `.env`, `access.json`, `bridge.key`, logs or chat transcripts.
- Don't add game assets (sprites, CGs, audio) or story text from Arknights. Link to public
  sources or fetch data at runtime instead.
- Don't add real people's Discord IDs, usernames or channel IDs. Use settings (`.env`).
- Code, comments and docs in English.

By contributing you agree that your contribution is licensed under the Apache License 2.0.
