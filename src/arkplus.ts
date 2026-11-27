// PRTS extra Arknights tools, answered by the bot itself (no AI):
//   /events     schedule of events and banners; announce picks the update channel
//   /stage      a stage: cost, recommended level, drops
//   /compare    two operators' maximum stats side by side
//   /materials  what an operator needs for elite, skills, masteries and modules
//   /remind     reminders delivered in the channel or by DM
// Game data comes from the same GitHub mirror as ark.ts. It is large (the stage
// and activity tables are 20 MB each), so it is trimmed once a day into
// cache/arkplus.json.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
} from 'discord.js'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { findOps, normName, registerHelp } from './ark.ts'

import { COLOR, FOOTER, SECTION, brand, stampEmbeds } from './theme.ts'
import { type Enemy, parseEnemies, statLines } from './enemy.ts'
import { CACHE_DIR } from './paths.ts'
import { announce, announceChannelFor, setAnnounceChannel } from './announce.ts'
const CACHE_FILE = join(CACHE_DIR, 'arkplus.json')
const REMIND_FILE = join(CACHE_DIR, 'reminders.json')
const GAMEDATA = 'https://raw.githubusercontent.com/ArknightsAssets/ArknightsGamedata/master/en/gamedata/excel/'
const WIKI = 'https://arknights.wiki.gg'
const UA = 'PRTS-Discord-bot/1.0 (private Arknights fan bot)'
const DATA_VERSION = 5
const MAX_AGE_MS = 24 * 3600 * 1000
const log = (s: string) => process.stderr.write(`prts arkplus: ${s}\n`)

const ANYWHERE = { type: 1, integration_types: [0, 1], contexts: [0, 1, 2] }
const PRIVATE_OPT = { type: 5, name: 'private', description: 'Only you can see the reply', required: false }

export const ARKPLUS_COMMANDS = [
  {
    name: 'events',
    description: 'Events and headhunting banners, and where PRTS posts updates',
    options: [
      {
        type: 1,
        name: 'schedule',
        description: 'Current and upcoming events and headhunting banners',
        options: [
          {
            type: 3,
            name: 'show',
            description: 'What to show (default: both)',
            required: false,
            choices: [
              { name: 'Events and banners', value: 'all' },
              { name: 'Events only', value: 'events' },
              { name: 'Headhunting banners only', value: 'banners' },
            ],
          },
          PRIVATE_OPT,
        ],
      },
      {
        type: 1,
        name: 'announce',
        description: 'Pick the channel for automatic updates: new stories, events and banners (Manage Server)',
        options: [
          { type: 7, name: 'channel', description: 'Channel to post in (leave empty to see the current setting)', required: false, channel_types: [0, 5] },
          { type: 5, name: 'off', description: 'Stop automatic updates in this server', required: false },
        ],
      },
    ],
  },
  {
    name: 'enemy',
    description: 'Enemy handbook: stats, abilities and description of an enemy',
    options: [{ type: 3, name: 'name', description: 'Enemy name, e.g. Patriot or Originium Slug', required: true, max_length: 100, autocomplete: true }, PRIVATE_OPT],
  },
  {
    name: 'stage',
    description: 'Look up a stage: cost, recommended level and drops',
    options: [{ type: 3, name: 'name', description: 'Stage code or name, e.g. 4-6, S3-3 or Lonely Moon', required: true, max_length: 100, autocomplete: true }, PRIVATE_OPT],
  },
  {
    name: 'compare',
    description: 'Compare two operators side by side',
    options: [
      { type: 3, name: 'operator1', description: 'First operator', required: true, max_length: 100, autocomplete: true },
      { type: 3, name: 'operator2', description: 'Second operator', required: true, max_length: 100, autocomplete: true },
      PRIVATE_OPT,
    ],
  },
  {
    name: 'materials',
    description: 'What an operator needs for elite, skills, masteries or modules',
    options: [
      { type: 3, name: 'operator', description: 'Operator name', required: true, max_length: 100, autocomplete: true },
      {
        type: 3,
        name: 'goal',
        description: 'What to raise (default: everything)',
        required: false,
        choices: [
          { name: 'Everything', value: 'everything' },
          { name: 'Elite 1', value: 'elite1' },
          { name: 'Elite 2', value: 'elite2' },
          { name: 'Skill levels 2 to 7', value: 'skills' },
          { name: 'All masteries (M3)', value: 'masteries' },
          { name: 'All modules (stages 1 to 3)', value: 'modules' },
        ],
      },
      PRIVATE_OPT,
    ],
  },
  {
    name: 'remind',
    description: 'Set a reminder for later',
    options: [
      {
        type: 1,
        name: 'add',
        description: 'Remind me later',
        options: [
          { type: 3, name: 'in', description: 'When, e.g. 30m, 2h, 1d12h, 90 minutes', required: true, max_length: 40 },
          { type: 3, name: 'message', description: 'What to remind you of', required: true, max_length: 400 },
        ],
      },
      { type: 1, name: 'list', description: 'Show your pending reminders' },
      { type: 1, name: 'cancel', description: 'Cancel a reminder', options: [{ type: 4, name: 'id', description: 'Reminder number from /remind list', required: true, min_value: 1 }] },
    ],
  },
].map(c => ({ ...c, ...ANYWHERE })) as any[]
export const ARKPLUS_NAMES = new Set(ARKPLUS_COMMANDS.map(c => c.name))

registerHelp([
  {
    cmd: 'events',
    group: 'Arknights records',
    short: 'Current and upcoming events and banners',
    usage: '/events schedule [show:<all|events|banners>] | announce [channel:<#channel>] [off:true]',
    detail:
      'schedule lists the events and headhunting banners that are running now or start soon, with countdowns. Dates come from the game data and are shown in your own time zone.\nannounce (needs Manage Server) picks the channel where PRTS posts automatic updates: new story chapters and events, and events or banners when they start and about a day before they end. Leave channel empty to see the current setting; off:true stops the updates.',
    examples: ['/events schedule', '/events schedule show: banners', '/events announce channel: #news', '/events announce off: true'],
  },
  {
    cmd: 'stage',
    group: 'Arknights records',
    short: 'Stage cost, recommended level and drops',
    usage: '/stage name:<code or name>',
    detail: "Shows a stage's sanity cost, recommended level, what it drops and how often, and what it gives on clear. Start typing for suggestions.",
    examples: ['/stage name: 4-6', '/stage name: S3-3', '/stage name: Years of Passion'],
  },
  {
    cmd: 'enemy',
    group: 'Arknights records',
    short: "An enemy's stats, abilities and handbook entry",
    usage: '/enemy name:<enemy>',
    detail:
      "Shows an enemy's handbook entry from the EN game data: class (Normal, Elite, Leader), type, attack and damage type, HP, ATK, DEF, RES, attack interval, move speed, range, weight, life points taken, immunities and abilities. If some stages use a stronger version, its changed stats are listed too. Story characters (Jesselton Williams, Yurodstvo, Patriot...) also show their portrait from the wiki, and enemies with several versions ('Emperor's Blade', Pursuer and Halberd Breaker) get buttons to switch between them. Start typing for suggestions.",
    examples: ['/enemy name: Patriot', '/enemy name: Originium Slug'],
  },
  {
    cmd: 'compare',
    group: 'Arknights records',
    short: 'Two operators side by side',
    usage: '/compare operator1:<name> operator2:<name>',
    detail: 'Compares maximum stats (HP, ATK, DEF, RES, DP cost, block, redeploy time, attack interval) at the highest promotion and level, without potential, trust or module bonuses.',
    examples: ['/compare operator1: Saria operator2: Hoshiguma'],
  },
  {
    cmd: 'materials',
    group: 'Arknights records',
    short: 'What an operator needs to be raised',
    usage: '/materials operator:<name> [goal:<elite1|elite2|skills|masteries|modules|everything>]',
    detail:
      'Adds up the materials and LMD for the chosen goal, grouped by material tier. Buttons under the reply switch between goals (Elite 1, Elite 2, skills, masteries, modules, everything). Use /farm material:<name> to see where to farm what you are missing.',
    examples: ['/materials operator: Exusiai goal: masteries', '/materials operator: Amiya'],
  },
  {
    cmd: 'music voice',
    group: 'Audio',
    short: "Play an operator's voice line in voice chat",
    usage: '/music voice operator:<name> [line:<title>] [language:<jp|en|cn|kr>]',
    detail:
      "Join a voice channel first. PRTS plays the operator's official in-game voice line (a random one unless you pick), and shows its text. Lines queue up if several are requested. If the music player is using the voice channel, please stop it first.",
    examples: ['/music voice operator: Texas', '/music voice operator: Amiya line: Greeting language: en'],
  },
  {
    cmd: 'remind',
    group: 'Utilities',
    short: 'Reminders in the channel or by DM',
    usage: '/remind add in:<30m, 2h, 1d> message:<text> | list | cancel id:<n>',
    detail: 'PRTS posts your reminder in the same channel and mentions you when it is due. If that channel is not reachable, I send it by direct message instead. Up to 25 pending reminders each.',
    examples: ['/remind add in: 2h message: Collect base production', '/remind list', '/remind cancel id: 3'],
  },
])

