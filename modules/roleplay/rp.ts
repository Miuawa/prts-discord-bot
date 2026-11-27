// Roleplay module: the /rp command, roleplay channels, away mode and turn reminders.
//
// - Roleplay channels live in <kit>/rp-channels.json (RP_KIT_DIR), managed
//   with /rp setchannel|removechannel (owners only), /rp channels, /rp pause|resume.
// - In a roleplay channel, plain messages from allowlisted players go to the
//   AI tagged rp="true" (no @mention needed), unless the channel is paused.
// - /rp act|ooc|join|recap go to the AI. /rp setchannel, /rp removechannel,
//   /rp channels, /rp pause, /rp resume, /rp players, /rp status, /rp afk and
//   /rp reminders are answered by the module itself.
import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction, type Client } from 'discord.js'
import { readFileSync, writeFileSync, renameSync, existsSync, statSync, mkdirSync } from 'fs'
import { join } from 'path'
import { ROOT, CACHE_DIR } from '../../src/paths.ts'

/** The narrator kit: CLAUDE.md, characters/, noncanon/, story-log/, rp-channels.json. */
export const KIT = process.env.RP_KIT_DIR ?? join(ROOT, 'roleplay-kit')
export const RP_FILE = join(KIT, 'rp-channels.json')
export const KIT_CLAUDE_MD = join(KIT, 'CLAUDE.md')
// Who may add or remove roleplay channels and change reminders: comma-separated
// Discord user IDs. Empty means nobody can.
const OWNERS = (process.env.RP_OWNER_IDS ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
const COLOR = { info: 0xe0383e, ok: 0xe0383e, warn: 0xf2a33a, dim: 0x5c6670 }
const FOOTER = 'Primitive Rhodes Island Terminal Service'

type RpChannel = { name: string; guildId: string | null; guildName: string | null; setBy: string; setAt: string; paused?: boolean; nudgeMin?: number }
type RpStore = { channels: Record<string, RpChannel> }

export function loadRp(): RpStore {
  try {
    const s = JSON.parse(readFileSync(RP_FILE, 'utf8'))
    return { channels: s.channels ?? {} }
  } catch {
    return { channels: {} }
  }
}

// rpState runs on every incoming message, so keep a parsed copy and re-read
// only when the file changes.
let cached: { mtime: number; store: RpStore } | null = null
function cachedRp(): RpStore {
  let mtime = 0
  try {
    mtime = statSync(RP_FILE).mtimeMs
  } catch {}
  if (cached?.mtime !== mtime) cached = { mtime, store: loadRp() }
  return cached.store
}
function saveRp(s: RpStore): void {
  mkdirSync(KIT, { recursive: true })
  writeFileSync(RP_FILE + '.tmp', JSON.stringify(s, null, 2) + '\n')
  renameSync(RP_FILE + '.tmp', RP_FILE)
}
// Optional seed: RP_CHANNEL_IDS (comma-separated channel IDs) are added as
// roleplay channels the first time, when rp-channels.json does not exist yet.
// Afterwards, manage them from Discord with /rp setchannel and /rp removechannel.
const SEED_CHANNELS = (process.env.RP_CHANNEL_IDS ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
if (SEED_CHANNELS.length && !existsSync(RP_FILE)) {
  try {
    mkdirSync(KIT, { recursive: true })
    const at = new Date().toISOString()
    saveRp({ channels: Object.fromEntries(SEED_CHANNELS.map(id => [id, { name: id, guildId: null, guildName: null, setBy: 'RP_CHANNEL_IDS', setAt: at }])) })
  } catch {}
}

/** 'active' | 'paused' | null (not a roleplay channel). Threads count as their parent. */
export function rpState(channelId: string, parentId?: string | null): 'active' | 'paused' | null {
  const ch = cachedRp().channels
  const c = ch[channelId] ?? (parentId ? ch[parentId] : undefined)
  if (!c) return null
  return c.paused ? 'paused' : 'active'
}

// Subcommands that go to the AI, and how their text is phrased for it.
export const RP_AI_SUBCOMMANDS: Record<string, (i: ChatInputCommandInteraction) => string> = {
  act: i => i.options.getString('text', true),
  ooc: i => `OOC: ${i.options.getString('text', true)}`,
  join: i => `OOC: I want to play ${i.options.getString('character', true)}.`,
  recap: i => {
    const extra = i.options.getString('focus')
    return `OOC: Please give a short recap of the story so far${extra ? ` (focus: ${extra})` : ''}.`
  },
}

export const RP_COMMAND = {
  name: 'rp',
  description: 'Roleplay: act, speak out of character, join, recap, and manage roleplay channels',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
  options: [
    {
      type: 1,
      name: 'act',
      description: 'Your character says or does something (AI narrator answers)',
      options: [{ type: 3, name: 'text', description: 'What your character says or does', required: true, max_length: 4000 }],
    },
    {
      type: 1,
      name: 'ooc',
      description: 'Say something out of character to the narrator (AI)',
      options: [{ type: 3, name: 'text', description: 'Your out-of-character message', required: true, max_length: 2000 }],
    },
    {
      type: 1,
      name: 'join',
      description: 'Join the roleplay or switch character (AI checks the character)',
      options: [{ type: 3, name: 'character', description: 'Character name (canon or your own original character)', required: true, max_length: 100 }],
    },
    {
      type: 1,
      name: 'recap',
      description: 'Ask the narrator for a recap of the story so far (AI)',
      options: [{ type: 3, name: 'focus', description: 'Anything to focus on (optional)', required: false, max_length: 200 }],
    },
    {
      type: 1,
      name: 'afk',
      description: 'Away or back: while away, PRTS plays your character in character',
      options: [
        { type: 5, name: 'away', description: 'True = I am away, False = I am back', required: true },
        { type: 3, name: 'note', description: 'Optional: when you expect to be back', required: false, max_length: 100 },
      ],
    },
    {
      type: 1,
      name: 'reminders',
      description: 'Owner: turn reminders, remind players who have not acted after some minutes (0 = off)',
      options: [{ type: 4, name: 'minutes', description: 'Minutes to wait before reminding (default 15, 0 turns it off)', required: true, min_value: 0, max_value: 240 }],
    },
    { type: 1, name: 'players', description: 'Show who plays which character' },
    { type: 1, name: 'pause', description: 'Pause narration here: plain messages are ignored until /rp resume' },
    { type: 1, name: 'resume', description: 'Resume narration in this channel' },
    {
      type: 1,
      name: 'setchannel',
      description: 'Owner: make a channel a roleplay channel (default: this one)',
      options: [{ type: 7, name: 'channel', description: 'Channel (default: the current one)', required: false, channel_types: [0, 5, 11, 12, 15] }],
    },
    {
      type: 1,
      name: 'removechannel',
      description: 'Owner: stop roleplay in a channel (default: this one)',
      options: [{ type: 7, name: 'channel', description: 'Channel (default: the current one)', required: false }],
    },
    { type: 1, name: 'channels', description: 'List roleplay channels and whether this channel is one' },
  ],
}

/** A short PRTS notice for refusals and mistakes, shown only to the person who used the command. */
const notice = (text: string, title = 'Request declined') => ({ embeds: [embed(title, COLOR.warn).setDescription(text)], flags: MessageFlags.Ephemeral as const })

function embed(title: string, color = COLOR.info): EmbedBuilder {
  return new EmbedBuilder().setColor(color).setAuthor({ name: 'PRTS · Roleplay Module' }).setTitle(title).setFooter({ text: FOOTER })
}

export function readPlayers(): [string, string][] {
  try {
    const md = readFileSync(KIT_CLAUDE_MD, 'utf8').split(/\r?\n/)
    const start = md.findIndex(l => /^\|\s*Discord username\s*\|/.test(l))
    if (start < 0) return []
    const rows: [string, string][] = []
    for (const l of md.slice(start + 2)) {
      if (!l.startsWith('|')) break
      const [, user, plays] = l.split('|').map(x => x.trim())
      // Keep only the character name: drop notes after the first sentence or parenthesis.
      const name = plays.split(/[,.(]/)[0].replace(/\*+/g, '').trim()
      rows.push([user.replace(/\s*\(.*$/, ''), name])
    }
    return rows
  } catch {
    return []
  }
}

// ---------- away players (/rp afk) ----------
// While a player is away, PRTS plays their character (the narrator is told through
// the afk="..." attribute on roleplay messages). Writing in the channel again, or
// /rp afk away:false, ends it.
const AFK_FILE = join(CACHE_DIR, 'rp-afk.json')
type Afk = Record<string, { username: string; character: string; since: number; note?: string }>
function loadAfk(): Afk {
  try {
    return JSON.parse(readFileSync(AFK_FILE, 'utf8'))
  } catch {
    return {}
  }
}
function saveAfk(a: Afk): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(AFK_FILE, JSON.stringify(a))
  } catch {}
}
const characterOf = (username: string) => readPlayers().find(([u]) => u.toLowerCase() === username.toLowerCase())?.[1]
/** Character names of players who are away, for the narrator. */
export function afkCharacters(): string[] {
  return Object.values(loadAfk()).map(a => a.character)
}
/** A player wrote in character: they are back. Returns true if they had been away. */
export function clearAfk(userId: string): boolean {
  const a = loadAfk()
  if (!a[userId]) return false
  delete a[userId]
  saveAfk(a)
  return true
}

// ---------- turn reminders ----------
// Each roleplay channel keeps its own session: the players who have written there recently. When some
// of them have acted and others have not, the others are reminded once (pinged) after a while. Players of
// other channels are never reminded here. A real narrator turn (a long reply) starts a new round.
const DEFAULT_NUDGE_MIN = 15
const SESSION_MS = 12 * 3600_000 // a player who has not written in a channel for 12 hours has left its session
type Round = { acted: Set<string>; since: number; nudged: boolean }
const rounds = new Map<string, Round>()
const PART_FILE = join(CACHE_DIR, 'rp-participants.json')
type Participants = Record<string, Record<string, { id: string; last: number }>> // channel -> username -> who/when
function loadParts(): Participants {
  try {
    return JSON.parse(readFileSync(PART_FILE, 'utf8'))
  } catch {
    return {}
  }
}
function saveParts(p: Participants): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(PART_FILE, JSON.stringify(p))
  } catch {}
}
/** The players in this channel's session, with their characters (players with no character are left out). */
export function sessionPlayers(channelId: string): { username: string; id: string; character: string; last: number }[] {
  const chars = new Map(readPlayers().map(([u, c]) => [u.toLowerCase(), c]))
  return Object.entries(loadParts()[channelId] ?? {})
    .filter(([, v]) => Date.now() - v.last < SESSION_MS)
    .map(([u, v]) => ({ username: u, id: v.id, character: chars.get(u) ?? '', last: v.last }))
    .filter(p => p.character)
}

