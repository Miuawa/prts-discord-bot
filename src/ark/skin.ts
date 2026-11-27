import { avatarUrl, clip, ephFlag, wikiUrl } from '../common.ts'
import { EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, type ChatInputCommandInteraction } from 'discord.js'
import { FOOTER } from '../theme.ts'
import { type Op, data, ensureData, findOps, normName, stripRich } from './data.ts'
import { MYRTLE, embed, notReady } from './helpers.ts'
import { fail, myrtleGet } from './myrtle.ts'

// ───────────────────────── /skin ─────────────────────────
// Outfit data and chibi availability come from Myrtle's backend; images are
// the official art files hosted on Myrtle's asset CDN (embedded by URL).
// Animated art and chibis are Spine data that Myrtle animates in the browser,
// so the bot links to the operator's Myrtle page for those.

const MYRTLE_ASSETS = 'https://assets.eltik.net/myrtle/en/textures'
export type Outfit = {
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

export async function getOutfits(opId: string): Promise<Outfit[]> {
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
export function skinButtons(op: Op, o?: Outfit, list?: Outfit[]) {
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
export function outfitEmbed(op: Op, o: Outfit): EmbedBuilder {
  const e = embed(`${op.name} · ${o.name}`)
    .setURL(`${MYRTLE}/operators/${op.id}`)
    .setDescription([o.line && `*${o.line}*`].filter(Boolean).join('\n') || null)
    .setImage(outfitArt(op.id, o))
    .setThumbnail(avatarUrl(op.id))
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

const outfitArt = (opId: string, o: Outfit) =>
  o.elite !== undefined ? `${MYRTLE_ASSETS}/chararts/${opId}/${opId}_${o.elite === 0 ? 1 : 2}.png` : `${MYRTLE_ASSETS}/skinpack/${opId}/${encodeURIComponent(o.portrait)}.png`

export function outfitListEmbed(op: Op, list: Outfit[]): EmbedBuilder {
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

export async function cmdSkin(i: ChatInputCommandInteraction, eph: boolean) {
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
