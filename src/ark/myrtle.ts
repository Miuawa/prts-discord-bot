import { GAMEDATA, UA, avatarUrl, clip, ephFlag, wikiUrl } from '../common.ts'
import { EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle, type ChatInputCommandInteraction } from 'discord.js'
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { join } from 'path'
import { COLOR, FOOTER } from '../theme.ts'
import { linePages, paged } from '../pages.ts'
import { CACHE_DIR } from '../paths.ts'
import { ensureData, findOps, opIndex } from './data.ts'
import { MYRTLE, embed } from './helpers.ts'

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
export let itemTable: { at: number; items: ItemTable } | null = null
export async function getItems(): Promise<ItemTable> {
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

export async function myrtleGet(path: string, timeoutMs = 15_000): Promise<any> {
  const r = await fetch(`${MYRTLE_API}/${path}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) })
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`myrtle ${r.status} ${path}`)
  return r.json()
}
export const myrtleSearch = async (q: string, limit = 25, timeoutMs?: number): Promise<{ entries: MUser[]; total: number }> =>
  (await myrtleGet(`search?q=${encodeURIComponent(q)}&limit=${limit}`, timeoutMs)) ?? { entries: [], total: 0 }
const myrtleUrl = (uid: string) => `${MYRTLE}/user/${uid}`
export const tag = (u: MUser) => (u.nick_number ? `${u.nickname}#${u.nick_number}` : u.nickname)
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

export const fail = (i: ChatInputCommandInteraction, msg: string) => i.editReply({ embeds: [embed('Record not found').setColor(COLOR.warn).setDescription(msg)] })

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

export async function cmdMyrtle(i: ChatInputCommandInteraction, eph: boolean) {
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
        .setThumbnail(avatarUrl(o.id))
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
