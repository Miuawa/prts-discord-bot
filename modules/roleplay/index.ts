// Roleplay module for the PRTS Discord bot: /rp, roleplay channels where
// players just write, away mode, turn reminders, and a narrator that can be
// the Claude Code session, the Anthropic API or any OpenAI-compatible model.
//
// Enable with PRTS_MODULES=roleplay. Settings: RP_* (see README.md here).
import type { HelpEntry, PrtsModule } from '../../src/modules.ts'
import { readAiConfig } from '../../src/modules.ts'
import { RP_COMMAND, RP_AI_SUBCOMMANDS, handleRpLocal, rpState, afkCharacters, clearAfk, noteRpMessage, noteNarratorTurn, nudgeTick, readPlayers } from './rp.ts'
import { roleplayPrompt, appendStoryLog, stripPlayerLines } from './prompt.ts'

const HELP: HelpEntry = {
  cmd: 'rp',
  group: 'Roleplay (AI)',
  short: 'Roleplay: act, OOC, join, recap, channels',
  usage: '/rp act | ooc | join | recap | afk away:<true|false> | players | status | pause | resume | reminders | setchannel | removechannel | channels',
  detail: [
    'In a roleplay channel you can simply write normally and the narrator answers. The /rp commands add:',
    '**/rp act text:** your character says or does something (AI)',
    '**/rp ooc text:** talk to the narrator out of character (AI)',
    '**/rp join character:** join the roleplay or switch character (AI checks the character)',
    '**/rp recap [focus:]** a recap of the story so far (AI)',
    '**/rp players** who plays whom · **/rp status** is this a roleplay channel?',
    '**/rp afk away:True** you are away: PRTS plays your character in character until you write again or use **/rp afk away:False**',
    '**/rp reminders minutes:** owner only: turn reminders, how long before players who have not acted are reminded (0 = off)',
    '**/rp pause** / **/rp resume** stop or restart narration here (chat freely while paused)',
    '**/rp setchannel [channel:]** / **/rp removechannel [channel:]** owner only: choose roleplay channels',
    '**/rp channels** list roleplay channels',
    'act, ooc, join and recap only work inside a roleplay channel.',
  ].join('\n'),
  examples: ['/rp act text: I set the teapot down and smile.', '/rp ooc text: brb, dinner', '/rp join character: Amiya', '/rp setchannel'],
}

const afkMeta = (): Record<string, string> => {
  const away = afkCharacters()
  return away.length ? { afk: away.join(', ') } : {}
}

export default function roleplay(): PrtsModule {
  return {
    name: 'roleplay',
    commands: [RP_COMMAND],
    help: [HELP],
    // RP_* settings, falling back to the core PRTS_* ones.
    ai: readAiConfig('RP', readAiConfig('PRTS')),
    turns: {
      prompt: roleplayPrompt,
      speaker(username) {
        const c = readPlayers().find(([u]) => u.toLowerCase() === username.toLowerCase())?.[1]
        return c ? `${c} (${username})` : username
      },
      clean: process.env.RP_STRIP_PLAYER_LINES === 'off' ? undefined : stripPlayerLines,
      after: appendStoryLog,
    },
    characterOf: username => readPlayers().find(([u]) => u.toLowerCase() === username.toLowerCase())?.[1],
    init(client) {
      setInterval(() => void nudgeTick(client).catch(() => {}), 60_000).unref()
    },
    channelState: channelId => rpState(channelId) ?? undefined,
    onMessage(msg, channelId) {
      // A player who writes is back from /rp afk, and counts as having acted this round.
      clearAfk(msg.author.id)
      noteRpMessage(channelId, msg.author.username, msg.author.id)
      return { rp: 'true', ...afkMeta() }
    },
    async onCommand(i, client) {
      if (await handleRpLocal(i, client)) return
      const sub = i.options.getSubcommand()
      if (sub === 'act' && i.channelId) {
        clearAfk(i.user.id)
        noteRpMessage(i.channelId, i.user.username, i.user.id)
      }
      return { text: RP_AI_SUBCOMMANDS[sub](i), meta: { rp: 'true', ...afkMeta() } }
    },
    onReply: (channelId, text) => noteNarratorTurn(channelId, text.length),
  }
}
