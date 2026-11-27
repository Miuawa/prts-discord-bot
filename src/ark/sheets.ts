import { UA } from '../common.ts'
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync, renameSync, utimesSync } from 'fs'
import { join } from 'path'
import { DATA_DIR } from '../paths.ts'
import { normName } from './data.ts'
import { log } from './helpers.ts'

const SHEETS = join(DATA_DIR, 'sheets')

// ───────────────────────── spreadsheets ─────────────────────────
// The community sheets change often, so the bot pulls them live from Google
// every 6 hours (per-tab CSV export, no images) and rewrites the local .txt
// copies in the data folder. The saved copy is the fallback when Google fails.
// The first run creates each file from the tab list below.

const SHEET_SOURCES: { file: string; id: string; tabs: string[] }[] = [
  {
    file: 'tier-list-aktierlist.txt',
    id: '1E7HmgKWiV8pKpJpvpVzziYxnaQTP01Vtw_PXEdL7XPA',
    tabs: [
      'Introduction',
      'The Tier List',
      'The Tier List - Large Size',
      'Newest Additions - Updated Octo',
      'Revisions',
      'Log',
      'The Tier List - Compressed',
      'Vanguards by Archetype',
      'Vanguards Template',
      'Guards Template',
      'Defenders Template',
      'Snipers Template',
      'Casters Template',
      'Medics Template',
      'Supporters Template',
      'Specialists Template',
    ],
  },
  { file: 'module-ratings-dragongjy.txt', id: '1A0_0XTAcDDtHkvyAwjTqEEzM8cf5h3E60u23ZVXw4eg', tabs: ['Module Ratings', 'Lower Rarities Modules', 'Changelog'] },
  {
    file: 'peteryr-farming.txt',
    id: '1RRiTIYVUNUf-xW8ljAJdYEOuSo23lpjHkPa0-zuC_4k',
    tabs: [
      'Farming Summary',
      'About',
      'Changelog',
      '• Rock',
      '• Sugar',
      '• Ester',
      '• Oriron',
      '• Keton',
      '• Device',
      '• Kohl',
      '• Manganese',
      '• Grindstone',
      '• RMA',
      '• Gel',
      '• Alloy',
      '• Crystal',
      '• Solvent',
      '• Fluid',
      '• Salt',
      '• Fiber',
      '• Cyclicene',
      '• Nodule',
      '• CN Gas Thing',
      '• CN Power Thing',
      'Data',
      'import',
    ],
  },
  {
    file: 'riic-base-skills.txt',
    id: '1zYc2JU46X0XWmV7s1503bN4feRdOMa1eehrTQ2jGaiE',
    tabs: ['MAIN', 'INFO', 'QOL', 'NEW', 'NOOB', 'SPECIAL', 'CC', 'FAC', 'TP', 'PP', 'RR', 'WS', 'HR', 'TR', 'RS', 'DORM', 'BIN', 'op', 'riicdetails'],
  },
]
const SHEET_REFRESH_MS = 6 * 3600 * 1000

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [],
    cell = '',
    q = false
  for (let k = 0; k < text.length; k++) {
    const ch = text[k]
    if (q) {
      if (ch === '"') {
        if (text[k + 1] === '"') {
          cell += '"'
          k++
        } else q = false
      } else cell += ch
    } else if (ch === '"') q = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else if (ch !== '\r') cell += ch
  }
  if (cell || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

async function fetchTab(id: string, tab: string): Promise<string[]> {
  const u = `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&headers=0&sheet=${encodeURIComponent(tab)}`
  const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60_000) })
  if (!r.ok) throw new Error(`${r.status}`)
  const t = await r.text()
  if (t.trimStart().startsWith('<')) throw new Error('not CSV (sheet private or tab missing)')
  return parseCsv(t)
    .map(row =>
      row
        .map(c => c.trim().replace(/\s*\n\s*/g, ' '))
        .filter(Boolean)
        .join(' | '),
    )
    .filter(Boolean)
}

