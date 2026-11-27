import { clip, ephFlag } from '../common.ts'
import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js'
import { COLOR, FOOTER } from '../theme.ts'
import { type Op, data, ensureData, normName } from './data.ts'
import { embed, notReady } from './helpers.ts'

// ───────────────────────── /recruit ─────────────────────────

function opRecruitTags(o: Op): Set<string> {
  const t = new Set<string>([o.cls, o.pos, ...o.tags])
  if (o.rarity === 6) t.add('Top Operator')
  if (o.rarity === 5) t.add('Senior Operator')
  if (o.rarity === 2) t.add('Starter')
  if (o.rarity === 1) t.add('Robot')
  return t
}

export async function cmdRecruit(i: ChatInputCommandInteraction, eph: boolean) {
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
