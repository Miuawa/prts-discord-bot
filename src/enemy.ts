// Enemy records for /enemy, built from the EN enemy handbook (excel/enemy_handbook_table.json)
// and the battle stats (levels/enemydata/enemy_database.json). Pure functions, so they can be
// tested without the network.

export type EnemyStats = {
  hp: number
  atk: number
  def: number
  res: number
  interval: number
  speed: number
  weight: number
  range: number
  lifePoints: number
  elementalRes: number
}
export type Enemy = {
  id: string
  index: string
  name: string
  level: string
  races: string[]
  damage: string[]
  attack: string
  flying: boolean
  desc: string
  note: string
  abilities: { title?: boolean; text: string }[]
  stats?: EnemyStats
  /** Levels 1 and up: the stronger versions some stages use. Only the values that differ from level 0. */
  stronger?: Partial<EnemyStats>[]
  immune: string[]
}

const LEVEL: Record<string, string> = { NORMAL: 'Normal', ELITE: 'Elite', BOSS: 'Leader' }
const DAMAGE: Record<string, string> = { PHYSIC: 'Physical', MAGIC: 'Arts', HEAL: 'Healing', NO_DAMAGE: 'No damage' }
const ATTACK: Record<string, string> = { MELEE: 'Melee', RANGED: 'Ranged', ALL: 'Melee and ranged', NONE: 'Does not attack' }
const IMMUNE: Record<string, string> = {
  stunImmune: 'Stun',
  silenceImmune: 'Silence',
  sleepImmune: 'Sleep',
  frozenImmune: 'Freeze',
  levitateImmune: 'Levitate',
  disarmedCombatImmune: 'Disarmed Combat',
  fearedImmune: 'Fear',
  palsyImmune: 'Paralysis',
  attractImmune: 'Attract',
}

const strip = (s: unknown) =>
  String(s ?? '')
    .replace(/<[@$/][^>]*>|<\/>/g, '')
    .replace(/\\n|\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

type Attr = Record<string, { m_defined?: boolean; m_value?: any }>
const val = (a: Attr | undefined, k: string): number | undefined => (a?.[k]?.m_defined ? Number(a[k].m_value) : undefined)

function statsOf(a: Attr | undefined, d: any): EnemyStats {
  return {
    hp: val(a, 'maxHp') ?? 0,
    atk: val(a, 'atk') ?? 0,
    def: val(a, 'def') ?? 0,
    res: val(a, 'magicResistance') ?? 0,
    interval: val(a, 'baseAttackTime') ?? 0,
    speed: val(a, 'moveSpeed') ?? 0,
    weight: val(a, 'massLevel') ?? 0,
    range: d?.rangeRadius?.m_defined ? Number(d.rangeRadius.m_value) : 0,
    lifePoints: d?.lifePointReduce?.m_defined ? Number(d.lifePointReduce.m_value) : 1,
    elementalRes: val(a, 'epResistance') ?? 0,
  }
}

/** Builds the enemy list. Enemies hidden from the in-game handbook are left out. */
export function parseEnemies(handbook: any, database: any): Record<string, Enemy> {
  const races: Record<string, string> = {}
  for (const [k, r] of Object.entries<any>(handbook?.raceData ?? {})) races[k] = r?.raceName ?? k
  const out: Record<string, Enemy> = {}
  for (const [id, h] of Object.entries<any>(handbook?.enemyData ?? {})) {
    if (!h?.name || h.hideInHandbook) continue
    const levels: any[] = Array.isArray(database?.[id]) ? database[id] : []
    const d0 = levels.find(l => l.level === 0)?.enemyData ?? levels[0]?.enemyData
    const a0: Attr | undefined = d0?.attributes
    const stats = d0 ? statsOf(a0, d0) : undefined
    const stronger: Partial<EnemyStats>[] = []
    const defined = (o: any) => Object.fromEntries(Object.entries<any>(o ?? {}).filter(([, v]) => v?.m_defined))
    for (const l of levels.filter(x => x.level > 0).sort((a, b) => a.level - b.level)) {
      if (!stats) break
      const d = l.enemyData
      const merged = statsOf({ ...a0, ...defined(d?.attributes) }, { ...d0, ...defined(d) })
      stronger.push(Object.fromEntries(Object.entries(merged).filter(([k, v]) => v !== stats[k as keyof EnemyStats])) as Partial<EnemyStats>)
    }
    const list = (x: unknown): string[] => (Array.isArray(x) ? x : [])
    const tags = [...list(h.enemyTags), ...list(d0?.enemyTags?.m_value)]
    out[id] = {
      id,
      index: String(h.enemyIndex ?? ''),
      name: strip(h.name),
      level: LEVEL[h.enemyLevel] ?? h.enemyLevel ?? '',
      races: [...new Set(tags.map(t => races[t]).filter(Boolean))],
      damage: (h.damageType ?? []).map((t: string) => DAMAGE[t] ?? t),
      attack: ATTACK[d0?.applyWay?.m_value] ?? '',
      flying: d0?.motion?.m_value === 'FLY',
      desc: strip(h.description),
      note: strip(d0?.description?.m_value),
      abilities: (Array.isArray(h.abilityList) ? h.abilityList : []).map((x: any) => ({ title: x.textFormat === 'TITLE' || undefined, text: strip(x.text) })).filter((x: any) => x.text),
      stats,
      stronger: stronger.some(x => Object.keys(x).length) ? stronger : undefined,
      immune: Object.entries(IMMUNE)
        .filter(([k]) => a0?.[k]?.m_defined && a0[k].m_value === true)
        .map(([, n]) => n),
    }
  }
  return out
}

/** "HP 45,000 · ATK 1,600 · ..." lines for the stats field. */
export function statLines(s: EnemyStats): string[] {
  const n = (x: number) => x.toLocaleString('en-US')
  return [
    `**HP** ${n(s.hp)} · **ATK** ${n(s.atk)} · **DEF** ${n(s.def)} · **RES** ${n(s.res)}`,
    `**Attack interval** ${s.interval}s · **Move speed** ${s.speed}${s.range ? ` · **Range** ${s.range}` : ''}`,
    `**Weight** ${s.weight} · **Life points taken** ${s.lifePoints}${s.elementalRes ? ` · **Elemental RES** ${s.elementalRes}` : ''}`,
  ]
}