async function refreshSheet(src: { file: string; id: string; tabs: string[] }): Promise<void> {
  const path = join(SHEETS, src.file)
  mkdirSync(SHEETS, { recursive: true })
  const old = existsSync(path) ? readFileSync(path, 'utf8') : src.tabs.map(t => `=== SHEET: ${t}`).join('\n')
  const tabs: { name: string; lines: string[] }[] = []
  for (const line of old.split(/\r?\n/)) {
    const m = /^=== SHEET: (.*)$/.exec(line)
    if (m) tabs.push({ name: m[1].trim(), lines: [] })
    else if (tabs.length && line.trim()) tabs[tabs.length - 1].lines.push(line)
  }
  if (!tabs.length) return
  // An unknown tab name makes Google return the first tab, so compare to it.
  const first = await fetchTab(src.id, tabs[0].name)
  let changed = 0
  for (const [n, tab] of tabs.entries()) {
    try {
      const lines = n === 0 ? first : await fetchTab(src.id, tab.name)
      if (!lines.length || (n > 0 && lines.join('\n') === first.join('\n'))) continue
      if (lines.join('\n') !== tab.lines.join('\n')) {
        tab.lines = lines
        changed++
      }
    } catch (e) {
      log(`sheet ${src.file} tab "${tab.name}": ${e}`)
    }
  }
  if (changed) {
    writeFileSync(path + '.tmp', tabs.map(t => `\n=== SHEET: ${t.name}\n${t.lines.join('\n')}\n`).join(''))
    renameSync(path + '.tmp', path)
  } else utimesSync(path, new Date(), new Date()) // mark as checked
  log(`sheet ${src.file}: ${changed} tab(s) updated`)
}

let refreshing = false
export async function refreshSheets(): Promise<void> {
  if (refreshing) return
  refreshing = true
  try {
    for (const s of SHEET_SOURCES) await refreshSheet(s).catch(e => log(`sheet ${s.file}: ${e}`))
  } finally {
    refreshing = false
  }
}
if (process.env.PRTS_NO_SHEET_REFRESH !== '1') {
  setTimeout(() => void refreshSheets(), 20_000).unref()
  setInterval(() => void refreshSheets(), SHEET_REFRESH_MS).unref()
}

export type Sheets = {
  mtime: number
  tiers: { tier: string; names: string[] }[]
  tierOf: Map<string, string[]> // normName(base name) -> tier labels with notes
  classOf: Map<string, string>
  modules: Map<string, string[][]> // normName(op) -> rows
  farm: Map<string, { label: string; rows: [string, number, number][] }>
  teams: { title: string; facility: string; members: string; desc: string; effect: string; tokens: Set<string> }[]
  notes: Map<string, { facilities: string; text: string; partners: string }>
  /** The sheet's write-ups for recently added or re-graded operators: normName -> grade change and reasoning. */
  tierNotes: Map<string, { change: string; text: string; update: string }>
  /** The sheet's revision log, newest first. */
  revisions: { date: string; text: string }[]
}
let sheets: Sheets | null = null

const TIER_RE = /^(EX|S\+|S|S-|A\+|A|A-|B\+|B|B-|C\+|C|C-|D\+|D|D-)$/
const RIIC_FACILITY: Record<string, string> = {
  SPECIAL: 'Multi-facility',
  CC: 'Control Center',
  FAC: 'Factory',
  TP: 'Trading Post',
  PP: 'Power Plant',
  RR: 'Reception Room',
  WS: 'Workshop',
  HR: 'Office',
  TR: 'Training Room',
  DORM: 'Dormitory',
  NOOB: 'Beginner',
}
export const RIIC_URL = 'https://docs.google.com/spreadsheets/d/1zYc2JU46X0XWmV7s1503bN4feRdOMa1eehrTQ2jGaiE/edit'
export const FARM_ALIAS: Record<string, string> = {
  Rock: 'Orirock',
  Ester: 'Polyester',
  Keton: 'Polyketon',
  Kohl: 'Loxic Kohl',
  Manganese: 'Manganese Ore',
  RMA: 'RMA70-12',
  Gel: 'Coagulating Gel',
  Alloy: 'Incandescent Alloy',
  Crystal: 'Crystalline Component',
  Solvent: 'Semi-Synthetic Solvent',
  Fluid: 'Compound Cutting Fluid',
  Salt: 'Transmuted Salt',
  Fiber: 'Fuscous Fiber',
}

function readSheetTabs(file: string): Map<string, string[]> {
  const tabs = new Map<string, string[]>()
  let cur: string[] | null = null
  for (const line of readFileSync(join(SHEETS, file), 'utf8').split(/\r?\n/)) {
    const m = /^=== SHEET: (.*)$/.exec(line)
    if (m) {
      cur = []
      tabs.set(m[1].trim(), cur)
      continue
    }
    if (cur && line.trim()) cur.push(line)
  }
  return tabs
}

