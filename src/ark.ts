// PRTS Arknights toolkit: instant slash commands answered by the bot itself
// (no Claude round trip). Dice and coins, operator cards, tier list, module
// ratings, farming, recruitment calculator, wiki search, story reader links.
//
// Data sources
// - Game data (EN): ArknightsAssets/ArknightsGamedata on GitHub (character,
//   module, faction and recruitment tables). Cached to cache/arkdata.json and
//   refreshed every 3 days in the background.
// - Timo's story reader (arknights.timo.beer): routes.json for page links.
// - Fan spreadsheets (AK Tier List, DragonGJY modules, PeterYR farming, RIIC
//   base guide): pulled live from Google every 6 hours into
//   <PRTS_DATA_DIR>/sheets/*.txt (created on first run), which are re-read
//   whenever they change.
// - Story index (optional): <PRTS_DATA_DIR>/stories.json or PRTS_STORIES_JSON.
//   Without it, /story only links to the story reader. PRTS_STORY_REFRESH_CMD
//   can rebuild it daily (see startStoryRefresh); the file is re-read on change.
// - arknights.wiki.gg MediaWiki API for /wiki and NPC fallbacks.
// - Images: myrtle.moe CDN (operator art), yuanyan3060 GitHub mirror (avatars).
import {
  EmbedBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  type StringSelectMenuInteraction,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type Client,
} from 'discord.js'
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync, renameSync, utimesSync } from 'fs'
import { join } from 'path'

const SHEETS = join(DATA_DIR, 'sheets')
const STORIES_JSON = process.env.PRTS_STORIES_JSON ?? join(DATA_DIR, 'stories.json')
import { COLOR, FOOTER, SECTION, brand, stampEmbeds } from './theme.ts'
import { linePages, paged } from './pages.ts'
import { CACHE_DIR, DATA_DIR } from './paths.ts'
import { announce } from './announce.ts'
import { type ModuleEffect, fillTemplate, parseModule, statLine, gradeWord, recLevel } from './equip.ts'
const CACHE_FILE = join(CACHE_DIR, 'arkdata.json')
const CACHE_MAX_AGE_MS = 3 * 24 * 3600 * 1000
const GAMEDATA = 'https://raw.githubusercontent.com/ArknightsAssets/ArknightsGamedata/master/en/gamedata/excel/'
const TIMO = 'https://arknights.timo.beer'
const WIKI = 'https://arknights.wiki.gg'
const MYRTLE = 'https://myrtle.moe'
const UA = process.env.PRTS_USER_AGENT ?? 'PRTS-Discord-bot/1.0 (unofficial Arknights fan bot)'

const log = (s: string) => process.stderr.write(`prts ark: ${s}\n`)

// ───────────────────────── command definitions ─────────────────────────

// Available everywhere the app is installed (servers, DMs, group DMs).
const ANYWHERE = { type: 1, integration_types: [0, 1], contexts: [0, 1, 2] }
const PRIVATE_OPT = { type: 5, name: 'private', description: 'Only you can see the reply', required: false }

export const ARK_COMMANDS = [
  {
    name: 'roll',
    description: 'Random tools: dice, coin toss, or let PRTS choose',
    options: [
      {
        type: 1,
        name: 'dice',
        description: 'Roll dice: 1d20 = one 20-sided die, 2d6+3 = two 6-sided dice plus 3',
        options: [
          { type: 3, name: 'dice', description: '1d20, 2d6+3, 4d6kh3 (keep highest 3), 2d20kl1 (keep lowest), d% (1-100)', required: false, max_length: 100 },
          { type: 3, name: 'reason', description: 'What the roll is for', required: false, max_length: 100 },
          PRIVATE_OPT,
        ],
      },
      {
        type: 1,
        name: 'coin',
        description: 'Toss a coin (or several)',
        options: [
          { type: 4, name: 'count', description: 'How many coins (default 1, max 100)', required: false, min_value: 1, max_value: 100 },
          { type: 3, name: 'reason', description: 'What the toss is for', required: false, max_length: 100 },
          { type: 4, name: 'heads', description: 'Chance of heads in percent (default 50)', required: false, min_value: 1, max_value: 99 },
          {
            type: 3,
            name: 'call',
            description: 'Call it before the toss',
            required: false,
            choices: [
              { name: 'Heads', value: 'heads' },
              { name: 'Tails', value: 'tails' },
            ],
          },
          PRIVATE_OPT,
        ],
      },
      {
        type: 1,
        name: 'choose',
        description: 'PRTS picks one option for you',
        options: [
          { type: 3, name: 'options', description: 'Options separated by | or commas', required: true, max_length: 500 },
          { type: 3, name: 'reason', description: 'What the choice is for', required: false, max_length: 100 },
          PRIVATE_OPT,
        ],
      },
    ],
  },
  {
    name: 'operator',
    description: 'Operator card: class, faction, tier, modules, links',
    options: [{ type: 3, name: 'name', description: 'Operator name', required: true, autocomplete: true, max_length: 60 }, PRIVATE_OPT],
  },
  {
    name: 'tier',
    description: 'AK Tier List (fan-made, global): show a tier or an operator',
    options: [
      {
        type: 3,
        name: 'tier',
        description: 'Tier to list (default: all top tiers)',
        required: false,
        choices: ['EX', 'S+', 'S', 'S-', 'A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-'].map(t => ({ name: t, value: t })),
      },
      {
        type: 3,
        name: 'class',
        description: 'Only this class',
        required: false,
        choices: ['Vanguard', 'Guard', 'Defender', 'Sniper', 'Caster', 'Medic', 'Supporter', 'Specialist'].map(c => ({ name: c, value: c })),
      },
      { type: 3, name: 'operator', description: 'Look up one operator instead', required: false, autocomplete: true, max_length: 60 },
      PRIVATE_OPT,
    ],
  },
  {
    name: 'farm',
    description: 'Best stages to farm a material (PeterYR sheet)',
    options: [{ type: 3, name: 'material', description: 'Material, e.g. Orirock, Device, RMA', required: true, autocomplete: true, max_length: 60 }, PRIVATE_OPT],
  },
  {
    name: 'recruit',
    description: 'Recruitment calculator: which tag combos guarantee good operators',
    options: [{ type: 3, name: 'tags', description: 'Up to 5 tags, separated by commas, e.g. Slow, Top Operator', required: true, autocomplete: true, max_length: 150 }, PRIVATE_OPT],
  },
  { name: 'wiki', description: 'Search arknights.wiki.gg', options: [{ type: 3, name: 'query', description: 'What to look up', required: true, autocomplete: true, max_length: 150 }, PRIVATE_OPT] },
  {
    name: 'story',
    description: "Find a story chapter or event and link it in Timo's reader",
    options: [{ type: 3, name: 'query', description: 'Stage code (15-12), title, event name or operator', required: true, autocomplete: true, max_length: 100 }, PRIVATE_OPT],
  },
  {
    name: 'base',
    description: 'Base (RIIC) skills and team combos: by operator, team or facility',
    options: [
      { type: 3, name: 'operator', description: "An operator's base skills and the teams they fit", required: false, autocomplete: true, max_length: 60 },
      { type: 3, name: 'team', description: 'A team combo from the RIIC guide', required: false, autocomplete: true, max_length: 100 },
      {
        type: 3,
        name: 'facility',
        description: 'List the team combos for a facility',
        required: false,
        choices: ['Multi-facility', 'Control Center', 'Factory', 'Trading Post'].map(n => ({ name: n, value: n })),
      },
      PRIVATE_OPT,
    ],
  },
  {
    name: 'skin',
    description: "An operator's outfits: art, artist, how to get it, animated and chibi versions",
    options: [
      { type: 3, name: 'operator', description: 'Operator name', required: true, autocomplete: true, max_length: 60 },
      { type: 3, name: 'outfit', description: 'One outfit to show (default: list them all)', required: false, autocomplete: true, max_length: 100 },
      PRIVATE_OPT,
    ],
  },
  {
    name: 'myrtle',
    description: 'Myrtle.moe player profiles: look up, link your account, roster, leaderboard',
    options: [
      {
        type: 1,
        name: 'profile',
        description: "A player's profile card: level, score, rank, supports, roster stats",
        options: [
          { type: 3, name: 'player', description: 'Name, Name#1234, UID or myrtle.moe link (default: your linked account)', required: false, autocomplete: true, max_length: 100 },
          { type: 6, name: 'user', description: 'A Discord user who linked their account', required: false },
          PRIVATE_OPT,
        ],
      },
      {
        type: 1,
        name: 'roster',
        description: "A player's operators: top builds, or one operator's build",
        options: [
          { type: 3, name: 'player', description: 'Name, Name#1234, UID or myrtle.moe link (default: your linked account)', required: false, autocomplete: true, max_length: 100 },
          { type: 6, name: 'user', description: 'A Discord user who linked their account', required: false },
          { type: 3, name: 'operator', description: 'Show only this operator', required: false, autocomplete: true, max_length: 60 },
          {
            type: 3,
            name: 'sort',
            description: 'Order (default: level)',
            required: false,
            choices: [
              { name: 'Level (promotion, then level)', value: 'level' },
              { name: 'Rarity', value: 'rarity' },
              { name: 'Masteries', value: 'mastery' },
              { name: 'Modules', value: 'module' },
              { name: 'Most recently obtained', value: 'recent' },
            ],
          },
          { type: 4, name: 'rarity', description: 'Only this rarity', required: false, min_value: 1, max_value: 6 },
          {
            type: 3,
            name: 'class',
            description: 'Only this class',
            required: false,
            choices: ['Vanguard', 'Guard', 'Defender', 'Sniper', 'Caster', 'Medic', 'Supporter', 'Specialist'].map(c => ({ name: c, value: c })),
          },
          PRIVATE_OPT,
        ],
      },
      {
        type: 1,
        name: 'pulls',
        description: "A player's public headhunting history: pity, 6★ and 5★ pulls, rates",
        options: [
          { type: 3, name: 'player', description: 'Name, Name#1234, UID or myrtle.moe link (default: your linked account)', required: false, autocomplete: true, max_length: 100 },
          { type: 6, name: 'user', description: 'A Discord user who linked their account', required: false },
          {
            type: 3,
            name: 'banner',
            description: 'Only this banner type (default: all)',
            required: false,
            choices: [
              { name: 'Limited', value: 'limited' },
              { name: 'Standard', value: 'standard' },
              { name: 'Kernel', value: 'kernel' },
              { name: 'Beginner', value: 'beginner' },
            ],
          },
          PRIVATE_OPT,
        ],
      },
      {
        type: 1,
        name: 'inventory',
        description: "A player's public item inventory: materials, chips, tickets",
        options: [
          { type: 3, name: 'player', description: 'Name, Name#1234, UID or myrtle.moe link (default: your linked account)', required: false, autocomplete: true, max_length: 100 },
          { type: 6, name: 'user', description: 'A Discord user who linked their account', required: false },
          { type: 3, name: 'item', description: 'Only items whose name contains this', required: false, max_length: 60, autocomplete: true },
          PRIVATE_OPT,
        ],
      },
      {
        type: 1,
        name: 'lookback',
        description: "A player's progress snapshots over time (operators, E2, masteries, modules, score)",
        options: [
          { type: 3, name: 'player', description: 'Name, Name#1234, UID or myrtle.moe link (default: your linked account)', required: false, autocomplete: true, max_length: 100 },
          { type: 6, name: 'user', description: 'A Discord user who linked their account', required: false },
          PRIVATE_OPT,
        ],
      },
      {
        type: 1,
        name: 'showcase',
        description: "A player's profile showcase: favourite operators, enemies, outfits, tier lists",
        options: [
          { type: 3, name: 'player', description: 'Name, Name#1234, UID or myrtle.moe link (default: your linked account)', required: false, autocomplete: true, max_length: 100 },
          { type: 6, name: 'user', description: 'A Discord user who linked their account', required: false },
          PRIVATE_OPT,
        ],
      },
      {
        type: 1,
        name: 'plans',
        description: "A player's public operator plans",
        options: [
          { type: 3, name: 'player', description: 'Name, Name#1234, UID or myrtle.moe link (default: your linked account)', required: false, autocomplete: true, max_length: 100 },
          { type: 6, name: 'user', description: 'A Discord user who linked their account', required: false },
          PRIVATE_OPT,
        ],
      },
      {
        type: 1,
        name: 'search',
        description: 'Find Myrtle players by in-game name',
        options: [{ type: 3, name: 'name', description: 'In-game name (part of it is fine)', required: true, max_length: 60 }, PRIVATE_OPT],
      },
      {
        type: 1,
        name: 'leaderboard',
        description: 'Myrtle account score leaderboard',
        options: [
          {
            type: 3,
            name: 'sort',
            description: 'Category (default: total)',
            required: false,
            choices: Object.entries({
              total_score: 'Total',
              operator_score: 'Operators',
              stage_score: 'Stages',
              roguelike_score: 'Integrated Strategies',
              sandbox_score: 'Reclamation Algorithm',
              medal_score: 'Medals',
              base_score: 'Base (RIIC)',
            }).map(([value, name]) => ({ name, value })),
          },
          { type: 3, name: 'server', description: 'Only this server', required: false, choices: ['EN', 'JP', 'KR'].map(s => ({ name: s, value: s })) },
          PRIVATE_OPT,
        ],
      },
      {
        type: 1,
        name: 'link',
        description: 'Link your Discord account to your Myrtle profile',
        options: [{ type: 3, name: 'player', description: 'Your name#1234, UID or myrtle.moe link', required: true, autocomplete: true, max_length: 100 }],
      },
      { type: 1, name: 'unlink', description: 'Remove the link to your Myrtle profile', options: [] },
    ],
  },
  {
    name: 'help',
    description: 'All commands, what they do and how to use them',
    options: [{ type: 3, name: 'command', description: 'Show details and examples for one command', required: false, choices: [] as { name: string; value: string }[] }, PRIVATE_OPT],
  },
].map(c => ({ ...ANYWHERE, ...c }))

