import { clip, ephFlag } from '../common.ts'
import { MessageFlags, type ChatInputCommandInteraction, type Client } from 'discord.js'
import { readFileSync, statSync, existsSync } from 'fs'
import { join } from 'path'
import { FOOTER } from '../theme.ts'
import { DATA_DIR } from '../paths.ts'
import { announce } from '../announce.ts'
import { data, ensureData, findOps } from './data.ts'
import { TIMO, embed, log } from './helpers.ts'

const STORIES_JSON = process.env.PRTS_STORIES_JSON ?? join(DATA_DIR, 'stories.json')

// ───────────────────────── /story ─────────────────────────

type Story = { group: string; group_name: string; kind: string; code: string; name: string; tag: string; file: string; synopsis: string; operator: string; speakers?: Record<string, number> }
let stories: Story[] | null = null
let storiesPath = STORIES_JSON
let storiesMtime = 0
export function loadStories(): Story[] {
  let mtime = 0
  try {
    mtime = statSync(storiesPath).mtimeMs
  } catch {}
  if (!stories || mtime !== storiesMtime) {
    storiesMtime = mtime
    try {
      stories = JSON.parse(readFileSync(storiesPath, 'utf8'))
    } catch (e) {
      log(`stories: ${e}`)
      stories ??= []
    }
  }
  return stories!
}

/** Lines and stories where a character speaks, from the story index (exact speaker name). */
export function storyAppearances(name: string): { lines: number; stories: number; groups: string[] } | null {
  const n = name.trim().toLowerCase()
  let lines = 0,
    count = 0
  const groups: string[] = []
  for (const s of loadStories()) {
    const hit = Object.entries(s.speakers ?? {}).find(([who]) => who.toLowerCase() === n)
    if (!hit) continue
    lines += hit[1]
    count++
    if (!groups.includes(s.group_name)) groups.push(s.group_name)
  }
  return count ? { lines, stories: count, groups } : null
}

// Optional daily story index refresh (PRTS_STORY_REFRESH_CMD). The command
// rebuilds the index outside git and prints one JSON line:
//   {"changed", "stories_json", "new_groups": [{id, name, kind, stories}], "grown_groups": [...]}
// New stories are announced in the channels picked with /events announce.
const REFRESH_CMD = process.env.PRTS_STORY_REFRESH_CMD?.trim()
type RefreshGroup = { id: string; name: string; kind: string; stories: number }
export async function runStoryRefresh(client: Client): Promise<void> {
  const proc = Bun.spawn(['sh', '-c', REFRESH_CMD!], { stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => proc.kill(), 15 * 60_000)
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  clearTimeout(timer)
  if (code !== 0) {
    log(`story refresh failed (${code}): ${clip(err.trim(), 300)}`)
    return
  }
  const res = JSON.parse(out.trim().split('\n').pop() || '{}') as { changed?: boolean; stories_json?: string; new_groups?: RefreshGroup[]; grown_groups?: RefreshGroup[] }
  if (res.stories_json && existsSync(res.stories_json)) storiesPath = res.stories_json
  const added = res.new_groups ?? []
  const grown = res.grown_groups ?? []
  if (res.changed) log(`story index refreshed: ${added.length} new groups, ${grown.length} with new chapters`)
  if (!(added.length || grown.length)) return
  ensureData()
  const line = (g: RefreshGroup) => {
    const slug = data?.timoGroups[g.id]
    const name = slug ? `[${g.name}](${TIMO}/${g.id.startsWith('main_') ? 'main' : 'side'}/${slug})` : g.name
    return `• ${name}${g.kind === 'record' ? ' (operator record)' : ''} · ${g.stories} ${g.stories === 1 ? 'story' : 'stories'}`
  }
  const big = [...added, ...grown].filter(g => g.kind !== 'record')
  const records = added.filter(g => g.kind === 'record')
  const parts = []
  if (big.length) parts.push(big.map(line).join('\n'))
  if (records.length) parts.push(`Operator records: ${records.map(g => g.name).join(', ')}`)
  const e = embed('New story records available')
    .setURL(TIMO)
    .setDescription(clip(`${parts.join('\n\n')}\n\nSearch them with \`/story\`.`, 4000))
    .setFooter({ text: `${FOOTER} · Story index: arknights.timo.beer` })
  await announce(client, e)
}
export function startStoryRefresh(client: Client): void {
  if (!REFRESH_CMD) return
  let running = false
  const tick = () => {
    if (running) return
    running = true
    void runStoryRefresh(client)
      .catch(e => log(`story refresh: ${e}`))
      .finally(() => {
        running = false
      })
  }
  setTimeout(tick, 60_000).unref()
  setInterval(tick, 24 * 3600 * 1000).unref()
}

function storyLink(s: Story): string | null {
  ensureData()
  const slug = data?.timoGroups[s.group]
  if (slug) return `${TIMO}/${s.group.startsWith('main_') ? 'main' : 'side'}/${slug}`
  if (s.operator) {
    const o = findOps(s.operator, 1)[0]
    const os = o && data?.timoOps[o.id]
    if (os) return `${TIMO}/operators/${os}`
  }
  return null
}

export async function cmdStory(i: ChatInputCommandInteraction, eph: boolean) {
  const q = i.options.getString('query', true).trim()
  const n = q.toLowerCase()
  const all = loadStories()
  const exactCode = all.filter(s => s.code.toLowerCase() === n)
  const hits = exactCode.length ? exactCode : all.filter(s => s.name.toLowerCase().includes(n) || s.group_name.toLowerCase().includes(n) || s.operator.toLowerCase() === n)
  if (!hits.length) {
    return i.reply({ content: `[PRTS] No story matches "${clip(q, 60)}". Try a stage code (15-12), a title, or an event name. Full library: ${TIMO}`, flags: MessageFlags.Ephemeral })
  }
  // Collapse to groups when a query matches a whole event.
  const e = embed(`Story records: ${clip(q, 80)}`).setURL(TIMO)
  const seen = new Set<string>()
  let shown = 0
  for (const s of hits) {
    const key = `${s.group}|${s.code}|${s.name}`
    if (seen.has(key)) continue
    seen.add(key)
    const link = storyLink(s)
    const title = clip(`${s.code ? s.code + ' ' : ''}${s.name}${s.tag ? ` (${s.tag})` : ''} · ${s.group_name}`, 250)
    const cast = Object.entries(s.speakers ?? {})
      .filter(([who]) => who !== '???' && !/^(\?+|narration)$/i.test(who))
      .slice(0, 6)
      .map(([who, n]) => `${who} (${n})`)
      .join(', ')
    e.addFields({
      name: title,
      value: clip(`${s.synopsis ? clip(s.synopsis, 220) + '\n' : ''}${cast ? `*Speaking:* ${clip(cast, 200)}\n` : ''}${link ? `[Read in Timo's reader](${link})` : ''}` || '—', 1024),
    })
    if (++shown >= 8) break
  }
  if (hits.length > shown) e.setDescription(`Showing ${shown} of ${hits.length} matches. Narrow the query for more precise results.`)
  e.setFooter({ text: `${FOOTER} · Story index: arknights.timo.beer` })
  return i.reply({ embeds: [e], flags: ephFlag(eph) })
}
