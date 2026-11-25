// PRTS lyrics finder for the music player. Tries four sources in parallel and
// uses the first hit in priority order: YouTube Music, LRCLib, Musixmatch, Genius.
// Plain (unsynced) text only; the result is posted in the channel by music.ts.
// Approach based on the pear-desktop "synced-lyrics" plugin (providers + matching).

export type LyricsQuery = { title: string; artist?: string; album?: string; duration?: number; videoId?: string }
export type LyricsResult = { title: string; artist?: string; text: string; provider: string; url?: string }
type Provider = { name: string; search(q: Required<Pick<LyricsQuery, 'title'>> & LyricsQuery): Promise<LyricsResult | null> }

const TIMEOUT_MS = 8000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

// ---------- cleaning and matching ----------
const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

const NOISE = /\s*[\(\[【（][^\)\]】）]*(official|video|audio|lyric|lyrics|mv|m\/v|hd|4k|visualizer|remaster|ost|full|version|live|explicit|music)[^\)\]】）]*[\)\]】）]/gi

/** Turns a YouTube-style title and channel name into a clean title and artist. */
export function tidyQuery(q: LyricsQuery): LyricsQuery {
  let title = q.title
    .replace(/\(via YouTube:.*\)$/i, '')
    .replace(NOISE, '')
    .replace(/\s*[|｜].*$/, '')
    .trim()
  let artist =
    (q.artist ?? '')
      .replace(/\s*-\s*Topic$/i, '')
      .replace(/VEVO$/i, '')
      .replace(/\s*Official( Channel)?$/i, '')
      .trim() || undefined
  const m = title.match(/^(.{1,60}?)\s+[-–—]\s+(.+)$/)
  if (m) {
    artist = m[1].trim()
    title = m[2].trim()
  }
  title = title
    .replace(/\s*[\(\[]\s*(feat|ft|featuring)\.?[^\)\]]*[\)\]]/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  return { ...q, title: title || q.title, artist }
}

// Dice coefficient on character bigrams: 1 = same, 0 = nothing in common.
function sim(a: string, b: string): number {
  a = norm(a)
  b = norm(b)
  if (!a || !b) return 0
  if (a === b) return 1
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length) > 0.4 ? 0.9 : 0.7
  const grams = (s: string) => {
    const m = new Map<string, number>()
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2)
      m.set(g, (m.get(g) ?? 0) + 1)
    }
    return m
  }
  const ga = grams(a),
    gb = grams(b)
  let hit = 0
  for (const [g, n] of ga) hit += Math.min(n, gb.get(g) ?? 0)
  return (2 * hit) / (Math.max(a.length - 1, 1) + Math.max(b.length - 1, 1))
}

const artistSim = (want: string | undefined, got: string) => {
  if (!want) return 0.7
  const parts = (s: string) =>
    s
      .split(/[&,;/]| x | feat\.? | ft\.? /i)
      .map(x => x.trim())
      .filter(Boolean)
  let best = 0
  for (const x of parts(want)) for (const y of parts(got)) best = Math.max(best, sim(x, y))
  return Math.max(best, sim(want, got))
}

const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
const tidyText = (s: string) =>
  s
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
const stripLrc = (s: string) => s.replace(/^\s*\[[^\]]*\]\s?/gm, '').replace(/<\d+:\d+(?:\.\d+)?>\s*/g, '')

async function getJson(url: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, Accept: 'application/json', ...(init.headers as object) }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// ---------- LRCLib ----------
const LRCLib: Provider = {
  name: 'LRCLib',
  async search(q) {
    const base = 'https://lrclib.net/api'
    type Item = { trackName: string; artistName: string; duration: number; instrumental: boolean; plainLyrics?: string; syncedLyrics?: string; id: number }
    let items: Item[] = []
    if (q.artist && q.duration) {
      try {
        const p = new URLSearchParams({ artist_name: q.artist, track_name: q.title, duration: String(Math.round(q.duration)), ...(q.album ? { album_name: q.album } : {}) })
        const one = await getJson(`${base}/get?${p}`)
        if (one?.id) items = [one]
      } catch {}
    }
    if (!items.length) {
      const p = new URLSearchParams(q.artist ? { track_name: q.title, artist_name: q.artist } : { q: q.title })
      items = await getJson(`${base}/search?${p}`).catch(() => [])
    }
    if (!items.length && q.artist) items = await getJson(`${base}/search?${new URLSearchParams({ q: `${q.artist} ${q.title}` })}`).catch(() => [])
    let best: { item: Item; score: number } | undefined
    for (const item of Array.isArray(items) ? items : []) {
      if (item.instrumental || !(item.plainLyrics || item.syncedLyrics)) continue
      const dur = q.duration && item.duration ? Math.abs(item.duration - q.duration) : 0
      if (dur > 15) continue
      const ts = sim(q.title, item.trackName),
        as = artistSim(q.artist, item.artistName)
      if (ts < 0.6 || as < 0.5) continue
      const score = ts + as - dur * 0.01
      if (!best || score > best.score) best = { item, score }
    }
    if (!best) return null
    const it = best.item
    return { title: it.trackName, artist: it.artistName, text: tidyText(it.plainLyrics || stripLrc(it.syncedLyrics!)), provider: 'LRCLib', url: `https://lrclib.net/api/get/${it.id}` }
  },
}

