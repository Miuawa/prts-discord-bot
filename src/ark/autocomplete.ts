import { clip } from '../common.ts'
import { type AutocompleteInteraction } from 'discord.js'
import { data, ensureData, findOps, normName } from './data.ts'
import { getItems, itemTable, myrtleSearch, tag } from './myrtle.ts'
import { type Sheets, loadSheets } from './sheets.ts'
import { type Outfit, getOutfits } from './skin.ts'
import { loadStories } from './story.ts'
import { wikiApi } from './wiki.ts'

// Discord drops autocomplete answers after 3 seconds, so web lookups give up sooner.
const AUTOCOMPLETE_TIMEOUT_MS = 2500

type Choice = { name: string; value: string }

// Pre-normalized lists, rebuilt only when the game data or the sheets change,
// so a keystroke is a plain filter instead of re-normalizing every entry.
let tagKeys: { of: unknown; list: [string, string][] } | null = null
function recruitTagKeys(): [string, string][] {
  if (!data) return []
  if (tagKeys?.of !== data) tagKeys = { of: data, list: data.recruitTags.map(t => [normName(t), t] as [string, string]) }
  return tagKeys.list
}
let teamKeys: { of: unknown; list: [string, Choice][] } | null = null
function teamChoices(sh: Sheets): [string, Choice][] {
  if (teamKeys?.of !== sh)
    teamKeys = { of: sh, list: sh.teams.map(t => [normName(`${t.title} ${t.members}`), { name: clip(`${t.title} · ${t.facility}`, 100), value: clip(t.title, 100) }] as [string, Choice]) }
  return teamKeys.list
}
let matKeys: { of: unknown; list: [string, Choice][] } | null = null
function materialChoices(sh: Sheets): [string, Choice][] {
  if (matKeys?.of !== sh) matKeys = { of: sh, list: [...sh.farm.values()].map(m => [normName(m.label), { name: m.label, value: m.label.replace(/ \(.*\)$/, '') }] as [string, Choice]) }
  return matKeys.list
}

// Web-backed suggestions are remembered for a few minutes, so retyping or
// backspacing does not repeat the request.
const webSuggest = new Map<string, { at: number; choices: Choice[] }>()
async function cachedSuggest(key: string, load: () => Promise<Choice[]>): Promise<Choice[]> {
  const hit = webSuggest.get(key)
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.choices
  const choices = await load()
  if (choices.length) {
    if (webSuggest.size > 500) webSuggest.clear()
    webSuggest.set(key, { at: Date.now(), choices })
  }
  return choices
}

export async function handleArkAutocomplete(i: AutocompleteInteraction): Promise<void> {
  const f = i.options.getFocused(true)
  const q = String(f.value ?? '')
  let choices: Choice[] = []
  ensureData()
  if (i.commandName === 'story' && f.name === 'query') {
    const n = q.trim().toLowerCase()
    const seen = new Set<string>()
    for (const s of loadStories().slice().reverse()) {
      const group = s.kind === 'record' ? '' : s.group_name
      const cands = [group, s.code ? `${s.code} ${s.name}` : s.kind === 'record' ? '' : s.name]
      for (const c of cands) {
        if (!c || seen.has(c) || (n && !c.toLowerCase().includes(n))) continue
        seen.add(c)
        choices.push({ name: clip(c === group ? `${c} (whole story)` : `${c} · ${s.group_name}`, 100), value: clip(c === group ? c : s.code || s.name, 100) })
      }
      if (choices.length >= 25) break
    }
  } else if (f.name === 'name' || f.name === 'operator') {
    const ops = findOps(q)
    choices = ops.slice(0, 25).map(o => ({ name: `${o.name} · ${o.rarity}★ ${o.cls}`, value: o.name }))
  } else if (f.name === 'team') {
    const sh = loadSheets()
    const n = normName(q)
    if (sh)
      choices = teamChoices(sh)
        .filter(([k]) => !n || k.includes(n))
        .slice(0, 25)
        .map(x => x[1])
  } else if (i.commandName === 'myrtle' && f.name === 'item') {
    // The item table loads once a day; until it is in memory, suggest nothing rather than wait.
    const n = q.trim().toLowerCase()
    const items = itemTable?.items
    if (!items) void getItems().catch(() => {})
    const seen = new Set<string>()
    for (const it of Object.values<any>(items ?? {})) {
      const name = String(it?.name ?? '')
      if (!name || seen.has(name) || (n && !name.toLowerCase().includes(n))) continue
      seen.add(name)
      choices.push({ name: clip(name, 100), value: clip(name, 60) })
      if (choices.length >= 25) break
    }
  } else if (f.name === 'material') {
    const sh = loadSheets()
    const n = normName(q)
    if (sh)
      choices = materialChoices(sh)
        .filter(([k]) => !n || k.includes(n))
        .slice(0, 25)
        .map(x => x[1])
  } else if (f.name === 'tags') {
    // Comma-separated: complete the last tag, keep the ones already typed.
    const parts = q.split(',')
    const last = normName(parts.pop() ?? '')
    const done = parts.map(x => x.trim()).filter(Boolean)
    const taken = new Set(done.map(normName))
    const prefix = done.length ? `${done.join(', ')}, ` : ''
    choices =
      done.length >= 5
        ? []
        : recruitTagKeys()
            .filter(([k]) => (!last || k.includes(last)) && !taken.has(k))
            .slice(0, 25)
            .map(([, t]) => ({ name: clip(prefix + t, 100), value: clip(prefix + t, 150) }))
  } else if (f.name === 'outfit' && i.commandName === 'skin') {
    const op = findOps(i.options.getString('operator') ?? '', 1)[0]
    if (op) {
      const n = normName(q)
      // The first load needs two web requests; give up in time and let it finish in the background for the next keystroke.
      const list = await Promise.race([getOutfits(op.id).catch(() => [] as Outfit[]), new Promise<Outfit[]>(r => setTimeout(() => r([]), AUTOCOMPLETE_TIMEOUT_MS))])
      choices = list
        .filter(o => !n || normName(o.name).includes(n) || normName(o.line).includes(n))
        .slice(0, 25)
        .map(o => ({ name: clip(`${o.name}${o.line ? ' · ' + o.line : ''}${o.animated ? ' · animated' : ''}`, 100), value: clip(o.name, 100) }))
    }
  } else if (f.name === 'player' && i.commandName === 'myrtle') {
    const name = q.trim().replace(/#\d*$/, '')
    if (name.length >= 2 && !/^\d+$/.test(name) && !/myrtle\.moe/i.test(name)) {
      choices = await cachedSuggest(`myrtle:${name.toLowerCase()}`, async () => {
        const r = await myrtleSearch(name, 25, AUTOCOMPLETE_TIMEOUT_MS).catch(() => null)
        return (r?.entries ?? []).map(u => ({ name: clip(`${tag(u)} · ${u.server} · Lv${u.level} · ${u.grade ?? '?'}`, 100), value: u.uid }))
      })
    }
  } else if (f.name === 'query' && i.commandName === 'wiki' && q.trim().length >= 2) {
    choices = await cachedSuggest(`wiki:${q.trim().toLowerCase()}`, async () => {
      const r = await wikiApi({ action: 'opensearch', search: q, limit: '10' }, AUTOCOMPLETE_TIMEOUT_MS).catch(() => null)
      return (r?.[1] ?? []).slice(0, 25).map((t: string) => ({ name: clip(t, 100), value: clip(t, 100) }))
    })
  }
  await i.respond(choices).catch(() => {})
}
