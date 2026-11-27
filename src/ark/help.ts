import { WIKI, clip, ephFlag } from '../common.ts'
import { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, type ChatInputCommandInteraction } from 'discord.js'
import { FOOTER } from '../theme.ts'
import { ARK_COMMANDS } from './definitions.ts'
import { MYRTLE, TIMO, embed } from './helpers.ts'
import { RIIC_URL } from './sheets.ts'

// ───────────────────────── /links /help ─────────────────────────

export function linksEmbed(): EmbedBuilder {
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
export const HELP: HelpEntry[] = [
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
/** Every /help entry (for the test that keeps /help in step with the commands). */
export const helpEntries = (): readonly HelpEntry[] => HELP
/** Other modules add their commands to /help here. */
export function registerHelp(entries: HelpEntry[]): void {
  const at = HELP.findIndex(h => h.cmd === 'status')
  HELP.splice(at < 0 ? HELP.length : at, 0, ...entries)
  fillHelpChoices()
}

export function helpDetail(h: HelpEntry): EmbedBuilder {
  const e = embed(h.cmd === 'links' ? 'Useful sites' : `/${h.cmd}`)
    .setDescription(h.detail)
    .addFields({ name: 'Usage', value: '`' + h.usage + '`' }, { name: 'Examples', value: h.examples.map(x => '`' + x + '`').join('\n') || '—' })
  if (!/\(AI\)/.test(h.group)) e.setFooter({ text: `${FOOTER} · Answered instantly by the bot (no AI)` })
  return e
}

export function helpMenu(): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('ark:help')
      .setPlaceholder('Details and examples for a command…')
      .addOptions(HELP.slice(0, 25).map(h => ({ label: h.cmd === 'links' ? 'Useful sites' : `/${h.cmd}`, value: h.cmd, description: clip(h.short, 100) }))),
  )
}

export async function cmdHelp(i: ChatInputCommandInteraction, eph: boolean) {
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