export const ARK_COMMAND_NAMES = new Set(ARK_COMMANDS.map(c => c.name))

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

type Op = {
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
type OpModule = { name: string; type: string; id?: string; unlock?: string; form?: string; fx?: ModuleEffect }
const DATA_VERSION = 8
type ArkData = {
  version: number
  builtAt: number
  ops: Op[]
  recruitTags: string[]
  timoGroups: Record<string, string>
  timoOps: Record<string, string>
}

let data: ArkData | null = null
let building: Promise<void> | null = null

async function getJson(url: string): Promise<any> {
  // A hung download would keep `building` set forever and block every refresh.
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(180_000) })
  if (!r.ok) throw new Error(`${r.status} ${url}`)
  return r.json()
}

const stripRich = (s: string) =>
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

function ensureData(): void {
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
function opIndex() {
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

type Sheets = {
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
const RIIC_URL = 'https://docs.google.com/spreadsheets/d/1zYc2JU46X0XWmV7s1503bN4feRdOMa1eehrTQ2jGaiE/edit'
const FARM_ALIAS: Record<string, string> = {
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

const baseOpName = (s: string) => normName(s.replace(/\s*\([^)]*\)\s*$/, ''))

function loadSheets(): Sheets | null {
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

function sheetDate(file: string): string {
  try {
    return new Date(statSync(join(SHEETS, file)).mtimeMs).toISOString().slice(0, 10)
  } catch {
    return 'unknown'
  }
}

// ───────────────────────── helpers ─────────────────────────

const stars = (n: number) => '★'.repeat(n)
const wikiUrl = (title: string) => `${WIKI}/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`
const randInt = (n: number) => {
  const buf = new Uint32Array(1)
  const lim = Math.floor(0x100000000 / n) * n
  do crypto.getRandomValues(buf)
  while (buf[0] >= lim)
  return buf[0] % n
}
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)
const ephFlag = (on: boolean): MessageFlags.Ephemeral | undefined => (on ? MessageFlags.Ephemeral : undefined)

function embed(title?: string): EmbedBuilder {
  const e = new EmbedBuilder().setColor(COLOR.info).setFooter({ text: FOOTER })
  if (title) e.setTitle(title)
  return e
}

async function notReady(i: ChatInputCommandInteraction, eph: boolean) {
  await i.reply({
    embeds: [
      embed('Records loading')
        .setColor(COLOR.warn)
        .setDescription('Operator records are being downloaded from the game data archive. Estimated time: under 60 seconds. Please try again shortly. I apologize for the delay.'),
    ],
    flags: ephFlag(eph),
  })
}

// ───────────────────────── /roll /coin /choose ─────────────────────────

function rollDice(expr: string): { text: string; total: number } | string {
  const src = expr.replace(/\s+/g, '').toLowerCase() || '1d20'
  const re = /([+-]?)(?:(\d*)d(\d+|%)(?:(kh|kl)(\d+))?|(\d+))/gy
  let pos = 0,
    total = 0,
    dice = 0
  const parts: string[] = []
  while (pos < src.length) {
    re.lastIndex = pos
    const m = re.exec(src)
    if (!m || m[0] === '' || (pos > 0 && !m[1])) return 'Unable to parse the dice expression. Examples: 1d20, 2d6+3, 4d6kh3, d%.'
    pos = re.lastIndex
    const sign = m[1] === '-' ? -1 : 1
    if (m[6] !== undefined) {
      total += sign * parseInt(m[6], 10)
      parts.push(`${sign < 0 ? '−' : parts.length ? '+' : ''} ${m[6]}`)
      continue
    }
    const count = m[2] ? parseInt(m[2], 10) : 1
    const sides = m[3] === '%' ? 100 : parseInt(m[3], 10)
    dice += count
    if (count < 1 || sides < 2 || sides > 10000 || dice > 100) return 'Request exceeds limits: at most 100 dice, 2 to 10000 sides each.'
    const rolls = Array.from({ length: count }, () => randInt(sides) + 1)
    let kept = rolls.map((_, idx) => idx)
    if (m[4]) {
      const k = Math.min(parseInt(m[5], 10), count)
      kept = kept.sort((a, b) => (m[4] === 'kh' ? rolls[b] - rolls[a] : rolls[a] - rolls[b])).slice(0, k)
    }
    const keep = new Set(kept)
    const sum = rolls.reduce((acc, r, idx) => acc + (keep.has(idx) ? r : 0), 0)
    total += sign * sum
    const shown = rolls
      .map((r, idx) => {
        const t = keep.has(idx) ? String(r) : `~~${r}~~`
        return r === sides && keep.has(idx) ? `**${t}**` : t
      })
      .join(', ')
    parts.push(`${sign < 0 ? '−' : parts.length ? '+' : ''} ${count}d${m[3]}${m[4] ? m[4] + m[5] : ''} [${shown}]`)
  }
  return { text: parts.join(' ').trim(), total }
}

async function cmdRoll(i: ChatInputCommandInteraction, eph: boolean) {
  const expr = i.options.getString('dice') ?? '1d20'
  const reason = i.options.getString('reason')
  const r = rollDice(expr)
  if (typeof r === 'string') return i.reply({ content: `[PRTS] ${r}`, flags: MessageFlags.Ephemeral })
  const e = embed(reason ? clip(reason, 200) : 'Dice roll')
    .setDescription(`Result: **${r.total}**\n\n\`${expr}\` · ${clip(r.text, 3400)}`)
    .addFields({ name: 'What this roll means', value: clip(diceExplain(expr), 1024) })
  return i.reply({ embeds: [e], flags: ephFlag(eph) })
}

/** "2d6+3" -> "2 six-sided dice, added together, plus 3" — so the notation is understandable at a glance. */
function diceExplain(expr: string): string {
  const parts: string[] = []
  const re = /([+-]?)\s*(?:(\d*)d(\d+|%)(?:(kh|kl)(\d+))?|(\d+))/gi
  for (const m of expr.replace(/\s+/g, '').matchAll(re)) {
    const sign = m[1] === '-' ? 'minus ' : parts.length ? 'plus ' : ''
    if (m[6] !== undefined) {
      parts.push(`${sign}${m[6]}`)
      continue
    }
    const n = Number(m[2] || 1)
    const sides = m[3] === '%' ? 'percentile (1-100)' : `${m[3]}-sided`
    const keep = m[4] ? `, keep the ${m[4] === 'kh' ? 'highest' : 'lowest'} ${m[5]}` : ''
    parts.push(`${sign}${n} ${sides} ${n === 1 ? 'die' : 'dice'}${keep}`)
  }
  // Explain only the notation this roll actually uses.
  const e = expr.replace(/\s+/g, '').toLowerCase()
  const notes = [
    /\d*d\d/.test(e) ? '**XdY** = X dice with Y sides' : '',
    /[+-]\d+(?![d\d])|[+-]\d+$/.test(e) || /^\d+[+-]/.test(e) ? '**+N / -N** adds or subtracts N' : '',
    /kh/.test(e) ? '**khN** keeps the highest N dice' : '',
    /kl/.test(e) ? '**klN** keeps the lowest N dice' : '',
    /d%/.test(e) ? '**d%** = a number from 1 to 100' : '',
  ].filter(Boolean)
  return `${parts.join(', ')}.${notes.length ? `\nNotation: ${notes.join(' · ')}.` : ''}`
}

async function cmdCoin(i: ChatInputCommandInteraction, eph: boolean) {
  const n = i.options.getInteger('count') ?? 1
  const call = i.options.getString('call')
  const pct = i.options.getInteger('heads') ?? 50
  const flips = Array.from({ length: n }, () => (randInt(100) < pct ? 'Heads' : 'Tails'))
  const heads = flips.filter(f => f === 'Heads').length
  let desc: string
  if (n === 1) {
    desc = `The coin lands on **${flips[0]}**.`
    if (call) desc += flips[0].toLowerCase() === call ? '\nYour call was correct. Congratulations.' : '\nYour call was incorrect. I apologize on behalf of probability.'
  } else {
    desc = `${flips.map(f => (f === 'Heads' ? 'H' : 'T')).join(' ')}\n\nHeads: **${heads}** · Tails: **${n - heads}** (${((heads / n) * 100).toFixed(1)}% heads)`
    if (call) desc += `\nYour call (${call}) was correct ${call === 'heads' ? heads : n - heads} of ${n} times.`
  }
  if (pct !== 50) desc += `\nWeighted coin: ${pct}% heads, ${100 - pct}% tails.`
  const reason = i.options.getString('reason')
  return i.reply({ embeds: [embed(`${reason ? clip(reason, 200) : 'Coin toss'}${n > 1 ? ` ×${n}` : ''}`).setDescription(desc)], flags: ephFlag(eph) })
}

async function cmdChoose(i: ChatInputCommandInteraction, eph: boolean) {
  const raw = i.options.getString('options', true)
  const opts = raw
    .split(raw.includes('|') ? '|' : ',')
    .map(s => s.trim())
    .filter(Boolean)
  if (opts.length < 2) return i.reply({ content: '[PRTS] Please provide at least two options, separated by | or commas.', flags: MessageFlags.Ephemeral })
  const pick = opts[randInt(opts.length)]
  const reason = i.options.getString('reason')
  const e = embed(reason ? clip(reason, 200) : 'Decision support').setDescription(
    `Options evaluated: ${opts.length}. Probability for each option: ${(100 / opts.length).toFixed(2)}%.\n\nSelected, without hesitation: **${clip(pick, 500)}**`,
  )
  return i.reply({ embeds: [e], flags: ephFlag(eph) })
}

// ───────────────────────── /operator ─────────────────────────

function opLinkRow(o: Op): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Wiki').setURL(wikiUrl(o.name)),
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Myrtle').setURL(`${MYRTLE}/operators/${o.id}`),
  )
  const slug = data?.timoOps[o.id]
  if (slug)
    row.addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Story records').setURL(`${TIMO}/operators/${slug}`),
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Voice lines').setURL(`${TIMO}/voices/${slug}`),
    )
  return row
}

/** The DragonGJY row for a module (matched by its letter, X/Y/D/A). */
const ratingRow = (m: OpModule, rows: string[][]) => rows.find(row => m.type.endsWith('-' + row[2].trim()))

function tierText(o: Op, sh: Sheets | null): string | null {
  const t = sh?.tierOf.get(normName(o.name))
  return t?.length ? t.join(', ') : null
}

/** The /operator card (also served by `ark:op:<id>`). */
function operatorCard(o: Op): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const sh = loadSheets()
  const e = embed(o.name)
    .setURL(wikiUrl(o.name))
    .setDescription([stars(o.rarity), o.usage ? `*${clip(o.usage, 300)}*` : '', o.desc ? `> ${clip(o.desc, 200)}` : ''].filter(Boolean).join('\n'))
    .setThumbnail(`https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/main/avatar/${o.id}.png`)
    .setImage(`https://assets.eltik.net/myrtle/en/textures/chararts/${o.id}/${o.id}_${o.rarity >= 4 ? 2 : 1}.png`)
  const tier = tierText(o, sh)
  const alts = (o.alts ?? []).map(id => opIndex()?.byId.get(id)).filter((x): x is Op => !!x)
  e.addFields({
    name: 'Profile',
    value: [
      `**Class:** ${o.cls} · **Branch:** ${o.branch}${o.pos ? ` · **Position:** ${o.pos}` : ''}`,
      (o.forms?.length ?? 0) > 1 ? `**Forms:** ${o.forms!.join(', ')}` : '',
      o.faction ? `**Faction:** ${o.faction}` : '',
      o.trait ? `**Trait:** ${clip(o.trait, 300)}` : '',
      o.summons?.length ? `**Summon:** ${o.summons.join(', ')}` : '',
      o.tags.length ? `**Tags:** ${o.tags.join(', ')}` : '',
      `**How to get:** ${o.obtain ?? (o.recruit ? 'Recruitment & Headhunting' : 'Headhunting')}${o.recruit ? ' (in the recruitment pool)' : ''}`,
      `**Tier:** ${tier ?? 'not listed'} *(AK Tier List)*`,
      alts.length ? `**Alternate:** ${alts.map(a => a.name).join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  })
  const rated = sh?.modules.get(normName(o.name)) ?? []
  if (o.modules.length)
    e.addFields({
      name: 'Modules',
      value: clip(
        o.modules
          .map(m => {
            const g = gradeWord(ratingRow(m, rated)?.[4])
            return `**${m.type}** ${m.name}${m.form ? ` *(${m.form})*` : ''}${g ? ` · rated ${g}` : ''}`
          })
          .join('\n'),
        1024,
      ),
    })
  e.setFooter({ text: `${FOOTER} · Press a button below for details · Tier and module ratings are fan-made` })
  const components = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...(o.modules.length ? [new ButtonBuilder().setCustomId(`ark:mod:${o.id}`).setStyle(ButtonStyle.Primary).setLabel('Modules')] : []),
      new ButtonBuilder().setCustomId(`ark:skin:${o.id}`).setStyle(ButtonStyle.Secondary).setLabel('Outfits'),
      new ButtonBuilder().setCustomId(`ark:base:${o.id}`).setStyle(ButtonStyle.Secondary).setLabel('Base skills'),
      new ButtonBuilder().setCustomId(`arkp:mat:${o.id}:everything`).setStyle(ButtonStyle.Secondary).setLabel('Materials'),
    ),
    opLinkRow(o),
  ]
  return { embeds: [e], components }
}

async function cmdOperator(i: ChatInputCommandInteraction, eph: boolean) {
  ensureData()
  const q = i.options.getString('name', true)
  if (!data) return notReady(i, eph)
  const o = findOps(q, 1)[0]
  if (!o) {
    // Not an operator: maybe an NPC. Fall back to the wiki.
    await i.deferReply({ flags: ephFlag(eph) })
    const w = await wikiLookup(q).catch(() => null)
    if (!w) return i.editReply({ content: `[PRTS] No operator or wiki record matches "${clip(q, 60)}". Please check the spelling.` })
    const who = w.data.title ?? q
    const app = storyAppearances(who) ?? storyAppearances(q)
    if (app)
      w.addFields({
        name: 'Story appearances',
        value: clip(`Speaks **${app.lines}** lines in **${app.stories}** stories: ${app.groups.join(', ')}. Search them with \`/story\`.`, 1024),
      })
    // arkplus imports this file, so load it lazily here.
    const art = await import('./arkplus.ts').then(m => m.wikiPortrait(who)).catch(() => null)
    if (art) w.setImage(art)
    return i.editReply({ embeds: [w.setAuthor({ name: 'No operator file found · Wiki record' })] })
  }
  return i.reply({ ...operatorCard(o), flags: ephFlag(eph) })
}

