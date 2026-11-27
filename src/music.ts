// PRTS music: plays local files, uploaded attachments, direct media links and
// pages yt-dlp understands (YouTube, SoundCloud, Bandcamp...) in a voice channel.
// Spotify track links are looked up by title and played from YouTube, because
// Spotify audio itself is DRM-protected.
// Handled directly by the bot (no Claude round trip), so it answers instantly.
// UI: a PRTS-styled "now playing" panel with control buttons, refreshed live.
import {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  StreamType,
  entersState,
  type AudioPlayer,
  type AudioResource,
} from '@discordjs/voice'
import {
  EmbedBuilder,
  MessageFlags,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  type StringSelectMenuInteraction,
  type Guild,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type AutocompleteInteraction,
  type GuildMember,
  type Message,
} from 'discord.js'
import { linePages, paged } from './pages.ts'
import { handleVoice, handleVoiceAutocomplete } from './voice.ts'
import { spawn, type ChildProcess } from 'child_process'
import { findLyrics, type LyricsQuery } from './lyrics.ts'
import { readdirSync, statSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, relative, extname, basename, dirname } from 'path'
import { ROOT, CACHE_DIR } from './paths.ts'

export const MUSIC_DIR = process.env.PRTS_MUSIC_DIR ?? join(ROOT, 'music')
const YTDLP = process.env.PRTS_YTDLP ?? 'yt-dlp'
const FFPROBE = process.env.PRTS_FFPROBE ?? 'ffprobe'
const AUDIO_EXT = new Set(['.mp3', '.ogg', '.opus', '.flac', '.wav', '.m4a', '.aac', '.webm'])
const MEDIA_EXT = new Set([...AUDIO_EXT, '.mp4', '.mkv', '.mov', '.avi', '.wma', '.m4v'])
const MAX_PLAYLIST = 1000
const MAX_QUEUE = 1000
const HISTORY_KEEP = 100
const HISTORY_FILE = join(CACHE_DIR, 'music-history.json')
const PANEL_REFRESH_MS = 15_000

// PRTS look: dark terminal panel, cyan accent, amber for paused, grey for idle.
const COLOR = { playing: 0x23b7e5, paused: 0xf2a33a, idle: 0x5c6670 }
const AUTHOR = 'PRTS · Audio Playback Module'
const FOOTER = 'Primitive Rhodes Island Terminal Service · Real-time logging activated'

export const MUSIC_COMMAND = {
  name: 'music',
  description: 'PRTS music player',
  type: 1,
  integration_types: [0],
  contexts: [0],
  options: [
    {
      type: 1,
      name: 'voice',
      description: "Play an operator's official voice line",
      options: [
        { type: 3, name: 'operator', description: 'Operator name', required: true, max_length: 100, autocomplete: true },
        { type: 3, name: 'line', description: 'Which line (default: a random one)', required: false, max_length: 100, autocomplete: true },
        {
          type: 3,
          name: 'language',
          description: 'Voice language (default: Japanese)',
          required: false,
          choices: [
            { name: 'Japanese', value: 'jp' },
            { name: 'English', value: 'en' },
            { name: 'Chinese', value: 'cn' },
            { name: 'Korean', value: 'kr' },
          ],
        },
      ],
    },
    {
      type: 1,
      name: 'play',
      description: 'Play a link, an uploaded file, or a song from the music folder',
      options: [
        { type: 3, name: 'song', description: 'YouTube/Spotify/SoundCloud link, search words, folder file name, or "all"', required: false, max_length: 500, autocomplete: true },
        { type: 11, name: 'file', description: 'Upload an audio or video file to play', required: false },
        { type: 5, name: 'shuffle', description: 'Shuffle the songs before queueing (for playlists and "all")', required: false },
        { type: 5, name: 'next', description: 'Play it right after the current song instead of at the end of the queue', required: false },
      ],
    },
    {
      type: 1,
      name: 'search',
      description: 'Search YouTube and pick songs or a playlist from a menu',
      options: [
        { type: 3, name: 'query', description: 'What to search for', required: true, max_length: 200 },
        {
          type: 3,
          name: 'type',
          description: 'Songs or playlists (default: songs)',
          required: false,
          choices: [
            { name: 'Songs', value: 'songs' },
            { name: 'Playlists', value: 'playlists' },
          ],
        },
      ],
    },
    {
      type: 1,
      name: 'radio',
      description: 'Start a YouTube radio (Mix) of similar songs',
      options: [{ type: 3, name: 'seed', description: 'Song name or YouTube link (default: what is playing)', required: false, max_length: 300 }],
    },
    {
      type: 1,
      name: 'artist',
      description: 'Shuffle songs by an artist',
      options: [
        { type: 3, name: 'name', description: 'Artist or band name', required: true, max_length: 100 },
        { type: 4, name: 'count', description: 'How many songs (default 15, max 30)', required: false, min_value: 1, max_value: 30 },
      ],
    },
    { type: 1, name: 'nowplaying', description: 'Show the PRTS playback panel' },
    { type: 1, name: 'queue', description: 'Show what is playing and what is next' },
    {
      type: 1,
      name: 'history',
      description: 'Show the songs played recently in this server',
      options: [{ type: 4, name: 'count', description: 'How many songs (default 15, max 40)', required: false, min_value: 1, max_value: 40 }],
    },
    { type: 1, name: 'remove', description: 'Remove a song from the queue', options: [{ type: 4, name: 'position', description: 'Position shown in /music queue', required: true, min_value: 1 }] },
    {
      type: 1,
      name: 'move',
      description: 'Move a song to another place in the queue',
      options: [
        { type: 4, name: 'from', description: 'Its current position in /music queue', required: true, min_value: 1 },
        { type: 4, name: 'to', description: 'The position to move it to (1 = plays next)', required: true, min_value: 1 },
      ],
    },
    {
      type: 1,
      name: 'replay',
      description: 'Queue a song that already played again, to play next',
      options: [{ type: 4, name: 'position', description: 'Which song in /music history (1 = the most recent)', required: false, min_value: 1, max_value: 100 }],
    },
    { type: 1, name: 'clear', description: 'Clear the queue (keeps the current song playing)' },
    { type: 1, name: 'list', description: 'List songs in the music folder', options: [{ type: 3, name: 'filter', description: 'Only show names containing this', required: false, max_length: 100 }] },
    {
      type: 1,
      name: 'lyrics',
      description: 'Post the lyrics of the current song (or another one) in the chat',
      options: [
        { type: 3, name: 'song', description: 'Song name (default: what is playing)', required: false, max_length: 200 },
        { type: 3, name: 'artist', description: 'Artist, for a more exact match', required: false, max_length: 100 },
      ],
    },
    {
      type: 1,
      name: 'skip',
      description: 'Skip the current song (or several at once)',
      options: [{ type: 4, name: 'count', description: 'How many songs to skip, counting the current one (default 1)', required: false, min_value: 1, max_value: 1000 }],
    },
    {
      type: 1,
      name: 'skipto',
      description: 'Jump to a song in the queue, skipping everything before it',
      options: [{ type: 4, name: 'position', description: 'Position shown in /music queue', required: true, min_value: 1 }],
    },
    { type: 1, name: 'pause', description: 'Pause playback' },
    { type: 1, name: 'resume', description: 'Resume playback' },
    { type: 1, name: 'shuffle', description: 'Shuffle the queue' },
    { type: 1, name: 'loop', description: 'Cycle loop: off, current track, whole playlist' },
    { type: 1, name: 'stop', description: 'Stop, clear the queue and leave the voice channel' },
  ],
}

