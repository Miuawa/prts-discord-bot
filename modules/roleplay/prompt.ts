// Prompt for roleplay turns answered by an API model (Anthropic or
// OpenAI-compatible). The Claude Code narrator reads the kit's CLAUDE.md
// itself and needs none of this.
//
// The model gets no tools, so the module builds the prompt from the kit: the
// rule sections of CLAUDE.md that matter for a turn, the player roster, the
// profiles of the characters in play or mentioned, the end of the current
// story log, and the channel history (added by the bot).
import { readFileSync, readdirSync, statSync, appendFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { ChannelEvent, Prompt } from '../../src/modules.ts'
import { KIT, KIT_CLAUDE_MD, readPlayers } from './rp.ts'

// Folder names inside the kit; change them for a kit with another layout.
const CHAR_DIR = join(KIT, process.env.RP_CHARACTERS_DIR ?? 'characters')
const NONCANON_DIR = join(KIT, process.env.RP_NONCANON_DIR ?? join('noncanon', 'characters'))
const STORY_DIR = join(KIT, process.env.RP_STORY_DIR ?? 'story-log')
// Profile (in CHAR_DIR) whose "Voice and personality" section sets the narrator's voice.
const NARRATOR_PROFILE = process.env.RP_NARRATOR_PROFILE ?? 'Narrator'

// Size budget, sized for a 32k-context 8-9B local model. Rough rule:
// 1 token ≈ 3.5 characters of English. Bigger models can take more
// (RP_PROFILE_CHARS, RP_STORY_TAIL_CHARS).
const PROFILE_CHARS = Number(process.env.RP_PROFILE_CHARS ?? 4500)
const MAX_PROFILES = 5
const NONCANON_CHARS = 1500
const STORY_TAIL_CHARS = Number(process.env.RP_STORY_TAIL_CHARS ?? 3500)
const MAX_TOKENS_RP = 1400 // OpenAI-compatible models only (see src/ai/providers.ts)

function readText(p: string): string {
  try {
    return readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
  } catch {
    return ''
  }
}
/** One markdown section (heading line included) up to the next heading of the same or higher level. */
function section(md: string, heading: string): string {
  const lines = md.split('\n')
  const i = lines.findIndex(l => /^#{1,6} /.test(l) && l.toLowerCase().includes(heading.toLowerCase()))
  if (i < 0) return ''
  const level = /^#+/.exec(lines[i])![0].length
  let j = i + 1
  while (j < lines.length && !new RegExp(`^#{1,${level}} `).test(lines[j])) j++
  return lines.slice(i, j).join('\n').trim()
}
const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, '') + '\n[...]')

