// Module (uniequip) effects from the game's battle_equip_table, turned into short plain text
// for the /operator card. Pure functions only, so they can be tested without the network.

export type ModuleEffect = {
  /** Stage 1 trait change, as the game shows it: a new trait text, or a line added to the old one. */
  trait?: { kind: 'replace' | 'add'; text: string }
  /** Stat bonus per stage (index 0 = stage 1), e.g. [{atk:50, attack_speed:5}, ...]. */
  stats: Record<string, number>[]
  /** Talent the module improves at stages 2 and 3 (stage 3 text, potential 1). */
  talents: { name: string; text: string }[]
  /** "Elite 2, Lv. 60" */
  unlock?: string
}

const STAT_NAME: Record<string, string> = {
  max_hp: 'Max HP',
  atk: 'ATK',
  def: 'DEF',
  magic_resistance: 'RES',
  attack_speed: 'ATK speed',
  cost: 'DP cost',
  respawn_time: 'Redeploy time',
  block_cnt: 'Block',
}
const STAT_ORDER = Object.keys(STAT_NAME)

type Board = { key: string; value: number; valueStr?: string | null }[] | null | undefined

/** Fills `{key}`, `{key:0%}` and `{key:0}` from a blackboard, and removes the game's colour tags. */
export function fillTemplate(text: string, board: Board): string {
  const vals = new Map((Array.isArray(board) ? board : []).filter(b => b?.key).map(b => [b.key.toLowerCase(), b]))
  return text
    .replace(/\{(-?)([\w@.[\]]+)(?::([\w.%]+))?\}/g, (whole, neg: string, key: string, fmt?: string) => {
      const b = vals.get(key.toLowerCase())
      if (!b) return whole
      if (b.value == null && b.valueStr) return b.valueStr
      const v = neg ? -b.value : b.value
      if (fmt?.endsWith('%')) return `${+(v * 100).toFixed(1)}%`
      return `${+v.toFixed(2)}`
    })
    .replace(/<[@$][^>]*>|<\/>/g, '')
    .replace(/\\n|\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Reads one module from battle_equip_table.json. Returns null when the module has no battle data. */
export function parseModule(raw: any): ModuleEffect | null {
  const phases: any[] = Array.isArray(raw?.phases) ? raw.phases : []
  if (!phases.length) return null
  const out: ModuleEffect = { stats: [], talents: [] }
  for (const ph of phases) {
    const s: Record<string, number> = {}
    for (const a of ph.attributeBlackboard ?? []) if (a?.key && a.value) s[a.key] = a.value
    out.stats.push(s)
  }
  // Trait: DISPLAY is what the game shows when it differs from the battle TRAIT data.
  const first = phases[0]?.parts ?? []
  const traitPart = ['DISPLAY', 'TRAIT', 'TRAIT_DATA_ONLY'].map(t => first.find((p: any) => p.target === t && !p.isToken && p.overrideTraitDataBundle?.candidates?.length)).find(Boolean)
  const tc = (traitPart?.overrideTraitDataBundle?.candidates ?? []).find((c: any) => !c.requiredPotentialRank) ?? traitPart?.overrideTraitDataBundle?.candidates?.[0]
  const uc = tc?.unlockCondition
  if (uc?.phase) out.unlock = `Elite ${/\d/.exec(uc.phase)?.[0] ?? '2'}, Lv. ${uc.level ?? 1}`
  if (tc) {
    if (tc.additionalDescription) out.trait = { kind: 'add', text: fillTemplate(tc.additionalDescription, tc.blackboard) }
    else if (tc.overrideDescripton) out.trait = { kind: 'replace', text: fillTemplate(tc.overrideDescripton, tc.blackboard) }
  }
  // Talents: the last stage, potential 1 (no potential bonus), one line per talent.
  const last = phases[phases.length - 1]?.parts ?? []
  const seen = new Set<string>()
  for (const p of last) {
    if (p.isToken || !/^TALENT/.test(p.target ?? '')) continue
    for (const c of p.addOrOverrideTalentDataBundle?.candidates ?? []) {
      if (c.requiredPotentialRank || c.isHideTalent) continue
      const text = c.upgradeDescription || c.description
      if (!text) continue
      const name = c.name ?? 'Talent'
      if (seen.has(name)) continue
      seen.add(name)
      out.talents.push({ name, text: fillTemplate(text, c.blackboard) })
    }
  }
  return out
}

/** "ATK +50 → +80 · ATK speed +5 → +7" (stage 1 → last stage). */
export function statLine(stats: Record<string, number>[]): string {
  if (!stats.length) return ''
  const a = stats[0],
    z = stats[stats.length - 1]
  const keys = [...new Set([...Object.keys(a), ...Object.keys(z)])].sort((x, y) => idx(x) - idx(y))
  const sign = (k: string, v: number) => {
    const n = +v.toFixed(2)
    const t = `${n > 0 ? '+' : ''}${n}`
    return k === 'respawn_time' ? `${t}s` : t
  }
  return keys
    .map(k => {
      const v1 = a[k] ?? 0,
        v3 = z[k] ?? 0
      return `${STAT_NAME[k] ?? k} ${v1 === v3 ? sign(k, v3) : `${sign(k, v1)} → ${sign(k, v3)}`}`
    })
    .join(' · ')
}
const idx = (k: string) => (STAT_ORDER.includes(k) ? STAT_ORDER.indexOf(k) : 99)

/** Grades from the DragonGJY sheet in words. */
export function gradeWord(g?: string): string {
  const t = (g ?? '').trim().toUpperCase()
  if (!t || t === '-') return ''
  const base = t[0]
  const word = base === 'S' ? 'outstanding' : base === 'A' ? 'strong' : base === 'B' ? 'decent' : base === 'C' ? 'weak' : base === 'D' ? 'poor' : ''
  return word ? `${word} (${t})` : t
}

/** "LEVEL 1+" -> what to do with it, in plain words. */
export function recLevel(lv?: string): string {
  const m = /(\d)\s*(\+?)/.exec(lv ?? '')
  if (!m) return ''
  const n = +m[1]
  if (n === 0) return 'not a priority to unlock'
  if (n === 3) return 'worth taking to stage 3'
  return m[2] ? `stage ${n} is the key step, higher stages are a smaller extra` : `stage ${n} is enough`
}
