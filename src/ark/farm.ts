import { clip, ephFlag } from '../common.ts'
import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js'
import { FOOTER } from '../theme.ts'
import { normName } from './data.ts'
import { embed } from './helpers.ts'
import { FARM_ALIAS, type Sheets, loadSheets, sheetDate } from './sheets.ts'

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

export async function cmdFarm(i: ChatInputCommandInteraction, eph: boolean) {
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
