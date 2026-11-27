// PRTS Arknights toolkit: instant slash commands answered by the bot itself
// (no Claude round trip). Dice and coins, operator cards, tier list, module
// ratings, farming, recruitment calculator, wiki search, story reader links.
//
// Each command lives in its own file under src/ark/ (roll, operator, tier,
// farm, recruit, wiki, story, base, skin, myrtle, help). Shared parts:
// definitions.ts (the slash command list), data.ts (game data and operator
// lookups), sheets.ts (community spreadsheets), helpers.ts, autocomplete.ts.
// This file routes commands, buttons and menus to them.
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
import { MessageFlags, type StringSelectMenuInteraction, type ChatInputCommandInteraction, type ButtonInteraction } from 'discord.js'
import { SECTION, brand, stampEmbeds } from './theme.ts'
import { baseOpEmbed, cmdBase } from './ark/base.ts'
import { ensureData, opIndex } from './ark/data.ts'
import { cmdFarm } from './ark/farm.ts'
import { HELP, cmdHelp, helpDetail, helpMenu, linksEmbed } from './ark/help.ts'
import { embed } from './ark/helpers.ts'
import { cmdMyrtle } from './ark/myrtle.ts'
import { cmdOperator, moduleView, operatorCard } from './ark/operator.ts'
import { cmdRecruit } from './ark/recruit.ts'
import { cmdChoose, cmdCoin, cmdRoll } from './ark/roll.ts'
import { type Outfit, cmdSkin, getOutfits, outfitEmbed, outfitListEmbed, skinButtons } from './ark/skin.ts'
import { cmdStory } from './ark/story.ts'
import { cmdTier } from './ark/tier.ts'
import { cmdWiki } from './ark/wiki.ts'

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

export { ARK_COMMANDS, ARK_COMMAND_NAMES } from './ark/definitions.ts'
export { findOps, normName } from './ark/data.ts'
export { refreshSheets } from './ark/sheets.ts'
export { operatorSummary } from './ark/tier.ts'
export { runStoryRefresh, startStoryRefresh } from './ark/story.ts'
export { type HelpEntry, helpEntries, registerHelp } from './ark/help.ts'
export { handleArkAutocomplete } from './ark/autocomplete.ts'
