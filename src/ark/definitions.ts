// ───────────────────────── command definitions ─────────────────────────

// Available everywhere the app is installed (servers, DMs, group DMs).
const ANYWHERE = { type: 1, integration_types: [0, 1], contexts: [0, 1, 2] }
const PRIVATE_OPT = { type: 5, name: 'private', description: 'Only you can see the reply', required: false }

export const ARK_COMMANDS = [
  {
    name: 'roll',
    description: 'Random tools: dice, coin toss, or let PRTS choose',
    options: [
      {
        type: 1,
        name: 'dice',
        description: 'Roll dice: 1d20 = one 20-sided die, 2d6+3 = two 6-sided dice plus 3',
        options: [
          { type: 3, name: 'dice', description: '1d20, 2d6+3, 4d6kh3 (keep highest 3), 2d20kl1 (keep lowest), d% (1-100)', required: false, max_length: 100 },
          { type: 3, name: 'reason', description: 'What the roll is for', required: false, max_length: 100 },
          PRIVATE_OPT,
        ],
      },
      {
        type: 1,
        name: 'coin',
        description: 'Toss a coin (or several)',
        options: [
          { type: 4, name: 'count', description: 'How many coins (default 1, max 100)', required: false, min_value: 1, max_value: 100 },
          { type: 3, name: 'reason', description: 'What the toss is for', required: false, max_length: 100 },
          { type: 4, name: 'heads', description: 'Chance of heads in percent (default 50)', required: false, min_value: 1, max_value: 99 },
          {
            type: 3,
            name: 'call',
            description: 'Call it before the toss',
            required: false,
            choices: [
              { name: 'Heads', value: 'heads' },
              { name: 'Tails', value: 'tails' },
            ],
          },
          PRIVATE_OPT,
        ],
      },
      {
        type: 1,
        name: 'choose',
        description: 'PRTS picks one option for you',
        options: [
          { type: 3, name: 'options', description: 'Options separated by | or commas', required: true, max_length: 500 },
          { type: 3, name: 'reason', description: 'What the choice is for', required: false, max_length: 100 },
          PRIVATE_OPT,
        ],
      },
    ],
  },
  {
    name: 'operator',
    description: 'Operator card: class, faction, tier, modules, links',
    options: [{ type: 3, name: 'name', description: 'Operator name', required: true, autocomplete: true, max_length: 60 }, PRIVATE_OPT],
  },
  {
    name: 'tier',
    description: 'AK Tier List (fan-made, global): show a tier or an operator',
    options: [
      {
        type: 3,
        name: 'tier',
        description: 'Tier to list (default: all top tiers)',
        required: false,
        choices: ['EX', 'S+', 'S', 'S-', 'A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-'].map(t => ({ name: t, value: t })),
      },
      {
        type: 3,
        name: 'class',
        description: 'Only this class',
        required: false,
        choices: ['Vanguard', 'Guard', 'Defender', 'Sniper', 'Caster', 'Medic', 'Supporter', 'Specialist'].map(c => ({ name: c, value: c })),
      },
      { type: 3, name: 'operator', description: 'Look up one operator instead', required: false, autocomplete: true, max_length: 60 },
      PRIVATE_OPT,
    ],
  },
  {
    name: 'farm',
    description: 'Best stages to farm a material (PeterYR sheet)',
    options: [{ type: 3, name: 'material', description: 'Material, e.g. Orirock, Device, RMA', required: true, autocomplete: true, max_length: 60 }, PRIVATE_OPT],
  },
  {
    name: 'recruit',
    description: 'Recruitment calculator: which tag combos guarantee good operators',
    options: [{ type: 3, name: 'tags', description: 'Up to 5 tags, separated by commas, e.g. Slow, Top Operator', required: true, autocomplete: true, max_length: 150 }, PRIVATE_OPT],
  },
  { name: 'wiki', description: 'Search arknights.wiki.gg', options: [{ type: 3, name: 'query', description: 'What to look up', required: true, autocomplete: true, max_length: 150 }, PRIVATE_OPT] },
  {
    name: 'story',
    description: "Find a story chapter or event and link it in Timo's reader",
    options: [{ type: 3, name: 'query', description: 'Stage code (15-12), title, event name or operator', required: true, autocomplete: true, max_length: 100 }, PRIVATE_OPT],
  },
  {
    name: 'base',
    description: 'Base (RIIC) skills and team combos: by operator, team or facility',
    options: [
      { type: 3, name: 'operator', description: "An operator's base skills and the teams they fit", required: false, autocomplete: true, max_length: 60 },
      { type: 3, name: 'team', description: 'A team combo from the RIIC guide', required: false, autocomplete: true, max_length: 100 },
      {
        type: 3,
        name: 'facility',
        description: 'List the team combos for a facility',
        required: false,
        choices: ['Multi-facility', 'Control Center', 'Factory', 'Trading Post'].map(n => ({ name: n, value: n })),
      },
      PRIVATE_OPT,
    ],
  },
  {
    name: 'skin',
    description: "An operator's outfits: art, artist, how to get it, animated and chibi versions",
    options: [
      { type: 3, name: 'operator', description: 'Operator name', required: true, autocomplete: true, max_length: 60 },
      { type: 3, name: 'outfit', description: 'One outfit to show (default: list them all)', required: false, autocomplete: true, max_length: 100 },
      PRIVATE_OPT,
    ],
  },
  {
    name: 'myrtle',
    description: 'Myrtle.moe player profiles: look up, link your account, roster, leaderboard',
    options: [
      {
        type: 1,
        name: 'profile',
        description: "A player's profile card: level, score, rank, supports, roster stats",
        options: [
          { type: 3, name: 'player', description: 'Name, Name#1234, UID or myrtle.moe link (default: your linked account)', required: false, autocomplete: true, max_length: 100 },
          { type: 6, name: 'user', description: 'A Discord user who linked their account', required: false },
          PRIVATE_OPT,
        ],
      },
      {
        type: 1,
        name: 'roster',
        description: "A player's operators: top builds, or one operator's build",
        options: [
          { type: 3, name: 'player', description: 'Name, Name#1234, UID or myrtle.moe link (default: your linked account)', required: false, autocomplete: true, max_length: 100 },
          { type: 6, name: 'user', description: 'A Discord user who linked their account', required: false },
          { type: 3, name: 'operator', description: 'Show only this operator', required: false, autocomplete: true, max_length: 60 },
          {
            type: 3,
            name: 'sort',
            description: 'Order (default: level)',
            required: false,
            choices: [
              { name: 'Level (promotion, then level)', value: 'level' },
              { name: 'Rarity', value: 'rarity' },
              { name: 'Masteries', value: 'mastery' },
              { name: 'Modules', value: 'module' },
              { name: 'Most recently obtained', value: 'recent' },
            ],
          },
          { type: 4, name: 'rarity', description: 'Only this rarity', required: false, min_value: 1, max_value: 6 },
          {
            type: 3,
            name: 'class',
            description: 'Only this class',
            required: false,
            choices: ['Vanguard', 'Guard', 'Defender', 'Sniper', 'Caster', 'Medic', 'Supporter', 'Specialist'].map(c => ({ name: c, value: c })),
          },
          PRIVATE_OPT,
        ],
      },
      {
        type: 1,
        name: 'pulls',
        description: "A player's public headhunting history: pity, 6★ and 5★ pulls, rates",
        options: [
          { type: 3, name: 'player', description: 'Name, Name#1234, UID or myrtle.moe link (default: your linked account)', required: false, autocomplete: true, max_length: 100 },
          { type: 6, name: 'user', description: 'A Discord user who linked their account', required: false },
          {
            type: 3,
            name: 'banner',
            description: 'Only this banner type (default: all)',
            required: false,
            choices: [
              { name: 'Limited', value: 'limited' },
              { name: 'Standard', value: 'standard' },
              { name: 'Kernel', value: 'kernel' },
              { name: 'Beginner', value: 'beginner' },
            ],
          },
          PRIVATE_OPT,
        ],
      },
      {
        type: 1,
        name: 'inventory',
        description: "A player's public item inventory: materials, chips, tickets",
        options: [
          { type: 3, name: 'player', description: 'Name, Name#1234, UID or myrtle.moe link (default: your linked account)', required: false, autocomplete: true, max_length: 100 },
          { type: 6, name: 'user', description: 'A Discord user who linked their account', required: false },
          { type: 3, name: 'item', description: 'Only items whose name contains this', required: false, max_length: 60, autocomplete: true },
          PRIVATE_OPT,
        ],
      },
      {
        type: 1,
        name: 'lookback',
        description: "A player's progress snapshots over time (operators, E2, masteries, modules, score)",
        options: [
          { type: 3, name: 'player', description: 'Name, Name#1234, UID or myrtle.moe link (default: your linked account)', required: false, autocomplete: true, max_length: 100 },
          { type: 6, name: 'user', description: 'A Discord user who linked their account', required: false },
          PRIVATE_OPT,
        ],
      },
      {
        type: 1,
        name: 'showcase',
        description: "A player's profile showcase: favourite operators, enemies, outfits, tier lists",
        options: [
          { type: 3, name: 'player', description: 'Name, Name#1234, UID or myrtle.moe link (default: your linked account)', required: false, autocomplete: true, max_length: 100 },
          { type: 6, name: 'user', description: 'A Discord user who linked their account', required: false },
          PRIVATE_OPT,
        ],
      },
      {
        type: 1,
        name: 'plans',
        description: "A player's public operator plans",
        options: [
          { type: 3, name: 'player', description: 'Name, Name#1234, UID or myrtle.moe link (default: your linked account)', required: false, autocomplete: true, max_length: 100 },
          { type: 6, name: 'user', description: 'A Discord user who linked their account', required: false },
          PRIVATE_OPT,
        ],
      },
      {
        type: 1,
        name: 'search',
        description: 'Find Myrtle players by in-game name',
        options: [{ type: 3, name: 'name', description: 'In-game name (part of it is fine)', required: true, max_length: 60 }, PRIVATE_OPT],
      },
      {
        type: 1,
        name: 'leaderboard',
        description: 'Myrtle account score leaderboard',
        options: [
          {
            type: 3,
            name: 'sort',
            description: 'Category (default: total)',
            required: false,
            choices: Object.entries({
              total_score: 'Total',
              operator_score: 'Operators',
              stage_score: 'Stages',
              roguelike_score: 'Integrated Strategies',
              sandbox_score: 'Reclamation Algorithm',
              medal_score: 'Medals',
              base_score: 'Base (RIIC)',
            }).map(([value, name]) => ({ name, value })),
          },
          { type: 3, name: 'server', description: 'Only this server', required: false, choices: ['EN', 'JP', 'KR'].map(s => ({ name: s, value: s })) },
          PRIVATE_OPT,
        ],
      },
      {
        type: 1,
        name: 'link',
        description: 'Link your Discord account to your Myrtle profile',
        options: [{ type: 3, name: 'player', description: 'Your name#1234, UID or myrtle.moe link', required: true, autocomplete: true, max_length: 100 }],
      },
      { type: 1, name: 'unlink', description: 'Remove the link to your Myrtle profile', options: [] },
    ],
  },
  {
    name: 'help',
    description: 'All commands, what they do and how to use them',
    options: [{ type: 3, name: 'command', description: 'Show details and examples for one command', required: false, choices: [] as { name: string; value: string }[] }, PRIVATE_OPT],
  },
].map(c => ({ ...ANYWHERE, ...c }))

export const ARK_COMMAND_NAMES = new Set(ARK_COMMANDS.map(c => c.name))
