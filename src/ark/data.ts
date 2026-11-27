import { GAMEDATA, UA } from '../common.ts'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { CACHE_DIR } from '../paths.ts'
import { type ModuleEffect, fillTemplate, parseModule } from '../equip.ts'
import { TIMO, log } from './helpers.ts'

const CACHE_FILE = join(CACHE_DIR, 'arkdata.json')
const CACHE_MAX_AGE_MS = 3 * 24 * 3600 * 1000

// ───────────────────────── game data ─────────────────────────

const CLASS: Record<string, string> = {
  PIONEER: 'Vanguard',
  WARRIOR: 'Guard',
  TANK: 'Defender',
  SNIPER: 'Sniper',
  CASTER: 'Caster',
  MEDIC: 'Medic',
  SUPPORT: 'Supporter',
  SPECIAL: 'Specialist',
}

export type Op = {
  id: string
  name: string
  rarity: number
  cls: string
  branch: string
  faction: string
  pos: string
  tags: string[]
  usage: string
  desc: string
  modules: OpModule[]
  recruit: boolean
  base: { name: string; room: string; unlock: string; desc: string }[]
  /** Class trait at the highest promotion (before modules). */
  trait?: string
  /** Names of summons and deployables (displayTokenDict). */
  summons?: string[]
  /** "Recruitment & Headhunting" etc., from the game data. */
  obtain?: string
  /** Ids of the same character's other versions (alters), from char_meta_table. */
  alts?: string[]
  /** Class forms the operator can switch between (Amiya: Caster, Guard, Medic). */
  forms?: string[]
}
/** A module from uniequip_table, with its effects from battle_equip_table when known. */
export type OpModule = { name: string; type: string; id?: string; unlock?: string; form?: string; fx?: ModuleEffect }
const DATA_VERSION = 8
type ArkData = {
  version: number
  builtAt: number
  ops: Op[]
  recruitTags: string[]
  timoGroups: Record<string, string>
  timoOps: Record<string, string>
}

export let data: ArkData | null = null
let building: Promise<void> | null = null

async function getJson(url: string): Promise<any> {
  // A hung download would keep `building` set forever and block every refresh.
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(180_000) })
  if (!r.ok) throw new Error(`${r.status} ${url}`)
  return r.json()
}

export const stripRich = (s: string) =>
  (s ?? '')
    .replace(/<[@$/][^>]*>|<\/>/g, '')
    .replace(/\\n/g, ' ')
    .trim()