// ───────────────────────── /tier ─────────────────────────

// Class from game data (reliable); the sheet's class templates as fallback.
function classOfName(n: string, sh: Sheets): string | undefined {
  const k = baseOpName(n)
  const o = opIndex()?.byKey.get(k)
  if (o) return o.cls
  if (/^amiya/.test(k) && /medic/i.test(n)) return 'Medic'
  return sh.classOf.get(k)
}

/** Tier, modules (with the DragonGJY grade) and the tier sheet's latest verdict for one operator, for /compare. */
export function operatorSummary(name: string): { tier?: string; modules: { type: string; name: string; grade?: string }[]; verdict?: string } {
  ensureData()
  const sh = loadSheets()
  const o = findOps(name, 1)[0]
  const rated = sh?.modules.get(normName(o?.name ?? name)) ?? []
  return {
    tier: sh?.tierOf.get(normName(o?.name ?? name))?.join(', '),
    modules: (o?.modules ?? []).map(m => ({ type: m.type, name: m.name, grade: ratingRow(m, rated)?.[4]?.trim() })),
    verdict: sh?.tierNotes.get(normName(o?.name ?? name))?.text,
  }
}

/** Short forms the tier sheet uses in its revision log ("Texas2", "Kal2", "Ros IS") for an operator. */
function tierAliases(o: Op | undefined, name: string): RegExp[] {
  const out = [name]
  const first = name.split(/[\s'’]/)[0]
  if (o && / the |,|·/.test(name)) out.push(`${first}2`, `${first.slice(0, 4)}2`, `${first.slice(0, 3)}2`)
  return out.map(a => new RegExp(`(^|[^\\w])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\w])`, 'i'))
}

async function cmdTier(i: ChatInputCommandInteraction, eph: boolean) {
  ensureData()
  const sh = loadSheets()
  if (!sh || !sh.tiers.length) return i.reply({ content: '[PRTS] The tier list sheet is unavailable. I apologize.', flags: MessageFlags.Ephemeral })
  const opQ = i.options.getString('operator')
  const want = i.options.getString('tier')
  const cls = i.options.getString('class')
  const SHEET = 'https://docs.google.com/spreadsheets/d/1E7HmgKWiV8pKpJpvpVzziYxnaQTP01Vtw_PXEdL7XPA/edit'
  const footer = `${FOOTER} · AK Tier List (fan-made, global, full investment) · checked ${sheetDate('tier-list-aktierlist.txt')}`
  const link = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Open the tier list').setURL(SHEET))
  if (opQ) {
    const o = findOps(opQ, 1)[0]
    const name = o?.name ?? opQ
    const t = sh.tierOf.get(normName(name))
    const e = embed(name).setURL(SHEET).setFooter({ text: footer })
    if (o) e.setThumbnail(`https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/main/avatar/${o.id}.png`)
    e.setDescription([o ? `${'★'.repeat(o.rarity)} · ${o.cls} · ${o.branch}` : '', t ? `Tier: **${t.join(', ')}**` : 'Not listed on the tier list.'].filter(Boolean).join('\n'))
    const note = sh.tierNotes.get(normName(name))
    if (note) e.addFields({ name: `Assessment · ${note.change}`, value: clip(note.text, 1000) })
    const pats = tierAliases(o, name)
    const revs = sh.revisions.filter(r => pats.some(p => p.test(r.text))).slice(0, 3)
    // Only the sentences of each revision that mention this operator.
    const about = (t: string) =>
      t
        .split(/(?<=\.)\s+/)
        .filter(x => pats.some(p => p.test(x)))
        .join(' ') || t
    if (revs.length) e.addFields({ name: 'Rating history', value: clip(revs.map(r => `**${r.date || 'Earlier'}** · ${clip(about(r.text), 280)}`).join('\n'), 1024) })
    if (!note && !revs.length && t) e.addFields({ name: 'Assessment', value: 'The sheet has no written reasoning for this operator yet. Its grade reflects full investment on the global server.' })
    return i.reply({ embeds: [e], components: [link], flags: ephFlag(eph) })
  }
  // One page per tier, names grouped by class, so each grade reads on its own.
  const CLASSES = ['Vanguard', 'Guard', 'Defender', 'Sniper', 'Caster', 'Medic', 'Supporter', 'Specialist']
  const tiers = sh.tiers.filter(t => !want || t.tier === want)
  const pages: EmbedBuilder[] = []
  for (const t of tiers) {
    const by = new Map<string, string[]>()
    for (const n of t.names) {
      const c = classOfName(n, sh) ?? 'Other'
      if (cls && c !== cls) continue
      by.set(c, [...(by.get(c) ?? []), n])
    }
    if (!by.size) continue
    const e = embed(`Tier ${t.tier}${cls ? ` · ${cls}s` : ''}`)
      .setURL(SHEET)
      .setDescription(`${[...by.values()].reduce((n, l) => n + l.length, 0)} operators. Use \`/tier operator:<name>\` for one operator's assessment.`)
    for (const c of [...CLASSES, 'Other']) if (by.get(c)?.length) e.addFields({ name: `${c}s`, value: clip(by.get(c)!.join(', '), 1024), inline: false })
    pages.push(e)
  }
  if (!pages.length) return i.reply({ embeds: [embed('Tier list').setDescription('No operators match that filter.').setFooter({ text: footer })], flags: ephFlag(eph) })
  pages.forEach((p, k) => p.setFooter({ text: `${footer}${pages.length > 1 ? ` · page ${k + 1} of ${pages.length}` : ''}` }))
  return i.reply({ ...paged(pages, [link]), flags: ephFlag(eph) })
}

// ───────────────────────── /module ─────────────────────────

/** The Modules button: what each module does (game data) and the community verdict. */
/** One module per page (`ark:modv:<operator id>:<index>:<fx|review>`), with buttons to switch module and tab. */
function moduleView(o: Op, idx: number, tab: string): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const rated = loadSheets()?.modules.get(normName(o.name)) ?? []
  const mods = o.modules.slice(0, 5)
  const m = mods[Math.min(Math.max(idx, 0), mods.length - 1)]
  const r = m ? ratingRow(m, rated) : undefined
  const e = embed(m ? `${m.type} · ${m.name}` : `Modules: ${o.name}`)
    .setURL(wikiUrl(o.name))
    .setThumbnail(`https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/main/avatar/${o.id}.png`)
  if (!m) return { embeds: [e.setDescription('No modules on record.')], components: [] }
  e.setDescription(`**${o.name}** · module ${mods.indexOf(m) + 1} of ${mods.length}${m.form ? ` · ${m.form}` : ''} · unlocks at ${m.unlock ?? 'Elite 2'}`)
  if (tab === 'review' && r) {
    const [, arch, , quick, mr, ic, lv, , pros, cons] = r
    const points = (t: string) =>
      (t ?? '')
        .split(/(?:^|\s)-\s+/)
        .map(x => x.trim())
        .filter(Boolean)
        .slice(0, 4)
        .map(x => `• ${clip(x, 170)}`)
        .join('\n')
    e.addFields(
      { name: 'In short', value: clip(quick.trim(), 300) },
      {
        name: 'Verdict',
        value:
          [gradeWord(mr) && `Rated **${gradeWord(mr)}**`, gradeWord(ic) && `value for materials **${gradeWord(ic)}**`].filter(Boolean).join(' · ') +
          (recLevel(lv) ? `\nRecommended: ${recLevel(lv)}` : ''),
      },
    )
    if (points(pros)) e.addFields({ name: 'Pros', value: clip(points(pros), 1024) })
    if (points(cons)) e.addFields({ name: 'Cons', value: clip(points(cons), 1024) })
    e.setFooter({ text: `${FOOTER} · DragonGJY module ratings (fan-made, CN-based, ${arch.trim()}) · checked ${sheetDate('module-ratings-dragongjy.txt')}` })
  } else {
    const fx = m.fx
    if (fx?.trait) e.addFields({ name: `Stage 1 · ${fx.trait.kind === 'add' ? 'trait bonus' : 'new trait'}`, value: clip(fx.trait.text, 400) })
    const st = fx ? statLine(fx.stats) : ''
    if (st) e.addFields({ name: `Stats · stage 1 → ${fx?.stats.length ?? 3}`, value: st })
    for (const t of fx?.talents ?? []) e.addFields({ name: `Stages 2–3 · ${t.name}`, value: clip(t.text, 450) })
    if (!fx) e.addFields({ name: 'Effect', value: r?.[3] ? clip(r[3], 300) : 'No effect data yet.' })
    if (r) e.addFields({ name: 'Verdict', value: [gradeWord(r[4]) && `Rated **${gradeWord(r[4])}**`, recLevel(r[6])].filter(Boolean).join(' · ') })
    e.setFooter({ text: `${FOOTER} · Effects from EN game data · Verdict from DragonGJY (fan-made)` })
  }
  const at = mods.indexOf(m)
  const rows = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      mods.map((x, k) =>
        new ButtonBuilder()
          .setCustomId(`ark:modv:${o.id}:${k}:${tab}`)
          .setLabel(x.type)
          .setStyle(k === at ? ButtonStyle.Primary : ButtonStyle.Secondary)
          .setDisabled(k === at),
      ),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`ark:modv:${o.id}:${at}:fx:tab`)
        .setLabel('Effects')
        .setStyle(tab !== 'review' || !r ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(tab !== 'review' || !r),
      new ButtonBuilder()
        .setCustomId(`ark:modv:${o.id}:${at}:review:tab`)
        .setLabel('Community review')
        .setStyle(tab === 'review' && r ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(!r || tab === 'review'),
    ),
  ]
  return { embeds: [e], components: mods.length > 1 ? rows : rows.slice(1) }
}

/** Buttons under /operator (`ark:<what>:<operator id>`): details, shown privately to whoever presses. */
export async function handleArkButton(i: ButtonInteraction): Promise<void> {
  const m = /^ark:(mod|modpc|modv|skin|base|op):(.+)$/.exec(i.customId)
  ensureData()
  const o = m && opIndex()?.byId.get(m[2].split(':')[0])
  if (!m || !o) {
    await i.reply({ content: '[PRTS] That record is no longer available. I apologize.', flags: MessageFlags.Ephemeral })
    return
  }
  const eph = MessageFlags.Ephemeral
  brand(i, { mod: SECTION.operator, modpc: SECTION.operator, modv: SECTION.operator, op: SECTION.operator, skin: SECTION.skin, base: SECTION.base }[m[1]])
  if (m[1] === 'mod' || m[1] === 'modpc' || m[1] === 'modv') {
    const [, idx, tab] = /^[^:]+(?::(\d+):(\w+))?(?::tab)?$/.exec(m[2].replace(/^[^:]+/, 'x')) ?? []
    const view = moduleView(o, Number(idx ?? 0), tab ?? (m[1] === 'modpc' ? 'review' : 'fx'))
    if (m[1] === 'modv' && i.message?.flags?.has(MessageFlags.Ephemeral)) await i.update(view)
    else await i.reply({ ...view, flags: eph })
  } else if (m[1] === 'op') {
    await i.reply({ ...operatorCard(o), flags: eph })
  } else if (m[1] === 'base') {
    await i.reply({ embeds: [baseOpEmbed(o)], flags: eph })
  } else {
    await i.deferReply({ flags: eph })
    const list = await getOutfits(o.id).catch(() => [])
    if (!list.length) {
      await i.editReply({ content: `[PRTS] No outfit records found for **${o.name}**. I apologize.` })
      return
    }
    await i.editReply({ embeds: [outfitListEmbed(o, list)], components: skinButtons(o, undefined, list) })
  }
}

// ───────────────────────── /farm ─────────────────────────

function findMaterial(q: string, sh: Sheets) {
  const n = normName(q)
  for (const [key, v] of sh.farm) if (normName(key) === n || normName(v.label).includes(n)) return { key, ...v }
  for (const [key, v] of sh.farm)
    if (
      normName(v.label)
        .split(' ')
        .some(w => w.startsWith(n))
    )
      return { key, ...v }
  // Tier names ("Orirock Cube", "Integrated Device", "Sugar Pack") share their family's tab.
  const words = n.split(' ').filter(w => w.length >= 3)
  const names = (key: string) => [key, ...(FARM_ALIAS[key] ?? '').split(' ')].map(normName).filter(Boolean)
  if (words.length > 1) for (const w of words) for (const [key, v] of sh.farm) if (names(key).includes(w)) return { key, ...v }
  return null
}

