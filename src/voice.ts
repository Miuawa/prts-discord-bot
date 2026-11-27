// PRTS /voice: plays an operator's official in-game voice lines in your voice channel.
// Separate from the music player. Line texts and recordings come from the Arknights
// story reader (arknights.timo.beer), the same source the other lookups use.
// If the music player is using the voice channel, this asks to wait instead of
// interrupting it.
import { COLOR, FOOTER } from './theme.ts'
import { clip } from './common.ts'
import {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  entersState,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  type AudioPlayer,
} from '@discordjs/voice'
import { EmbedBuilder, MessageFlags, type AutocompleteInteraction, type ChatInputCommandInteraction, type GuildMember } from 'discord.js'
import { findOps, normName } from './ark.ts'

const SITE = 'https://arknights.timo.beer'
const DUB_DIR: Record<string, string> = { jp: 'voice', cn: 'voice_cn', en: 'voice_en', kr: 'voice_kr' }
const DUB_NAME: Record<string, string> = { jp: 'Japanese', cn: 'Chinese', en: 'English', kr: 'Korean' }
const IDLE_LEAVE_MS = 20_000
const MAX_QUEUE = 10

// ---------- line data ----------
type Line = { title: string; text: string; id: string; dubs: string[] }
let lines: { at: number; byChar: Map<string, Line[]> } | null = null
let loading: Promise<void> | null = null
async function ensureLines(): Promise<Map<string, Line[]> | null> {
  if (lines && Date.now() - lines.at < 12 * 3600_000) return lines.byChar
  loading ??= (async () => {
    const r = await fetch(`${SITE}/json/voices.en.json`, { headers: { 'User-Agent': 'PRTS-Discord-bot/1.0 (private Arknights fan bot)' }, signal: AbortSignal.timeout(60_000) })
    if (!r.ok) throw new Error(`voices ${r.status}`)
    const raw = (await r.json()) as Record<string, any[]>
    const byChar = new Map<string, Line[]>()
    for (const [id, rows] of Object.entries(raw)) {
      byChar.set(
        id,
        (Array.isArray(rows) ? rows : []).map(x => ({
          title: String(x.title ?? 'Line'),
          text: String(x.text ?? ''),
          id: String(x.id),
          dubs: Array.isArray(x.dubs) ? x.dubs : [],
        })),
      )
    }
    lines = { at: Date.now(), byChar }
  })().finally(() => {
    loading = null
  })
  try {
    await loading
  } catch (err) {
    process.stderr.write(`prts voice: data load failed: ${err}\n`)
  }
  return lines?.byChar ?? null
}
const clean = (s: string) =>
  s
    .replace(/\{@nickname\}/gi, 'Doctor')
    .replace(/\{@[a-z_]+\}/gi, '')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .trim()
const clipUrl = (charId: string, id: string, dub: string) => `${SITE}/game/en/audio/sound_beta_2/${DUB_DIR[dub]}/${encodeURIComponent(charId.toLowerCase())}/${id.toLowerCase()}.mp3`

// ---------- playback ----------
type Clip = { url: string; label: string }
type Session = { player: AudioPlayer; queue: Clip[]; leaveTimer?: ReturnType<typeof setTimeout> }
const sessions = new Map<string, Session>()

function playNext(guildId: string): void {
  const s = sessions.get(guildId)
  if (!s) return
  const next = s.queue.shift()
  if (!next) {
    s.leaveTimer = setTimeout(() => end(guildId), IDLE_LEAVE_MS)
    return
  }
  s.player.play(createAudioResource(next.url))
}
function end(guildId: string): void {
  const s = sessions.get(guildId)
  if (!s) return
  clearTimeout(s.leaveTimer)
  s.player.removeAllListeners()
  s.player.stop(true)
  sessions.delete(guildId)
  try {
    getVoiceConnection(guildId)?.destroy()
  } catch {}
}