// kind: file = local path or direct URL ffmpeg can open; ytdlp = page URL
type Track = {
  title: string
  kind: 'file' | 'ytdlp'
  ref: string
  url?: string // public link to show (YouTube page, Spotify page, attachment...)
  source: string // "YouTube", "Spotify → YouTube", "Music archive", "Upload", "Link"
  duration?: number // seconds
  live?: boolean // live stream / 24/7 station (no end)
  artist?: string
  thumb?: string
  requester?: string
}
// One finished (or skipped) song, kept for the session summary and /music history.
type Played = { live?: boolean; title: string; url?: string; requester?: string; duration?: number; at: number; skipped?: boolean }
type GuildState = {
  player: AudioPlayer
  queue: Track[]
  current?: Track
  resource?: AudioResource
  loop: 'off' | 'track' | 'queue'
  proc?: ChildProcess
  channel?: { send: (o: any) => Promise<Message> }
  panel?: Message
  timer?: ReturnType<typeof setInterval>
  played: number
  history: Played[] // this session; shown as a summary when everything has finished
  skipped?: boolean // current song was skipped by someone
  guild?: Guild
  idle?: number // panel ticks in a row with nothing playing
  alone?: number // panel ticks in a row with no listeners in the voice channel
}
const states = new Map<string, GuildState>()

// ---------- helpers ----------
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
const short = (s: string, n = 90) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const clip = (s: string, n = 1900) => (s.length > n ? s.slice(0, n - 20) + '\n…(list truncated)' : s)
const num = (v: string | undefined) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}
const na = (v: string | undefined) => (v && v !== 'NA' ? v : undefined)

function fmt(sec?: number): string {
  if (sec === undefined) return '--:--'
  const s = Math.floor(sec),
    h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    r = s % 60
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(r).padStart(2, '0')}`
}

const len = (x: { duration?: number; live?: boolean }) => (x.live ? '🔴 LIVE' : fmt(x.duration))

function bar(pos: number, total?: number, width = 18): string {
  if (!total) return '▰'.repeat(3) + '▱'.repeat(width - 3)
  const filled = Math.min(width, Math.round((pos / total) * width))
  return '▰'.repeat(filled) + '▱'.repeat(width - filled)
}

// Past songs per server survive restarts (cache/music-history.json, last HISTORY_KEEP each).
let histStore: Record<string, Played[]> | null = null
function histAll(): Record<string, Played[]> {
  if (!histStore) {
    try {
      histStore = JSON.parse(readFileSync(HISTORY_FILE, 'utf8'))
    } catch {
      histStore = {}
    }
  }
  return histStore!
}
function pushHistory(guildId: string, e: Played): void {
  const all = histAll()
  const list = (all[guildId] ??= [])
  list.push(e)
  if (list.length > HISTORY_KEEP) list.splice(0, list.length - HISTORY_KEEP)
  try {
    mkdirSync(dirname(HISTORY_FILE), { recursive: true })
    writeFileSync(HISTORY_FILE, JSON.stringify(all))
  } catch {}
}
const link = (title: string, url?: string, n = 60) => (url && /^https?:/.test(url) ? `[${short(title, n).replace(/[\[\]]/g, '')}](${url})` : short(title, n))

// Strip video noise so lyric searches find the song.
function cleanTitle(t: string): string {
  return t
    .replace(/\s*[\(\[][^\)\]]*(official|video|audio|lyric|lyrics|mv|m\/v|hd|4k|visualizer|ost|full)[^\)\]]*[\)\]]/gi, '')
    .replace(/\(via YouTube:.*\)$/i, '')
    .replace(/\s*[|｜].*$/, '')
    .trim()
}
const lyricsUrl = (q: string) => `https://genius.com/search?q=${encodeURIComponent(cleanTitle(q))}`

// ---------- local folder ----------
function listSongs(): string[] {
  mkdirSync(MUSIC_DIR, { recursive: true })
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      try {
        if (statSync(p).isDirectory()) walk(p)
        else if (AUDIO_EXT.has(extname(name).toLowerCase())) out.push(p)
      } catch {}
    }
  }
  walk(MUSIC_DIR)
  return out.sort((a, b) => a.localeCompare(b))
}
const fileTitle = (p: string) => basename(p, extname(p))

function findLocal(query: string): Track[] {
  const songs = listSongs()
  const q = norm(query)
  const toTrack = (p: string): Track => ({ title: fileTitle(p), kind: 'file', ref: p, source: 'Music archive' })
  if (q === 'all') return songs.map(toTrack)
  const exact = songs.filter(s => norm(fileTitle(s)) === q)
  if (exact.length) return [toTrack(exact[0])]
  const words = q.split(' ').filter(Boolean)
  return songs.filter(s => words.every(w => norm(relative(MUSIC_DIR, s)).includes(w))).map(toTrack)
}

// ---------- links ----------
function run(cmd: string, args: string[], timeoutMs = 45_000): Promise<string> {
  return new Promise((resolve, reject) => {
    // yt-dlp prints in the Windows console codepage unless told otherwise.
    const full = cmd === YTDLP ? ['--encoding', 'utf-8', ...args] : args
    const p = spawn(cmd, full, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
    let out = '',
      err = ''
    const t = setTimeout(() => {
      p.kill()
      reject(new Error('timed out'))
    }, timeoutMs)
    p.stdout.on('data', d => (out += d))
    p.stderr.on('data', d => (err += d))
    p.on('error', e => {
      clearTimeout(t)
      reject(e)
    })
    p.on('close', code => {
      clearTimeout(t)
      code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').pop() || `exit ${code}`))
    })
  })
}

async function probeDuration(path: string): Promise<number | undefined> {
  try {
    return num((await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], 10_000)).trim())
  } catch {
    return undefined
  }
}

async function ytdlpTracks(target: string, source = 'YouTube', limit = MAX_PLAYLIST): Promise<Track[]> {
  const out = await run(
    YTDLP,
    [
      '--flat-playlist',
      '--no-warnings',
      '--playlist-end',
      String(limit),
      '--print',
      '%(title)s\t%(webpage_url,url)s\t%(duration)s\t%(uploader,channel,artist)s\t%(id)s\t%(extractor_key,ie_key)s\t%(thumbnail)s\t%(live_status)s',
      target,
    ],
    120_000,
  ) // big playlists take a while to list
  return out
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      const [title, url, dur, who, id, ex, thumb, liveStatus] = l.split('\t')
      const yt = /youtube/i.test(ex ?? '') || /youtu/i.test(url ?? '')
      return {
        title: na(title) ?? url,
        kind: 'ytdlp' as const,
        ref: url || target,
        url: url || undefined,
        source: yt ? source : (na(ex) ?? 'Web'),
        duration: num(dur),
        live: liveStatus === 'is_live' || undefined,
        artist: na(who),
        thumb: na(thumb) ?? (yt && na(id) ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : undefined),
      }
    })
}