export function noteRpMessage(channelId: string, username: string, userId: string): void {
  const parts = loadParts()
  ;(parts[channelId] ??= {})[username.toLowerCase()] = { id: userId, last: Date.now() }
  saveParts(parts)
  const r = rounds.get(channelId) ?? { acted: new Set<string>(), since: Date.now(), nudged: false }
  if (!r.acted.size) r.since = Date.now()
  r.acted.add(username.toLowerCase())
  rounds.set(channelId, r)
}
export function noteNarratorTurn(channelId: string, textLength: number): void {
  if (textLength > 600) rounds.delete(channelId)
}
export async function nudgeTick(client: Client): Promise<void> {
  const store = cachedRp()
  const away = new Set(Object.values(loadAfk()).map(a => a.username.toLowerCase()))
  for (const [channelId, r] of rounds) {
    const ch = store.channels[channelId]
    const minutes = ch?.nudgeMin ?? DEFAULT_NUDGE_MIN
    if (!ch || ch.paused || !minutes || r.nudged || !r.acted.size) continue
    if (Date.now() - r.since < minutes * 60_000) continue
    const waiting = sessionPlayers(channelId).filter(p => !r.acted.has(p.username) && !away.has(p.username))
    if (!waiting.length) continue
    r.nudged = true
    try {
      const channel = await client.channels.fetch(channelId)
      if (channel && 'send' in channel)
        await channel.send({
          content: waiting.map(p => `<@${p.id}>`).join(' '),
          embeds: [
            embed('Awaiting input').setDescription(
              `The scene is waiting for **${waiting.map(p => p.character).join(', ')}**. Operator, please select your action when ready. There is no hurry.\nIf you will be away, use \`/rp afk\` and PRTS will play your character.`,
            ),
          ],
          allowedMentions: { users: waiting.map(p => p.id) },
        })
    } catch {}
  }
}