// ───────────────────────── data ─────────────────────────
type Stage = { id: string; code: string; name: string; type: string; diff: string; ap: number; danger: string; desc: string; exp: number; gold: number; drops: [string, string, string, string][] }
type CharPlus = {
  name: string
  rarity: number
  cls: string
  branch: string
  obtain: string
  hp: number
  atk: number
  def: number
  res: number
  cost: number
  block: number
  redeploy: number
  aspd: number
  elite: [Cost[], Cost[]]
  skills: Cost[][]
  masteries: Cost[][][]
  modules: { name: string; cost: Cost[][] }[]
}
type Cost = [string, number] // item id, count
type Plus = {
  version: number
  builtAt: number
  items: Record<string, [string, number]> // id -> [name, tier]
  stages: Stage[]
  events: { id: string; type: string; name: string; start: number; end: number }[]
  banners: { id: string; name: string; type: string; open: number; end: number; up6?: string[]; up5?: string[] }[]
  chars: Record<string, CharPlus>
  enemies: Record<string, Enemy>
}
let plus: Plus | null = null
let building: Promise<void> | null = null

async function getJson(file: string): Promise<any> {
  const r = await fetch(GAMEDATA + file, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(240_000) })
  if (!r.ok) throw new Error(`${r.status} ${file}`)
  return r.json()
}
const stripRich = (s: string) =>
  (s ?? '')
    .replace(/<[@$/][^>]*>|<\/>/g, '')
    .replace(/\\n/g, '\n')
    .replace(/<[^>]+>/g, '')
    .trim()
const tierOf = (r: string | number) => (typeof r === 'number' ? r + 1 : parseInt(String(r).replace(/\D/g, ''), 10) || 0)
const arr = (x: any): any[] => (Array.isArray(x) ? x : [])
const costs = (list: any): Cost[] => arr(list).map(c => [String(c.id), Number(c.count)] as Cost)
const CLS: Record<string, string> = { PIONEER: 'Vanguard', WARRIOR: 'Guard', TANK: 'Defender', SNIPER: 'Sniper', CASTER: 'Caster', MEDIC: 'Medic', SUPPORT: 'Supporter', SPECIAL: 'Specialist' }

async function buildPlus(): Promise<void> {
  log('building data cache (large download)...')
  const out: Plus = { version: DATA_VERSION, builtAt: Date.now(), items: {}, stages: [], events: [], banners: [], chars: {}, enemies: {} }

  const it = await getJson('item_table.json')
  for (const [id, v] of Object.entries<any>(it.items ?? {})) out.items[id] = [v.name, tierOf(v.rarity)]

  const gacha = await getJson('gacha_table.json')
  for (const p of arr(gacha.gachaPoolClient)) {
    const dm = p.dynMeta && typeof p.dynMeta === 'object' ? p.dynMeta : {}
    const up6 = [dm.main6RarityCharId, dm.sub6RarityCharId, p.limitParam?.limitedCharId].filter((x: any) => typeof x === 'string')
    const up5 = arr(dm.rare5CharList).filter((x: any) => typeof x === 'string')
    out.banners.push({ id: p.gachaPoolId, name: p.gachaPoolName, type: String(p.gachaRuleType), open: p.openTime, end: p.endTime, ...(up6.length ? { up6 } : {}), ...(up5.length ? { up5 } : {}) })
  }

  const act = await getJson('activity_table.json')
  for (const a of Object.values<any>(act.basicInfo ?? {})) {
    if (!a.displayOnHome) continue
    out.events.push({ id: a.id, type: a.type, name: a.name, start: a.startTime, end: a.endTime })
  }

  // Enemy handbook text plus battle stats (the stats file lives in levels/, next to excel/).
  try {
    const [hb, db] = await Promise.all([getJson('enemy_handbook_table.json'), getJson('../levels/enemydata/enemy_database.json')])
    out.enemies = parseEnemies(hb, db)
  } catch (e) {
    log(`enemy data: ${e}`)
  }

  const st = await getJson('stage_table.json')
  for (const s of Object.values<any>(st.stages ?? {})) {
    if (!s.code || s.isStoryOnly || s.apCost === undefined) continue
    const d = s.stageDropInfo ?? {}
    const drops: Stage['drops'] = []
    for (const r of arr(d.displayDetailRewards)) drops.push([String(r.id), String(r.type), String(r.occPercent), String(r.dropType)])
    if (!drops.length) for (const r of arr(d.displayRewards)) drops.push([String(r.id), String(r.type), 'ALWAYS', String(r.dropType)])
    out.stages.push({
      id: s.stageId,
      code: String(s.code),
      name: String(s.name ?? ''),
      type: s.stageType,
      diff: s.diffGroup ?? s.difficulty ?? '',
      ap: s.apCost,
      danger: s.dangerLevel && s.dangerLevel !== '-' ? s.dangerLevel : '',
      desc: stripRich(s.description).slice(0, 700),
      exp: s.expGain ?? 0,
      gold: s.goldGain ?? 0,
      drops,
    })
  }

  const equip = await getJson('uniequip_table.json')
  const modsByChar: Record<string, { name: string; cost: Cost[][] }[]> = {}
  for (const e of Object.values<any>(equip.equipDict ?? {})) {
    if (!e.charId || e.typeName1 === 'ORIGINAL' || !e.itemCost) continue
    ;(modsByChar[e.charId] ??= []).push({ name: e.uniEquipName, cost: [1, 2, 3].map(n => costs(e.itemCost[String(n)])) })
  }

  const chars = await getJson('character_table.json')
  for (const [id, c] of Object.entries<any>(chars)) {
    if (!id.startsWith('char_') || c.isNotObtainable || !CLS[c.profession]) continue
    const ph = arr(c.phases)
    const last = ph[ph.length - 1]?.attributesKeyFrames?.slice(-1)[0]?.data
    if (!last) continue
    out.chars[id] = {
      name: c.name,
      rarity: tierOf(c.rarity),
      cls: CLS[c.profession],
      branch: c.subProfessionId,
      obtain: String(c.itemObtainApproach ?? ''),
      hp: last.maxHp,
      atk: last.atk,
      def: last.def,
      res: last.magicResistance,
      cost: last.cost,
      block: last.blockCnt,
      redeploy: last.respawnTime,
      aspd: last.baseAttackTime,
      elite: [costs(ph[1]?.evolveCost), costs(ph[2]?.evolveCost)],
      skills: arr(c.allSkillLvlup).map((l: any) => costs(l.lvlUpCost)),
      masteries: arr(c.skills).map((sk: any) => arr(sk.levelUpCostCond).map((m: any) => costs(m.levelUpCost))),
      modules: modsByChar[id] ?? [],
    }
  }
  plus = out
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(CACHE_FILE, JSON.stringify(out))
  log(`cached: ${out.stages.length} stages, ${Object.keys(out.chars).length} operators, ${out.events.length} events, ${out.banners.length} banners`)
}

export function ensurePlus(): void {
  if (!plus && existsSync(CACHE_FILE)) {
    try {
      plus = JSON.parse(readFileSync(CACHE_FILE, 'utf8'))
    } catch {
      plus = null
    }
  }
  if ((!plus || plus.version !== DATA_VERSION || Date.now() - plus.builtAt > MAX_AGE_MS) && !building) {
    building = buildPlus()
      .catch(e => {
        log(`build failed: ${e}`)
      })
      .finally(() => {
        building = null
      })
  }
}
setTimeout(ensurePlus, 20_000).unref()
setInterval(ensurePlus, 6 * 3600 * 1000).unref()

// ───────────────────────── helpers ─────────────────────────
const ephFlag = (on: boolean): MessageFlags.Ephemeral | undefined => (on ? MessageFlags.Ephemeral : undefined)
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)
const embed = (title?: string) => {
  const e = new EmbedBuilder().setColor(COLOR.info).setFooter({ text: FOOTER })
  if (title) e.setTitle(title)
  return e
}
const itemName = (p: Plus, id: string) => p.items[id]?.[0] ?? (id === '4001' ? 'LMD' : id)
const wikiUrl = (t: string) => `${WIKI}/wiki/${encodeURIComponent(t.replace(/ /g, '_'))}`