async function spotifyTracks(url: string): Promise<Track[]> {
  if (!/\/track\//.test(url)) throw new Error('only Spotify track links are supported, not albums or playlists')
  const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`)
  if (!res.ok) throw new Error(`Spotify lookup failed (${res.status})`)
  const data = (await res.json()) as { title?: string; thumbnail_url?: string }
  if (!data.title) throw new Error('Spotify gave no title')
  const found = await ytdlpTracks(`ytsearch1:${data.title} audio`, 'Spotify → YouTube')
  return found.map(t => ({ ...t, title: data.title!, url, thumb: data.thumbnail_url ?? t.thumb }))
}

async function resolveQuery(query: string): Promise<Track[]> {
  const q = query.trim()
  if (/^https?:\/\//i.test(q)) {
    const u = new URL(q)
    if (/(^|\.)spotify\.com$/i.test(u.hostname)) return spotifyTracks(q)
    if (MEDIA_EXT.has(extname(u.pathname).toLowerCase()) && !/youtu/i.test(u.hostname)) return [{ title: decodeURIComponent(basename(u.pathname)), kind: 'file', ref: q, url: q, source: 'Link' }]
    return ytdlpTracks(q)
  }
  const local = findLocal(q)
  if (local.length) {
    await Promise.all(
      local.slice(0, 10).map(async t => {
        t.duration = await probeDuration(t.ref)
      }),
    )
    return local
  }
  return ytdlpTracks(`ytsearch1:${q}`)
}

// ---------- discovery: search, radio, artist ----------
const ytId = (url?: string) => url?.match(/(?:v=|youtu\.be\/|\/shorts\/)([\w-]{11})/)?.[1]

async function searchSongs(q: string, n = 10): Promise<Track[]> {
  return ytdlpTracks(`ytsearch${n}:${q}`)
}

type PlaylistHit = { title: string; url: string; owner?: string }
async function searchPlaylists(q: string, n = 10): Promise<PlaylistHit[]> {
  const out = await run(YTDLP, [
    '--flat-playlist',
    '--no-warnings',
    '--playlist-end',
    String(n),
    '--print',
    '%(title)s\t%(url)s\t%(uploader,channel)s',
    `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAw%3D%3D`,
  ])
  return out
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      const [title, url, owner] = l.split('\t')
      return { title: na(title) ?? url, url, owner: na(owner) }
    })
    .filter(p => /list=/.test(p.url))
}

// YouTube "Mix" (radio): list=RD<videoId> gives an endless-style playlist of similar songs.
async function radioTracks(seed: string, count = 25): Promise<{ seedTitle: string; tracks: Track[] }> {
  let id = ytId(seed)
  let seedTitle = seed
  if (!id) {
    const [hit] = await searchSongs(seed, 1)
    if (!hit) throw new Error('no song found to start the radio from')
    id = ytId(hit.url)
    seedTitle = hit.title
    if (!id) throw new Error('the seed is not a YouTube video')
  }
  const tracks = await ytdlpTracks(`https://www.youtube.com/watch?v=${id}&list=RD${id}`, 'YouTube radio', Math.max(count, 25))
  if (tracks[0] && ytId(tracks[0].url) === id) seedTitle = tracks[0].title
  return { seedTitle, tracks: tracks.slice(0, count) }
}

// Name of a YouTube channel without the "- Topic" / VEVO / "Official" decorations.
const channelName = (n: string) =>
  norm(
    n
      .replace(/\s*-\s*Topic$/i, '')
      .replace(/VEVO$/i, '')
      .replace(/\s+Official( Channel)?$/i, ''),
  )

// The artist's own YouTube channel: the first channel whose name is the artist's name.
async function findArtistChannel(name: string): Promise<string | undefined> {
  const out = await run(YTDLP, [
    '--flat-playlist',
    '--no-warnings',
    '--playlist-end',
    '8',
    '--print',
    '%(title)s\t%(url)s',
    `https://www.youtube.com/results?search_query=${encodeURIComponent(name)}&sp=EgIQAg%3D%3D`,
  ])
  const key = norm(name)
  for (const l of out.split('\n')) {
    const [title, url] = l.trim().split('\t')
    if (!url || /\s*-\s*Topic$/i.test(title ?? '')) continue // Topic channels have no uploads page
    if (channelName(title ?? '') === key) return url
  }
  return undefined
}

async function artistTracks(name: string, count: number): Promise<Track[]> {
  const key = norm(name)
  const seen = new Set<string>()
  const usable = (t: Track) => {
    const d = t.duration ?? 0
    if (d && (d < 60 || d > 900)) return false // skip shorts and long compilations
    if (/\b(merch|teaser|trailer|reaction|interview|behind the scenes|announcement|livestream)\b/i.test(t.title)) return false
    const k = norm(cleanTitle(t.title))
    if (seen.has(k)) return false
    seen.add(k)
    return true
  }
  // 1. The artist's own channel (what the artist really uploaded).
  let pool: Track[] = []
  try {
    const channel = await findArtistChannel(name)
    if (channel) pool = (await ytdlpTracks(`${channel.replace(/\/$/, '')}/videos`, 'YouTube', 100)).filter(usable)
  } catch (err) {
    process.stderr.write(`prts music: artist channel lookup failed: ${err}\n`)
  }
  // 2. Fallback: a search, keeping only results uploaded by the artist (or titled "Artist - Song").
  if (pool.length < Math.min(5, count)) {
    seen.clear()
    const word = new RegExp(`(^| )${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`)
    const raw = await searchSongs(`${name} official audio`, Math.min(50, count * 3))
    const strict = raw.filter(t => (channelName(t.artist ?? '') === key || (norm(t.title).startsWith(key + ' ') && word.test(norm(t.title)))) && usable(t))
    pool = [...pool, ...strict]
  }
  shuffle(pool)
  return pool.slice(0, count)
}

// Results waiting for the user to pick from a select menu.
type Pick = { userId: string; expires: number } & ({ kind: 'songs'; tracks: Track[] } | { kind: 'playlists'; lists: PlaylistHit[] })
const picks = new Map<string, Pick>()
const PICK_TTL = 10 * 60_000
function newPick(p: Pick): string {
  const now = Date.now()
  for (const [k, v] of picks) if (v.expires < now) picks.delete(k)
  const token = Math.random().toString(36).slice(2, 10)
  picks.set(token, p)
  return token
}

// ---------- panel ----------
function statusOf(st: GuildState): 'playing' | 'paused' | 'idle' {
  if (!st.current) return 'idle'
  const s = st.player.state.status
  return s === AudioPlayerStatus.Paused || s === AudioPlayerStatus.AutoPaused ? 'paused' : 'playing'
}

function panelEmbed(st: GuildState): EmbedBuilder {
  const status = statusOf(st)
  const e = new EmbedBuilder().setColor(COLOR[status]).setAuthor({ name: AUTHOR }).setFooter({ text: FOOTER })
  const t = st.current
  if (!t) {
    return e.setTitle('Idle').setDescription('Nothing is playing. Use `/music play` to queue a track.')
  }
  const pos = (st.resource?.playbackDuration ?? 0) / 1000
  const label = status === 'paused' ? '⏸  PAUSED' : t.live ? '🔴  LIVE STREAM' : '▶  NOW PLAYING'
  e.setTitle(short(t.title, 240))
  if (t.url) e.setURL(t.url)
  if (t.thumb) e.setThumbnail(t.thumb)
  e.setDescription(
    [`**${label}**${t.artist ? `  ·  ${short(t.artist, 60)}` : ''}`, '```', t.live ? `${bar(pos)}  ${fmt(pos)} · 🔴 LIVE` : `${bar(pos, t.duration)}  ${fmt(pos)} / ${fmt(t.duration)}`, '```'].join(
      '\n',
    ),
  )
  e.addFields({
    name: 'Details',
    value: `**Source:** ${t.source} · **Requested by:** ${t.requester ?? '—'}\n**Queue:** ${st.queue.length} waiting${st.loop === 'track' ? ' · 🔂 track loop' : st.loop === 'queue' ? ' · 🔁 playlist loop' : ''}`,
  })
  return e
}

function panelRows(st: GuildState): ActionRowBuilder<ButtonBuilder>[] {
  const status = statusOf(st)
  const off = status === 'idle'
  const ctl = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('music:toggle')
      .setEmoji(status === 'paused' ? '▶️' : '⏸️')
      .setLabel(status === 'paused' ? 'Resume' : 'Pause')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(off),
    new ButtonBuilder().setCustomId('music:skip').setEmoji('⏭️').setLabel('Skip').setStyle(ButtonStyle.Secondary).setDisabled(off),
    new ButtonBuilder()
      .setCustomId('music:shuffle')
      .setEmoji('🔀')
      .setLabel('Shuffle')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(off || st.queue.length < 2),
    new ButtonBuilder()
      .setCustomId('music:loop')
      .setEmoji('🔁')
      .setLabel(st.loop === 'track' ? 'Loop: track' : st.loop === 'queue' ? 'Loop: playlist' : 'Loop: off')
      .setStyle(st.loop !== 'off' ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(off),
    new ButtonBuilder().setCustomId('music:stop').setEmoji('⏹️').setLabel('Stop').setStyle(ButtonStyle.Danger).setDisabled(off),
  )
  const rows = [ctl]
  const extra = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('music:queue').setEmoji('📜').setLabel('Queue').setStyle(ButtonStyle.Secondary).setDisabled(off),
    new ButtonBuilder()
      .setCustomId('music:radio')
      .setEmoji('📻')
      .setLabel('Radio')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(off || !ytId(st.current?.url)),
  )
  if (st.current) {
    extra.addComponents(new ButtonBuilder().setCustomId('music:lyrics').setEmoji('🎼').setLabel('Lyrics').setStyle(ButtonStyle.Secondary))
    if (st.current.url && /^https?:/.test(st.current.url)) extra.addComponents(new ButtonBuilder().setURL(st.current.url).setEmoji('🔗').setLabel('Open source').setStyle(ButtonStyle.Link))
  }
  rows.push(extra)
  return rows
}