async function cmdFarm(i: ChatInputCommandInteraction, eph: boolean) {
  const sh = loadSheets()
  const q = i.options.getString('material', true)
  const m = sh && findMaterial(q, sh)
  if (!m) return i.reply({ content: `[PRTS] No farming record for "${clip(q, 60)}". Try names like Orirock, Device, RMA, Gel or Alloy.`, flags: MessageFlags.Ephemeral })
  if (!m.rows.length) {
    const e = embed(`Farming: ${m.label}`)
      .setDescription(
        `No stage is worth farming for this material. The sheet's advice: **buy it from event shops instead**.\n[Open the full sheet](https://docs.google.com/spreadsheets/d/1RRiTIYVUNUf-xW8ljAJdYEOuSo23lpjHkPa0-zuC_4k/htmlview)`,
      )
      .setFooter({ text: `${FOOTER} · PeterYR farming sheet (fan-made, Penguin Statistics data) · checked ${sheetDate('peteryr-farming.txt')}` })
    return i.reply({ embeds: [e], flags: ephFlag(eph) })
  }
  // A tier name ("Orirock Cube") lands on its family's tab; say so, so the title does not look wrong.
  const fam = m.label.replace(/ \(.*\)$/, '')
  const family =
    normName(m.label).includes(normName(q)) || normName(m.key) === normName(q)
      ? ''
      : `**${clip(q, 60)}** is listed under its material family, **${fam}**. These stages are the most efficient for that family; craft up in the Workshop as needed.\n\n`
  const lines = m.rows
    .slice(0, 10)
    .map(([st, eff, drop], idx) => `\`${String(idx + 1).padStart(2)}\` **${st}** · efficiency ${(eff * 100).toFixed(1)}%${isNaN(drop) ? '' : ` · main drop ${(drop * 100).toFixed(1)}%`}`)
  const e = embed(`Farming: ${m.label}`)
    .setDescription(
      `${family}${lines.join('\n')}\n\nEfficiency is relative to the best stage (100%). "(perm)" stages are permanent event reruns.\n[Open the full sheet](https://docs.google.com/spreadsheets/d/1RRiTIYVUNUf-xW8ljAJdYEOuSo23lpjHkPa0-zuC_4k/htmlview) · [Penguin Statistics](https://penguin-stats.io)`,
    )
    .setFooter({ text: `${FOOTER} · PeterYR farming sheet (fan-made, Penguin Statistics data) · checked ${sheetDate('peteryr-farming.txt')}` })
  return i.reply({ embeds: [e], flags: ephFlag(eph) })
}

// ───────────────────────── /recruit ─────────────────────────

function opRecruitTags(o: Op): Set<string> {
  const t = new Set<string>([o.cls, o.pos, ...o.tags])
  if (o.rarity === 6) t.add('Top Operator')
  if (o.rarity === 5) t.add('Senior Operator')
  if (o.rarity === 2) t.add('Starter')
  if (o.rarity === 1) t.add('Robot')
  return t
}

async function cmdRecruit(i: ChatInputCommandInteraction, eph: boolean) {
  ensureData()
  if (!data) return notReady(i, eph)
  const known = new Map(data.recruitTags.map(t => [normName(t), t]))
  const chosen: string[] = []
  for (const v of (i.options.getString('tags') ?? '')
    .split(/[,;|]/)
    .map(x => x.trim())
    .filter(Boolean)) {
    const t = known.get(normName(v))
    if (!t) return i.reply({ content: `[PRTS] "${clip(v, 40)}" is not a recruitment tag. Please separate tags with commas and pick from the suggestions.`, flags: MessageFlags.Ephemeral })
    if (!chosen.includes(t)) chosen.push(t)
  }
  if (chosen.length > 5) return i.reply({ content: '[PRTS] Recruitment shows five tags at most. Please enter up to five.', flags: MessageFlags.Ephemeral })
  const pool = data.ops.filter(o => o.recruit).map(o => ({ o, tags: opRecruitTags(o) }))
  const combos: { tags: string[]; ops: Op[]; min: number }[] = []
  const n = chosen.length
  for (let mask = 1; mask < 1 << n; mask++) {
    const tags = chosen.filter((_, b) => mask & (1 << b))
    if (tags.length > 3) continue
    let ops = pool.filter(p => tags.every(t => p.tags.has(t))).map(p => p.o)
    if (!tags.includes('Top Operator')) ops = ops.filter(o => o.rarity < 6)
    if (!ops.length) continue
    const special = tags.includes('Robot') || tags.includes('Starter')
    const counted = special ? ops : ops.filter(o => o.rarity >= 3) // 9-hour recruits skip 1–2★
    if (!counted.length) continue
    combos.push({ tags, ops: counted.sort((a, b) => b.rarity - a.rarity), min: Math.min(...counted.map(o => o.rarity)) })
  }
  const good = combos.filter(c => c.min >= 4 || c.tags.includes('Robot')).sort((a, b) => b.min - a.min || a.ops.length - b.ops.length)
  const e = embed(`Recruitment analysis: ${chosen.join(', ')}`)
  if (!good.length) {
    e.setColor(COLOR.dim).setDescription('No combination guarantees a 4★ or better operator. Recommendation: set the timer to 9:00:00 for experience, or refresh the tags.')
  } else {
    if (chosen.includes('Top Operator')) e.setColor(COLOR.ok).setDescription('**Top Operator** detected. Set the timer to 9:00:00 and select it. A 6★ operator is guaranteed. Congratulations.')
    else e.setDescription('Set the timer to **9:00:00** and select one of these tag sets. Minimum rarity is guaranteed.')
    for (const c of good.slice(0, 12)) {
      const label = c.tags.includes('Robot') && c.min < 4 ? '1★ Robot' : `${c.min}★+`
      e.addFields({
        name: `${label} · ${c.tags.join(' + ')}`,
        value: clip(c.ops.map(o => `${o.name} ${o.rarity}★`).join(', '), 1024),
      })
    }
  }
  e.setFooter({ text: `${FOOTER} · Recruitment pool from EN game data` })
  return i.reply({ embeds: [e], flags: ephFlag(eph) })
}

// ───────────────────────── /wiki ─────────────────────────

async function wikiApi(params: Record<string, string>, timeoutMs = 8000): Promise<any> {
  const u = new URL(WIKI + '/api.php')
  for (const [k, v] of Object.entries({ format: 'json', ...params })) u.searchParams.set(k, v)
  const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) })
  if (!r.ok) throw new Error(`wiki ${r.status}`)
  return r.json()
}

