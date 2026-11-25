// Loads settings into process.env before any other module reads them, so
// bot.ts imports this file first. Precedence: real environment, then the
// repo's .env (one folder up from src/, or PRTS_ENV_FILE), then
// ~/.claude/channels/discord/.env (DISCORD_STATE_DIR), which is where the
// official Discord plugin's /discord:configure stores the bot token.
import { readFileSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const STATE_DIR = process.env.DISCORD_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'discord')
export const ENV_FILE = join(STATE_DIR, '.env')
export const REPO_ENV_FILE = process.env.PRTS_ENV_FILE ?? join(dirname(fileURLToPath(import.meta.url)), '..', '.env')

for (const f of [REPO_ENV_FILE, ENV_FILE]) {
  try {
    // The token is a credential: lock the file to its owner. No-op on Windows (would need ACLs).
    try {
      chmodSync(f, 0o600)
    } catch {}
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(\w+)\s*=\s*(.*?)\s*$/)
      if (!m || process.env[m[1]] !== undefined) continue
      process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
    }
  } catch {}
}