/** Returns the data, or replies "records loading" and returns null. */
async function need(i: ChatInputCommandInteraction, eph: boolean): Promise<Plus | null> {
  ensurePlus()
  if (plus) return plus
  await i.reply({
    embeds: [
      embed('Records loading')
        .setColor(COLOR.warn)
        .setDescription('Event, stage and material records are being downloaded from the game data archive. Estimated time: under 2 minutes. Please try again shortly. I apologize for the delay.'),
    ],
    flags: ephFlag(eph),
  })
  return null
}

// ───────────────────────── /events ─────────────────────────
const BANNER_KIND: Record<string, string> = {
  NORMAL: 'Standard',
  LIMITED: 'Limited',
  LINKAGE: 'Collaboration',
  ATTAIN: 'Guaranteed 6★',
  CLASSIC: 'Kernel',
  CLASSIC_ATTAIN: 'Kernel',
  SINGLE: 'Rate-up',
  DOUBLE: 'Dual rate-up',
  CLASSIC_DOUBLE: 'Kernel dual rate-up',
  FESCLASSIC: 'Festival kernel',
  SPECIAL: 'Special',
  CLASSIC_SINGLE: 'Kernel rate-up',
}
// ----- wiki lookups: the game data has no rate-up or event operator lists, the wiki does -----
const wikiCache = new Map<string, { at: number; value: string | null }>()
async function wikiText(page: string): Promise<string | null> {
  const hit = wikiCache.get(page)
  if (hit && Date.now() - hit.at < (hit.value ? 6 * 3600_000 : 30 * 60_000)) return hit.value
  let value: string | null = null
  try {
    const r = await fetch(`${WIKI}/api.php?${new URLSearchParams({ action: 'parse', page, prop: 'wikitext', format: 'json', formatversion: '2', redirects: '1' })}`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(6000),
    })
    const j: any = await r.json()
    value = typeof j?.parse?.wikitext === 'string' ? j.parse.wikitext : null
  } catch {}
  wikiCache.set(page, { at: Date.now(), value })
  return value
}
async function wikiSearchTitle(q: string): Promise<string | null> {
  try {
    const r = await fetch(`${WIKI}/api.php?${new URLSearchParams({ action: 'opensearch', search: q, limit: '3', format: 'json' })}`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(5000),
    })
    const j: any = await r.json()
    const want = normName(q)
    return (j?.[1] ?? []).find((t: string) => normName(t) === want) ?? null
  } catch {
    return null
  }
}
const splitNames = (t: string) =>
  t
    .split(',')
    .map(x => x.replace(/\[\[|\]\]|\{\{[^}]*\}\}/g, '').trim())
    .filter(Boolean)

// Banners: parsed from "Headhunting/Banners/<year>". A banner of the game data is matched by its start time.
type WikiBanner = { start: number; text: string }
const bannerCache = new Map<number, { at: number; list: WikiBanner[] }>()
async function wikiBanners(year: number): Promise<WikiBanner[]> {
  const hit = bannerCache.get(year)
  if (hit && Date.now() - hit.at < 3 * 3600_000) return hit.list
  const w = await wikiText(`Headhunting/Banners/${year}`)
  const list: WikiBanner[] = []
  for (const chunk of (w ?? '').split('{{Banners cell').slice(1)) {
    const body = chunk.split('}}')[0]
    const f: Record<string, string> = {}
    for (const line of body.split('\n')) {
      const m = /^\|\s*([a-z0-9]+)\s*=\s*(.*)$/i.exec(line.trim())
      if (m) f[m[1].toLowerCase()] = m[2].trim()
    }
    const startStr = f.globalstart ?? f.start
    const t = startStr ? Date.parse(startStr.replace(/\//g, '-').replace(' ', 'T') + (startStr.includes(':') ? 'Z' : 'T00:00:00Z')) : NaN
    if (!Number.isFinite(t)) continue
    let text = ''
    if (f.operators) {
      const ops = splitNames(f.operators)
      const codes = (f.limited ?? '').split(',').map(x => x.trim())
      if (codes.length === ops.length && codes.some(c => c === '2' || c === '1')) {
        const main = ops.filter((_, k) => codes[k] === '2'),
          second = ops.filter((_, k) => codes[k] === '1')
        text = `Rate-up: ${main.join(', ') || '—'}${second.length ? `\nSecondary: ${second.join(', ')}` : ''}`
      } else if (ops.length > 12) {
        text = `Pool: ${ops.slice(0, 10).join(', ')} and ${ops.length - 10} more`
      } else text = `Rate-up: ${ops.join(', ')}`
    } else if (f.operators1) {
      text = `Choose from: ${splitNames(f.operators1).join(', ')}${f.operators2 ? `\n5★ choices: ${splitNames(f.operators2).slice(0, 8).join(', ')}…` : ''}`
    }
    if (text) list.push({ start: t / 1000, text: f.name ? `${f.name}\n${text}` : text })
  }
  bannerCache.set(year, { at: Date.now(), list })
  return list
}
async function rateUpFor(openSec: number): Promise<string | null> {
  const years = [...new Set([new Date(openSec * 1000).getUTCFullYear()])]
  const lists = await Promise.all(years.map(wikiBanners))
  let best: WikiBanner | null = null
  for (const b of lists.flat()) if (Math.abs(b.start - openSec) < 36 * 3600 && (!best || Math.abs(b.start - openSec) < Math.abs(best.start - openSec))) best = b
  return best ? best.text.replace(/^[^\n]*\n(?=(Rate-up|Choose|Pool|Secondary))/, '') : null
}

// Events: the "Operators" section of the event's wiki page lists the operators the event features.
const evOpsCache = new Map<string, { at: number; list: string[] }>()
async function eventOperators(name: string): Promise<string[]> {
  const hit = evOpsCache.get(name)
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.list
  const base = name.replace(/\s*[-–:]?\s*Rerun$/i, '').trim()
  let w = await wikiText(base)
  if (!w) {
    const t = await wikiSearchTitle(base)
    if (t) w = await wikiText(t)
  }
  const list: string[] = []
  if (w) {
    const i = w.indexOf('\n==Operators==')
    if (i >= 0) {
      const j = w.indexOf('\n==', i + 5)
      const sec = w.slice(i, j < 0 ? undefined : j)
      for (const m of sec.matchAll(/\{\{Operator list\|([^}]*)\}\}/g)) for (const n of splitNames(m[1].replace(/^\s*(?:6star|5star|4star)\s*=/i, ''))) if (!list.includes(n)) list.push(n)
    }
  }
  evOpsCache.set(name, { at: Date.now(), list: list.slice(0, 14) })
  return list.slice(0, 14)
}

async function cmdAnnounce(i: ChatInputCommandInteraction) {
  if (!i.guildId) return i.reply({ content: '[PRTS] Automatic updates can only be set up inside a server.', flags: MessageFlags.Ephemeral })
  const ch = i.options.getChannel('channel')
  const off = i.options.getBoolean('off') ?? false
  const current = announceChannelFor(i.guildId)
  if (!ch && !off) {
    const where = current ? `<#${current}>` : 'nowhere (off)'
    return i.reply({ content: `[PRTS] Automatic updates in this server go to ${where}. Use \`/events announce channel:\` to change it.`, flags: MessageFlags.Ephemeral })
  }
  if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild))
    return i.reply({ content: '[PRTS] Insufficient permissions. Choosing the update channel needs the Manage Server permission.', flags: MessageFlags.Ephemeral })
  if (off) {
    setAnnounceChannel(i.guildId, null)
    return i.reply({ content: '[PRTS] Automatic updates are off for this server.', flags: MessageFlags.Ephemeral })
  }
  const target = await i.client.channels.fetch(ch!.id).catch(() => null)
  const me = i.guild?.members.me
  if (!target || !('send' in target) || (me && 'permissionsFor' in target && !target.permissionsFor(me)?.has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])))
    return i.reply({ content: `[PRTS] I cannot post in <#${ch!.id}>. Please give me Send Messages and Embed Links there, or pick another channel.`, flags: MessageFlags.Ephemeral })
  setAnnounceChannel(i.guildId, ch!.id)
  return i.reply({
    content: `[PRTS] Confirmed. New stories, events and headhunting banners will be announced in <#${ch!.id}>. Real-time logging activated.`,
  })
}