async function refreshPanel(guildId: string, repost = false): Promise<void> {
  const st = states.get(guildId)
  if (!st?.channel) return
  const payload = { embeds: [panelEmbed(st)], components: panelRows(st) }
  try {
    if (st.panel && !repost) {
      await st.panel.edit(payload)
    } else {
      st.panel = await st.channel.send(payload)
    }
  } catch (err) {
    process.stderr.write(`prts music: panel update failed: ${err}\n`)
  }
}

// Leaves the voice channel for a reason other than someone typing /music stop,
// and says why in the channel (the session summary, if any, is posted first).
async function leave(guildId: string, reason: string, destroy = true): Promise<void> {
  const channel = states.get(guildId)?.channel
  await cleanup(guildId, reason)
  if (destroy) {
    try {
      getVoiceConnection(guildId)?.destroy()
    } catch {}
  }
  await channel?.send(`\`[PRTS]\` 👋 ${reason}`).catch(() => {})
}

function startTimer(guildId: string) {
  const st = states.get(guildId)
  if (!st || st.timer) return
  st.timer = setInterval(() => {
    const s = states.get(guildId)
    if (!s) return
    // Leave after about a minute alone, instead of streaming to nobody
    // (radio and loop would otherwise keep yt-dlp running for hours).
    const conn = getVoiceConnection(guildId)
    const vc = conn ? s.guild?.channels.cache.get(conn.joinConfig.channelId ?? '') : undefined
    const listeners = vc?.isVoiceBased() ? vc.members.filter(m => !m.user.bot).size : 1
    s.alone = listeners ? 0 : (s.alone ?? 0) + 1
    if (s.alone >= 4) {
      void leave(guildId, 'No operators remain in the voice channel. Playback suspended and audio module disconnected. Use `/music play` and I will return without hesitation.')
      return
    }
    // Nothing playing for about 5 minutes: leave instead of sitting in the channel.
    s.idle = s.current ? 0 : (s.idle ?? 0) + 1
    if (s.idle >= 20) {
      void leave(guildId, 'No playback activity was detected for 5.00 minutes. Disconnecting from the voice channel. Use `/music play` and I will return without hesitation.')
      return
    }
    if (statusOf(s) === 'playing') void refreshPanel(guildId)
  }, PANEL_REFRESH_MS)
}

// ---------- playback ----------
function makeResource(st: GuildState, t: Track): AudioResource {
  if (t.kind === 'file') return createAudioResource(t.ref)
  const proc = spawn(YTDLP, ['-f', 'bestaudio/best', '--no-playlist', '--no-warnings', '-q', '-o', '-', t.ref], { windowsHide: true })
  proc.on('error', e => process.stderr.write(`prts music: yt-dlp failed: ${e}\n`))
  proc.stderr.on('data', () => {})
  st.proc = proc
  return createAudioResource(proc.stdout!, { inputType: StreamType.Arbitrary })
}

function killProc(st: GuildState) {
  try {
    st.proc?.kill()
  } catch {}
  st.proc = undefined
}

// Logs the song that just stopped (finished, skipped or cut off). Songs that
// failed instantly (under 3 s) are not logged.
function finishCurrent(guildId: string, st: GuildState): Played | undefined {
  const t = st.current
  if (!t) return undefined
  const secs = (st.resource?.playbackDuration ?? 0) / 1000
  const e: Played = { title: t.title, url: t.url, requester: t.requester, duration: t.live ? Math.round(secs) : t.duration, live: t.live, at: Date.now(), ...(st.skipped ? { skipped: true } : {}) }
  st.skipped = false
  if (secs < 3) return undefined
  st.history.push(e)
  pushHistory(guildId, e)
  return e
}

// The panel of a song that is over becomes a one-line log entry without buttons,
// so old panels never sit there frozen on "NOW PLAYING".
function retirePanel(st: GuildState, e?: Played): void {
  const old = st.panel
  st.panel = undefined
  if (!old) return
  const emb = new EmbedBuilder().setColor(COLOR.idle)
  if (e) emb.setDescription(`${e.skipped ? '⏭ Skipped' : '✔ Played'} · ${link(e.title, e.url, 80)}${e.requester ? ` · ${e.requester}` : ''} · \`${len(e)}\``)
  else emb.setDescription('Track ended.')
  void old.edit({ embeds: [emb], components: [] }).catch(() => {})
}

// Everything has been played: the last panel turns into a summary of the session.
function summaryEmbed(history: Played[], title: string, note: string): EmbedBuilder {
  const e = new EmbedBuilder().setColor(COLOR.idle).setAuthor({ name: AUTHOR }).setFooter({ text: FOOTER }).setTitle(title)
  const shown = history.slice(-25)
  const first = history.length - shown.length
  const lines = shown.map(
    (h, n) => `\`${String(first + n + 1).padStart(2, '0')}\` ${h.skipped ? '⏭' : '✔'} ${link(h.title, h.url, 55)}${h.requester ? ` · ${short(h.requester, 20)}` : ''} · \`${len(h)}\``,
  )
  const total = history.reduce((s, h) => s + (h.duration ?? 0), 0)
  const skipped = history.filter(h => h.skipped).length
  e.setDescription([note, '', ...(first ? [`…${first} earlier song(s) not shown.`] : []), ...lines].join('\n'))
  e.addFields({ name: 'Session', value: `**${history.length}** songs · **${fmt(total)}** total${skipped ? ` · ${skipped} skipped` : ''}` })
  return e
}

