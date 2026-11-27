import { avatarUrl, clip, ephFlag } from '../common.ts'
import { EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle, type ChatInputCommandInteraction } from 'discord.js'
import { FOOTER } from '../theme.ts'
import { paged } from '../pages.ts'
import { type Op, ensureData, findOps, normName, opIndex } from './data.ts'
import { embed } from './helpers.ts'
import { ratingRow } from './operator.ts'
import { type Sheets, baseOpName, loadSheets, sheetDate } from './sheets.ts'

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

export async function cmdTier(i: ChatInputCommandInteraction, eph: boolean) {
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
    if (o) e.setThumbnail(avatarUrl(o.id))
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