async function cmdEvents(i: ChatInputCommandInteraction, eph: boolean) {
  const p = await need(i, eph)
  if (!p) return
  await i.deferReply({ flags: ephFlag(eph) })
  const show = i.options.getString('show') ?? 'all'
  const now = Math.floor(Date.now() / 1000)
  const SOON = now + 60 * 24 * 3600
  const split = <T extends { start: number; end: number }>(xs: T[]) => ({
    now: xs.filter(x => x.start <= now && x.end > now).sort((a, b) => a.end - b.end),
    soon: xs.filter(x => x.start > now && x.start < SOON).sort((a, b) => a.start - b.start),
  })
  const line = (name: string, extra: string, start: number, end: number, running: boolean) =>
    running ? `**${clip(name, 60)}**${extra} · ends <t:${end}:R> (<t:${end}:d>)` : `**${clip(name, 60)}**${extra} · starts <t:${start}:R> (<t:${start}:d>)`
  const field = (name: string, rows: string[], empty: string) => {
    let text = '',
      used = 0
    for (const r of rows) {
      if ((text + '\n' + r).length > 1000) break
      text += (text ? '\n' : '') + r
      used++
    }
    if (used < rows.length) text += `\n…and ${rows.length - used} more.`
    return { name, value: text || empty }
  }
  const e = embed('Events and headhunting').setDescription('Real-time logging activated. Times are shown in your own time zone.')
  if (show !== 'banners') {
    const evs = split(p.events)
    const shown = [...evs.now, ...evs.soon.slice(0, 6)]
    const ops = new Map(await Promise.all(shown.map(async x => [x.id, await eventOperators(x.name).catch(() => [] as string[])] as const)))
    const byName = new Map(Object.values(p.chars).map(c => [normName(c.name), c]))
    const row = (x: (typeof shown)[number], running: boolean) => {
      const names = ops.get(x.id) ?? []
      // Operators whose in-game obtain method is "Event Reward" are the free (welfare) ones.
      const free = names.filter(n => byName.get(normName(n))?.obtain === 'Event Reward')
      const rest = names.filter(n => !free.includes(n))
      const detail = [free.length ? `Free reward: ${free.join(', ')}` : '', rest.length ? `Featured: ${clip(rest.join(', '), 200)}` : ''].filter(Boolean).join(' · ')
      return line(x.name, '', x.start, x.end, running) + (detail ? `\n↳ ${detail}` : '')
    }
    e.addFields(
      field(
        'Events running now',
        evs.now.map(x => row(x, true)),
        'No records on file.',
      ),
      field(
        'Events coming up',
        evs.soon.slice(0, 6).map(x => row(x, false)),
        'No announcements on file yet.',
      ),
    )
  }
  if (show !== 'events') {
    const bs = split(p.banners.filter(b => !/^(NEWBEE|BEGINNER)/i.test(b.id) && b.end - b.open < 400 * 86400).map(b => ({ ...b, start: b.open })))
    const picked = [...bs.now, ...bs.soon.slice(0, 5)]
    const ups = new Map(await Promise.all(picked.map(async b => [b.id, await rateUpFor(b.open).catch(() => null)] as const)))
    const bl = (b: (typeof picked)[number], running: boolean) =>
      line(b.name, ` _(${BANNER_KIND[b.type] ?? String(b.type).toLowerCase()})_`, b.open, b.end, running) +
      (() => {
        const names = (ids?: string[]) =>
          (ids ?? [])
            .map(id => p.chars[id]?.name)
            .filter(Boolean)
            .join(', ')
        const game = b.up6?.length || b.up5?.length ? `Rate-up: ${names(b.up6)}${b.up5?.length ? ` · 5★: ${names(b.up5)}` : ''}` : null
        const text = /^(CLASSIC|CLASSIC_DOUBLE)$/.test(b.type) && game ? game : (ups.get(b.id) ?? game)
        return text ? `\n↳ ${clip(text.replace(/\n/g, ' · '), 260)}` : ''
      })()
    e.addFields(
      field(
        'Headhunting now',
        bs.now.map(b => bl(b, true)),
        'No records on file.',
      ),
      field(
        'Headhunting coming up',
        bs.soon.slice(0, 5).map(b => bl(b, false)),
        'No announcements on file yet.',
      ),
    )
  }
  e.setFooter({ text: `${FOOTER} · Dates from the game data (EN); operators from the Arknights wiki` })
  await i.editReply({ embeds: [e] })
}

// ───────────────────────── /stage ─────────────────────────
let stageIx: { of: Plus; keyed: [string, string, Stage][] } | null = null
function stageIndex(p: Plus) {
  if (stageIx?.of !== p) {
    // The game data lists some stages twice (ids ending in #f# or #s are variants of the same stage); keep the plain one.
    const best = new Map<string, Stage>()
    for (const s of p.stages) {
      const key = `${s.code}|${s.name}|${s.type}|${s.diff}`
      const cur = best.get(key)
      if (!cur || (cur.id.includes('#') && !s.id.includes('#'))) best.set(key, s)
    }
    stageIx = { of: p, keyed: [...best.values()].map(s => [normName(s.code), normName(s.name ?? ''), s] as [string, string, Stage]) }
  }
  return stageIx.keyed
}
const STAGE_TYPE: Record<string, string> = {
  MAIN: 'Main story',
  SUB: 'Side story',
  ACTIVITY: 'Event',
  DAILY: 'Supply stage',
  CAMPAIGN: 'Annihilation',
  CLIMB_TOWER: 'Stationary Security Service',
  GUIDE: 'Tutorial',
  TRAINING: 'Training',
}
function findStages(q: string, limit = 25): Stage[] {
  if (!plus) return []
  const n = normName(q)
  if (!n)
    return plus.stages
      .filter(s => s.type === 'MAIN' && s.diff !== 'TOUGH')
      .slice(-limit)
      .reverse()
  const scored: [number, Stage][] = []
  for (const [code, name, s] of stageIndex(plus)) {
    const sc = code === n ? 0 : name === n ? 1 : code.startsWith(n) ? 2 : name.startsWith(n) ? 3 : name.includes(n) ? 4 : -1
    if (sc >= 0) scored.push([sc + (s.diff === 'TOUGH' ? 0.5 : 0), s])
  }
  return scored
    .sort((a, b) => a[0] - b[0] || a[1].code.localeCompare(b[1].code))
    .slice(0, limit)
    .map(x => x[1])
}
const OCC: Record<string, number> = { ALWAYS: 0, ALMOST: 1, USUAL: 2, OFTEN: 3, SOMETIMES: 4 }
const OCC_LABEL = ['Always', 'Almost always', 'Usually', 'Often', 'Sometimes']
async function cmdStage(i: ChatInputCommandInteraction, eph: boolean) {
  const p = await need(i, eph)
  if (!p) return
  const q = i.options.getString('name', true)
  const s = p.stages.find(x => x.id === q) ?? findStages(q, 1)[0]
  if (!s) {
    await i.reply({
      embeds: [
        embed('Record not found')
          .setColor(COLOR.warn)
          .setDescription(`No stage matches "${clip(q, 60)}". Please try the stage code, for example 4-6 or S3-3. I apologize.`),
      ],
      flags: ephFlag(eph),
    })
    return
  }
  const groups: string[][] = [[], [], [], [], []]
  const extra: string[] = []
  const listed = new Set<string>()
  for (const [id, type, occ, drop] of [...s.drops].sort((x, y) => (OCC[x[2]] ?? 4) - (OCC[y[2]] ?? 4))) {
    const name = type === 'GOLD' ? 'LMD' : type === 'CHAR' ? `${p.chars[id]?.name ?? 'an operator'} (operator)` : itemName(p, id)
    if (listed.has(name + drop)) continue
    listed.add(name + drop)
    if (drop === 'ONCE' || drop === 'FIRST') {
      extra.push(name)
      continue
    }
    if (type === 'DIAMOND' || type === 'DIAMOND_SHD') continue
    groups[OCC[occ] ?? 4].push(name)
  }
  const e = embed(`${s.code} · ${s.name}`)
    .setURL(wikiUrl(s.code))
    .setDescription(
      [
        `**${STAGE_TYPE[s.type] ?? s.type}${s.diff === 'TOUGH' ? ' · challenge mode' : ''}** · ${s.ap ? `${s.ap} Sanity` : 'free (no Sanity)'}${s.danger ? ` · recommended ${s.danger.replace(/^LV\.?\s*/i, 'Lv. ')}` : ''}`,
        '',
        `*${clip((s.desc || 'No description on record.').replace(/\s*\n\s*/g, ' '), 600)}*`,
      ].join('\n'),
    )
  const lines = groups.map((g, k) => (g.length ? `**${OCC_LABEL[k]}:** ${[...new Set(g)].join(', ')}` : '')).filter(Boolean)
  e.addFields({ name: 'Drops', value: clip(lines.join('\n') || 'No drop list in the game data.', 1000) })
  const rewards = [
    s.exp || s.gold ? `**Every clear:** ${s.exp.toLocaleString('en-US')} operator EXP · ${s.gold.toLocaleString('en-US')} LMD` : '',
    extra.length ? `**First clear:** ${clip([...new Set(extra)].join(', '), 300)}` : '',
  ].filter(Boolean)
  if (rewards.length) e.addFields({ name: 'Rewards', value: rewards.join('\n') })
  const links = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Wiki').setURL(wikiUrl(s.code)),
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('Wiki search')
      .setURL(`${WIKI}/index.php?search=${encodeURIComponent(s.name)}`),
  )
  await i.reply({ embeds: [e], components: [links], flags: ephFlag(eph) })
}