async function endSession(guildId: string, st: GuildState, note: string, title = 'Playback complete'): Promise<void> {
  const hist = st.history
  st.history = []
  const old = st.panel
  st.panel = undefined
  if (!hist.length) {
    if (old) await old.edit({ components: [] }).catch(() => {})
    return
  }
  const payload = { embeds: [summaryEmbed(hist, title, note)], components: [] }
  if (
    old &&
    (await old.edit(payload).then(
      () => true,
      () => false,
    ))
  )
    return
  await st.channel?.send(payload).catch(() => {})
}

function playNext(guildId: string): void {
  const st = states.get(guildId)
  if (!st) return
  killProc(st)
  // While looping, the same panel is edited in place: no history entry, no
  // retired "Played" line and no new panel. Only tracks that actually played
  // count, so a broken link can't spin in a fast fail-and-retry cycle.
  const silent = st.loop !== 'off' && !!st.current && (st.resource?.playbackDuration ?? 0) > 5000
  const wasSkipped = !!st.skipped
  const done = silent ? undefined : finishCurrent(guildId, st)
  if (silent) st.skipped = false
  let next: Track | undefined
  if (silent && st.loop === 'track' && !wasSkipped) next = st.current
  else {
    if (silent && st.loop === 'queue') st.queue.push(st.current!)
    next = st.queue.shift()
  }
  st.current = next
  st.resource = undefined
  if (!next) {
    void endSession(guildId, st, 'Queue empty. All systems operational.')
    return
  }
  if (!silent) retirePanel(st, done)
  try {
    st.resource = makeResource(st, next)
    st.player.play(st.resource)
    st.played++
    void refreshPanel(guildId, !silent || !st.panel)
  } catch (err) {
    process.stderr.write(`prts music: failed to play ${next.ref}: ${err}\n`)
    playNext(guildId)
  }
}

function getState(guildId: string): GuildState {
  let st = states.get(guildId)
  if (!st) {
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } })
    st = { player, queue: [], loop: 'off', played: 0, history: [] }
    states.set(guildId, st)
    player.on(AudioPlayerStatus.Idle, () => playNext(guildId))
    player.on('error', err => process.stderr.write(`prts music: player error: ${err.message}\n`))
  }
  return st
}

async function cleanup(guildId: string, note: string) {
  const st = states.get(guildId)
  if (!st) return
  st.queue = []
  st.loop = 'off'
  if (st.timer) clearInterval(st.timer)
  killProc(st)
  finishCurrent(guildId, st)
  st.current = undefined
  st.player.removeAllListeners(AudioPlayerStatus.Idle)
  st.player.stop(true)
  await endSession(guildId, st, note, 'Playback terminated')
  states.delete(guildId)
}

function shuffle<T>(a: T[]) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
}

// Shown only on request (/music queue or the Queue button), never posted on its own.
function queueReply(st?: GuildState): { content?: string; embeds?: EmbedBuilder[]; components?: any[] } {
  if (!st?.current) return { content: '[PRTS] No playback in progress. The queue is empty.' }
  const lines = st.queue.map((t, n) => `\`${String(n + 1).padStart(2, '0')}\` ${link(t.title, t.url, 60)}${t.requester ? ` · ${short(t.requester, 20)}` : ''} · \`${len(t)}\``)
  const total = st.queue.reduce((s, t) => s + (t.duration ?? 0), 0)
  const head = `▶ **${link(st.current.title, st.current.url, 70)}** · \`${len(st.current)}\`\n\n`
  const make = (body: string, k: number, n: number) =>
    new EmbedBuilder()
      .setColor(COLOR.playing)
      .setAuthor({ name: AUTHOR })
      .setTitle(`Playback queue${st.loop === 'track' ? '  ·  🔂 track loop' : st.loop === 'queue' ? '  ·  🔁 playlist loop' : ''}`)
      .setDescription(head + (body || '_Nothing queued after this._'))
      .setFooter({ text: st.queue.length ? `${st.queue.length} waiting · about ${fmt(total)} remaining${n > 1 ? ` · page ${k + 1} of ${n}` : ''}` : FOOTER })
  // Fifteen songs a page; the page buttons switch the same message.
  return paged(lines.length ? linePages(lines, make, 3500, 15) : [make('', 0, 1)])
}