export const baseOpName = (s: string) => normName(s.replace(/\s*\([^)]*\)\s*$/, ''))

export function loadSheets(): Sheets | null {
  const files = ['tier-list-aktierlist.txt', 'module-ratings-dragongjy.txt', 'peteryr-farming.txt', 'riic-base-skills.txt']
  let mtime = 0
  try {
    for (const f of files) mtime = Math.max(mtime, statSync(join(SHEETS, f)).mtimeMs)
  } catch {
    return sheets
  }
  if (sheets && sheets.mtime === mtime) return sheets
  const s: Sheets = { mtime, tiers: [], tierOf: new Map(), classOf: new Map(), modules: new Map(), farm: new Map(), teams: [], notes: new Map(), tierNotes: new Map(), revisions: [] }
  try {
    const tl = readSheetTabs(files[0])
    let cur: { tier: string; names: string[] } | null = null
    for (const line of tl.get('The Tier List') ?? []) {
      const t = line.trim()
      if (TIER_RE.test(t)) {
        cur = { tier: t, names: [] }
        s.tiers.push(cur)
        continue
      }
      if (!cur) continue
      for (const n of t
        .split(' | ')
        // The sheet writes some names as "Kal'tsit· Esperanta".
        .map(x => x.trim().replace(/(\S)·\s*/g, '$1 '))
        .filter(Boolean)) {
        cur.names.push(n)
        const note = /\(([^)]*)\)\s*$/.exec(n)?.[1]
        const k = baseOpName(n)
        s.tierOf.set(k, [...(s.tierOf.get(k) ?? []), note ? `${cur.tier} (${note})` : cur.tier])
      }
    }
    for (const [tab, lines] of tl) {
      if (/^Newest Additions/.test(tab)) {
        const update = (lines.find(l => /^Update\b/.test(l)) ?? '').trim()
        for (const line of lines) {
          const f = line.split(' | ').map(x => x.trim())
          if (f.length < 5 || f[0] === 'Name' || !/★/.test(f[1])) continue
          s.tierNotes.set(baseOpName(f[0].replace(/(\S)·\s*/g, '$1 ')), { change: f[3], text: f.slice(4).join(' | '), update })
        }
      }
      if (tab === 'Revisions') {
        let last = ''
        for (const line of lines) {
          const m = /^([A-Z][a-z]{2} \d{1,2}, \d{4}) \| (.*)$/.exec(line.trim())
          if (m) last = m[1]
          const text = m ? m[2] : line.trim()
          if (text) s.revisions.push({ date: m ? m[1] : last, text })
        }
      }
    }
    for (const [tab, lines] of tl) {
      const m = /^(\w+?)s? Template$/.exec(tab)
      if (!m) continue
      const cls = m[1]
      for (const line of lines.slice(1)) if (!TIER_RE.test(line.trim())) for (const n of line.split(' | ')) if (n.trim()) s.classOf.set(baseOpName(n), cls)
    }
  } catch (e) {
    log(`tier sheet: ${e}`)
  }
  try {
    const mr = readSheetTabs(files[1])
    for (const tab of ['Module Ratings', 'Lower Rarities Modules']) {
      for (const line of mr.get(tab) ?? []) {
        const f = line.split(' | ')
        if (f.length < 10 || f[0] === 'Operator') continue
        const k = normName(f[0])
        s.modules.set(k, [...(s.modules.get(k) ?? []), f])
      }
    }
  } catch (e) {
    log(`module sheet: ${e}`)
  }
  try {
    const fm = readSheetTabs(files[2])
    // The sheet's Data tab names each material family's tier-3 item ("gas | liquefied high-energy gas"), so new
    // families get a proper name as soon as the sheet adds them, even while their tab is still "CN Gas Thing".
    const family = new Map<string, string>()
    for (const line of [...(fm.get('Data') ?? []), ...(fm.get('import') ?? [])]) {
      const f = line.split(' | ').map(x => x.trim())
      if (f.length >= 5 && /^[a-z][a-z ]*$/.test(f[3]) && /^[a-z][a-z0-9 -]+$/.test(f[4])) family.set(f[3], f[4].replace(/\b[a-z]/g, c => c.toUpperCase()).replace(/\bHigh-energy\b/, 'High-Energy'))
    }
    for (const [tab, lines] of fm) {
      if (!tab.startsWith('• ')) continue
      const raw = tab.slice(2).trim()
      // "CN Gas Thing" / "CN Power Thing" were placeholders; the sheet now calls them Gas and Electrode.
      const fam = raw.replace(/^CN\s+|\s+Thing$/gi, '').replace(/^Power$/i, 'Electrode')
      const key = fam
      const rows: [string, number, number][] = []
      for (const line of lines) {
        const f = line.split(' | ')
        const num = (x?: string) => (x == null ? NaN : x.trim().endsWith('%') ? parseFloat(x) / 100 : parseFloat(x))
        const eff = num(f[1])
        const drop = num(f[2])
        if (f.length >= 2 && /^[A-Z0-9]/.test(f[0]) && !isNaN(eff) && f[0] !== 'Stage') rows.push([f[0], eff, isNaN(drop) ? NaN : drop])
      }
      const full = FARM_ALIAS[key] ?? family.get(key.toLowerCase())
      const label = full && normName(full) !== normName(key) ? `${full} (${key})` : key
      const shopOnly = lines.some(l => /BUY FROM EVENT SHOPS/i.test(l))
      if (rows.length || shopOnly) s.farm.set(key, { label, rows })
    }
  } catch (e) {
    log(`farm sheet: ${e}`)
  }
  try {
    const rb = readSheetTabs(files[3])
    for (let [tab, lines] of rb) {
      const facility = RIIC_FACILITY[tab]
      if (!facility) continue
      // Teams come first; the WORKERS and BACK TO TOP sections after them are not part of the last team.
      const endAt = lines.findIndex(l => /^(WORKERS|BACK TO TOP)$/.test(l.trim()))
      if (endAt >= 0) lines = lines.slice(0, endAt)
      const starts: number[] = []
      lines.forEach((l, k) => {
        if (l.includes('| EFFECT: |') && k > 0) starts.push(k - 1)
      })
      starts.forEach((st, n) => {
        const block = lines.slice(st, starts[n + 1] ?? lines.length)
        const [d, eff = ''] = block[1].split('| EFFECT: |')
        // Members are "(A + B + C)" under the description, or a " | " list under the first facility row
        // ("CC", "PP | FAC | ..."). Other lines in parentheses are effect notes like "(Theoretical max)".
        const facRow = block.findIndex((l, k) => k >= 2 && /^(CC|FAC|TP|PP|RR|WS|HR|TR|RS|DORM)( \||$)/.test(l.trim()))
        const members = /^\(.*\+.*\)$/.test(block[2]?.trim() ?? '')
          ? block[2].trim().replace(/^\(|\)$/g, '')
          : facRow > 0 && block[facRow + 1] && !/[:"]/.test(block[facRow + 1])
            ? [...new Set(block[facRow + 1].split(/\s*\|\s*/).filter(t => t && !/^(or|and|[A-Z ]{4,})$/.test(t)))].join(', ')
            : ''
        const tokens = new Set<string>()
        for (const l of block) for (const t of l.split(/\s*(?:\||\+|,|\(|\))\s*/)) if (t) tokens.add(normName(t))
        s.teams.push({ title: block[0].trim(), facility, members, desc: d.trim(), effect: eff.replace(/\s*\|\s*/g, ' ').trim(), tokens })
      })
    }
    for (const tab of ['NEW', 'BIN']) {
      const lines = rb.get(tab) ?? []
      for (let k = 1; k + 1 < lines.length; k++) {
        if (!lines[k].includes('| PERSONAL THOUGHTS')) continue
        const key = normName(lines[k - 1])
        if (s.notes.has(key)) continue
        const [text, ...partners] = lines[k + 1].split(' | ')
        s.notes.set(key, { facilities: lines[k].split(' | PERSONAL')[0], text: text.trim(), partners: partners.join(', ') })
      }
    }
  } catch (e) {
    log(`riic sheet: ${e}`)
  }
  sheets = s
  return s
}

export function sheetDate(file: string): string {
  try {
    return new Date(statSync(join(SHEETS, file)).mtimeMs).toISOString().slice(0, 10)
  } catch {
    return 'unknown'
  }
}