// ───────────────────────── /enemy ─────────────────────────
function findEnemies(q: string): Enemy[] {
  const list = Object.values(plus?.enemies ?? {})
  const n = normName(q)
  if (!n) return list.filter(e => e.level === 'Leader').slice(-25)
  const exact = list.filter(e => normName(e.name) === n || e.id === q || normName(e.index) === n)
  const starts = list.filter(e => !exact.includes(e) && normName(e.name).startsWith(n))
  const has = list.filter(e => !exact.includes(e) && !starts.includes(e) && normName(e.name).includes(n))
  return [...exact, ...starts, ...has].slice(0, 25)
}

// Leaders and enemies named like an operator have their enemy page at "<Name>/Enemy" on the wiki;
// "go" opens that page when it exists and falls back to search results when it does not.
const enemyWikiGuess = (e: Enemy) => (e.level === 'Leader' || findOps(e.name, 1)[0]?.name === e.name ? `${WIKI}/index.php?search=${encodeURIComponent(`${e.name}/Enemy`)}&go=Go` : wikiUrl(e.name))

function enemyEmbed(e: Enemy): EmbedBuilder {
  const kind = [e.races.join(', '), e.attack, e.flying ? 'flying' : '', e.damage.length ? `deals ${e.damage.join(' and ')} damage` : ''].filter(Boolean).join(' · ')
  const em = embed(e.name)
    .setURL(enemyWikiGuess(e))
    .setThumbnail(`https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/main/enemy/${e.id}.png`)
    .setDescription([`**${e.level}**${e.index ? ` · \`${e.index}\`` : ''}${kind ? ` · ${kind}` : ''}`, e.desc ? `\n*${clip(e.desc, 600)}*` : ''].filter(Boolean).join('\n'))
  if (e.note && e.note !== e.desc) em.addFields({ name: 'In battle', value: clip(e.note, 500) })
  if (e.stats) {
    const lines = statLines(e.stats)
    if (e.stronger) {
      const n = (x: number) => x.toLocaleString('en-US')
      const names: Record<string, string> = {
        hp: 'HP',
        atk: 'ATK',
        def: 'DEF',
        res: 'RES',
        interval: 'Attack interval',
        speed: 'Move speed',
        weight: 'Weight',
        range: 'Range',
        lifePoints: 'Life points taken',
        elementalRes: 'Elemental RES',
      }
      e.stronger.forEach((lv, k) => {
        if (Object.keys(lv).length)
          lines.push(
            `*Level ${k + 1} (some stages):* ${Object.entries(lv)
              .map(([key, v]) => `${names[key] ?? key} ${n(v as number)}`)
              .join(' · ')}`,
          )
      })
    }
    em.addFields({ name: e.stronger ? 'Stats (level 0)' : 'Stats', value: clip(lines.join('\n'), 1024) })
  }
  if (e.abilities.length) em.addFields({ name: 'Abilities', value: clip(e.abilities.map(a => (a.title ? `**${a.text}**` : `• ${a.text}`)).join('\n'), 1024) })
  if (e.immune.length) em.addFields({ name: 'Immune to (base form)', value: e.immune.join(', ') })
  return em.setFooter({ text: `${FOOTER} · Enemy handbook, EN game data` })
}

/** Every image in a wiki infobox, with its tab label ("Talulah (Act I).png:NPC (Prologue to Act II)"). */
export function parseInfoboxImages(wikitext: string): { kind: 'character' | 'operator' | 'faction'; images: { file: string; label: string }[] } | null {
  const at = wikitext.search(/\{\{\s*(Character|Operator|Faction) infobox/i)
  if (at < 0) return null
  const head = wikitext.slice(at)
  const kind = /^\{\{\s*Operator/i.test(head) ? 'operator' : /^\{\{\s*Faction/i.test(head) ? 'faction' : 'character'
  const m = /\n\s*\|\s*image\s*=([\s\S]*?)(?=\n\s*\||\}\})/.exec(head)
  const images = (m?.[1] ?? '')
    .split(/[;\n]/)
    .map(x => x.trim())
    .filter(x => /\.(png|jpe?g|webp|gif)/i.test(x))
    .map(x => {
      const [file, label] = x.split(/:(?=[^:]*$)/)
      return { file: file.trim(), label: (label ?? '').trim() }
    })
  return { kind, images }
}

/** Which infobox image fits an enemy: one named after it or after the character link ("Lava the Purgatory"),
 * then a label matching the link's section ("Amiya/Story#Babel"), then an NPC tab, then the first image that
 * is not operator art. Later images are often other people (Yurodstvo's avatars), so earlier ones win. */
export function pickPortrait(images: { file: string; label: string }[], names: string | string[], hint = ''): { file: string; label: string } | undefined {
  const ns = (Array.isArray(names) ? names : [names]).map(normName).filter(Boolean)
  const h = normName(hint)
  const ok = (x: { label: string }) => !/operator/i.test(x.label)
  return (
    ns.map(n => images.find(x => ok(x) && normName(x.file.replace(/\.\w+$/, '')) === n)).find(Boolean) ??
    (h ? images.find(x => ok(x) && normName(x.label).includes(h)) : undefined) ??
    images.find(x => /^NPC\b/i.test(x.label)) ??
    images.find(ok) ??
    images[0]
  )
}

async function wikiApi(params: Record<string, string>): Promise<any> {
  const u = new URL(`${WIKI}/api.php`)
  for (const [k, v] of Object.entries({ format: 'json', redirects: '1', ...params })) u.searchParams.set(k, v)
  const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) })
  if (!r.ok) throw new Error(`wiki ${r.status}`)
  return r.json()
}

/** "'Emperor's Blade', Pursuer" -> "Emperor's Blade"; "Originium Slug α" -> "Originium Slug". */
export const enemyBaseName = (name: string) =>
  name
    .split(/',\s|,\s/)[0]
    .replace(/^'|'$/g, '')
    .replace(/\s+[αβγδεΩ]$/, '')
    .trim()

/** Other handbook entries of the same enemy, current one included: same base name ('Emperor's Blade',
 * Pursuer) or same id with a level suffix (enemy_1025_reveng and _2: Avenger, Hateful Avenger), joined
 * transitively so 'Hateful Avenger' the Leader comes along too. */
function enemyVariants(e: Enemy): Enemy[] {
  const all = Object.values(plus?.enemies ?? {})
  const stem = (x: Enemy) => x.id.replace(/_\d+$/, '')
  const base = (x: Enemy) => normName(enemyBaseName(x.name))
  const group = new Set<Enemy>([e])
  for (let grew = true; grew; ) {
    grew = false
    const stems = new Set([...group].map(stem)),
      bases = new Set([...group].map(base))
    for (const x of all)
      if (!group.has(x) && (stems.has(stem(x)) || bases.has(base(x)))) {
        group.add(x)
        grew = true
      }
  }
  return [...group].sort((a, b) => a.id.localeCompare(b.id))
}

async function infoboxOf(page: string): Promise<{ title: string; box: ReturnType<typeof parseInfoboxImages> } | null> {
  const r = await wikiApi({ action: 'parse', page, prop: 'wikitext', section: '0' })
  if (!r?.parse) return null
  return { title: String(r.parse.title ?? page), box: parseInfoboxImages(String(r.parse.wikitext?.['*'] ?? '')) }
}

type EnemyWiki = { enemyPage?: string; character?: string; portrait?: string }
/** Portraits the wiki cannot tell apart (checked by hand): enemy id -> infobox image file. */
const PORTRAIT_OVERRIDE: Record<string, string> = {
  enemy_2078_skzmst: 'Mon3tr original.png', // Mon2tr is Mon3tr's original form, not the humanoid operator art
}
const enemyWikiCache = new Map<string, { at: number; value: EnemyWiki }>()

/** The character an enemy page is about: "Talulah/Ally" -> Talulah, or the link in the bold lead
 * ("'''[[Lava the Purgatory|Lava]], Flame of Resistance'''"). Generic enemies (the "Catapult", Frost) have none. */
export function enemyCharacter(title: string, wikitext: string): { page: string; hint: string } | null {
  if (title.includes('/')) return { page: title.split('/')[0], hint: '' }
  const body = wikitext.slice(Math.max(0, wikitext.search(/\{\{\s*Enemy infobox/i)))
  const lead = /'''(.+?)'''/.exec(body.slice(body.indexOf('}}')))
  const link = lead && /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|[^\]]*)?\]\]/.exec(lead[1])
  if (!link || /enemy$/i.test(link[1])) return null
  return { page: link[1].trim(), hint: (link[2] ?? '').trim() }
}

/** The enemy's own wiki page (found by its game id), the character it shows, and their portrait:
 * from the story tab first, then from the character the page links to. Operator pages keep the NPC art on "<page>/Story". */
async function enemyWiki(e: Enemy): Promise<EnemyWiki> {
  const hit = enemyWikiCache.get(e.id)
  if (hit && Date.now() - hit.at < 12 * 3600_000) return hit.value
  const value: EnemyWiki = {}
  const fileUrl = async (file: string) => {
    const info = await wikiApi({ action: 'query', titles: `File:${file}`, prop: 'imageinfo', iiprop: 'url' })
    return Object.values<any>(info?.query?.pages ?? {})[0]?.imageinfo?.[0]?.url as string | undefined
  }
  const plain = e.name.replace(/^'|'$/g, '')
  try {
    const found = await wikiApi({ action: 'query', list: 'search', srsearch: `insource:"${e.id}"`, srlimit: '5', srnamespace: '0' })
    for (const r of found?.query?.search ?? []) {
      const pg = await wikiApi({ action: 'parse', page: r.title, prop: 'wikitext', section: '0' })
      const text = String(pg?.parse?.wikitext?.['*'] ?? '')
      if (!new RegExp(`filename\\s*=\\s*${e.id}\\s*[\\n|}]`).test(text)) continue
      value.enemyPage = String(pg.parse.title)
      const root = value.enemyPage.split('/')[0]
      // 1. The story tab of the enemy (or of the character an "X/Enemy" page belongs to): its infobox,
      //    or the first picture on the page ('Amiya', Furnace's Finale/Story).
      const story = await wikiApi({ action: 'parse', page: `${root}/Story`, prop: 'wikitext', section: '0' }).catch(() => null)
      const storyText = String(story?.parse?.wikitext?.['*'] ?? '')
      const box = storyText ? parseInfoboxImages(storyText) : null
      const forced = box?.images.find(x => x.file === PORTRAIT_OVERRIDE[e.id])
      let file = forced?.file ?? (box?.images.length ? pickPortrait(box.images, [plain, root])?.file : /\[\[File:([^|\]]+)/i.exec(storyText)?.[1])
      if (file) value.character = root
      // 2. Otherwise the character the enemy page links to (Lava, Flame of Resistance -> Lava the Purgatory).
      const ch = file ? null : enemyCharacter(value.enemyPage, text)
      if (ch) {
        let cb = await infoboxOf(ch.page)
        if (cb?.box?.kind === 'operator') cb = (await infoboxOf(`${cb.title}/Story`).catch(() => null)) ?? cb
        const imgs = cb?.box?.images ?? []
        // A link to one section of a story ("Amiya/Story#Babel") that has no picture of its own: show none.
        const hinted = ch.hint ? imgs.find(x => !/operator/i.test(x.label) && normName(x.label).includes(normName(ch.hint))) : undefined
        const pick = imgs.find(x => x.file === PORTRAIT_OVERRIDE[e.id]) ?? (ch.hint ? hinted : pickPortrait(imgs, [plain, ch.page]))
        if (cb && pick) {
          file = pick.file
          value.character = cb.title.replace(/\/Story$/, '')
        }
      }
      if (file) value.portrait = await fileUrl(file.trim())
      if (!value.portrait) value.character = undefined
      break
    }
  } catch {
    if (hit) return hit.value
    return value // not cached, so a wiki hiccup is retried next time
  }
  enemyWikiCache.set(e.id, { at: Date.now(), value })
  return value
}

/** The main picture of a wiki page for /operator's wiki fallback: operator art on an operator page
 * (operators not yet on EN, such as Talulah), otherwise the NPC portrait. */
export async function wikiPortrait(page: string): Promise<string | null> {
  try {
    const pg = await infoboxOf(page)
    const imgs = pg?.box?.images ?? []
    const pick = pg?.box?.kind === 'operator' ? imgs[0] : pickPortrait(imgs, page)
    if (!pick) return null
    const info = await wikiApi({ action: 'query', titles: `File:${pick.file}`, prop: 'imageinfo', iiprop: 'url' })
    return Object.values<any>(info?.query?.pages ?? {})[0]?.imageinfo?.[0]?.url ?? null
  } catch {
    return null
  }
}

/** The /enemy reply, with buttons for the enemy's other variants (`arkp:enemy:<enemy id>`). */
async function enemyView(e: Enemy): Promise<{ embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] }> {
  const em = enemyEmbed(e)
  const wk = await enemyWiki(e)
  const rows: ActionRowBuilder<ButtonBuilder>[] = []
  if (wk.enemyPage) em.setURL(wikiUrl(wk.enemyPage))
  if (wk.portrait) {
    em.setImage(wk.portrait)
    em.setFooter({ text: `${FOOTER} · Enemy handbook, EN game data · Portrait from the Arknights wiki` })
  }
  const vars = enemyVariants(e)
  if (vars.length > 1) {
    // Buttons hold up to five; list the rest so none is hidden.
    if (vars.length > 5) em.addFields({ name: `Variants (${vars.length})`, value: clip(vars.map(v => (v.id === e.id ? `**${v.name}** (shown)` : v.name)).join('\n'), 1024) })
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        vars.slice(0, 5).map((v, _, shown) => {
          const label = (x: Enemy) => /',\s*(.+)$/.exec(x.name)?.[1] ?? x.name.replace(/^'|'$/g, '')
          // Two variants can share a name ('Hateful Avenger' the Elite and the Leader): add the class.
          const short = shown.filter(x => label(x) === label(v)).length > 1 ? `${label(v)} (${v.level})` : label(v)
          return new ButtonBuilder()
            .setCustomId(`arkp:enemy:${v.id}`)
            .setLabel(clip(short, 80))
            .setStyle(v.id === e.id ? ButtonStyle.Primary : ButtonStyle.Secondary)
            .setDisabled(v.id === e.id)
        }),
      ),
    )
  }
  const links = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('Wiki')
      .setURL(wk.enemyPage ? wikiUrl(wk.enemyPage) : enemyWikiGuess(e)),
  )
  if (wk.character) links.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Character page').setURL(wikiUrl(wk.character)))
  rows.push(links)
  return { embeds: [em], components: rows }
}

async function cmdEnemy(i: ChatInputCommandInteraction, eph: boolean) {
  const p = await need(i, eph)
  if (!p) return
  const q = i.options.getString('name', true)
  const e = p.enemies?.[q] ?? findEnemies(q)[0]
  if (!e) {
    await i.reply({
      embeds: [
        embed('Record not found')
          .setColor(COLOR.warn)
          .setDescription(`No enemy in the handbook matches "${clip(q, 60)}". Please pick a name from the suggestions. I apologize.`),
      ],
      flags: ephFlag(eph),
    })
    return
  }
  // The portrait lookup asks the wiki, which can take longer than Discord's 3 second reply window.
  await i.deferReply({ flags: ephFlag(eph) })
  await i.editReply(await enemyView(e))
}

// ───────────────────────── /compare ─────────────────────────
function charOf(p: Plus, q: string): { id: string; c: CharPlus } | null {
  for (const o of findOps(q, 8)) if (p.chars[o.id]) return { id: o.id, c: p.chars[o.id] }
  return null
}
async function cmdCompare(i: ChatInputCommandInteraction, eph: boolean) {
  const p = await need(i, eph)
  if (!p) return
  const a = charOf(p, i.options.getString('operator1', true)),
    b = charOf(p, i.options.getString('operator2', true))
  if (!a || !b) {
    await i.reply({
      embeds: [
        embed('Record not found')
          .setColor(COLOR.warn)
          .setDescription(`I could not find ${!a ? 'the first' : 'the second'} operator. Please pick a name from the suggestions. I apologize.`),
      ],
      flags: ephFlag(eph),
    })
    return
  }
  const rows: [string, (c: CharPlus) => number, 'high' | 'low', (n: number) => string][] = [
    ['HP', c => c.hp, 'high', n => n.toLocaleString('en-US')],
    ['ATK', c => c.atk, 'high', n => n.toLocaleString('en-US')],
    ['DEF', c => c.def, 'high', n => n.toLocaleString('en-US')],
    ['RES', c => c.res, 'high', n => String(n)],
    ['DP cost', c => c.cost, 'low', n => String(n)],
    ['Block', c => c.block, 'high', n => String(n)],
    ['Redeploy', c => c.redeploy, 'low', n => `${n}s`],
    ['Interval', c => c.aspd, 'low', n => `${n}s`],
  ]
  const w = 9
  const nameA = clip(a.c.name, 14),
    nameB = clip(b.c.name, 14)
  const lines = [`${''.padEnd(w)}${nameA.padEnd(15)}${nameB}`]
  for (const [label, get, better, f] of rows) {
    const x = get(a.c),
      y = get(b.c)
    const mark = (me: number, other: number) => (me === other ? ' ' : (better === 'high' ? me > other : me < other) ? '▲' : ' ')
    lines.push(`${label.padEnd(w)}${(f(x) + mark(x, y)).padEnd(15)}${f(y)}${mark(y, x)}`)
  }
  const who = (x: { c: CharPlus }) => `**${x.c.name}** · ${'★'.repeat(x.c.rarity)} ${x.c.cls} (${findOps(x.c.name, 1)[0]?.branch ?? x.c.branch})`
  const e = embed(`${a.c.name} vs ${b.c.name}`)
    .setDescription([who(a), who(b), '```', ...lines, '```', '▲ marks the better value.'].join('\n'))
    .setFooter({ text: `${FOOTER} · Maximum level at the highest promotion, without potential, trust or module bonuses` })
  await i.reply({ embeds: [e], flags: ephFlag(eph) })
}

// ───────────────────────── /materials ─────────────────────────
function sum(into: Map<string, number>, list: Cost[]) {
  for (const [id, n] of list) into.set(id, (into.get(id) ?? 0) + n)
}
const GOALS: [string, string][] = [
  ['everything', 'Everything'],
  ['elite1', 'Elite 1'],
  ['elite2', 'Elite 2'],
  ['skills', 'Skills'],
  ['masteries', 'Masteries'],
  ['modules', 'Modules'],
]
const TIER_NAME = ['', 'Tier 1 (common)', 'Tier 2', 'Tier 3', 'Tier 4', 'Tier 5 (rarest)']

/** The /materials view for one goal, with buttons to switch goal (`arkp:mat:<operator id>:<goal>`). */
function materialsView(p: Plus, id: string, goal: string): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const c = p.chars[id]
  const total = new Map<string, number>()
  const parts: string[] = []
  const want = (g: string) => goal === 'everything' || goal === g
  if (want('elite1') && c.elite[0].length) {
    sum(total, c.elite[0])
    parts.push('Elite 1')
  }
  if (want('elite2') && c.elite[1].length) {
    sum(total, c.elite[1])
    parts.push('Elite 2')
  }
  if (want('skills') && c.skills.length) {
    for (const l of c.skills) sum(total, l)
    parts.push('skill levels 2 to 7')
  }
  if (want('masteries') && c.masteries.length) {
    for (const sk of c.masteries) for (const m of sk) sum(total, m)
    parts.push(`masteries (${c.masteries.length} skill${c.masteries.length > 1 ? 's' : ''} to M3)`)
  }
  if (want('modules') && c.modules.length) {
    for (const m of c.modules) for (const st of m.cost) sum(total, st)
    parts.push(`modules to stage 3 (${c.modules.map(m => m.name).join(', ')})`)
  }
  const label = GOALS.find(g => g[0] === goal)?.[1] ?? goal
  const e = embed(`${c.name} · ${label}`).setURL(wikiUrl(c.name)).setThumbnail(`https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/main/avatar/${id}.png`)
  const lmd = total.get('4001') ?? 0
  total.delete('4001')
  if (!total.size) {
    e.setDescription(`${'★'.repeat(c.rarity)} ${c.cls} · ${c.name} needs nothing for this goal in the game data.`).setColor(COLOR.dim)
  } else {
    e.setDescription([`${'★'.repeat(c.rarity)} ${c.cls} · covers ${parts.join(', ')}.`, lmd ? `**LMD:** ${lmd.toLocaleString('en-US')}` : ''].filter(Boolean).join('\n'))
    const byTier = new Map<number, [string, number][]>()
    for (const [mid, n] of total) {
      const t = p.items[mid]?.[1] ?? 0
      byTier.set(t, [...(byTier.get(t) ?? []), [mid, n]])
    }
    for (const t of [...byTier.keys()].sort((x, y) => y - x)) {
      const list = byTier.get(t)!.sort((x, y) => y[1] - x[1])
      e.addFields({ name: TIER_NAME[t] ?? 'Other', value: clip(list.map(([mid, n]) => `${itemName(p, mid)} ×${n.toLocaleString('en-US')}`).join(' · '), 1024) })
    }
    // Farmable materials only: chips, skill summaries and module items come from other places.
    const top = [...total.entries()]
      .filter(([mid]) => (p.items[mid]?.[1] ?? 0) >= 3 && (p.items[mid]?.[1] ?? 0) <= 4 && !/Chip|Skill Summary|Data Supplement|Module|Battle Record/i.test(itemName(p, mid)))
      .sort((x, y) => (p.items[y[0]]?.[1] ?? 0) - (p.items[x[0]]?.[1] ?? 0) || y[1] - x[1])
      .map(([mid]) => mid)
      .slice(0, 3)
      .map(mid => `\`/farm material:${itemName(p, mid)}\``)
    if (top.length) e.addFields({ name: 'Where to farm', value: top.join(' · ') })
  }
  e.setFooter({ text: `${FOOTER} · Totals from the EN game data` })
  const has: Record<string, boolean> = {
    everything: true,
    elite1: c.elite[0].length > 0,
    elite2: c.elite[1].length > 0,
    skills: c.skills.length > 0,
    masteries: c.masteries.length > 0,
    modules: c.modules.length > 0,
  }
  const btns = GOALS.filter(([g]) => has[g]).map(([g, l]) =>
    new ButtonBuilder()
      .setCustomId(`arkp:mat:${id}:${g}`)
      .setLabel(l)
      .setStyle(g === goal ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(g === goal),
  )
  const rows: ActionRowBuilder<ButtonBuilder>[] = []
  for (let k = 0; k < btns.length; k += 3) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(btns.slice(k, k + 3)))
  return { embeds: [e], components: rows }
}