// ---------- lyrics ----------
// Lyrics are fetched by lyrics.ts (YouTube Music, LRCLib, Musixmatch, Genius) and
// posted in the channel, split over embeds when long.
const mdEscape = (s: string) => s.replace(/([\\*_~|`])/g, '\\$1').replace(/^([>#-])/gm, '\\$1')
function lyricChunks(text: string, max = 3800): string[] {
  const out: string[] = []
  let cur = ''
  for (const para of text.split(/\n{2,}/)) {
    const piece = para.length > max ? para.match(new RegExp(`[\\s\\S]{1,${max}}`, 'g'))! : [para]
    for (const part of piece) {
      if (cur && cur.length + part.length + 2 > max) {
        out.push(cur)
        cur = ''
      }
      cur += (cur ? '\n\n' : '') + part
    }
  }
  if (cur) out.push(cur)
  return out
}
const trackQuery = (t: Track): LyricsQuery => ({ title: t.title, artist: t.artist, duration: t.duration, videoId: ytId(t.url) })

async function sendLyrics(i: { editReply: (o: any) => Promise<unknown>; followUp: (o: any) => Promise<unknown> }, q: LyricsQuery, who?: string): Promise<void> {
  const name = cleanTitle(q.title)
  const links = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setURL(lyricsUrl(`${q.artist ?? ''} ${name}`.trim()))
      .setEmoji('🎼')
      .setLabel('Genius')
      .setStyle(ButtonStyle.Link),
    new ButtonBuilder()
      .setURL(`https://www.musixmatch.com/search?query=${encodeURIComponent(`${q.artist ?? ''} ${name}`.trim())}`)
      .setLabel('Musixmatch')
      .setStyle(ButtonStyle.Link),
    new ButtonBuilder()
      .setURL(`https://www.google.com/search?q=${encodeURIComponent(`${q.artist ?? ''} ${name} lyrics`.trim())}`)
      .setLabel('Web search')
      .setStyle(ButtonStyle.Link),
  )
  const r = await findLyrics(q).catch(() => null)
  if (!r) {
    await i
      .editReply({
        content: `[PRTS] No lyrics record found for **${short(name)}**${q.artist ? ` by ${short(q.artist, 40)}` : ''}. I apologize. Please specify the song and artist with \`/music lyrics\`, or use the search functions below.`,
        components: [links],
      })
      .catch(() => {})
    return
  }
  const chunks = lyricChunks(mdEscape(r.text)).slice(0, 4)
  const foot = `Lyrics via ${r.provider}${who ? ` · requested by ${who}` : ''}`
  const embeds = chunks.map((c, n) => {
    const e = new EmbedBuilder()
      .setColor(COLOR.playing)
      .setDescription(c)
      .setFooter({ text: chunks.length > 1 ? `${foot} · part ${n + 1}/${chunks.length}` : foot })
    if (n === 0) {
      e.setAuthor({ name: AUTHOR }).setTitle(short(`${r.title}${r.artist ? ` · ${r.artist}` : ''}`, 250))
      if (r.url) e.setURL(r.url)
    }
    return e
  })
  await i.editReply({ content: '', embeds: [embeds[0]], components: chunks.length === 1 ? [links] : [] }).catch(() => {})
  for (let n = 1; n < embeds.length; n++) {
    await i.followUp({ embeds: [embeds[n]], components: n === embeds.length - 1 ? [links] : [] }).catch(() => {})
  }
}

// ---------- slash command ----------
// Every action answers with ok + a one-line message. Successes are public log
// lines (who did what); failures stay private to the person who asked.
type Result = { ok: boolean; msg: string }
const fail = (msg: string): Result => ({ ok: false, msg })

// Deferred private reply: drop it when the public panel/log already says it all.
async function settle(i: { editReply: (o: any) => Promise<unknown>; deleteReply: () => Promise<unknown> }, r: Result): Promise<void> {
  if (r.ok) await i.deleteReply().catch(() => {})
  else await i.editReply({ content: r.msg, components: [] }).catch(() => {})
}

export async function handleMusic(i: ChatInputCommandInteraction): Promise<void> {
  const sub = i.options.getSubcommand()
  if (sub === 'voice') return handleVoice(i)
  const guild = i.guild
  if (!guild) {
    await i.reply({ content: '[PRTS] Audio functions are only available inside a server. I apologize for the inconvenience.', flags: MessageFlags.Ephemeral })
    return
  }
  const st = states.get(guild.id)

  switch (sub) {
    case 'list': {
      const f = i.options.getString('filter')
      let songs = listSongs()
      if (f) songs = songs.filter(s => norm(relative(MUSIC_DIR, s)).includes(norm(f)))
      // The music folder is the bot owner's own collection of audio files on the PC that runs PRTS.
      const about =
        'These are audio files stored on the computer that runs PRTS, in its music folder (the owner adds them). Play one with `/music play song:<name>`; anyone can also play YouTube links or upload a file with `/music play file:`.'
      const lines = songs.map((s, n) => `\`${String(n + 1).padStart(3, '0')}\` ${fileTitle(s)}`)
      const make = (body: string, k: number, n: number) =>
        new EmbedBuilder()
          .setColor(COLOR.playing)
          .setAuthor({ name: AUTHOR })
          .setTitle(`Music archive · ${songs.length} file${songs.length === 1 ? '' : 's'}${f ? ` matching "${short(f, 30)}"` : ''}`)
          .setDescription(`${about}\n\n${body || '_No audio files found in the music folder._'}`)
          .setFooter({ text: `${FOOTER}${n > 1 ? ` · page ${k + 1} of ${n}` : ''}` })
      await i.reply({ ...paged(lines.length ? linePages(lines, make, 3000, 25) : [make('', 0, 1)]), flags: MessageFlags.Ephemeral })
      return
    }
    case 'lyrics': {
      const song = i.options.getString('song')
      const artist = i.options.getString('artist') ?? undefined
      const cur = st?.current
      if (!song && !cur) {
        await i.reply({ content: '[PRTS] No playback in progress. Please specify a song.', flags: MessageFlags.Ephemeral })
        return
      }
      await i.deferReply()
      const q: LyricsQuery = song ? { title: song, artist } : { ...trackQuery(cur!), ...(artist ? { artist } : {}) }
      await sendLyrics(i, q, (i.member as GuildMember | null)?.displayName)
      return
    }
    case 'play': {
      const member = i.member as GuildMember | null
      const vc = member?.voice?.channel
      if (!vc) {
        await i.reply({ content: '[PRTS] Please join a voice channel first. I will follow without hesitation.', flags: MessageFlags.Ephemeral })
        return
      }
      const query = i.options.getString('song')
      const file = i.options.getAttachment('file')
      if (!query && !file) {
        await i.reply({ content: '[PRTS] Please give a link, search words, a file name, or upload a file.', flags: MessageFlags.Ephemeral })
        return
      }
      await i.deferReply({ flags: MessageFlags.Ephemeral })
      const found: Track[] = []
      try {
        if (file) found.push({ title: fileTitle(file.name), kind: 'file', ref: file.url, url: file.url, source: 'Upload', duration: file.duration ?? undefined })
        if (query) found.push(...(await resolveQuery(query)))
      } catch (err) {
        await i.editReply(`[PRTS] Retrieval failed. I apologize. (${short(String((err as Error).message ?? err), 180)})`)
        return
      }
      if (!found.length) {
        await i.editReply('[PRTS] No matching audio record found. I apologize.')
        return
      }
      const mix = i.options.getBoolean('shuffle') && found.length > 1
      if (mix) shuffle(found)
      await settle(i, await enqueue(i, member!, found, mix ? `🔀 **${found.length} tracks** (shuffled)` : undefined, !!i.options.getBoolean('next')))
      return
    }
    case 'search': {
      const q = i.options.getString('query', true)
      const type = (i.options.getString('type') ?? 'songs') as 'songs' | 'playlists'
      await i.deferReply({ flags: MessageFlags.Ephemeral })
      try {
        if (type === 'songs') {
          const tracks = (await searchSongs(q, 10)).slice(0, 10)
          if (!tracks.length) {
            await i.editReply('[PRTS] No search results found. I apologize.')
            return
          }
          const token = newPick({ userId: i.user.id, expires: Date.now() + PICK_TTL, kind: 'songs', tracks })
          const menu = new StringSelectMenuBuilder()
            .setCustomId(`music:pick:${token}`)
            .setPlaceholder('Select one or more tracks to queue')
            .setMinValues(1)
            .setMaxValues(tracks.length)
            .addOptions(
              tracks.map((t, n) => ({
                label: short(t.title, 100),
                value: String(n),
                description: short(`${t.artist ?? t.source} · ${len(t)}`, 100),
              })),
            )
          await i.editReply({
            content: `**[PRTS] Search results** for “${short(q, 80)}” · ${tracks.length} track(s). Select to queue.`,
            components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
          })
        } else {
          const lists = await searchPlaylists(q, 10)
          if (!lists.length) {
            await i.editReply('[PRTS] No playlist records found. I apologize.')
            return
          }
          const token = newPick({ userId: i.user.id, expires: Date.now() + PICK_TTL, kind: 'playlists', lists })
          const menu = new StringSelectMenuBuilder()
            .setCustomId(`music:pick:${token}`)
            .setPlaceholder('Select a playlist to queue')
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(lists.map((p, n) => ({ label: short(p.title, 100), value: String(n), description: short(p.owner ? `by ${p.owner}` : 'YouTube playlist', 100) })))
          await i.editReply({
            content: `**[PRTS] Playlist results** for “${short(q, 80)}”. Up to ${MAX_PLAYLIST} tracks are queued from the one you pick.`,
            components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
          })
        }
      } catch (err) {
        await i.editReply(`[PRTS] Search failed. I apologize. (${short(String((err as Error).message ?? err), 180)})`)
      }
      return
    }
    case 'radio': {
      const member = i.member as GuildMember | null
      if (!member?.voice?.channel) {
        await i.reply({ content: '[PRTS] Please join a voice channel first.', flags: MessageFlags.Ephemeral })
        return
      }
      const seed = i.options.getString('seed') ?? st?.current?.url ?? st?.current?.title
      if (!seed) {
        await i.reply({ content: '[PRTS] No playback in progress. Please specify a song to begin the radio from.', flags: MessageFlags.Ephemeral })
        return
      }
      await i.deferReply({ flags: MessageFlags.Ephemeral })
      await settle(i, await startRadio(i, member, seed))
      return
    }
    case 'artist': {
      const member = i.member as GuildMember | null
      if (!member?.voice?.channel) {
        await i.reply({ content: '[PRTS] Please join a voice channel first.', flags: MessageFlags.Ephemeral })
        return
      }
      const name = i.options.getString('name', true)
      const count = i.options.getInteger('count') ?? 15
      await i.deferReply({ flags: MessageFlags.Ephemeral })
      try {
        const tracks = await artistTracks(name, count)
        if (!tracks.length) {
          await i.editReply(`[PRTS] No songs found for ${short(name, 60)}. I apologize.`)
          return
        }
        for (const t of tracks) t.source = `Artist shuffle · ${short(name, 40)}`
        await settle(i, await enqueue(i, member, tracks, `${tracks.length} shuffled songs by **${short(name, 60)}**`))
      } catch (err) {
        await i.editReply(`[PRTS] Artist lookup failed. I apologize. (${short(String((err as Error).message ?? err), 180)})`)
      }
      return
    }
    case 'nowplaying': {
      if (!st?.current) {
        await i.reply({ content: '[PRTS] No playback in progress.', flags: MessageFlags.Ephemeral })
        return
      }
      if (i.channel && 'send' in i.channel) st.channel = i.channel as any
      await i.reply({ content: '[PRTS] Playback panel refreshed.', flags: MessageFlags.Ephemeral })
      await refreshPanel(guild.id, true)
      return
    }
    case 'queue': {
      await i.reply({ ...queueReply(st), flags: MessageFlags.Ephemeral })
      return
    }
    case 'replay': {
      const member = i.member as GuildMember | null
      if (!member?.voice?.channel) {
        await i.reply({ content: '[PRTS] Please join a voice channel first.', flags: MessageFlags.Ephemeral })
        return
      }
      const n = i.options.getInteger('position') ?? 1
      const past = histAll()[guild.id] ?? []
      const h = past[past.length - n]
      if (!h?.url) {
        await i.reply({
          content: h ? '[PRTS] That record has no link on file, so it cannot be replayed. I apologize.' : '[PRTS] No record at that position in `/music history`.',
          flags: MessageFlags.Ephemeral,
        })
        return
      }
      await i.deferReply({ flags: MessageFlags.Ephemeral })
      try {
        const tracks = (await resolveQuery(h.url)).slice(0, 1)
        if (!tracks.length) {
          await i.editReply('[PRTS] Retrieval failed: the record could not be loaded again. I apologize.')
          return
        }
        await settle(i, await enqueue(i, member, tracks, `🔁 **${short(h.title)}** again`, true))
      } catch (err) {
        await i.editReply(`[PRTS] Replay failed. I apologize. (${short(String((err as Error).message ?? err), 180)})`)
      }
      return
    }
    case 'history': {
      const n = i.options.getInteger('count') ?? 15
      const all = histAll()[guild.id] ?? []
      const list = all.slice(-n).reverse()
      if (!list.length) {
        await i.reply({ content: '[PRTS] No playback records on file for this server.', flags: MessageFlags.Ephemeral })
        return
      }
      const lines = list.map(h => `${h.skipped ? '⏭' : '✔'} ${link(h.title, h.url, 60)}${h.requester ? ` · ${short(h.requester, 20)}` : ''} · \`${len(h)}\` · <t:${Math.floor(h.at / 1000)}:R>`)
      const e = new EmbedBuilder()
        .setColor(COLOR.idle)
        .setAuthor({ name: AUTHOR })
        .setTitle(`Music log · last ${list.length} song(s)`)
        .setDescription(lines.join('\n').slice(0, 4000))
        .setFooter({ text: `${all.length} song(s) on record · ${FOOTER}` })
      await i.reply({ embeds: [e], flags: MessageFlags.Ephemeral })
      return
    }
    default: {
      const r = await control(
        guild.id,
        sub,
        i.member as GuildMember | null,
        i.options.getInteger('position') ?? i.options.getInteger('count') ?? i.options.getInteger('from') ?? undefined,
        i.options.getInteger('to') ?? undefined,
      )
      await i.reply(r.ok ? { content: r.msg } : { content: r.msg, flags: MessageFlags.Ephemeral })
    }
  }
}

// Join the member's voice channel if needed, queue the tracks, start playback.
// Returns a short private confirmation for the person who asked.
type AnyInteraction = { guild: Guild | null; channel: any; user: { username: string } }
async function enqueue(i: AnyInteraction, member: GuildMember, found: Track[], label?: string, atFront = false): Promise<Result> {
  const guild = i.guild!
  const vc = member.voice?.channel
  if (!vc) return fail('[PRTS] Please join a voice channel first. I will follow without hesitation.')
  const who = member.displayName ?? i.user.username
  for (const t of found) t.requester = who

  const state = getState(guild.id)
  state.guild = guild
  if (i.channel && 'send' in i.channel) state.channel = i.channel
  let conn = getVoiceConnection(guild.id)
  if (!conn || conn.joinConfig.channelId !== vc.id) {
    conn = joinVoiceChannel({ channelId: vc.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: true })
    try {
      await entersState(conn, VoiceConnectionStatus.Ready, 20_000)
    } catch (err) {
      conn.destroy()
      return fail(`[PRTS] Voice connection failed. I apologize. Please check that I may Connect and Speak in ${vc.name}. (${short(String(err), 150)})`)
    }
    const c = conn
    c.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([entersState(c, VoiceConnectionStatus.Signalling, 5_000), entersState(c, VoiceConnectionStatus.Connecting, 5_000)])
      } catch {
        c.destroy()
        await leave(guild.id, 'Voice connection lost (disconnected or moved out of the channel). Playback has been terminated. I apologize for the inconvenience.', false)
      }
    })
  }
  if (state.queue.length + found.length > MAX_QUEUE) return fail(`[PRTS] Queue capacity is limited to ${MAX_QUEUE} tracks. I apologize for the inconvenience.`)
  conn.subscribe(state.player)
  startTimer(guild.id)
  if (atFront) state.queue.unshift(...found)
  else state.queue.push(...found)
  const idle = state.player.state.status === AudioPlayerStatus.Idle
  const what = label ?? (found.length === 1 ? `**${short(found[0].title)}**` : `**${found.length} tracks**`)
  if (idle) {
    playNext(guild.id)
    return { ok: true, msg: '' }
  }
  await refreshPanel(guild.id)
  await state.channel?.send(`\`[PRTS]\` ➕ **${who}** queued ${what} (${atFront ? 'plays next' : `position ${state.queue.length - found.length + 1}`}).`).catch(() => {})
  return { ok: true, msg: '' }
}

