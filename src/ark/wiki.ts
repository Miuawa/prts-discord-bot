import { WIKI, UA, clip, ephFlag, wikiUrl } from '../common.ts'
import { EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js'
import { FOOTER } from '../theme.ts'
import { normName } from './data.ts'
import { embed, log } from './helpers.ts'

// ───────────────────────── /wiki ─────────────────────────

export async function wikiApi(params: Record<string, string>, timeoutMs = 8000): Promise<any> {
  const u = new URL(WIKI + '/api.php')
  for (const [k, v] of Object.entries({ format: 'json', ...params })) u.searchParams.set(k, v)
  const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) })
  if (!r.ok) throw new Error(`wiki ${r.status}`)
  return r.json()
}

export async function wikiLookup(q: string): Promise<EmbedBuilder | null> {
  const s = await wikiApi({ action: 'query', list: 'search', srsearch: q, srlimit: '6', srwhat: 'text' })
  let titles: string[] = (s.query?.search ?? []).map((x: any) => x.title)
  // Prefer an exact or near-exact title match.
  const exact = await wikiApi({ action: 'opensearch', search: q, limit: '1' }).catch(() => null)
  const ex = exact?.[1]?.[0]
  if (ex && normName(ex) === normName(q)) titles = [ex, ...titles.filter(t => t !== ex)]
  if (!titles.length) return null
  const [p, parsed, toc] = await Promise.all([
    wikiApi({ action: 'query', prop: 'extracts|pageimages', exintro: '1', explaintext: '1', exchars: '1400', piprop: 'thumbnail', pithumbsize: '400', titles: titles[0], redirects: '1' }),
    wikiApi({ action: 'parse', page: titles[0], prop: 'wikitext', section: '0', redirects: '1' }).catch(() => null),
    wikiApi({ action: 'parse', page: titles[0], prop: 'sections', redirects: '1' }).catch(() => null),
  ])
  const page: any = Object.values(p.query?.pages ?? {})[0]
  const title = page?.title ?? titles[0]
  const e = embed(title)
    .setURL(wikiUrl(title))
    .setDescription(clip((page?.extract || 'No summary available. Please open the page.').replace(/\n{2,}/g, '\n\n').trim(), 1500))
  if (page?.thumbnail?.source) e.setThumbnail(page.thumbnail.source)
  // Key facts from the page's infobox, when it has one.
  const wt = String(parsed?.parse?.wikitext?.['*'] ?? '')
  const FACTS: [string, string][] = [
    ['race', 'Race'],
    ['affiliation', 'Affiliation'],
    ['occupation', 'Occupation'],
    ['birthplace', 'Birthplace'],
    ['status', 'Status'],
    ['type', 'Type'],
    ['leader', 'Leader'],
    ['part', 'Part of'],
    ['grade', 'Class'],
    ['damage', 'Damage'],
    ['appearance', 'Appears in'],
  ]
  const field = (k: string) => {
    const m = new RegExp(`\\n\\s*\\|\\s*${k}\\s*=([\\s\\S]*?)(?=\\n\\s*\\||\\}\\})`, 'i').exec(wt)
    if (!m) return ''
    return m[1]
      .replace(/<ref[\s\S]*?(<\/ref>|\/>)/g, '')
      .replace(/\{\{Collapsible[^{}]*?content=/gi, '')
      .replace(/\}\}/g, '')
      .replace(/\{\{[^{}]*\|text=([^|}]*)[^{}]*\}\}/g, '$1')
      .replace(/\{\{[^{}]*\}\}/g, '')
      .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
      .replace(/''+/g, '')
      .split(/\n\s*\*+\s*|\n/)
      .map(x => x.replace(/^\*+\s*/, '').trim())
      .filter(Boolean)
      .slice(0, 4)
      .join(', ')
      .replace(/^[,\s]+/, '')
  }
  const facts = FACTS.map(([k, label]) => [label, field(k)] as const).filter(([, v]) => v && v.length < 200)
  if (facts.length) e.addFields({ name: 'Profile', value: clip(facts.map(([l, v]) => `**${l}:** ${v}`).join('\n'), 1024) })
  const secs = (toc?.parse?.sections ?? []).filter((x: any) => x.toclevel === 1 && !/^(References|Navigation|Notes|Gallery|Trivia)$/i.test(x.line)).slice(0, 10)
  if (secs.length) e.addFields({ name: 'On this page', value: clip(secs.map((x: any) => `[${x.line.replace(/<[^>]+>/g, '')}](${wikiUrl(title)}#${encodeURIComponent(x.anchor)})`).join(' · '), 1024) })
  const more = titles.slice(1, 6).map(t => `[${t}](${wikiUrl(t)})`)
  if (more.length) e.addFields({ name: 'Other results', value: more.join(' · ') })
  e.setFooter({ text: `${FOOTER} · arknights.wiki.gg` })
  return e
}

export async function cmdWiki(i: ChatInputCommandInteraction, eph: boolean) {
  const q = i.options.getString('query', true)
  await i.deferReply({ flags: ephFlag(eph) })
  try {
    const e = await wikiLookup(q)
    if (!e) return i.editReply({ content: `[PRTS] The wiki has no record matching "${clip(q, 80)}".` })
    return i.editReply({ embeds: [e] })
  } catch (err) {
    log(`wiki: ${err}`)
    return i.editReply({ content: `[PRTS] The wiki did not respond. Please try again, or search directly: ${WIKI}/index.php?search=${encodeURIComponent(q)}` })
  }
}