async function cmdMaterials(i: ChatInputCommandInteraction, eph: boolean) {
  const p = await need(i, eph)
  if (!p) return
  const hit = charOf(p, i.options.getString('operator', true))
  if (!hit) {
    await i.reply({
      embeds: [embed('Record not found').setColor(COLOR.warn).setDescription('I could not find that operator. Please pick a name from the suggestions. I apologize.')],
      flags: ephFlag(eph),
    })
    return
  }
  await i.reply({ ...materialsView(p, hit.id, i.options.getString('goal') ?? 'everything'), flags: ephFlag(eph) })
}

/** Buttons from /materials and the /operator card. A private reply is switched in place; a public one answers privately. */
export async function handleArkPlusButton(i: ButtonInteraction): Promise<void> {
  ensurePlus()
  const pic = /^arkp:(?:enemy|enpic):([^:]+)/.exec(i.customId)
  if (pic) {
    const e = plus?.enemies?.[pic[1]]
    if (!e) {
      await i.reply({ content: '[PRTS] That record is not available right now. Please try again shortly. I apologize.', flags: MessageFlags.Ephemeral })
      return
    }
    // The wiki lookup can take longer than Discord's 3 second window, so acknowledge first.
    const inPlace = i.message?.flags?.has(MessageFlags.Ephemeral)
    await (inPlace ? i.deferUpdate() : i.deferReply({ flags: MessageFlags.Ephemeral }))
    await i.editReply(stampEmbeds(await enemyView(e), SECTION.enemy) as Awaited<ReturnType<typeof enemyView>>)
    return
  }
  const m = /^arkp:mat:([^:]+):(\w+)$/.exec(i.customId)
  if (!m || !plus?.chars[m[1]]) {
    await i.reply({ content: '[PRTS] That record is not available right now. Please try again shortly. I apologize.', flags: MessageFlags.Ephemeral })
    return
  }
  const view = materialsView(plus, m[1], m[2])
  stampEmbeds(view, SECTION.materials)
  if (i.message?.flags?.has(MessageFlags.Ephemeral)) await i.update(view)
  else await i.reply({ ...view, flags: MessageFlags.Ephemeral })
}