async function startRadio(i: AnyInteraction, member: GuildMember, seed: string): Promise<Result> {
  try {
    const st = states.get(i.guild!.id)
    const { seedTitle, tracks } = await radioTracks(seed)
    // If the seed is already playing, don't queue it twice.
    const playingId = ytId(st?.current?.url)
    const list = tracks.filter(t => !playingId || ytId(t.url) !== playingId)
    if (!list.length) return fail('[PRTS] The radio retrieval returned no tracks. I apologize.')
    for (const t of list) t.source = `YouTube radio · ${short(seedTitle, 40)}`
    return await enqueue(i, member, list, `📻 radio from **${short(seedTitle, 60)}** (${list.length} tracks)`)
  } catch (err) {
    return fail(`[PRTS] Radio could not start. I apologize. (${short(String((err as Error).message ?? err), 180)})`)
  }
}

// Shared by slash subcommands and panel buttons. Successful actions return a
// public log line naming who did it.
async function control(guildId: string, action: string, member: GuildMember | null, n?: number, m?: number): Promise<Result> {
  const st = states.get(guildId)
  const who = member?.displayName ?? 'Operator'
  const log = (icon: string, text: string): Result => ({ ok: true, msg: `\`[PRTS]\` ${icon} **${short(who, 40)}** ${text}` })
  if (!st?.current && action !== 'stop') return fail('[PRTS] No playback in progress.')
  switch (action) {
    case 'skip': {
      const was = st!.current!.title
      const more = Math.min(Math.max((n ?? 1) - 1, 0), st!.queue.length)
      if (more) st!.queue.splice(0, more)
      st!.skipped = true
      st!.player.stop()
      return log('⏭', more ? `skipped **${short(was)}** and ${more} more track(s).` : `skipped **${short(was)}**.`)
    }
    case 'skipto': {
      const target = n ? st!.queue[n - 1] : undefined
      if (!target) return fail(`[PRTS] No record at position ${n}. Please consult \`/music queue\`.`)
      st!.queue.splice(0, n! - 1)
      st!.skipped = true
      st!.player.stop()
      return log('⏭', `jumped to **${short(target.title)}** (skipped ${n! - 1} queued track(s) and the current one).`)
    }
    case 'pause':
      if (!st!.player.pause()) return fail('[PRTS] Playback is already paused.')
      await refreshPanel(guildId)
      return log('⏸', 'paused playback. Standing by.')
    case 'resume':
      if (!st!.player.unpause()) return fail('[PRTS] Playback is not paused.')
      await refreshPanel(guildId)
      return log('▶', 'resumed playback.')
    case 'toggle':
      return control(guildId, statusOf(st!) === 'paused' ? 'resume' : 'pause', member)
    case 'shuffle':
      shuffle(st!.queue)
      await refreshPanel(guildId)
      return log('🔀', `shuffled the queue (${st!.queue.length} track(s)).`)
    case 'loop': {
      st!.loop = st!.loop === 'off' ? 'track' : st!.loop === 'track' ? 'queue' : 'off'
      await refreshPanel(guildId)
      return log('🔁', st!.loop === 'off' ? 'turned loop off.' : st!.loop === 'track' ? 'is looping the current track.' : 'is looping the entire playlist.')
    }
    case 'clear': {
      if (!st!.queue.length) return fail('[PRTS] The queue is already empty.')
      const c = st!.queue.length
      st!.queue = []
      await refreshPanel(guildId)
      return log('🧹', `cleared the queue (${c} track(s)).`)
    }
    case 'remove': {
      const t = n ? st!.queue[n - 1] : undefined
      if (!t) return fail(`[PRTS] No record at position ${n}. Please consult \`/music queue\`.`)
      st!.queue.splice(n! - 1, 1)
      await refreshPanel(guildId)
      return log('➖', `removed **${short(t.title)}** from the queue.`)
    }
    case 'move': {
      const t = n ? st!.queue[n - 1] : undefined
      if (!t || !m) return fail(`[PRTS] No record at position ${n}. Please consult \`/music queue\`.`)
      const to = Math.min(m, st!.queue.length)
      st!.queue.splice(n! - 1, 1)
      st!.queue.splice(to - 1, 0, t)
      await refreshPanel(guildId)
      return log('↕', `moved **${short(t.title)}** to position ${to}${to === 1 ? ' (plays next)' : ''}.`)
    }
    case 'stop': {
      if (!st) return fail('[PRTS] No playback in progress.')
      await cleanup(guildId, `Playback terminated by ${who}. Leaving the voice channel. Thank you for listening.`)
      getVoiceConnection(guildId)?.destroy()
      return log('⏹', 'terminated playback and cleared the queue.')
    }
  }
  return fail('[PRTS] Unrecognized function. I apologize for the inconvenience.')
}