async function enqueueClip(i: ChatInputCommandInteraction, member: GuildMember, clip_: Clip): Promise<string | null> {
  const guild = i.guild!
  const vc = member.voice?.channel
  if (!vc) return '[PRTS] Please join a voice channel first. I will follow without hesitation.'
  let s = sessions.get(guild.id)
  const existing = getVoiceConnection(guild.id)
  if (existing && !s) return '[PRTS] The music player is using the voice channel. Please use `/music stop` first, or wait until it has finished. I apologize for the inconvenience.'
  if (s && s.queue.length >= MAX_QUEUE) return `[PRTS] ${MAX_QUEUE} voice lines are already waiting. Please try again shortly.`
  if (!existing || existing.joinConfig.channelId !== vc.id) {
    if (existing) end(guild.id)
    const conn = joinVoiceChannel({ channelId: vc.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: true })
    try {
      await entersState(conn, VoiceConnectionStatus.Ready, 20_000)
    } catch (err) {
      conn.destroy()
      return `[PRTS] Voice connection failed. I apologize. Please check that I may Connect and Speak in ${vc.name}.`
    }
    conn.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([entersState(conn, VoiceConnectionStatus.Signalling, 5_000), entersState(conn, VoiceConnectionStatus.Connecting, 5_000)])
      } catch {
        end(guild.id)
      }
    })
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } })
    s = { player, queue: [] }
    sessions.set(guild.id, s)
    player.on(AudioPlayerStatus.Idle, () => playNext(guild.id))
    player.on('error', err => process.stderr.write(`prts voice: player error: ${err.message}\n`))
    conn.subscribe(player)
  }
  s = sessions.get(guild.id)!
  clearTimeout(s.leaveTimer)
  s.queue.push(clip_)
  if (s.player.state.status === AudioPlayerStatus.Idle) playNext(guild.id)
  return null
}

// ---------- command ----------
export async function handleVoice(i: ChatInputCommandInteraction): Promise<void> {
  if (!i.guild) {
    await i.reply({ content: '[PRTS] Voice lines are only available inside a server. I apologize for the inconvenience.', flags: MessageFlags.Ephemeral })
    return
  }
  const member = i.member as GuildMember | null
  if (!member?.voice?.channel) {
    await i.reply({ content: '[PRTS] Please join a voice channel first. I will follow without hesitation.', flags: MessageFlags.Ephemeral })
    return
  }
  await i.deferReply()
  const byChar = await ensureLines()
  if (!byChar) {
    await i.editReply('[PRTS] The voice archive is unavailable at the moment. I apologize. Please try again later.')
    return
  }
  const op = findOps(i.options.getString('operator', true), 1)[0]
  const rows = op ? byChar.get(op.id) : undefined
  if (!op || !rows?.length) {
    await i.editReply(`[PRTS] No voice records found for that operator. Please pick a name from the suggestions. I apologize.`)
    return
  }
  const want = i.options.getString('line')
  const row = (want && rows.find(r => r.id === want)) || (want && rows.find(r => normName(r.title) === normName(want))) || rows[Math.floor(Math.random() * rows.length)]
  const asked = i.options.getString('language') ?? 'jp'
  const dub = row.dubs.includes(asked) ? asked : (['jp', 'cn', 'en', 'kr'].find(d => row.dubs.includes(d)) ?? null)
  if (!dub) {
    await i.editReply('[PRTS] No recording exists for that line. I apologize.')
    return
  }
  const problem = await enqueueClip(i, member, { url: clipUrl(op.id, row.id, dub), label: `${op.name} · ${row.title}` })
  if (problem) {
    await i.editReply(problem)
    return
  }
  const note = dub !== asked ? ` (no ${DUB_NAME[asked]} recording, so ${DUB_NAME[dub]})` : ''
  const e = new EmbedBuilder()
    .setColor(COLOR.info)
    .setAuthor({ name: 'PRTS · Voice Archive' })
    .setTitle(clip(`${op.name} · ${row.title}`, 250))
    .setDescription(clip(`“${clean(row.text)}”`, 1500) || '_No text on record._')
    .setFooter({ text: `${FOOTER} · ${DUB_NAME[dub]}${note}` })
  await i.editReply({ content: '', embeds: [e] })
}

export async function handleVoiceAutocomplete(i: AutocompleteInteraction): Promise<void> {
  const f = i.options.getFocused(true)
  const q = normName(String(f.value ?? ''))
  let out: { name: string; value: string }[] = []
  if (f.name === 'operator') {
    out = findOps(String(f.value ?? ''))
      .slice(0, 25)
      .map(o => ({ name: `${o.name} · ${o.rarity}★ ${o.cls}`, value: o.name }))
  } else if (f.name === 'line') {
    const op = findOps(i.options.getString('operator') ?? '', 1)[0]
    const rows = op ? ((await ensureLines())?.get(op.id) ?? []) : []
    out = rows
      .filter(r => !q || normName(r.title).includes(q) || normName(r.text).includes(q))
      .slice(0, 25)
      .map(r => ({ name: clip(`${r.title}: ${clean(r.text)}`, 100), value: r.id }))
  }
  await i.respond(out).catch(() => {})
}