// ───────────────────────── /remind ─────────────────────────
type Reminder = { id: number; userId: string; channelId?: string; at: number; text: string }
type RemindStore = { next: number; items: Reminder[] }
function loadReminders(): RemindStore {
  try {
    return JSON.parse(readFileSync(REMIND_FILE, 'utf8'))
  } catch {
    return { next: 1, items: [] }
  }
}
function saveReminders(s: RemindStore): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(REMIND_FILE, JSON.stringify(s))
  } catch {}
}
const UNITS: Record<string, number> = {
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  m: 60,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hrs: 3600,
  hour: 3600,
  hours: 3600,
  d: 86400,
  day: 86400,
  days: 86400,
  w: 604800,
  week: 604800,
  weeks: 604800,
}
/** "1h30m", "2 days", "90 minutes" → seconds, or null. */
export function parseDuration(text: string): number | null {
  const t = text.toLowerCase().trim()
  const re = /(\d+(?:\.\d+)?)\s*([a-z]+)/g
  if (t.replace(re, '').replace(/[\s,]|and/g, '')) return null
  let total = 0,
    m: RegExpExecArray | null
  while ((m = re.exec(t))) {
    const u = UNITS[m[2]]
    if (!u) return null
    total += parseFloat(m[1]) * u
  }
  return total >= 10 ? Math.round(total) : null
}
async function cmdRemind(i: ChatInputCommandInteraction) {
  const sub = i.options.getSubcommand()
  const store = loadReminders()
  const mine = store.items.filter(r => r.userId === i.user.id).sort((a, b) => a.at - b.at)
  if (sub === 'add') {
    const secs = parseDuration(i.options.getString('in', true))
    if (!secs) {
      await i.reply({ content: '[PRTS] I could not read that time. Please use something like `30m`, `2h` or `1d12h` (at least 10 seconds). I apologize.', flags: MessageFlags.Ephemeral })
      return
    }
    if (secs > 60 * 86400) {
      await i.reply({ content: '[PRTS] Reminders can be set up to 60 days ahead. I apologize for the limitation.', flags: MessageFlags.Ephemeral })
      return
    }
    if (mine.length >= 25) {
      await i.reply({ content: '[PRTS] You already have 25 pending reminders. Please cancel one with `/remind cancel`.', flags: MessageFlags.Ephemeral })
      return
    }
    const r: Reminder = { id: store.next++, userId: i.user.id, channelId: i.channelId ?? undefined, at: Date.now() + secs * 1000, text: i.options.getString('message', true) }
    store.items.push(r)
    saveReminders(store)
    await i.reply({
      embeds: [
        embed('Reminder registered. Real-time logging activated.')
          .setColor(COLOR.ok)
          .setDescription(`**#${r.id}** · <t:${Math.floor(r.at / 1000)}:R> (<t:${Math.floor(r.at / 1000)}:f>)\n${clip(r.text, 300)}`),
      ],
      flags: MessageFlags.Ephemeral,
    })
    return
  }
  if (sub === 'list') {
    const lines = mine.map(r => `**#${r.id}** · <t:${Math.floor(r.at / 1000)}:R> · ${clip(r.text, 80)}`)
    await i.reply({ embeds: [embed('Your reminders').setDescription(lines.join('\n') || 'No pending reminders on file.')], flags: MessageFlags.Ephemeral })
    return
  }
  const id = i.options.getInteger('id', true)
  const r = mine.find(x => x.id === id)
  if (!r) {
    await i.reply({ content: `[PRTS] No pending reminder #${id} of yours. See \`/remind list\`.`, flags: MessageFlags.Ephemeral })
    return
  }
  store.items = store.items.filter(x => x !== r)
  saveReminders(store)
  await i.reply({ content: `[PRTS] Reminder #${id} cancelled. The record has been deleted.`, flags: MessageFlags.Ephemeral })
}