async function wikiLookup(q: string): Promise<EmbedBuilder | null> {
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

async function cmdWiki(i: ChatInputCommandInteraction, eph: boolean) {
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

// ───────────────────────── /story ─────────────────────────

type Story = { group: string; group_name: string; kind: string; code: string; name: string; tag: string; file: string; synopsis: string; operator: string; speakers?: Record<string, number> }
let stories: Story[] | null = null
let storiesPath = STORIES_JSON
let storiesMtime = 0
function loadStories(): Story[] {
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
function storyAppearances(name: string): { lines: number; stories: number; groups: string[] } | null {
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

async function cmdStory(i: ChatInputCommandInteraction, eph: boolean) {
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

// ───────────────────────── /base ─────────────────────────

// The RIIC guide's shorthand, spelled out so the effects read in plain words.
const RIIC_WORDS: [RegExp, string][] = [
  [/\bMD (CC|TPs?|PPs?|RR|HR|Facs?)\b/g, 'morale drain per hour ($1)'],
  [/\bMD\b/g, 'morale drain'],
  [/\bCC\b/g, 'Control Center'],
  [/\bTPs?\b/g, 'Trading Post'],
  [/\bPPs?\b/g, 'Power Plant'],
  [/\bRR\b/g, 'Reception Room'],
  [/\bHR\b/g, 'Office'],
  [/\bFacs?\b/g, 'Factory'],
  [/\bDORMs?\b/gi, 'Dormitory'],
  [/\bprod\b/gi, 'productivity'],
  [/\b(\d)(\d)(\d) setup\b/g, '$1-$2-$3 base layout'],
  [/\b2XX setup\b/g, '2-x-x base layout'],
]
const riic = (t: string) => RIIC_WORDS.reduce((x, [re, w]) => x.replace(re, w), t ?? '')
/** Member names of a team, each with their operator portrait link when known. */
function teamMembers(t: { members: string }): { names: string[]; first?: Op } {
  const names = t.members
    .split(/\s*(?:,|\+|\/|\band\b)\s*/)
    .map(x => x.trim())
    .filter(x => x && !/^\d|setup|lv\d|all /i.test(x))
  const first = names.map(n => findOps(n, 1)[0]).find(Boolean)
  return { names, first }
}

function baseOpEmbed(o: Op): EmbedBuilder {
  const sh = loadSheets()
  const footer = `${FOOTER} · RIIC base skill guide (fan-made, live from Google Sheets) · checked ${sheetDate('riic-base-skills.txt')}`
  const e = embed(`Base skills: ${o.name}`).setURL(RIIC_URL).setThumbnail(`https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/main/avatar/${o.id}.png`).setFooter({ text: footer })
  const rooms = [...new Set((o.base ?? []).map(b => b.room))]
  e.setDescription(o.base?.length ? `${'★'.repeat(o.rarity)} · ${o.cls}\nWorks best in: **${rooms.join(', ')}**` : 'No base skills found in game data.')
  for (const b of (o.base ?? []).slice(0, 6)) e.addFields({ name: `${b.name} · ${b.room} · unlocks at ${b.unlock.replace(/^E(\d)/, 'Elite $1')}`, value: clip(b.desc, 1024) })
  const note = sh?.notes.get(normName(o.name))
  if (note) e.addFields({ name: `Guide notes (${riic(note.facilities)})`, value: clip(riic(note.text).replace(/ - /g, '\n- '), 1024) })
  const key = normName(o.name)
  const teams = (sh?.teams ?? []).filter(t => t.tokens.has(key))
  if (teams.length) e.addFields({ name: 'Appears in team combos', value: clip(teams.map(t => `**${t.title}** (${t.facility})`).join('\n'), 1024) })
  return e
}

async function cmdBase(i: ChatInputCommandInteraction, eph: boolean) {
  ensureData()
  const sh = loadSheets()
  const opQ = i.options.getString('operator')
  const teamQ = i.options.getString('team')
  const fac = i.options.getString('facility')
  const footer = `${FOOTER} · RIIC base skill guide (fan-made, live from Google Sheets) · checked ${sheetDate('riic-base-skills.txt')}`
  if (opQ) {
    if (!data) return notReady(i, eph)
    const o = findOps(opQ, 1)[0]
    if (!o) return i.reply({ content: `[PRTS] No operator matches "${clip(opQ, 60)}".`, flags: MessageFlags.Ephemeral })
    return i.reply({ embeds: [baseOpEmbed(o)], flags: ephFlag(eph) })
  }
  if (teamQ) {
    const n = normName(teamQ)
    const t = sh?.teams.find(x => normName(x.title) === n) ?? sh?.teams.find(x => normName(x.title).includes(n))
    if (!t) return i.reply({ content: `[PRTS] No team combo matches "${clip(teamQ, 60)}". Use the suggestions or /base facility:.`, flags: MessageFlags.Ephemeral })
    const m = teamMembers(t)
    const e = embed(t.title)
      .setURL(RIIC_URL)
      .setDescription(`**${t.facility}**${t.effect ? ` · ${riic(t.effect)}` : ''}`)
      .setFooter({ text: footer })
    if (m.first) e.setThumbnail(`https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/main/avatar/${m.first.id}.png`)
    if (t.members) e.addFields({ name: 'Core members', value: clip(riic(t.members), 1024) })
    if (t.desc) e.addFields({ name: 'How it works', value: clip(riic(t.desc), 1024) })
    e.addFields({ name: 'More', value: "Use `/base operator:<name>` for one member's base skills." })
    return i.reply({ embeds: [e], flags: ephFlag(eph) })
  }
  const list = (sh?.teams ?? []).filter(t => !fac || t.facility === fac)
  const e = embed(fac ? `Base team combos: ${fac}` : 'Base team combos')
    .setURL(RIIC_URL)
    .setFooter({ text: footer })
  if (!fac) {
    const by = new Map<string, string[]>()
    for (const t of list) by.set(t.facility, [...(by.get(t.facility) ?? []), t.title])
    e.setDescription('Use `/base operator:` for one operator, `/base team:` for details, or `/base facility:` to filter.')
    for (const [f, ts] of by) e.addFields({ name: f, value: clip(ts.join(', '), 1024) })
  } else {
    e.setDescription('Use `/base team:<name>` for how a team works.')
    for (const t of list.slice(0, 24))
      e.addFields({ name: t.title, value: clip([t.effect ? riic(t.effect) : '', t.members ? `Members: ${riic(t.members)}` : ''].filter(Boolean).join('\n') || '—', 1024) })
  }
  return i.reply({ embeds: [e], flags: ephFlag(eph) })
}

// ───────────────────────── /myrtle ─────────────────────────
// Public player data from myrtle.moe's backend (the same JSON its site uses).
// Only public profiles are returned; fields a player hides come back null.

const MYRTLE_API = 'https://api.myrtle.moe/api'
const MYRTLE_LINKS = join(CACHE_DIR, 'myrtle-links.json')
const SCORE_NAMES: Record<string, string> = {
  total_score: 'Total',
  operator_score: 'Operators',
  stage_score: 'Stages',
  roguelike_score: 'Integrated Strategies',
  sandbox_score: 'Reclamation Algorithm',
  medal_score: 'Medals',
  base_score: 'Base (RIIC)',
}

type MUser = {
  uid: string
  nickname: string
  nick_number: string
  level: number
  server: string
  avatar_id?: string
  secretary?: string
  secretary_skin_id?: string
  resume?: string
  total_score?: number
  grade?: string
  public_profile?: boolean
  orundum?: number | null
  lmd?: number | null
  originite?: number | null
  max_sanity?: number | null
  monthly_sub_end?: number | null
  register_ts?: number | null
  last_online_ts?: number | null
  cumulative_signin?: number | null
  operator_count?: number
  skin_count?: number
  updated_at?: string
  rank_global?: number
  rank_server?: number
  [k: string]: any
}
type MRosterOp = {
  operator_id: string
  elite: number
  level: number
  potential: number
  skill_level: number
  favor_point: number
  skin_id: string
  obtained_at: number
  masteries: { index: number; mastery: number }[]
  modules: { id: string; level: number; locked: boolean }[]
}

type MPull = { charId: string; star: string; poolId: string; at: number }
// Myrtle's API keys (limited/regular/special) don't match the site's banner types, so pulls are regrouped by pool id.
const PULL_KINDS: Record<string, string> = { limited: 'Limited', standard: 'Standard', kernel: 'Kernel', beginner: 'Beginner' }
const pullKind = (poolId: string) => (/^LIMITED/.test(poolId) ? 'limited' : /^(FESCLASSIC|CLASSIC_DOUBLE)/.test(poolId) ? 'kernel' : /^BOOT/.test(poolId) ? 'beginner' : 'standard')

// Item names for /myrtle inventory: the game's item table, cached for a day.
type ItemTable = Record<string, { name: string; rarity: any; sortId: number }>
let itemTable: { at: number; items: ItemTable } | null = null
async function getItems(): Promise<ItemTable> {
  if (itemTable && Date.now() - itemTable.at < 24 * 3600_000) return itemTable.items
  const r = await fetch(`${GAMEDATA}item_table.json`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) })
  if (!r.ok) throw new Error(`item_table ${r.status}`)
  itemTable = { at: Date.now(), items: (await r.json()).items ?? {} }
  return itemTable.items
}
const rarityNum = (r: any) => (typeof r === 'number' ? r + 1 : Number(/(\d+)/.exec(String(r))?.[1] ?? 1))
// Myrtle's showcase names can arrive as UTF-8 read as Latin-1; undo that when it round-trips cleanly.
const fixText = (s: string | null | undefined) => {
  if (!s) return ''
  if (!/[Â-Å]/.test(s)) return s
  const t = Buffer.from(s, 'latin1').toString('utf8')
  return t.includes('�') ? s : t
}

async function myrtleGet(path: string, timeoutMs = 15_000): Promise<any> {
  const r = await fetch(`${MYRTLE_API}/${path}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) })
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`myrtle ${r.status} ${path}`)
  return r.json()
}
const myrtleSearch = async (q: string, limit = 25, timeoutMs?: number): Promise<{ entries: MUser[]; total: number }> =>
  (await myrtleGet(`search?q=${encodeURIComponent(q)}&limit=${limit}`, timeoutMs)) ?? { entries: [], total: 0 }
const myrtleUrl = (uid: string) => `${MYRTLE}/user/${uid}`
const tag = (u: MUser) => (u.nick_number ? `${u.nickname}#${u.nick_number}` : u.nickname)
// Myrtle's avatar URL scheme: "@" becomes "_" and the "#N" stays; without an "@", a trailing "#N" is dropped.
const myrtleAvatar = (id?: string) => {
  if (!id) return null
  const s = id.includes('@') ? id.replace(/@/g, '_') : id.replace(/#\d+$/, '')
  return `${MYRTLE_API}/avatar/${encodeURIComponent(s)}`
}
const pct = (x?: number | null) => (typeof x === 'number' ? `${(x * 100).toFixed(1)}%` : '—')
const num = (x?: number | null) => (typeof x === 'number' ? x.toLocaleString('en-US') : null)
const opInfo = (id: string) => opIndex()?.byId.get(id)
const opName = (id: string) => opInfo(id)?.name ?? id.replace(/^char_\d+_/, '')

function loadLinks(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(MYRTLE_LINKS, 'utf8'))
  } catch {
    return {}
  }
}
function saveLinks(l: Record<string, string>) {
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(MYRTLE_LINKS + '.tmp', JSON.stringify(l, null, 2))
  renameSync(MYRTLE_LINKS + '.tmp', MYRTLE_LINKS)
}

// Name, Name#1234, UID or a myrtle.moe/user/<uid> link → one user (or why not).
async function resolvePlayer(q: string): Promise<{ user: MUser; others: MUser[] } | string> {
  const s = q.trim()
  const url = /myrtle\.moe\/user\/(\d+)/i.exec(s)
  const uid = url?.[1] ?? (/^\d{5,12}$/.test(s) ? s : null)
  if (uid) {
    const u = await myrtleGet(`get-user?uid=${uid}`)
    if (u?.uid) return { user: u, others: [] }
    if (url) return `No public Myrtle profile has UID ${uid}. It may be private or not uploaded yet.`
  }
  const m = /^(.*?)#(\d{1,6})$/.exec(s)
  const name = (m?.[1] ?? s).trim()
  if (!name) return 'Please give a name, Name#1234, UID or myrtle.moe link.'
  const { entries } = await myrtleSearch(name, 50)
  let hits = entries
  if (m) hits = hits.filter(e => e.nick_number === m[2].padStart(4, '0') || e.nick_number === m[2])
  const exact = hits.filter(e => e.nickname.toLowerCase() === name.toLowerCase())
  const pick = exact.length ? exact : hits
  if (!pick.length) return `No public Myrtle profile matches "${clip(s, 60)}". The player may not have uploaded their account, or the profile is private.`
  const full = (await myrtleGet(`get-user?uid=${pick[0].uid}`)) ?? pick[0]
  return { user: full, others: pick.slice(1, 6) }
}

// The player to show: the player: option, else the user: option's link, else your own link.
async function targetPlayer(i: ChatInputCommandInteraction): Promise<{ user: MUser; others: MUser[] } | string> {
  const q = i.options.getString('player')
  if (q) return resolvePlayer(q)
  const du = i.options.getUser('user')
  const links = loadLinks()
  const uid = links[(du ?? i.user).id]
  if (!uid)
    return du
      ? `${du.username} has not linked a Myrtle profile. They can use \`/myrtle link\`.`
      : 'No Myrtle profile is linked to your account. Use `/myrtle link player:<name#1234 or UID>`, or give `player:`.'
  return resolvePlayer(uid)
}

const fail = (i: ChatInputCommandInteraction, msg: string) => i.editReply({ embeds: [embed('Record not found').setColor(COLOR.warn).setDescription(msg)] })

// "Y3" (type letter + level), or "TYP-Y Lv3" in long form; falls back to the level.
function modLabel(opId: string, m: { id: string; level: number }, long = false): string {
  const t = opInfo(opId)?.modules.find(x => x.id === m.id)?.type
  if (!t) return `Lv${m.level}`
  return long ? `${t} Lv${m.level}` : `${t.split('-').pop()}${m.level}`
}

function opLine(r: MRosterOp): string {
  const o = opInfo(r.operator_id)
  const m = r.masteries.map(x => x.mastery)
  const mods = r.modules.filter(x => !x.locked && x.level > 0)
  return [
    `${o ? o.rarity + '★ ' : ''}**${opName(r.operator_id)}**`,
    `E${r.elite} Lv${r.level}`,
    `P${r.potential + 1}`,
    `SL${r.skill_level}`,
    m.some(Boolean) ? `M${m.join('/')}` : '',
    mods.length ? `Mod ${mods.map(x => modLabel(r.operator_id, x)).join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

function rosterStats(ros: MRosterOp[]): string {
  const c = (f: (r: MRosterOp) => boolean) => ros.filter(f).length
  const six = c(r => opInfo(r.operator_id)?.rarity === 6)
  const m9 = c(r => r.masteries.length > 0 && r.masteries.filter(x => x.mastery === 3).length >= 1)
  const m3s = ros.reduce((n, r) => n + r.masteries.filter(x => x.mastery === 3).length, 0)
  const mods = ros.reduce((n, r) => n + r.modules.filter(x => !x.locked && x.level > 0).length, 0)
  return [
    `**${ros.length}** operators · **${six}** 6★`,
    `**${c(r => r.elite === 2)}** at E2 · **${c(r => r.elite === 2 && r.level >= 90)}** at E2 Lv90`,
    `**${m3s}** M3 skills on **${m9}** operators · **${c(r => r.masteries.length > 0 && r.masteries.every(x => x.mastery === 3))}** fully mastered`,
    `**${mods}** modules unlocked · **${c(r => r.favor_point >= 25570)}** at 200% trust`,
  ].join('\n')
}

async function cmdMyrtle(i: ChatInputCommandInteraction, eph: boolean) {
  const sub = i.options.getSubcommand()
  ensureData()

  if (sub === 'unlink') {
    const links = loadLinks()
    const had = links[i.user.id]
    delete links[i.user.id]
    saveLinks(links)
    return i.reply({ content: had ? '[PRTS] Myrtle link removed. Your records remain on myrtle.moe.' : '[PRTS] No Myrtle profile was linked to your account.', flags: MessageFlags.Ephemeral })
  }

  await i.deferReply({ flags: ephFlag(sub === 'link' || eph) })

  if (sub === 'link') {
    const r = await resolvePlayer(i.options.getString('player', true))
    if (typeof r === 'string') return fail(i, r)
    const links = loadLinks()
    links[i.user.id] = r.user.uid
    saveLinks(links)
    return i.editReply({
      embeds: [
        embed('Identity verification complete.')
          .setColor(COLOR.ok)
          .setDescription(
            `Your Discord account is now linked to **[${tag(r.user)}](${myrtleUrl(r.user.uid)})** (${r.user.server}, UID ${r.user.uid}).\n` +
              '`/myrtle profile` and `/myrtle roster` will show this account by default, and others can find it with `user:`.',
          )
          .setThumbnail(myrtleAvatar(r.user.avatar_id)),
      ],
    })
  }

  if (sub === 'search') {
    const q = i.options.getString('name', true)
    const { entries, total } = await myrtleSearch(q, 15)
    if (!entries.length) return fail(i, `No public Myrtle profile matches "${clip(q, 60)}".`)
    const e = embed(`Myrtle players matching "${clip(q, 40)}"`)
      .setURL(`${MYRTLE}/user/search`)
      .setDescription(entries.map(u => `[**${tag(u)}**](${myrtleUrl(u.uid)}) · ${u.server} · Lv${u.level} · ${u.grade ?? '?'} (${pct(u.total_score)}) · ${u.operator_count ?? '?'} ops`).join('\n'))
      .setFooter({ text: `${FOOTER} · ${total} result(s)${total > entries.length ? `, showing ${entries.length}` : ''} · Data from myrtle.moe` })
    return i.editReply({ embeds: [e] })
  }

  if (sub === 'leaderboard') {
    const sort = i.options.getString('sort') ?? 'total_score'
    const server = i.options.getString('server')
    const lb = await myrtleGet(`leaderboard?sort=${sort}&limit=15${server ? `&server=${server}` : ''}`)
    const rows: MUser[] = lb?.entries ?? []
    if (!rows.length) return fail(i, 'The leaderboard returned no entries.')
    const e = embed(`Myrtle leaderboard · ${SCORE_NAMES[sort]}${server ? ` · ${server}` : ''}`)
      .setURL(`${MYRTLE}/user/leaderboard`)
      .setDescription(
        rows
          .map(
            (u, k) =>
              `\`${String(k + 1).padStart(2)}\` [**${tag(u)}**](${myrtleUrl(u.uid)}) · ${u.server} · Lv${u.level} · **${pct(u[sort])}**${sort !== 'total_score' ? ` (total ${u.grade ?? ''} ${pct(u.total_score)})` : ` · ${u.grade ?? ''}`}`,
          )
          .join('\n'),
      )
      .setFooter({ text: `${FOOTER} · ${num(lb.total) ?? '?'} ranked accounts · Myrtle's account score, not an official ranking` })
    return i.editReply({ embeds: [e] })
  }

  const t = await targetPlayer(i)
  if (typeof t === 'string') return fail(i, t)
  const u = t.user

  if (sub === 'pulls') {
    const raw: Record<string, { records: MPull[] }> | null = await myrtleGet(`gacha/public-records?uid=${u.uid}`).catch(() => null)
    const data: Record<string, { records: MPull[] }> | null = raw && {}
    if (raw && data) {
      for (const v of Object.values(raw)) for (const x of v.records ?? []) (data[pullKind(x.poolId)] ??= { records: [] }).records.push(x)
      for (const v of Object.values(data)) v.records.sort((a, b) => b.at - a.at) // newest first
    }
    const only = i.options.getString('banner')
    const kinds = Object.entries(PULL_KINDS).filter(([k]) => !only || k === only)
    const have = kinds.filter(([k]) => data?.[k]?.records?.length)
    if (!data || !have.length) return fail(i, `**${tag(u)}** has no public pull history. They can upload it and switch on public pulls in their Myrtle settings.`)
    const e = embed(`${tag(u)} · Headhunting`)
      .setURL(`${myrtleUrl(u.uid)}?tab=pulls`)
      .setThumbnail(myrtleAvatar(u.avatar_id))
    const sixes: (MPull & { kind: string })[] = []
    let all = 0
    for (const [k, name] of have) {
      const r = data[k].records // newest first
      const n = (s: string) => r.filter(x => x.star === s).length
      // Limited pity doesn't carry between limited banners, so only count within the latest banner.
      const scope = k === 'limited' ? r.filter(x => x.poolId === r[0].poolId) : r
      const since = scope.findIndex(x => x.star === '6')
      all += r.length
      for (const x of r) if (x.star === '6') sixes.push({ ...x, kind: name })
      e.addFields({
        name: name,
        inline: true,
        value: [
          `**${r.length}** pulls`,
          `6★ **${n('6')}** (${((n('6') / r.length) * 100).toFixed(2)}%) · 5★ **${n('5')}** (${((n('5') / r.length) * 100).toFixed(2)}%)`,
          k === 'limited'
            ? `**${since < 0 ? scope.length : since}** since last 6★ in the latest banner (resets each limited banner; 0 if it has ended)`
            : since < 0
              ? 'No 6★ yet'
              : `**${since}** since last 6★`,
        ].join('\n'),
      })
    }
    sixes.sort((a, b) => b.at - a.at)
    const line = (x: MPull & { kind: string }) => `6★ **${opName(x.charId)}** · ${x.kind} · <t:${Math.floor(x.at / 1000)}:d>`
    const fives = have.flatMap(([k, name]) => data[k].records.filter(x => x.star === '5').map(x => ({ ...x, kind: name }))).sort((a, b) => b.at - a.at)
    e.setDescription(
      [
        `**${all}** recorded pulls · pulls are grouped into banner types the same way as the Myrtle website`,
        sixes.length ? '\n**Latest 6★**\n' + sixes.slice(0, 8).map(line).join('\n') : '',
        fives.length
          ? '\n**Latest 5★**\n' +
            fives
              .slice(0, 5)
              .map(x => `5★ ${opName(x.charId)} · ${x.kind} · <t:${Math.floor(x.at / 1000)}:d>`)
              .join('\n')
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    ).setFooter({ text: `${FOOTER} · Public pull data from myrtle.moe` })
    return i.editReply({ embeds: [e] })
  }

  if (sub === 'inventory') {
    const inv: { item_id: string; quantity: number }[] | null = await myrtleGet(`inventory?uid=${u.uid}`).catch(() => null)
    if (!inv?.length) return fail(i, `**${tag(u)}** does not share an inventory publicly.`)
    const items = await getItems().catch(() => ({}) as ItemTable)
    const q = (i.options.getString('item') ?? '').trim().toLowerCase()
    const rows = inv
      .map(x => ({ name: items[x.item_id]?.name ?? x.item_id, q: x.quantity, r: rarityNum(items[x.item_id]?.rarity), sort: items[x.item_id]?.sortId ?? 0 }))
      .filter(x => x.q > 0 && (!q || x.name.toLowerCase().includes(q)))
      .sort((a, b) => b.r - a.r || b.sort - a.sort || b.q - a.q)
    if (!rows.length) return fail(i, `No item in ${tag(u)}'s inventory matches "${clip(q, 60)}".`)
    const lines = rows.map(x => `${'★'.repeat(Math.min(x.r, 6))} ${x.name} **×${num(x.q)}**`)
    const pages = linePages(
      lines,
      (body, k, n) =>
        embed(`${tag(u)} · Inventory`)
          .setURL(`${myrtleUrl(u.uid)}?tab=inventory`)
          .setThumbnail(myrtleAvatar(u.avatar_id))
          .setDescription(body)
          .setFooter({ text: `${FOOTER} · ${rows.length} items${q ? ' (filtered)' : ''} · page ${k + 1} of ${n} · Data from myrtle.moe` }),
      3000,
      25,
    )
    return i.editReply(paged(pages))
  }

  if (sub === 'lookback') {
    const lb: { snapshots?: { period_start: string; activity_name?: string; summary: Record<string, any> }[] } | null = await myrtleGet(`lookback?uid=${u.uid}`).catch(() => null)
    const snaps = [...(lb?.snapshots ?? [])].sort((a, b) => a.period_start.localeCompare(b.period_start))
    if (!snaps.length) return fail(i, `**${tag(u)}** has no public progress snapshots yet.`)
    const last = snaps.slice(-6)
    const stats: [string, string][] = [
      ['operators', 'Operators'],
      ['elite2', 'E2'],
      ['skill_level7', 'SL7'],
      ['masteries', 'Masteries'],
      ['mastery3', 'M3'],
      ['modules', 'Modules'],
      ['module_stage3', 'Mod Lv3'],
      ['max_potential', 'Pot 6'],
      ['skins', 'Outfits'],
    ]
    const e = embed(`${tag(u)} · Lookback`)
      .setURL(`${myrtleUrl(u.uid)}?tab=lookback`)
      .setThumbnail(myrtleAvatar(u.avatar_id))
    last.forEach((sn, k) => {
      const prev = snaps[snaps.length - last.length + k - 1]
      const d = (key: string) => {
        const a = sn.summary[key],
          b = prev?.summary[key]
        return typeof a === 'number' && typeof b === 'number' && a !== b ? ` (${a > b ? '+' : ''}${a - b})` : ''
      }
      const sc = sn.summary.total_score,
        ps = prev?.summary.total_score
      e.addFields({
        name: `${clip(sn.activity_name ?? 'Snapshot', 60)} · <t:${Math.floor(Date.parse(sn.period_start) / 1000)}:d>`,
        value:
          stats
            .filter(([key]) => typeof sn.summary[key] === 'number')
            .map(([key, n]) => `${n} **${sn.summary[key]}**${d(key)}`)
            .join(' · ') +
          `\nScore **${sn.summary.grade ?? '?'}** ${pct(sc)}${typeof sc === 'number' && typeof ps === 'number' && sc !== ps ? ` (${sc > ps ? '+' : ''}${((sc - ps) * 100).toFixed(1)} pts)` : ''}`,
      })
    })
    e.setFooter({ text: `${FOOTER} · Latest ${last.length} of ${snaps.length} snapshots · Data from myrtle.moe` })
    return i.editReply({ embeds: [e] })
  }

  if (sub === 'plans') {
    const pl: { id?: string; operator_id: string; groups?: string[] }[] | null = await myrtleGet(`plans/public?uid=${u.uid}`).catch(() => null)
    if (!Array.isArray(pl) || !pl.length) return fail(i, `**${tag(u)}** has no public operator plans.`)
    const groups = new Map<string, string[]>()
    for (const p of pl) for (const g of p.groups?.length ? p.groups : ['Ungrouped']) groups.set(g, [...(groups.get(g) ?? []), opName(p.operator_id)])
    const e = embed(`${tag(u)} · Plans`)
      .setURL(`${myrtleUrl(u.uid)}?tab=plans`)
      .setThumbnail(myrtleAvatar(u.avatar_id))
      .setDescription(`**${pl.length}** planned operators. Open the profile for the exact targets.`)
    for (const [g, names] of [...groups].slice(0, 15)) e.addFields({ name: `${clip(g, 60)} (${names.length})`, value: clip(names.join(' · '), 1000) })
    e.setFooter({ text: `${FOOTER} · Data from myrtle.moe` })
    return i.editReply({ embeds: [e] })
  }

  if (sub === 'showcase') {
    const sc: { blocks?: { block: any; removed?: boolean; entities?: { id: string; entity?: { name?: string } | null }[] }[] } | null = await myrtleGet(`get-user-showcase?uid=${u.uid}`).catch(
      () => null,
    )
    const blocks = (sc?.blocks ?? []).filter(b => !b.removed)
    if (!blocks.length) return fail(i, `**${tag(u)}** has not set up a profile showcase.`)
    const KINDS: Record<string, string> = { operator: 'Favourite operators', enemy: 'Favourite enemies', skin: 'Favourite outfits' }
    const e = embed(`${tag(u)} · Showcase`)
      .setURL(`${myrtleUrl(u.uid)}?tab=showcase`)
      .setThumbnail(myrtleAvatar(u.avatar_id))
    // Grids and tier lists get their own picture (Myrtle's preview image), up to Discord's 10 embeds.
    const previews: EmbedBuilder[] = []
    for (const b of blocks.slice(0, 20)) {
      const t = b.block?.type
      if ((t === 'grid' || t === 'tier_list') && b.block.slug && previews.length < 9) {
        const slug = encodeURIComponent(String(b.block.slug))
        previews.push(
          embed(
            `${t === 'grid' ? 'Grid' : 'Tier list'} · ${clip(
              String(b.block.slug)
                .replace(/-(?=[a-z0-9]*\d)[a-z0-9]{6}$/, '')
                .replace(/-/g, ' '),
              80,
            )}`,
          )
            .setURL(`${MYRTLE}/${t === 'grid' ? 'grids' : 'tier-lists'}/${slug}`)
            .setImage(`${MYRTLE}/api/og/${t === 'grid' ? 'grid-image' : 'tier-list'}/${slug}`),
        )
      }
      if (t === 'favourites') {
        const names = (b.entities ?? []).map(x => fixText(x.entity?.name ?? x.id.replace(/^(char|enemy)_\d+_/, '')))
        e.addFields({ name: `${KINDS[b.block.entity_kind] ?? 'Favourites'} (${names.length})`, value: clip(names.join(' · ') || '—', 1000) })
      } else if (t === 'tier_list') e.addFields({ name: 'Tier list', value: `[${clip(String(b.block.slug), 80)}](${MYRTLE}/tier-lists/${encodeURIComponent(b.block.slug)})` })
      else if (t === 'grid') e.addFields({ name: 'Grid', value: `[${clip(String(b.block.slug), 80)}](${MYRTLE}/grids/${encodeURIComponent(b.block.slug)})` })
      else if (t === 'plan') e.addFields({ name: 'Plan', value: `${opName(String(b.block.operator_id ?? ''))} · [Showcase](${myrtleUrl(u.uid)}?tab=showcase)` })
    }
    e.setFooter({ text: `${FOOTER} · Data from myrtle.moe` })
    for (const p of previews) p.setFooter({ text: `${FOOTER} · Preview from myrtle.moe` })
    return i.editReply({ embeds: [e, ...previews] })
  }

  const roster: MRosterOp[] = (await myrtleGet(`roster?uid=${u.uid}`).catch(() => null)) ?? []
  const others = t.others.length ? `\nOther matches: ${t.others.map(o => `[${tag(o)}](${myrtleUrl(o.uid)})`).join(', ')}` : ''

  if (sub === 'roster') {
    if (!roster.length) return fail(i, `**${tag(u)}** does not share their roster publicly.`)
    const opQ = i.options.getString('operator')
    const e = embed(`${tag(u)} · Roster`)
      .setURL(myrtleUrl(u.uid))
      .setThumbnail(myrtleAvatar(u.avatar_id))
    if (opQ) {
      const o = findOps(opQ, 1)[0]
      const r = o && roster.find(x => x.operator_id === o.id)
      if (!o) return fail(i, `No operator matches "${clip(opQ, 60)}".`)
      if (!r) return i.editReply({ embeds: [e.setDescription(`**${o.name}** is not in ${tag(u)}'s roster.${others}`)] })
      e.setTitle(`${tag(u)} · ${o.name}`)
        .setDescription(opLine(r) + others)
        .setThumbnail(`https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/main/avatar/${o.id}.png`)
        .addFields({
          name: 'Build',
          value: [
            `**Skills:** ${r.masteries.length ? r.masteries.map(x => `S${x.index + 1} ${x.mastery ? 'M' + x.mastery : `SL${r.skill_level}`}`).join(' · ') : `SL${r.skill_level}`}`,
            `**Modules:** ${r.modules.length ? r.modules.map(x => (x.locked ? `${modLabel(r.operator_id, x, true)} locked` : modLabel(r.operator_id, x, true))).join(' · ') : 'none'}`,
            `**Trust:** ${r.favor_point >= 25570 ? '200% (max)' : `${num(r.favor_point)} points`}`,
            r.obtained_at ? `**Obtained:** <t:${r.obtained_at}:D>` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        })
      const links = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Myrtle profile').setURL(myrtleUrl(u.uid)),
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Operator page').setURL(`${MYRTLE}/operators/${o.id}`),
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Wiki').setURL(wikiUrl(o.name)),
      )
      return i.editReply({ embeds: [e], components: [links] })
    }
    const sort = i.options.getString('sort') ?? 'level'
    const rar = i.options.getInteger('rarity')
    const cls = i.options.getString('class')
    let list = roster.filter(r => (!rar || opInfo(r.operator_id)?.rarity === rar) && (!cls || opInfo(r.operator_id)?.cls === cls))
    const rarity = (r: MRosterOp) => opInfo(r.operator_id)?.rarity ?? 0
    const mast = (r: MRosterOp) => r.masteries.reduce((n, x) => n + x.mastery, 0)
    const mods = (r: MRosterOp) => r.modules.reduce((n, x) => n + (x.locked ? 0 : x.level), 0)
    const by: Record<string, (a: MRosterOp, b: MRosterOp) => number> = {
      level: (a, b) => b.elite - a.elite || b.level - a.level || rarity(b) - rarity(a),
      rarity: (a, b) => rarity(b) - rarity(a) || b.elite - a.elite || b.level - a.level,
      mastery: (a, b) => mast(b) - mast(a) || b.elite - a.elite || b.level - a.level,
      module: (a, b) => mods(b) - mods(a) || b.elite - a.elite || b.level - a.level,
      recent: (a, b) => b.obtained_at - a.obtained_at,
    }
    list = list.sort(by[sort] ?? by.level)
    const shown: string[] = []
    for (const r of list) {
      const line = opLine(r)
      if (shown.join('\n').length + line.length > 3600 || shown.length >= 20) break
      shown.push(line)
    }
    e.setDescription((shown.join('\n') || 'No operators match those filters.') + others)
      .addFields({ name: 'Roster summary', value: rosterStats(roster) })
      .setFooter({ text: `${FOOTER} · Showing ${shown.length} of ${list.length}${rar || cls ? ' (filtered)' : ''} · Data from myrtle.moe` })
    return i.editReply({ embeds: [e] })
  }

  // profile
  const [score, supports, rank, enemies] = await Promise.all([
    myrtleGet(`get-user-score?uid=${u.uid}`).catch(() => null),
    myrtleGet(`get-user-supports?uid=${u.uid}`).catch(() => null),
    myrtleGet(`leaderboard?q=${encodeURIComponent(u.nickname)}&limit=50`)
      .then(r => (r?.entries ?? []).find((x: MUser) => x.uid === u.uid))
      .catch(() => null),
    myrtleGet(`encountered-enemies?uid=${u.uid}`).catch(() => null),
  ])
  // Enemy handbook progress. The raw count includes hidden and duplicate entries (it can pass 100%), so count handbook entries.
  const hb: { encounteredCount?: number; handbookTotal?: number; enemies?: { name?: string | null; enemyIndex?: string | null }[] } | null = enemies
  const met = hb && typeof hb.encounteredCount === 'number' ? new Set((hb.enemies ?? []).filter(x => x.name && x.enemyIndex).map(x => x.enemyIndex)).size || hb.encounteredCount : null
  const now = Date.now() / 1000
  const sec = u.secretary ? opName(u.secretary) : null
  const e = embed(tag(u))
    .setURL(myrtleUrl(u.uid))
    .setThumbnail(myrtleAvatar(u.avatar_id))
    .setDescription([u.resume ? `*${clip(u.resume, 200)}*` : '', `**Lv${u.level}** · ${u.server} server · UID \`${u.uid}\`${sec ? ` · Assistant: ${sec}` : ''}`].filter(Boolean).join('\n') + others)
  const s = score ?? u
  e.addFields({
    name: 'Overview',
    value: [
      `**Account score:** ${s.grade ?? u.grade ?? '?'} · ${pct(s.total_score)}`,
      rank?.rank_global ? `**Rank:** #${num(rank.rank_global)} global · #${num(rank.rank_server)} ${u.server}` : '',
      `**Collection:** ${u.operator_count ?? roster.length} operators · ${u.skin_count ?? '?'} outfits`,
      met != null ? `**Enemy handbook:** ${met}${hb?.handbookTotal ? ` of ${hb.handbookTotal} (${Math.min(100, (met / hb.handbookTotal) * 100).toFixed(1)}%)` : ''} encountered` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  })
  if (score)
    e.addFields({
      name: 'Score breakdown',
      value: Object.entries(SCORE_NAMES)
        .filter(([k]) => k !== 'total_score')
        .map(([k, n]) => `${n}: **${pct(score[k])}**`)
        .join(' · '),
    })
  if (Array.isArray(supports) && supports.length)
    e.addFields({
      name: 'Support units',
      value: supports
        .map(
          (x: any) =>
            `**${opName(x.operator_id)}** · E${x.elite} Lv${x.level} · S${x.skill_index + 1} ${x.specialize_level ? 'M' + x.specialize_level : 'SL' + x.skill_level}${x.current_equip ? ` · Mod ${modLabel(x.operator_id, { id: x.current_equip, level: roster.find(r => r.operator_id === x.operator_id)?.modules.find(m => m.id === x.current_equip)?.level ?? 1 })}` : ''}`,
        )
        .join('\n'),
    })
  if (roster.length) e.addFields({ name: 'Roster', value: rosterStats(roster) })
  const res = [num(u.lmd) && `${num(u.lmd)} LMD`, num(u.orundum) && `${num(u.orundum)} Orundum`, num(u.originite) && `${num(u.originite)} Originite Prime`].filter(Boolean)
  if (res.length) e.addFields({ name: 'Resources', value: res.join(' · ') })
  const acct = [
    u.register_ts ? `Joined <t:${u.register_ts}:D>` : '',
    u.last_online_ts ? `Last online <t:${u.last_online_ts}:R>` : '',
    u.cumulative_signin ? `${u.cumulative_signin} check-in days` : '',
    u.monthly_sub_end ? (u.monthly_sub_end > now ? `Monthly Card until <t:${u.monthly_sub_end}:D>` : 'No active Monthly Card') : '',
  ].filter(Boolean)
  if (acct.length) e.addFields({ name: 'Account', value: acct.join(' · ') })
  e.addFields({ name: 'More', value: `Roster: \`/myrtle roster player:${u.uid}\`` })
  e.setImage(`${MYRTLE}/api/og/user/${u.uid}?v=${encodeURIComponent(u.updated_at ?? '')}`)
  e.setFooter({ text: `${FOOTER} · Data from myrtle.moe${u.updated_at ? ' · synced' : ''}` })
  if (u.updated_at) e.setTimestamp(new Date(u.updated_at))
  const links = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Myrtle profile').setURL(myrtleUrl(u.uid)),
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Leaderboard').setURL(`${MYRTLE}/user/leaderboard`),
  )
  return i.editReply({ embeds: [e], components: [links] })
}

// ───────────────────────── /skin ─────────────────────────
// Outfit data and chibi availability come from Myrtle's backend; images are
// the official art files hosted on Myrtle's asset CDN (embedded by URL).
// Animated art and chibis are Spine data that Myrtle animates in the browser,
// so the bot links to the operator's Myrtle page for those.

const MYRTLE_ASSETS = 'https://assets.eltik.net/myrtle/en/textures'
type Outfit = {
  id: string
  name: string
  line: string
  artist: string
  obtain: string
  time: number
  portrait: string
  animated: boolean
  chibi: string[]
  elite?: number
}
const outfitCache = new Map<string, { at: number; list: Outfit[] }>()

async function getOutfits(opId: string): Promise<Outfit[]> {
  const hit = outfitCache.get(opId)
  if (hit && Date.now() - hit.at < 3600_000) return hit.list
  const [skins, chibis] = await Promise.all([myrtleGet(`skins/${opId}`), myrtleGet(`chibis/${opId}`).catch(() => null)])
  const chibiOf = new Map<string, string[]>()
  for (const s of chibis?.skins ?? [])
    chibiOf.set(
      String(s.name),
      Object.keys(s.animationTypes ?? {}).filter(k => k !== 'dynamic'),
    )
  const NAMES: Record<string, string> = { dorm: 'base', front: 'battle (front)', back: 'battle (back)' }
  const list: Outfit[] = []
  for (const s of Object.values<any>(skins?.charSkins ?? {})) {
    if (s.charId !== opId || !s.portraitId) continue
    const d = s.displaySkin ?? {}
    const def = /#\d+$/.test(s.skinId) && !s.skinId.includes('@')
    const elite = def ? (s.skinId.endsWith('#1') ? 0 : 2) : undefined
    const key = def ? 'default' : (s.skinId.split('@')[1] ?? '')
    if (def && s.skinId.endsWith('#1+')) continue
    list.push({
      id: s.skinId,
      name: def ? `Default outfit (Elite ${elite})` : stripRich(d.skinName ?? s.skinId),
      line: def ? '' : stripRich(d.skinGroupName ?? ''),
      artist: (d.drawerList ?? []).join(', '),
      obtain: def ? (elite === 0 ? 'Recruited' : 'Promote to Elite 2') : stripRich(d.obtainApproach ?? ''),
      time: d.getTime ?? 0,
      portrait: s.portraitId,
      animated: !!s.dynIllustId,
      chibi: (chibiOf.get(key) ?? []).map(k => NAMES[k] ?? k),
      elite,
    })
  }
  list.sort((a, b) => (a.elite ?? 9) - (b.elite ?? 9) || a.time - b.time)
  outfitCache.set(opId, { at: Date.now(), list })
  return list
}

// Link buttons under a /skin reply: Myrtle's player for chibis and animated art.
function skinButtons(op: Op, o?: Outfit, list?: Outfit[]) {
  const page = `${MYRTLE}/operators/${op.id}`
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Chibi player').setURL(page))
  if (!o || o.animated) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Animated art').setURL(page))
  if (o) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Full-size art').setURL(outfitArt(op.id, o)))
  row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Wiki').setURL(wikiUrl(op.name)))
  const rows: ActionRowBuilder<any>[] = []
  if (list && list.length > 1)
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`ark:outfit:${op.id}`)
          .setPlaceholder('View an outfit…')
          .addOptions(list.slice(0, 25).map(x => ({ label: clip(x.name, 100), value: clip(x.id, 100), description: clip(x.line || x.obtain || ' ', 100), default: x.id === o?.id }))),
      ),
    )
  rows.push(row)
  return rows
}

