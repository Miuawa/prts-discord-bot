// The PRTS look shared by every bot reply: one colour set, one footer, and a
// "PRTS · <module>" header line on each embed, like the music panel's
// "PRTS · Audio Playback Module".
import { EmbedBuilder } from 'discord.js'

// PRTS cyan for every normal reply (success included); amber only for warnings and errors, grey for empty states.
export const COLOR = { info: 0x23b7e5, ok: 0x23b7e5, warn: 0xf2a33a, dim: 0x5c6670 }
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
  enemy: 'Enemy Handbook',
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
  // Only the first embed gets the header; later ones are captions or continuations of it.
  for (const e of embeds.slice(0, 1)) {
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

// Plain-text /prts answers get a light frame matching the command cards: a small
// "PRTS · Terminal Interface" line on top and the card footer underneath, both as
// Discord subtext (-#) so they stay quiet next to the answer.
export const CHAT_HEADER = '-# PRTS · Terminal Interface'
export const CHAT_FOOTER = `-# ${FOOTER}`
/** Room the frame takes in a message, for chunking. */
export const FRAME_CHARS = CHAT_HEADER.length + CHAT_FOOTER.length + 4

/** Strips a header or footer line the model copied into its text itself. */
function unframe(text: string): string {
  return text.replace(/^\s*(?:-#\s*)?PRTS · Terminal Interface\s*\n+/, '').replace(/\n+\s*(?:-#\s*)?Primitive Rhodes Island Terminal Service\s*$/, '')
}
/** Adds the header to the first message of an answer and the footer under each reply. */
export function frameChunks(chunks: string[], first: boolean): string[] {
  if (!chunks.length) return chunks
  const out = chunks.map(c => c)
  out[0] = unframe(out[0])
  out[out.length - 1] = unframe(out[out.length - 1])
  if (first) out[0] = `${CHAT_HEADER}\n${out[0]}`
  out[out.length - 1] = `${out[out.length - 1]}\n${CHAT_FOOTER}`
  return out
}