export const normName = (s: string) =>
  s
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[‘’'"`·.\-–]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

async function buildData(): Promise<void> {
  log('building game data cache...')
  const [chars, equip, battleEquip, patch, meta, teams, gacha, routes, building] = await Promise.all([
    getJson(GAMEDATA + 'character_table.json'),
    getJson(GAMEDATA + 'uniequip_table.json'),
    getJson(GAMEDATA + 'battle_equip_table.json').catch(e => (log(`battle_equip_table: ${e}`), {})),
    getJson(GAMEDATA + 'char_patch_table.json').catch(() => ({ patchChars: {} })),
    getJson(GAMEDATA + 'char_meta_table.json').catch(() => ({ spCharGroups: {} })),
    getJson(GAMEDATA + 'handbook_team_table.json'),
    getJson(GAMEDATA + 'gacha_table.json'),
    getJson(TIMO + '/json/routes.json').catch(() => ({ groups: {}, ops: {} })),
    getJson(GAMEDATA + 'building_data.json').catch(() => ({ chars: {}, buffs: {} })),
  ])
  const ROOM: Record<string, string> = {
    CONTROL: 'Control Center',
    MANUFACTURE: 'Factory',
    TRADING: 'Trading Post',
    POWER: 'Power Plant',
    MEETING: 'Reception Room',
    WORKSHOP: 'Workshop',
    HIRE: 'Office',
    TRAINING: 'Training Room',
    DORMITORY: 'Dormitory',
  }
  const baseOf = (id: string) => {
    const out: Op['base'] = []
    const slots = building.chars?.[id]?.buffChar
    for (const slot of Array.isArray(slots) ? slots : [])
      for (const b of Array.isArray(slot?.buffData) ? slot.buffData : []) {
        const buff = building.buffs?.[b.buffId]
        if (!buff) continue
        const ph = /PHASE_(\d)/.exec(b.cond?.phase ?? '')?.[1] ?? '0'
        const lv = b.cond?.level > 1 ? ` Lv${b.cond.level}` : ''
        out.push({ name: buff.buffName, room: ROOM[buff.roomType] ?? buff.roomType, unlock: `E${ph}${lv}`, desc: stripRich(buff.description) })
      }
    return out
  }
  const sub = equip.subProfDict ?? {}
  const modsByChar: Record<string, (OpModule & { order: number })[]> = {}
  for (const e of Object.values<any>(equip.equipDict ?? {})) {
    if (!e.charId || e.typeName1 === 'ORIGINAL') continue
    const fx = parseModule(battleEquip[e.uniEquipId]) ?? undefined
    const ph = /\d/.exec(e.unlockEvolvePhase ?? '')?.[0]
    const unlock = ph ? `Elite ${ph}, Lv. ${e.unlockLevel ?? 1}` : fx?.unlock
    // Amiya's Guard and Medic forms keep their modules under the base Amiya (tmplId names the form).
    const tmpl = e.tmplId && e.tmplId !== e.charId ? (patch.patchChars?.[e.tmplId] ?? chars[e.tmplId]) : null
    const form = tmpl ? `${CLASS[tmpl.profession] ?? sub[tmpl.subProfessionId]?.subProfessionName ?? 'other'} form` : undefined
    ;(modsByChar[e.charId] ??= []).push({
      name: e.uniEquipName,
      type: `${e.typeName1}-${e.typeName2}`,
      id: e.uniEquipId,
      unlock,
      form,
      fx,
      order: (form ? 100 : 0) + (e.charEquipOrder ?? 9),
    })
  }
  for (const list of Object.values(modsByChar)) list.sort((a, b) => a.order - b.order)
  // Recruitable pool, from the in-game "All Possible Operators" text.
  const pool = new Set<string>()
  for (const line of String(gacha.recruitDetail ?? '').split('\n')) {
    if (!line.includes(' / ') && !line.includes('<@rc.eml>')) continue
    if (line.includes('Operators displayed')) continue
    for (const n of stripRich(line).split(' / ')) if (n.trim()) pool.add(normName(n))
  }
  const altsOf: Record<string, string[]> = {}
  for (const group of Object.values<string[]>(meta.spCharGroups ?? {})) for (const id of group) altsOf[id] = group.filter(x => x !== id)
  const traitOf = (c: any): string | undefined => {
    const cands = c.trait?.candidates ?? []
    const last = cands[cands.length - 1]
    const text = last?.overrideDescripton || c.description
    return text ? fillTemplate(text, last?.blackboard) : undefined
  }
  const ops: Op[] = []
  for (const [id, c] of Object.entries<any>(chars)) {
    if (!id.startsWith('char_') || c.isNotObtainable || !CLASS[c.profession]) continue
    const rarity = typeof c.rarity === 'number' ? c.rarity + 1 : parseInt(String(c.rarity).replace(/\D/g, ''), 10) || 0
    const fac = c.teamId || c.groupId || c.nationId
    ops.push({
      id,
      name: c.name,
      rarity,
      cls: CLASS[c.profession],
      branch: sub[c.subProfessionId]?.subProfessionName ?? c.subProfessionId,
      faction: teams[fac]?.powerName ?? fac ?? '',
      pos: c.position === 'MELEE' ? 'Melee' : c.position === 'RANGED' ? 'Ranged' : '',
      tags: c.tagList ?? [],
      usage: stripRich(c.itemUsage),
      desc: stripRich(c.itemDesc),
      modules: modsByChar[id] ?? [],
      recruit: pool.has(normName(c.name)),
      base: baseOf(id),
      trait: traitOf(c),
      summons: [
        ...new Set(
          Object.keys(c.displayTokenDict ?? {})
            .map(t => chars[t]?.name)
            .filter(Boolean),
        ),
      ] as string[],
      obtain: stripRich(c.itemObtainApproach ?? '') || undefined,
      alts: altsOf[id] ?? [],
      forms: (patch.infos?.[id]?.tmplIds ?? []).map((t: string) => CLASS[(patch.patchChars?.[t] ?? chars[t])?.profession]).filter(Boolean),
    })
  }
  data = {
    version: DATA_VERSION,
    builtAt: Date.now(),
    ops,
    recruitTags: (gacha.gachaTags ?? []).map((t: any) => t.tagName).filter((t: string) => t && !/^(Male|Female)$/.test(t)),
    timoGroups: routes.groups ?? {},
    timoOps: routes.ops ?? {},
  }
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(CACHE_FILE, JSON.stringify(data))
  log(`game data cached: ${ops.length} operators, ${pool.size} recruitable`)
}

export function ensureData(): void {
  if (!data && existsSync(CACHE_FILE)) {
    try {
      data = JSON.parse(readFileSync(CACHE_FILE, 'utf8'))
    } catch {
      data = null
    }
  }
  if ((!data || data.version !== DATA_VERSION || Date.now() - data.builtAt > CACHE_MAX_AGE_MS) && !building) {
    building = buildData()
      .catch(e => {
        log(`data build failed: ${e}`)
      })
      .finally(() => {
        building = null
      })
  }
}
ensureData()
setInterval(ensureData, 6 * 3600 * 1000).unref()

// Lookups by id and by normalized name, rebuilt whenever `data` is replaced.
// Autocomplete runs findOps on every keystroke, so names are normalized once.
let index: { of: ArkData; byId: Map<string, Op>; byKey: Map<string, Op>; keyed: [string, Op][]; top: Op[] } | null = null
export function opIndex() {
  if (!data) return null
  if (index?.of !== data) {
    const keyed = data.ops.map(o => [normName(o.name), o] as [string, Op])
    index = {
      of: data,
      keyed,
      byId: new Map(data.ops.map(o => [o.id, o])),
      byKey: new Map(keyed.slice().reverse()), // first operator wins on duplicate names, like find()
      top: data.ops.slice().sort((a, b) => b.rarity - a.rarity || a.name.localeCompare(b.name)),
    }
  }
  return index
}

export function findOps(q: string, limit = 25): Op[] {
  const ix = opIndex()
  if (!ix) return []
  const n = normName(q)
  if (!n) return ix.top.slice(0, limit)
  const scored: [number, Op][] = []
  for (const [on, o] of ix.keyed) {
    const s = on === n ? 0 : on.startsWith(n) ? 1 : on.split(' ').some(w => w.startsWith(n)) ? 2 : on.includes(n) ? 3 : -1
    if (s >= 0) scored.push([s, o])
  }
  return scored
    .sort((a, b) => a[0] - b[0] || a[1].name.length - b[1].name.length)
    .slice(0, limit)
    .map(x => x[1])
}
