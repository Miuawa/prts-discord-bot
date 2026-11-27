import { avatarUrl, clip, ephFlag } from '../common.ts'
import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from 'discord.js'
import { FOOTER } from '../theme.ts'
import { type Op, data, ensureData, findOps, normName } from './data.ts'
import { embed, notReady } from './helpers.ts'
import { RIIC_URL, loadSheets, sheetDate } from './sheets.ts'

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

export function baseOpEmbed(o: Op): EmbedBuilder {
  const sh = loadSheets()
  const footer = `${FOOTER} · RIIC base skill guide (fan-made, live from Google Sheets) · checked ${sheetDate('riic-base-skills.txt')}`
  const e = embed(`Base skills: ${o.name}`).setURL(RIIC_URL).setThumbnail(avatarUrl(o.id)).setFooter({ text: footer })
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

export async function cmdBase(i: ChatInputCommandInteraction, eph: boolean) {
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
    if (m.first) e.setThumbnail(avatarUrl(m.first.id))
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