// ---------- Genius ----------
// Index of the closing tag of an element whose content starts at `from`.
function elemEnd(html: string, from: number, name = 'div'): number {
  const re = new RegExp(`<(/?)${name}\\b[^>]*>`, 'gi')
  re.lastIndex = from
  let depth = 1,
    m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    depth += m[1] ? -1 : 1
    if (!depth) return m.index
  }
  return html.length
}
const divEnd = (html: string, from: number) => elemEnd(html, from)
// Genius puts "Contributors / Translations / Read More" blocks inside the lyrics container.
function dropExcluded(html: string): string {
  for (let guard = 0; guard < 20; guard++) {
    const at = html.indexOf('data-exclude-from-selection="true"')
    if (at < 0) break
    const start = html.lastIndexOf('<', at)
    const name = /^<(\w+)/.exec(html.slice(start))?.[1] ?? 'div'
    const openEnd = html.indexOf('>', at) + 1
    const end = elemEnd(html, openEnd, name)
    html = html.slice(0, start) + html.slice(Math.min(html.indexOf('>', end) + 1, html.length) || html.length)
  }
  return html
}

const Genius: Provider = {
  name: 'Genius',
  async search(q) {
    const data = await getJson(`https://genius.com/api/search/song?${new URLSearchParams({ q: `${q.artist ?? ''} ${q.title}`.trim(), page: '1', per_page: '8' })}`)
    const hits: any[] = data?.response?.sections?.[0]?.hits ?? []
    let best: { r: any; score: number } | undefined
    for (const h of hits) {
      const r = h.result
      if (!r || r.instrumental || /Deleted-artist/.test(r.primary_artist?.url ?? '')) continue
      const ts = sim(q.title, r.title),
        as = artistSim(q.artist, r.primary_artist?.name ?? r.artist_names ?? '')
      if (ts < 0.55 || as < 0.4) continue
      if (!best || ts + as > best.score) best = { r, score: ts + as }
    }
    if (!best) return null
    const res = await fetch(best.r.url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const html = await res.text()
    const parts: string[] = []
    let from = 0
    for (;;) {
      const at = html.indexOf('data-lyrics-container="true"', from)
      if (at < 0) break
      const open = html.indexOf('>', at) + 1
      const end = divEnd(html, open)
      parts.push(dropExcluded(html.slice(open, end)))
      from = end
    }
    if (!parts.length) return null
    const text = decode(
      parts
        .join('\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/?(?:a|span|i|b|em|strong|div|p)[^>]*>/gi, '')
        .replace(/<[^>]+>/g, ''),
    )
    const clean = tidyText(text)
    if (!clean || /^\[?instrumental\]?$/i.test(clean)) return null
    return { title: best.r.title, artist: best.r.primary_artist?.name, text: clean, provider: 'Genius', url: best.r.url }
  },
}

// ---------- Musixmatch (desktop app API, anonymous token) ----------
const MXM = 'https://apic-desktop.musixmatch.com/ws/1.1/'
const MXM_APP = 'web-desktop-app-v1.0'
let mxmToken: { token: string; expires: number } | null = null
let mxmCookie = 'x-mxm-user-id='
async function mxmFetch(path: string, params: Record<string, string>): Promise<any> {
  const res = await fetch(`${MXM}${path}?${new URLSearchParams(params)}`, {
    headers: { Cookie: mxmCookie, Authority: 'apic-desktop.musixmatch.com', 'User-Agent': UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const sc = res.headers.get('set-cookie')
  if (sc) mxmCookie = sc.split(';')[0]
  return res.json()
}
async function mxmGetToken(force = false): Promise<string> {
  if (!force && mxmToken && mxmToken.expires > Date.now()) return mxmToken.token
  const j = await mxmFetch('token.get', { app_id: MXM_APP })
  const token = j?.message?.body?.user_token
  if (!token || /^0+$/.test(token)) throw new Error('Musixmatch is not handing out tokens right now')
  mxmToken = { token, expires: Date.now() + 10 * 60_000 }
  return token
}
const Musixmatch: Provider = {
  name: 'Musixmatch',
  async search(q) {
    const run = async (force: boolean) =>
      mxmFetch('macro.subtitles.get', {
        app_id: MXM_APP,
        format: 'json',
        usertoken: await mxmGetToken(force),
        q_track: q.title,
        ...(q.artist ? { q_artist: q.artist } : {}),
        ...(q.duration ? { q_duration: String(Math.round(q.duration)) } : {}),
        ...(q.album ? { q_album: q.album } : {}),
        namespace: 'lyrics_richsynched',
        subtitle_format: 'lrc',
      })
    let j = await run(false)
    if (j?.message?.header?.status_code === 401) j = await run(true)
    const calls = j?.message?.body?.macro_calls
    const track = calls?.['matcher.track.get']?.message?.body?.track
    if (!track || track.track_id === 115264642) return null // Musixmatch's "no match" placeholder song
    if (sim(q.title, track.track_name) < 0.5 || artistSim(q.artist, track.artist_name) < 0.4) return null
    const lyr = calls?.['track.lyrics.get']?.message?.body?.lyrics
    let text: string | undefined = lyr && !lyr.instrumental ? lyr.lyrics_body : undefined
    if (!text) {
      const sub = calls?.['track.subtitles.get']?.message?.body?.subtitle_list?.[0]?.subtitle?.subtitle_body
      if (sub) text = stripLrc(sub)
    }
    if (!text) return null
    text = tidyText(text.replace(/\n*\*{3,}[^\n]*NOT for Commercial use[^\n]*\*{3,}[\s\S]*$/i, '').replace(/\n*\(\d{6,}\)\s*$/, ''))
    return text ? { title: track.track_name, artist: track.artist_name, text, provider: 'Musixmatch', url: track.track_share_url } : null
  },
}

// ---------- YouTube Music ----------
const YTM_CLIENT = { clientName: 'WEB_REMIX', clientVersion: '1.20250101.01.00', hl: 'en' }
async function ytmPost(endpoint: string, body: object): Promise<any> {
  return getJson(`https://music.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://music.youtube.com' },
    body: JSON.stringify({ context: { client: YTM_CLIENT }, ...body }),
  })
}
const YTMusic: Provider = {
  name: 'YouTube Music',
  async search(q) {
    if (!q.videoId) return null
    const next = await ytmPost('next', { videoId: q.videoId })
    const tabs: any[] = next?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs ?? []
    const tab = tabs.find(t => t?.tabRenderer?.endpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType === 'MUSIC_PAGE_TYPE_TRACK_LYRICS')
    const browseId = tab?.tabRenderer?.endpoint?.browseEndpoint?.browseId
    if (!browseId) return null
    const data = await ytmPost('browse', { browseId })
    const shelf = data?.contents?.sectionListRenderer?.contents?.[0]?.musicDescriptionShelfRenderer
    const runs: { text: string }[] | undefined = shelf?.description?.runs
    const text = runs?.map(r => r.text).join('')
    if (!text || /^Lyrics not available/i.test(text)) return null
    return { title: q.title, artist: q.artist, text: tidyText(text), provider: 'YouTube Music', url: `https://music.youtube.com/watch?v=${q.videoId}` }
  },
}

// Priority order. All start at once; the first non-empty answer in this order wins.
export const PROVIDERS: Provider[] = [YTMusic, LRCLib, Musixmatch, Genius]

// ---------- public API ----------
const cache = new Map<string, { at: number; value: LyricsResult | null }>()
const CACHE_MS = 60 * 60_000

export async function findLyrics(raw: LyricsQuery): Promise<LyricsResult | null> {
  const q = tidyQuery(raw)
  const key = q.videoId ?? `${norm(q.artist ?? '')}|${norm(q.title)}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value
  const runs = PROVIDERS.map(p =>
    p.search(q).catch(err => {
      process.stderr.write(`prts lyrics: ${p.name} failed: ${(err as Error).message ?? err}\n`)
      return null
    }),
  )
  let found: LyricsResult | null = null
  for (const r of runs) {
    const v = await r
    if (v?.text && v.text.length > 20) {
      found = v
      break
    }
  }
  if (cache.size > 200) cache.delete(cache.keys().next().value!)
  if (found) cache.set(key, { at: Date.now(), value: found })
  return found
}