/** One outfit: its art and details. */
function outfitEmbed(op: Op, o: Outfit): EmbedBuilder {
  const e = embed(`${op.name} · ${o.name}`)
    .setURL(`${MYRTLE}/operators/${op.id}`)
    .setDescription([o.line && `*${o.line}*`].filter(Boolean).join('\n') || null)
    .setImage(outfitArt(op.id, o))
    .setThumbnail(`https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/main/avatar/${op.id}.png`)
  e.addFields({
    name: 'Details',
    value: [
      o.artist ? `**Artist:** ${o.artist}` : '',
      o.obtain ? `**How to get:** ${o.obtain}` : '',
      o.time && o.elite === undefined ? `**Released (EN):** <t:${o.time}:D>` : '',
      `**Animated art:** ${o.animated ? 'yes, press Animated art below' : 'no'}`,
      `**Chibi animations:** ${o.chibi.length ? o.chibi.join(', ') : 'not available'}`,
    ]
      .filter(Boolean)
      .join('\n'),
  })
  return e.setFooter({ text: `${FOOTER} · Art © Hypergryph/Yostar, hosted by myrtle.moe` })
}

/** The outfit menu (`ark:outfit:<operator id>`). A private reply is switched in place; a public one answers privately. */
export async function handleArkSelect(i: StringSelectMenuInteraction): Promise<void> {
  if (i.customId === 'ark:help') {
    const which = i.values[0]
    const h = HELP.find(x => x.cmd === which)
    const view = stampEmbeds({ embeds: [which === 'links' ? linksEmbed() : h ? helpDetail(h) : embed('Unknown command')], components: [helpMenu()] }, SECTION.help) as any
    if (i.message?.flags?.has(MessageFlags.Ephemeral)) await i.update(view)
    else await i.reply({ ...view, flags: MessageFlags.Ephemeral })
    return
  }
  const m = /^ark:outfit:(.+)$/.exec(i.customId)
  ensureData()
  const op = m && opIndex()?.byId.get(m[1])
  if (!op) {
    await i.reply({ content: '[PRTS] That record is no longer available. I apologize.', flags: MessageFlags.Ephemeral })
    return
  }
  const list = await getOutfits(op.id).catch(() => [] as Outfit[])
  const o = list.find(x => x.id === i.values[0])
  if (!o) {
    await i.reply({ content: '[PRTS] That outfit record is no longer available. I apologize.', flags: MessageFlags.Ephemeral })
    return
  }
  const view = stampEmbeds({ embeds: [outfitEmbed(op, o)], components: skinButtons(op, o, list) }, SECTION.skin) as any
  if (i.message?.flags?.has(MessageFlags.Ephemeral)) await i.update(view)
  else await i.reply({ ...view, flags: MessageFlags.Ephemeral })
}

