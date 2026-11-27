// The PRTS look shared by every bot reply: one colour set, one footer, and a
// "PRTS · <module>" header line on each embed, like the music panel's
// "PRTS · Audio Playback Module".
import { EmbedBuilder } from 'discord.js'

export const COLOR = { info: 0x23b7e5, ok: 0x3fb950, warn: 0xf2a33a, dim: 0x5c6670 }
export const FOOTER = 'Primitive Rhodes Island Terminal Service'

/** The PRTS module each command and button answers as. */
export const SECTION: Record<string, string> = {
  operator: 'Operator Archives',
  skin: 'Outfit Archives',
  tier: 'Tier Assessment',
  farm: 'Farming Guide',
  recruit: 'Recruitment Analysis',
  base: 'RIIC Base Records',
  wiki: 'Terra Wiki Records',
  story: 'Story Records',
  myrtle: 'Myrtle Uplink',
  roll: 'Probability Module',
  remind: 'Reminder Service',
  help: 'Function List',
  events: 'Event Schedule',
  stage: 'Combat Records',
  compare: 'Operator Comparison',
  materials: 'Materials Planning',
  status: 'System Status',
  rp: 'Roleplay Module',
}

/** Adds the "PRTS · <section>" header to embeds that have none yet. */
export function stampEmbeds(payload: unknown, section: string): unknown {
  if (!section || !payload || typeof payload !== 'object') return payload
  const embeds = (payload as { embeds?: unknown[] }).embeds
  if (!Array.isArray(embeds)) return payload
  for (const e of embeds) {
    if (e instanceof EmbedBuilder) {
      if (!e.data.author) e.setAuthor({ name: `PRTS · ${section}` })
    } else if (e && typeof e === 'object' && !(e as any).author) (e as any).author = { name: `PRTS · ${section}` }
  }
  return payload
}

type Replies = { reply: Function; editReply: Function; followUp: Function; update?: Function }
/** Wraps an interaction so every reply it sends carries the section header. */
export function brand<T>(i: T, section: string | undefined): T {
  if (!section) return i
  const r = i as unknown as Replies
  for (const k of ['reply', 'editReply', 'followUp', 'update'] as const) {
    const orig = r[k]
    if (typeof orig !== 'function') continue
    r[k] = (p: unknown, ...rest: unknown[]) => orig.call(i, stampEmbeds(p, section), ...rest)
  }
  return i
}
