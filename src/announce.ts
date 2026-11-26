// Where PRTS posts automatic bulletins (new stories, events and banners starting or
// ending soon). Each server picks its own channel with /events announce, saved in
// cache/announce-channels.json. PRTS_ANNOUNCE_CHANNEL (a channel ID) is an optional
// extra channel set by the bot owner.
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { Client, EmbedBuilder } from 'discord.js'
import { CACHE_DIR } from './paths.ts'

const FILE = join(CACHE_DIR, 'announce-channels.json')
const ENV_CHANNEL = (process.env.PRTS_ANNOUNCE_CHANNEL ?? process.env.PRTS_STORY_ANNOUNCE_CHANNEL)?.trim()
const log = (s: string) => process.stderr.write(`prts announce: ${s}\n`)

type Store = Record<string, string> // guild id -> channel id
function load(): Store {
  try {
    const s = JSON.parse(readFileSync(FILE, 'utf8'))
    return s && typeof s === 'object' ? s : {}
  } catch {
    return {}
  }
}

export function announceChannelFor(guildId: string): string | null {
  return load()[guildId] ?? null
}

export function setAnnounceChannel(guildId: string, channelId: string | null): void {
  const s = load()
  if (channelId) s[guildId] = channelId
  else delete s[guildId]
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(FILE, JSON.stringify(s, null, 1))
}

export function announceChannels(): string[] {
  return [...new Set([...Object.values(load()), ...(ENV_CHANNEL ? [ENV_CHANNEL] : [])])]
}

/** Sends one embed to every configured channel. A channel the bot can no longer reach is skipped. */
export async function announce(client: Client, embed: EmbedBuilder): Promise<void> {
  for (const id of announceChannels()) {
    try {
      const ch = await client.channels.fetch(id)
      if (ch && 'send' in ch) await ch.send({ embeds: [embed] })
    } catch (err) {
      log(`channel ${id}: ${err}`)
    }
  }
}