const outfitArt = (opId: string, o: Outfit) =>
  o.elite !== undefined ? `${MYRTLE_ASSETS}/chararts/${opId}/${opId}_${o.elite === 0 ? 1 : 2}.png` : `${MYRTLE_ASSETS}/skinpack/${opId}/${encodeURIComponent(o.portrait)}.png`

function outfitListEmbed(op: Op, list: Outfit[]): EmbedBuilder {
  const page = `${MYRTLE}/operators/${op.id}`
  const lines = list.map(o => {
    const has = [o.animated ? 'animated art' : '', o.chibi.length ? 'chibi' : ''].filter(Boolean).join(', ')
    const meta = o.elite !== undefined ? o.obtain : [o.line, o.obtain, o.artist && `art by ${o.artist}`].filter(Boolean).join(' · ')
    return `**${o.name}**${has ? ` · *${has}*` : ''}\n${meta}`
  })
  const newest = [...list].filter(o => o.elite === undefined).pop() ?? list[list.length - 1]
  const e = embed(`${op.name} · Outfits (${list.length})`)
    .setURL(page)
    .setDescription(
      clip(lines.join('\n'), 3600) + '\n\nPick an outfit from the menu below to see its art. **Chibi player** opens Myrtle, which plays chibis and animated art live and can save them as GIF or WebM.',
    )
    .setImage(outfitArt(op.id, newest))
    .setFooter({ text: `${FOOTER} · Picture: ${newest.name} · Art © Hypergryph/Yostar, hosted by myrtle.moe` })
  return e
}

async function cmdSkin(i: ChatInputCommandInteraction, eph: boolean) {
  ensureData()
  if (!data) return notReady(i, eph)
  const q = i.options.getString('operator', true)
  const op = findOps(q, 1)[0]
  if (!op) return i.reply({ content: `[PRTS] No operator matches "${clip(q, 60)}". Please check the spelling.`, flags: MessageFlags.Ephemeral })
  await i.deferReply({ flags: ephFlag(eph) })
  const list = await getOutfits(op.id)
  if (!list.length) return fail(i, `No outfit records found for **${op.name}**.`)
  const page = `${MYRTLE}/operators/${op.id}`
  const want = i.options.getString('outfit')
  if (want) {
    const n = normName(want)
    const o = list.find(x => x.id === want) ?? list.find(x => normName(x.name) === n) ?? list.find(x => normName(x.name).includes(n))
    if (!o) return fail(i, `**${op.name}** has no outfit matching "${clip(want, 60)}". Outfits: ${list.map(x => x.name).join(', ')}`)
    return i.editReply({ embeds: [outfitEmbed(op, o)], components: skinButtons(op, o, list) })
  }
  return i.editReply({ embeds: [outfitListEmbed(op, list)], components: skinButtons(op, undefined, list) })
}

// ───────────────────────── /links /help ─────────────────────────

function linksEmbed(): EmbedBuilder {
  return embed('Arknights resources').setDescription(
    [
      '**Lore and story**',
      `• [Arknights Wiki](${WIKI}): operators, characters, events, lore`,
      `• [Timo's Story Reader](${TIMO}): every story script, art, music, voice lines`,
      '',
      '**Account and planning**',
      `• [Myrtle](${MYRTLE}): roster tracker, community pull stats, DPS tool, squad builder · \`/myrtle\``,
      '• [Penguin Statistics](https://penguin-stats.io): community drop rates',
      '• [Arknights Toolbox](https://arkntools.app): material planner, recruit and base tools',
      '',
      '**Community sheets** (fan-made)',
      '• [AK Tier List](https://docs.google.com/spreadsheets/d/1E7HmgKWiV8pKpJpvpVzziYxnaQTP01Vtw_PXEdL7XPA/edit) · `/tier`',
      '• [DragonGJY module ratings](https://docs.google.com/spreadsheets/d/1A0_0XTAcDDtHkvyAwjTqEEzM8cf5h3E60u23ZVXw4eg/edit) · `/operator`',
      '• [PeterYR farming](https://docs.google.com/spreadsheets/d/1RRiTIYVUNUf-xW8ljAJdYEOuSo23lpjHkPa0-zuC_4k/htmlview) · `/farm`',
      `• [RIIC base skill guide](${RIIC_URL}) · \`/base\``,
      '• [TacticalBreakfast mastery guides](https://docs.google.com/spreadsheets/d/1iJF12O6QOba1dlUVmobwvc1eBZE7FRB6-tKxmZEcG1I/)',
    ].join('\n'),
  )
}