// ---------- autocomplete ----------
// /music play song: suggests files from the music folder (links and search words still work).
export async function handleMusicAutocomplete(i: AutocompleteInteraction): Promise<void> {
  if (i.options.getSubcommand(false) === 'voice') return handleVoiceAutocomplete(i)
  const focused = i.options.getFocused(true)
  if (focused.name !== 'song') {
    await i.respond([])
    return
  }
  const key = norm(String(focused.value))
  const hits = listSongs()
    .map(f => fileTitle(f))
    .filter(t => !key || norm(t).includes(key))
    .slice(0, 25)
  await i.respond(hits.map(t => ({ name: short(t, 100), value: short(t, 100) }))).catch(() => {})
}

// ---------- panel buttons ----------
export async function handleMusicButton(i: ButtonInteraction): Promise<void> {
  const action = i.customId.slice('music:'.length)
  if (!i.guildId) return
  const member = i.member as GuildMember | null
  const st = states.get(i.guildId)
  if (action === 'queue') {
    await i.reply({ ...queueReply(st), flags: MessageFlags.Ephemeral })
    return
  }
  if (action === 'radio') {
    if (!member?.voice?.channel || !st?.current) {
      await i.reply({ content: '[PRTS] Insufficient permissions. Please join my voice channel to start the radio.', flags: MessageFlags.Ephemeral })
      return
    }
    await i.deferReply({ flags: MessageFlags.Ephemeral })
    await settle(i, await startRadio(i, member, st.current.url ?? st.current.title))
    return
  }
  if (action === 'lyrics') {
    const t = st?.current
    if (!t) {
      await i.reply({ content: '[PRTS] No playback in progress.', flags: MessageFlags.Ephemeral })
      return
    }
    await i.deferReply()
    await sendLyrics(i, trackQuery(t), member?.displayName)
    return
  }
  // Controls need the presser to be in the same voice channel as PRTS.
  const botChannel = getVoiceConnection(i.guildId)?.joinConfig.channelId
  if (botChannel && member?.voice?.channelId !== botChannel) {
    await i.reply({ content: '[PRTS] Insufficient permissions. Please join my voice channel to use the controls.', flags: MessageFlags.Ephemeral })
    return
  }
  await i.deferUpdate()
  const r = await control(i.guildId, action, member)
  if (r.ok) await ((st?.channel ?? i.channel) as any)?.send(r.msg).catch(() => {})
  else await i.followUp({ content: r.msg, flags: MessageFlags.Ephemeral }).catch(() => {})
}

// ---------- search result menus ----------
export async function handleMusicSelect(i: StringSelectMenuInteraction): Promise<void> {
  const token = i.customId.slice('music:pick:'.length)
  const p = picks.get(token)
  if (!p || p.expires < Date.now()) {
    await i.update({ content: '[PRTS] These search results have expired. Please search again.', components: [] }).catch(() => {})
    return
  }
  if (p.userId !== i.user.id) {
    await i.reply({ content: '[PRTS] Insufficient permissions. This menu belongs to another user.', flags: MessageFlags.Ephemeral })
    return
  }
  const member = i.member as GuildMember | null
  if (!member?.voice?.channel) {
    await i.reply({ content: '[PRTS] Please join a voice channel first, then pick again.', flags: MessageFlags.Ephemeral })
    return
  }
  await i.deferUpdate()
  let tracks: Track[] = []
  let label: string | undefined
  try {
    if (p.kind === 'songs') {
      tracks = i.values.map(v => ({ ...p.tracks[Number(v)] })).filter(t => t.ref)
    } else {
      const pl = p.lists[Number(i.values[0])]
      tracks = await ytdlpTracks(pl.url, 'YouTube playlist')
      for (const t of tracks) t.source = `Playlist · ${short(pl.title, 40)}`
      label = `playlist **${short(pl.title, 60)}** (${tracks.length} tracks)`
    }
  } catch (err) {
    await i.editReply({ content: `[PRTS] Retrieval failed. I apologize. (${short(String((err as Error).message ?? err), 180)})`, components: [] })
    return
  }
  if (!tracks.length) {
    await i.editReply({ content: '[PRTS] No tracks to queue.', components: [] })
    return
  }
  picks.delete(token)
  await settle(i, await enqueue(i, member, tracks, label))
}