/** Delivers due reminders: in the channel where they were set, or by DM when that fails. */
export function startReminders(client: Client): void {
  const tick = async () => {
    const store = loadReminders()
    const due = store.items.filter(r => r.at <= Date.now())
    if (!due.length) return
    store.items = store.items.filter(r => r.at > Date.now())
    saveReminders(store)
    for (const r of due) {
      const late = Date.now() - r.at > 120_000
      const text = `\`[PRTS]\` ⏰ <@${r.userId}> Scheduled reminder: ${r.text}${late ? ' _(delivered late. I apologize: the system was offline.)_' : ''}`
      let sent = false
      if (r.channelId) {
        try {
          const ch = await client.channels.fetch(r.channelId)
          if (ch && 'send' in ch) {
            await ch.send({ content: text, allowedMentions: { users: [r.userId] } })
            sent = true
          }
        } catch {}
      }
      if (!sent) {
        try {
          const u = await client.users.fetch(r.userId)
          await u.send(`[PRTS] ⏰ Scheduled reminder: ${r.text}${late ? ' (delivered late. I apologize: the system was offline.)' : ''}`)
        } catch (err) {
          log(`reminder #${r.id} could not be delivered: ${err}`)
        }
      }
    }
  }
  setInterval(() => void tick().catch(() => {}), 15_000).unref()
  void tick().catch(() => {})
}

// ───────────────────────── announcements ─────────────────────────
// In the channels picked with /events announce (see announce.ts), posts when an event or headhunting banner starts and
// again about a day before it ends. Posted ids are remembered in cache/announced.json, and
// on the very first run everything already running counts as announced (no backlog spam).
const ANNOUNCED_FILE = join(CACHE_DIR, 'announced.json')
export function startAnnouncements(client: Client): void {
  let seen: Record<string, number> | null = null
  try {
    seen = JSON.parse(readFileSync(ANNOUNCED_FILE, 'utf8'))
  } catch {}
  const tick = async () => {
    ensurePlus()
    if (!plus) return
    const now = Math.floor(Date.now() / 1000)
    const items = [
      ...plus.events.map(e => ({ key: `ev:${e.id}`, name: e.name, kind: 'Event', start: e.start, end: e.end })),
      ...plus.banners
        .filter(b => BANNER_KIND[b.type] && b.type !== 'NORMAL' && b.end - b.open < 60 * 24 * 3600)
        .map(b => ({ key: `hh:${b.id}`, name: b.name, kind: `${BANNER_KIND[b.type]} headhunting`, start: b.open, end: b.end })),
    ]
    const first = seen === null
    seen ??= {}
    const posts: string[] = []
    for (const x of items) {
      if (x.end <= now) continue
      if (x.start <= now && !seen[`${x.key}:start`]) {
        seen[`${x.key}:start`] = now
        if (!first) posts.push(`🟢 **${clip(x.name, 80)}** (${x.kind}) has started · ends <t:${x.end}:R> (<t:${x.end}:f>)`)
      }
      if (x.end - now < 26 * 3600 && x.start <= now && !seen[`${x.key}:end`]) {
        seen[`${x.key}:end`] = now
        if (!first) posts.push(`⏳ **${clip(x.name, 80)}** (${x.kind}) ends <t:${x.end}:R> (<t:${x.end}:f>)`)
      }
    }
    for (const k of Object.keys(seen)) if (now - seen[k] > 120 * 24 * 3600) delete seen[k]
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(ANNOUNCED_FILE, JSON.stringify(seen))
    if (!posts.length) return
    await announce(
      client,
      new EmbedBuilder()
        .setColor(0x23b7e5)
        .setTitle('Operations bulletin')
        .setDescription(clip(posts.join('\n'), 4000))
        .setFooter({ text: 'PRTS · /events schedule for the full list' }),
    )
  }
  setTimeout(() => void tick().catch(e => log(`announcements: ${e}`)), 90_000).unref()
  setInterval(() => void tick().catch(e => log(`announcements: ${e}`)), 15 * 60_000).unref()
}

// ───────────────────────── dispatch ─────────────────────────
export async function handleArkPlus(i: ChatInputCommandInteraction): Promise<void> {
  brand(i, SECTION[i.commandName])
  const eph = i.commandName === 'remind' ? true : (i.options.getBoolean('private') ?? false)
  switch (i.commandName) {
    case 'events':
      await (i.options.getSubcommand() === 'announce' ? cmdAnnounce(i) : cmdEvents(i, eph))
      break
    case 'stage':
      await cmdStage(i, eph)
      break
    case 'compare':
      await cmdCompare(i, eph)
      break
    case 'enemy':
      await cmdEnemy(i, eph)
      break
    case 'materials':
      await cmdMaterials(i, eph)
      break
    case 'remind':
      await cmdRemind(i)
      break
  }
}

export async function handleArkPlusAutocomplete(i: AutocompleteInteraction): Promise<void> {
  const f = i.options.getFocused(true)
  const q = String(f.value ?? '')
  ensurePlus()
  let choices: { name: string; value: string }[] = []
  if (i.commandName === 'stage' && f.name === 'name') {
    choices = findStages(q).map(s => ({ name: clip(`${s.code} · ${s.name}${s.diff === 'TOUGH' ? ' (challenge)' : ''} · ${STAGE_TYPE[s.type] ?? s.type}`, 100), value: s.id }))
  } else if (i.commandName === 'enemy' && f.name === 'name') {
    choices = findEnemies(q).map(e => ({ name: clip(`${e.name} · ${e.level}${e.index ? ` · ${e.index}` : ''}`, 100), value: e.id }))
  } else if (f.name.startsWith('operator')) {
    choices = findOps(q)
      .slice(0, 25)
      .map(o => ({ name: `${o.name} · ${o.rarity}★ ${o.cls}`, value: o.name }))
  }
  await i.respond(choices).catch(() => {})
}
