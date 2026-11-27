import { avatarUrl, clip, ephFlag, wikiUrl } from '../common.ts'
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, type ChatInputCommandInteraction } from 'discord.js'
import { FOOTER } from '../theme.ts'
import { statLine, gradeWord, recLevel } from '../equip.ts'
import { type Op, type OpModule, data, ensureData, findOps, normName, opIndex } from './data.ts'
import { MYRTLE, TIMO, embed, notReady, stars } from './helpers.ts'
import { type Sheets, loadSheets, sheetDate } from './sheets.ts'
import { storyAppearances } from './story.ts'
import { wikiLookup } from './wiki.ts'

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
export const ratingRow = (m: OpModule, rows: string[][]) => rows.find(row => m.type.endsWith('-' + row[2].trim()))

function tierText(o: Op, sh: Sheets | null): string | null {
  const t = sh?.tierOf.get(normName(o.name))
  return t?.length ? t.join(', ') : null
}

/** The /operator card (also served by `ark:op:<id>`). */
export function operatorCard(o: Op): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const sh = loadSheets()
  const e = embed(o.name)
    .setURL(wikiUrl(o.name))
    .setDescription([stars(o.rarity), o.usage ? `*${clip(o.usage, 300)}*` : '', o.desc ? `> ${clip(o.desc, 200)}` : ''].filter(Boolean).join('\n'))
    .setThumbnail(avatarUrl(o.id))
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

export async function cmdOperator(i: ChatInputCommandInteraction, eph: boolean) {
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
    const art = await import('../arkplus.ts').then(m => m.wikiPortrait(who)).catch(() => null)
    if (art) w.setImage(art)
    return i.editReply({ embeds: [w.setAuthor({ name: 'No operator file found · Wiki record' })] })
  }
  return i.reply({ ...operatorCard(o), flags: ephFlag(eph) })
}

// ───────────────────────── /module ─────────────────────────

/** The Modules button: what each module does (game data) and the community verdict. */
/** One module per page (`ark:modv:<operator id>:<index>:<fx|review>`), with buttons to switch module and tab. */
export function moduleView(o: Op, idx: number, tab: string): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const rated = loadSheets()?.modules.get(normName(o.name)) ?? []
  const mods = o.modules.slice(0, 5)
  const m = mods[Math.min(Math.max(idx, 0), mods.length - 1)]
  const r = m ? ratingRow(m, rated) : undefined
  const e = embed(m ? `${m.type} · ${m.name}` : `Modules: ${o.name}`)
    .setURL(wikiUrl(o.name))
    .setThumbnail(avatarUrl(o.id))
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