// ---------- messages from people with no character ----------
// Someone with no character on the roster writes in a roleplay channel: PRTS answers them itself (once per
// half hour per channel) instead of passing it to the narrator, which would otherwise leave them waiting.
const unregisteredNoticeAt = new Map<string, number>()
export function interceptUnregistered(username: string, userId: string, channelId: string, text: string): { embeds: EmbedBuilder[] } | 'drop' | void {
  if (characterOf(username)) return
  if (/^\s*(\(\(|ooc:)/i.test(text)) return // out of character: the narrator answers as usual
  const key = `${channelId}:${userId}`
  if (Date.now() - (unregisteredNoticeAt.get(key) ?? 0) < 30 * 60_000) return 'drop'
  unregisteredNoticeAt.set(key, Date.now())
  return {
    embeds: [
      embed('Identity verification', COLOR.warn).setDescription(
        'No character is on file for you, so this message was not sent to the narrator.\nTo join the story, use `/rp join character:<name>`. To speak out of character, start your message with `OOC:` or use `/rp ooc`.',
      ),
    ],
  }
}

/** Module-handled /rp subcommands. Returns false when the subcommand is for the AI. */
export async function handleRpLocal(i: ChatInputCommandInteraction, client: Client): Promise<boolean> {
  const sub = i.options.getSubcommand()
  const here = i.channelId
  const parent = i.channel && 'parentId' in i.channel && i.channel.isThread?.() ? i.channel.parentId : null

  if (sub === 'channels' || sub === 'setchannel' || sub === 'removechannel') {
    const store = loadRp()
    if (sub === 'channels') {
      const lines = Object.entries(store.channels).map(
        ([id, c]) => `<#${id}> · ${c.paused ? 'paused' : 'active'}${c.guildName ? ` · ${c.guildName}` : ''}${id === here || id === parent ? ' · **you are here**' : ''}`,
      )
      const st = here ? rpState(here, parent) : null
      const where =
        st === 'active'
          ? 'This channel: **active roleplay**. Write normally, or use `/rp act`.'
          : st === 'paused'
            ? 'This channel: **paused**. Plain messages are ignored until `/rp resume`.'
            : 'This channel: **not a roleplay channel**. Here, PRTS acts as an assistant (`/prts`).'
      await i.reply({
        embeds: [embed('Roleplay channels').setDescription(`${where}\n\n${lines.join('\n') || 'No roleplay channels are registered. Use `/rp setchannel` in the channel you want.'}`)],
        flags: MessageFlags.Ephemeral,
      })
      return true
    }
    if (!OWNERS.includes(i.user.id)) {
      await i.reply(notice('Insufficient permissions. Only the roleplay owner can change roleplay channels.'))
      return true
    }
    const picked = i.options.getChannel('channel')
    const id = picked?.id ?? here
    if (!id) {
      await i.reply(notice('No channel detected.'))
      return true
    }
    if (sub === 'setchannel') {
      if (i.channel?.isDMBased?.() && !picked) {
        await i.reply(notice('Roleplay channels must be server channels.'))
        return true
      }
      const name = (picked && 'name' in picked ? picked.name : i.channel && 'name' in i.channel ? i.channel.name : null) ?? id
      store.channels[id] = { name: String(name), guildId: i.guildId, guildName: i.guild?.name ?? null, setBy: i.user.username, setAt: new Date().toISOString() }
      saveRp(store)
      const e = embed('Roleplay channel registered', COLOR.ok).setDescription(
        `<#${id}> is now a roleplay channel. Players can write normally there and the narrator will answer. No @mention needed.\nReal-time logging activated.`,
      )
      if (i.guildId && !client.guilds.cache.has(i.guildId)) {
        e.setColor(COLOR.warn).addFields({
          name: 'Notice',
          value: 'I am not a member of this server, so I cannot read plain messages here. `/rp act` and `/rp ooc` will still work. To enable plain messages, invite the bot to this server.',
        })
      }
      await i.reply({ embeds: [e] })
      return true
    }
    if (sub === 'removechannel') {
      if (!store.channels[id]) {
        await i.reply(notice(`<#${id}> is not a roleplay channel.`))
        return true
      }
      delete store.channels[id]
      saveRp(store)
      await i.reply({ embeds: [embed('Roleplay channel removed', COLOR.dim).setDescription(`<#${id}> is no longer a roleplay channel. PRTS will act as an assistant there.`)] })
      return true
    }
  }

  if (sub === 'afk') {
    const afk = loadAfk()
    const character = characterOf(i.user.username)
    if (i.options.getBoolean('away', true)) {
      if (!character) {
        await i.reply(notice('I have no character on record for you. Use `/rp join character:<name>` first.'))
        return true
      }
      afk[i.user.id] = { username: i.user.username, character, since: Date.now(), note: i.options.getString('note') ?? undefined }
      saveAfk(afk)
      const note = i.options.getString('note')
      await i.reply({
        embeds: [
          embed('Operator away', COLOR.warn).setDescription(
            `**${character}** is away${note ? `: ${note}` : ''}. PRTS will play ${character} in character, with small and safe actions, until you return.\nWrite in the roleplay channel or use \`/rp afk away: False\` to take over again.`,
          ),
        ],
      })
    } else {
      if (!afk[i.user.id]) {
        await i.reply(notice('You are not marked as away.'))
        return true
      }
      const c = afk[i.user.id].character
      delete afk[i.user.id]
      saveAfk(afk)
      await i.reply({ embeds: [embed('Welcome home', COLOR.ok).setDescription(`Identity verification complete. Welcome home, **${c}**. You play your character again from the next message.`)] })
    }
    return true
  }
  if (sub === 'reminders') {
    if (!OWNERS.includes(i.user.id)) {
      await i.reply(notice('Insufficient permissions. Only the roleplay owner can change this.'))
      return true
    }
    const store = loadRp()
    const key = here && store.channels[here] ? here : parent && store.channels[parent] ? parent : null
    if (!key) {
      await i.reply(notice('This is not a roleplay channel.'))
      return true
    }
    const m = i.options.getInteger('minutes', true)
    store.channels[key].nudgeMin = m
    saveRp(store)
    await i.reply({
      embeds: [embed('Turn reminders', COLOR.ok).setDescription(m ? `Players who have not acted will be reminded once after **${m} minute(s)**.` : 'Turn reminders are off in this channel.')],
    })
    return true
  }
  if (sub === 'players') {
    const rows = readPlayers()
    const key = here && rpState(here, parent) ? (cachedRp().channels[here] ? here : parent) : null
    const session = key ? sessionPlayers(key) : []
    const e = embed('Roleplay roster').setDescription(rows.map(([, c]) => `**${c}**`).join('\n') || 'No players are registered. Use `/rp join`.')
    if (key)
      e.addFields({
        name: 'In this channel',
        value: session.length ? session.map(p => `**${p.character}** · last wrote <t:${Math.floor(p.last / 1000)}:R>`).join('\n') : 'Nobody has written here in the last 12 hours.',
      })
    e.addFields({ name: 'Join or switch', value: '`/rp join character:<name>`' })
    await i.reply({ embeds: [e] })
    return true
  }
  if (sub === 'pause' || sub === 'resume') {
    const store = loadRp()
    const key = here && store.channels[here] ? here : parent && store.channels[parent] ? parent : null
    if (!key) {
      await i.reply(notice('This is not a roleplay channel.'))
      return true
    }
    store.channels[key].paused = sub === 'pause'
    saveRp(store)
    await i.reply({
      embeds: [
        embed(sub === 'pause' ? 'Narration paused' : 'Narration resumed', sub === 'pause' ? COLOR.warn : COLOR.ok).setDescription(
          sub === 'pause'
            ? 'Plain messages in this channel are now ignored. Feel free to chat. `/rp act` still works, and `/rp resume` restarts narration.'
            : 'Welcome home. Plain messages in this channel are in character again.',
        ),
      ],
    })
    return true
  }

  // act / ooc / join / recap → the AI, but only inside a roleplay channel.
  if (!(sub in RP_AI_SUBCOMMANDS)) return true
  if (!here || !rpState(here, parent)) {
    await i.reply(notice('Roleplay commands work only in a roleplay channel. Use `/rp channels` to find one, or `/prts` to talk to me here.'))
    return true
  }
  return false
}