export type HelpEntry = { cmd: string; group: string; short: string; usage: string; detail: string; examples: string[] }
const HELP: HelpEntry[] = [
  {
    cmd: 'prts',
    group: 'Conversation (AI)',
    short: 'Talk to PRTS: lore, game help, research, or just chat',
    usage: '/prts message:<anything>',
    detail:
      'The only command answered by the AI. Ask about Arknights story and characters, game mechanics, or anything else. PRTS searches the wiki, the story scripts and the web when needed, and cites sources. Long questions may take a moment: a "Retrieving records..." reply comes first.',
    examples: ['/prts message: What is Originium?', '/prts message: Explain the Kazdel civil war briefly', '/prts message: Good morning, PRTS'],
  },
  {
    cmd: 'operator',
    group: 'Arknights records',
    short: 'Operator card: class, faction, tier, modules, art, links',
    usage: '/operator name:<operator>',
    detail:
      'Shows a compact card like the wiki infobox: rarity, class, branch, position, faction, trait, summons, tags, how to get them, tier (AK Tier List), alternate versions, their modules with a rating, and E2 art. Buttons open the details privately: **Modules** (one module per page with buttons to switch: what it does in plain words, its stats and the DragonGJY verdict, plus a Community review tab with pros and cons), **Outfits** (like /skin) and **Base skills** (like /base), plus links to the wiki, Myrtle, story records and voice lines. Names autocomplete as you type. For non-operators (NPCs) it shows a wiki summary and their story appearances.',
    examples: ['/operator name: Texas', '/operator name: Wang'],
  },
  {
    cmd: 'tier',
    group: 'Arknights records',
    short: 'AK Tier List by tier, class or operator',
    usage: '/tier [tier:<EX…C->] [class:<class>] [operator:<name>]',
    detail:
      "With no options: every grade, one page per grade with names grouped by class (use the page buttons). Pick a tier, a class, or both to filter. With operator: a card with their grade, the sheet's written assessment and their rating history. Fan-made list for the global server, assuming full investment; refreshed from the Google Sheet every 6 hours.",
    examples: ['/tier', '/tier tier: S+', '/tier class: Medic', '/tier operator: Texas the Omertosa'],
  },

  {
    cmd: 'farm',
    group: 'Arknights records',
    short: 'Best stages to farm a material',
    usage: '/farm material:<material>',
    detail:
      'Lists the 10 most sanity-efficient stages for a material, with efficiency relative to the best stage and the main drop rate. Data from the PeterYR sheet (Penguin Statistics), refreshed every 6 hours; new material families appear under their proper names as soon as the sheet adds them. Materials autocomplete.',
    examples: ['/farm material: Device', '/farm material: Orirock', '/farm material: RMA70-12'],
  },
  {
    cmd: 'recruit',
    group: 'Arknights records',
    short: 'Recruitment tag calculator',
    usage: '/recruit tags:<tag, tag, ...>',
    detail:
      'Enter the tags shown in your recruitment slot, separated by commas (each one autocompletes as you type). PRTS lists every tag combination that guarantees a 4★ or better operator, assuming a 9:00:00 timer, plus 1★ Robot combos. If nothing is guaranteed, it says so.',
    examples: ['/recruit tags: Crowd-Control, Melee', '/recruit tags: Top Operator, Defender, Slow'],
  },
  {
    cmd: 'base',
    group: 'Arknights records',
    short: 'Base (RIIC) skills and team combos',
    usage: '/base [operator:<name>] [team:<team>] [facility:<facility>]',
    detail:
      "operator: the operator's official base skills (facility and unlock), which facilities they work best in, notes from the RIIC guide, and the team combos they appear in. team: the combo's facility and effect in plain words (no MD/CC shorthand), core members with a portrait, and how it works. facility: one card per combo with its effect and members. No option: an overview of all combos. Refreshed from the RIIC Google Sheet every 6 hours.",
    examples: ['/base operator: Proviso', '/base team: Vermeil Team (EXP)', '/base facility: Trading Post'],
  },
  {
    cmd: 'wiki',
    group: 'Arknights records',
    short: 'Search arknights.wiki.gg',
    usage: '/wiki query:<anything>',
    detail:
      'Finds the best matching wiki page and shows its picture, summary, key facts (race, affiliation, birthplace, status, appearances), links to its sections, and related pages. Page titles autocomplete as you type.',
    examples: ['/wiki query: Kazdel', '/wiki query: Originium'],
  },
  {
    cmd: 'story',
    group: 'Arknights records',
    short: "Find a story chapter and link it in Timo's reader",
    usage: '/story query:<stage code, title or event>',
    detail: "Searches every EN story by stage code, title or event name, with a short synopsis and a link to read it in Timo's Story Reader.",
    examples: ['/story query: 15-12', '/story query: Rewinding Breeze'],
  },
  {
    cmd: 'skin',
    group: 'Arknights records',
    short: 'Operator outfits: art, artist, how to get, animated/chibi',
    usage: '/skin operator:<operator> [outfit:<outfit>]',
    detail:
      'Without outfit: a menu to pick any outfit, and a list of every outfit (default E0/E2 and all skins) with its line, how to get it and the artist, and marks which have animated art and chibi animations. With outfit: shows that outfit’s full official art, artist, release date and links. Outfits autocomplete once the operator is filled in. Animated art and chibis are viewed on the operator’s Myrtle page, which plays them live.',
    examples: ['/skin operator: Reed the Flame Shadow', '/skin operator: Reed the Flame Shadow outfit: Summer Flowers FA075', '/skin operator: Necrass outfit: Default outfit (Elite 2)'],
  },
  {
    cmd: 'myrtle',
    group: 'Arknights records',
    short: 'Myrtle.moe player profiles, rosters and leaderboard',
    usage: '/myrtle profile|roster|pulls|inventory|lookback|showcase|plans [player:] [user:] · search name: · leaderboard [sort] [server] · link player: · unlink',
    detail: [
      'Reads public player data from [myrtle.moe](https://myrtle.moe) (players upload their own account there).',
      '**/myrtle profile [player:] [user:]** level, server, UID, account score and grade, rank, score breakdown, support units, roster stats, account info and a link to the profile',
      '**/myrtle roster [player:] [user:] [operator:] [sort:] [rarity:] [class:]** top builds (E2/level, potential, skill level, masteries, modules), or one operator’s build',
      '**/myrtle pulls [player:] [user:] [banner:]** public headhunting history: pulls, 6★/5★ counts and rates, pity since last 6★, latest 6★ and 5★ (only if the player made pulls public)',
      '**/myrtle inventory [player:] [user:] [item:]** public item inventory, highest rarity first, or only items matching a name',
      '**/myrtle lookback [player:] [user:]** progress snapshots over time (operators, E2, masteries, modules, score) with changes between them',
      '**/myrtle showcase [player:] [user:]** favourite operators, enemies and outfits, plus tier lists, from their profile showcase',
      '**/myrtle plans [player:] [user:]** public operator plans, grouped',
      '**/myrtle search name:** find players by in-game name',
      '**/myrtle leaderboard [sort:] [server:]** top 15 by total or one category',
      '**/myrtle link player:** link your Discord account to your Myrtle profile, so profile/roster default to you and others can use `user:@you` · **/myrtle unlink** removes it',
      '`player:` takes a name (it autocompletes), Name#1234, a UID or a myrtle.moe/user link. Private profiles and hidden fields are not shown.',
    ].join('\n'),
    examples: [
      '/myrtle link player: Doctor#1234',
      '/myrtle profile',
      '/myrtle profile user: @Texas',
      '/myrtle roster sort: mastery',
      '/myrtle roster operator: Suzuran',
      '/myrtle leaderboard sort: base_score',
    ],
  },
  {
    cmd: 'links',
    group: 'Arknights records',
    short: 'Useful Arknights sites and the community sheets PRTS uses',
    usage: '/help command: links',
    detail: 'Wiki, story reader, Myrtle, Penguin Statistics, planners, and the community sheets PRTS uses.',
    examples: ['/help command: links'],
  },

  {
    cmd: 'roll',
    group: 'Utilities',
    short: 'Dice, coin toss, or let PRTS choose',
    usage: '/roll dice [dice:<expression>] [reason:<text>] | coin [count:<1-100>] [call:<heads|tails>] [heads:<1-99 %>] [reason:] | choose options:<a | b | c> [reason:]',
    detail:
      'dice: default 1d20. Supports several dice and modifiers (2d6+3, 1d20+1d4-1), keep highest/lowest (4d6kh3, 2d20kl1), and percentile (d%). Max 100 dice. Kept maximum rolls are bold, dropped dice are struck through, and the reply explains the notation the roll uses.\ncoin: one coin, or up to 100 with a heads/tails tally. Call it beforehand if you like, and set heads: to weight the coin (for example heads: 70 for a 70% chance of heads).\nchoose: separate options with | or commas; PRTS picks one at random, without hesitation.\nEvery /roll takes an optional reason, shown as the title.',
    examples: ['/roll dice', '/roll dice dice: 4d6kh3 reason: Strength', '/roll coin count: 10', '/roll choose options: tea | coffee | juice'],
  },

  {
    cmd: 'music',
    group: 'Audio',
    short: 'Music player in your voice channel',
    usage:
      '/music play song:<link, search or file> | search | radio | artist | queue | history | skip count:<n> | skipto position:<n> | move from:<n> to:<n> | replay | pause | resume | loop | shuffle | remove | clear | stop | lyrics | nowplaying | list',
    detail:
      "Join a voice channel first. play accepts YouTube/SoundCloud links and playlists, Spotify track links, search words, uploaded audio files, or songs from the bot's music folder. Each song gets a now-playing panel with buttons; actions like skip or pause are logged publicly with who did them, and when everything has played the panel becomes a summary of the session. play has options shuffle and next (play right after the current song); replay queues a past song again; queue and history are private views of what is next and what was played. search lets you pick from results; radio plays similar songs; artist shuffles an artist; lyrics posts the lyrics in the chat (current song, or name a song and artist).",
    examples: ['/music play song: arknights ost', '/music search query: lofi', '/music radio', '/music skip'],
  },
  {
    cmd: 'status',
    group: 'Utilities',
    short: 'Is the narrative core online?',
    usage: '/status',
    detail:
      'Shows whether the Claude Code narrator is connected, when the AI last replied, how many requests are waiting and the bot uptime. Only you can see the answer. It also shows which AI answers /prts and each module, and whether it can be reached.',
    examples: ['/status'],
  },
  {
    cmd: 'help',
    group: 'Utilities',
    short: 'This guide',
    usage: '/help [command:<name>]',
    detail: "With no option: the list of all commands, with a menu to open any command's details. With a command: details and examples.",
    examples: ['/help', '/help command: recruit'],
  },
]
// Fill the /help command:<choice> list from the table above (Discord allows 25 choices).
const fillHelpChoices = () => {
  ;(ARK_COMMANDS.find(c => c.name === 'help') as any).options[0].choices = HELP.slice(0, 25).map(h => ({ name: `/${h.cmd}`, value: h.cmd }))
}
fillHelpChoices()
/** Other modules add their commands to /help here. */
export function registerHelp(entries: HelpEntry[]): void {
  const at = HELP.findIndex(h => h.cmd === 'status')
  HELP.splice(at < 0 ? HELP.length : at, 0, ...entries)
  fillHelpChoices()
}

function helpDetail(h: HelpEntry): EmbedBuilder {
  const e = embed(h.cmd === 'links' ? 'Useful sites' : `/${h.cmd}`)
    .setDescription(h.detail)
    .addFields({ name: 'Usage', value: '`' + h.usage + '`' }, { name: 'Examples', value: h.examples.map(x => '`' + x + '`').join('\n') || '—' })
  if (!/\(AI\)/.test(h.group)) e.setFooter({ text: `${FOOTER} · Answered instantly by the bot (no AI)` })
  return e
}

function helpMenu(): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('ark:help')
      .setPlaceholder('Details and examples for a command…')
      .addOptions(HELP.slice(0, 25).map(h => ({ label: h.cmd === 'links' ? 'Useful sites' : `/${h.cmd}`, value: h.cmd, description: clip(h.short, 100) }))),
  )
}

async function cmdHelp(i: ChatInputCommandInteraction, eph: boolean) {
  const which = i.options.getString('command')
  if (which) {
    if (which === 'links') return i.reply({ embeds: [linksEmbed()], flags: ephFlag(eph) })
    const h = HELP.find(x => x.cmd === which)
    if (h) return i.reply({ embeds: [helpDetail(h)], flags: ephFlag(eph) })
  }
  const e = embed('Function list').setDescription(
    'All systems operational. Welcome home.\nPick a command from the menu below for its options and examples. Every command also has `private:`, so that only you see the reply.',
  )
  for (const g of [...new Set(HELP.map(h => h.group))]) {
    // "Useful sites" goes last in its group, after the commands.
    const lines = [...HELP.filter(x => x.group === g && x.cmd !== 'links'), ...HELP.filter(x => x.group === g && x.cmd === 'links')].map(h =>
      h.cmd === 'links' ? `**Useful sites** · \`/help command: links\`` : `**/${h.cmd}** · ${h.short}`,
    )
    e.addFields({ name: g, value: clip(lines.join('\n'), 1024) })
  }
  e.setFooter({ text: `${FOOTER} · Commands marked (AI) use the AI; everything else is answered instantly by the bot` })
  return i.reply({ embeds: [e], components: [helpMenu()], flags: ephFlag(eph) })
}

// ───────────────────────── dispatch ─────────────────────────

export async function handleArk(i: ChatInputCommandInteraction): Promise<void> {
  brand(i, SECTION[i.commandName])
  const eph = i.options.getBoolean('private') ?? false
  switch (i.commandName) {
    case 'roll': {
      const sub = i.options.getSubcommand()
      await (sub === 'coin' ? cmdCoin(i, eph) : sub === 'choose' ? cmdChoose(i, eph) : cmdRoll(i, eph))
      break
    }
    case 'operator':
      await cmdOperator(i, eph)
      break
    case 'tier':
      await cmdTier(i, eph)
      break
    case 'farm':
      await cmdFarm(i, eph)
      break
    case 'recruit':
      await cmdRecruit(i, eph)
      break
    case 'wiki':
      await cmdWiki(i, eph)
      break
    case 'story':
      await cmdStory(i, eph)
      break
    case 'base':
      await cmdBase(i, eph)
      break
    case 'skin':
      await cmdSkin(i, eph)
      break
    case 'myrtle':
      await cmdMyrtle(i, eph)
      break
    case 'help':
      await cmdHelp(i, eph)
      break
  }
}

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