type Profile = { name: string; aliases: string[] }
let profileCache: { at: number; list: Profile[] } | null = null
function profiles(): Profile[] {
  if (profileCache && Date.now() - profileCache.at < 60_000) return profileCache.list
  const list: Profile[] = []
  try {
    for (const f of readdirSync(CHAR_DIR)) {
      if (!f.endsWith('.md') || f.startsWith('_') || f.toLowerCase() === 'readme.md') continue
      const name = f.slice(0, -3)
      const h1 = /^# (.+)$/m.exec(readText(join(CHAR_DIR, f)))?.[1] ?? ''
      // "# Name (Other Name)" → alias "Other Name"
      const aliases = [...h1.matchAll(/\(([^)]+)\)/g)]
        .flatMap(m => m[1].split(/[,/]| or /))
        .map(s => s.trim())
        .filter(s => s.length > 2)
      list.push({ name, aliases: [name.replace(/-/g, ' '), ...aliases] })
    }
  } catch {}
  profileCache = { at: Date.now(), list }
  return list
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function mentioned(text: string): string[] {
  return profiles()
    .filter(p => p.aliases.some(a => new RegExp(`(^|[^\\p{L}])${escapeRe(a)}([^\\p{L}]|$)`, 'iu').test(text)))
    .map(p => p.name)
}
function profileExcerpt(name: string, focus: 'full' | 'voice'): string {
  const md = readText(join(CHAR_DIR, name + '.md'))
  if (!md) return ''
  const title = /^# .+$/m.exec(md)?.[0] ?? `# ${name}`
  const parts = focus === 'voice' ? [section(md, 'Voice and personality')] : ['Quick facts', 'Looks', 'Personality and voice', 'Abilities', 'Open questions'].map(h => section(md, h))
  let out = `${title}\n${parts.filter(Boolean).join('\n\n')}`
  const nc = readText(join(NONCANON_DIR, name + '.md'))
  if (nc && focus === 'full') {
    // The latest story section holds what the current story invented.
    const secs = nc.split(/\n(?=## )/)
    out += `\n\nInvented in our own stories (non-canon, keep consistent):\n${clip(secs[secs.length - 1], NONCANON_CHARS)}`
  }
  return clip(out, PROFILE_CHARS + (focus === 'full' ? NONCANON_CHARS : 0))
}

function storyLogFile(): string | null {
  const want = process.env.RP_STORY_LOG
  if (want) return join(STORY_DIR, want.endsWith('.md') ? want : want + '.md')
  try {
    const files = readdirSync(STORY_DIR).filter(f => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
    files.sort((a, b) => statSync(join(STORY_DIR, b)).mtimeMs - statSync(join(STORY_DIR, a)).mtimeMs)
    return join(STORY_DIR, files[0] ?? 'session.md')
  } catch {
    return join(STORY_DIR, 'session.md')
  }
}

const PREAMBLE = [
  'You are the narrator of a Discord roleplay, running inside a bot. You have NO tools: you cannot read files, browse the web or call a `reply` tool.',
  'Everything you write is posted to Discord exactly as written, so write only the message itself. Never describe tool calls, never write "Replied to ...", never show your reasoning.',
  'Ignore any rule below that tells you to use tools, open or edit files, update the story log, the roster or memory: the bot handles that. You cannot change the player roster.',
  'Players care about canon. Use only the facts in the profiles below. If something is not covered, keep it vague or mark it as invented. Never invent chapter numbers or quotes.',
].join('\n')

export function roleplayPrompt(ev: ChannelEvent, history: string): Prompt {
  const md = readText(KIT_CLAUDE_MD)
  const m = ev.meta
  const players = readPlayers()
  const blocks: string[] = [PREAMBLE]
  if (players.length) blocks.push('Players (Discord username → character they play):\n' + players.map(([u, c]) => `- ${u} → ${c}`).join('\n'))
  // Matched by words in the heading, so "Narrator voice: PRTS" or "PRTS personality" work too.
  for (const h of ['Narrator voice', 'personality', 'Turn flow with two or more players', 'Turn format']) blocks.push(section(md, h))
  blocks.push(
    [
      'Notes for this turn:',
      '- A message tagged /rp ooc, /rp join or /rp recap (text starts with "OOC:") is out of character: answer briefly in the narrator voice, no turn format. For a recap, summarise the recent story log below.',
      '- Discord shows about 2000 characters per message; the bot splits your text at blank lines, so keep paragraphs short and separate scene, choices and fact-check with blank lines.',
      '- In a fact-check, cite only sources named in the profiles below; mark everything else "(invented for our story)".',
      // The guard against the most common small-model mistake: writing for other players.
      `- Player characters${players.length ? ` (${players.map(([, c]) => c).join(', ')})` : ''} belong to their players. Never write their dialogue, choices or feelings, except the words the player just wrote and small gestures. Narrate everyone else.`,
      '- The fact-check (if any) is the last thing in a turn. Write nothing after it: no footers, no OOC notes, no system lines.',
      '- If the message addresses another player character directly and that player has not answered yet, reply with one short line such as *(Waiting for <character>...)* instead of a full turn, unless the player wrote "go on" or "continue".',
    ].join('\n'),
  )
  blocks.push(section(md, 'Local model notes'))
  // Everything above is the same every turn, so llama-server can reuse it from its prompt
  // cache. What changes (away players, profiles, story log) comes after.
  if (m.afk) blocks.push(`Away players (play them yourself with small, safe actions; still give them a choice block): ${m.afk}`)

  const narrator = profileExcerpt(NARRATOR_PROFILE, 'voice')
  if (narrator) blocks.push('Narrator voice reference:\n' + narrator)
  const inPlay = players.map(([, c]) => c).filter(c => profiles().some(x => x.name === c))
  const names = [...new Set([...inPlay, ...mentioned(`${ev.content}\n${history.slice(-1500)}`).sort()])].filter(n => n !== NARRATOR_PROFILE).slice(0, MAX_PROFILES)
  if (names.length)
    blocks.push(
      'Character profiles:\n\n' +
        names
          .map(n => profileExcerpt(n, 'full'))
          .filter(Boolean)
          .join('\n\n---\n\n'),
    )
  // The story log tail changes every turn, which would make the model re-read the whole
  // history after it. Once the channel history itself is long enough, it carries the story.
  const f = history.length < 6000 ? storyLogFile() : null
  const tail = f ? readText(f).slice(-STORY_TAIL_CHARS) : ''
  if (tail.trim()) blocks.push(`Recent story log (${f!.split(/[\\/]/).pop()}):\n[...]${tail}`)
  return { system: blocks.filter(Boolean).join('\n\n'), maxTokens: MAX_TOKENS_RP }
}

/** Append an API-written in-character turn to the story log (the Claude Code narrator writes its own). */
export function appendStoryLog(ev: ChannelEvent, userLine: string, text: string, label: string): void {
  const m = ev.meta
  if ((m.subcommand && m.subcommand !== 'act') || text.length < 300) return
  const f = storyLogFile()
  if (!f) return
  const when = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
  try {
    mkdirSync(STORY_DIR, { recursive: true })
    const head = existsSync(f) ? '' : `# Story log (${f.split(/[\\/]/).pop()})\n`
    appendFileSync(
      f,
      `${head}\n### ${when} · PRTS (${label})\n\n${userLine
        .split('\n')
        .map(l => `> ${l}`)
        .join('\n')}\n\n${text}\n`,
    )
  } catch (e) {
    process.stderr.write(`prts roleplay: story log append failed: ${e}\n`)
  }
}

/**
 * Guard for small models: drop dialogue lines written for player characters
 * ("**Texas:** ..." or "Texas: ..."), unless that player is away (/rp afk).
 * Player characters' words belong to their players; the rules say so, but
 * 8-12B models often ignore it.
 */
export function stripPlayerLines(ev: ChannelEvent, text: string): string {
  const away = new Set(
    (ev.meta.afk ?? '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean),
  )
  const names = readPlayers()
    .map(([, c]) => c)
    .filter(c => c && !away.has(c.toLowerCase()))
  if (!names.length) return text
  const alt = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  // Optional quote/bullet, optional bold/italic, the name, optional "(...)" aside, a colon, then speech.
  const re = new RegExp(`^\\s*(?:[>*_-]\\s*)*(?:\\*\\*|__)?\\s*(?:${alt})\\s*(?:\\([^)]*\\))?\\s*(?::\\s*(?:\\*\\*|__)|(?:\\*\\*|__)\\s*:|:)\\s*\\S`, 'i')
  let dropped = 0
  const out = text.split('\n').filter(l => {
    if (!re.test(l)) return true
    dropped++
    return false
  })
  if (!dropped) return text
  process.stderr.write(`prts roleplay: removed ${dropped} line(s) written for player characters\n`)
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
