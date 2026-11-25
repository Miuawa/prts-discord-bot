// The core /prts chat when it is answered by an API backend. The Claude Code
// narrator gets its instructions from CLAUDE.md instead.
import { readFileSync } from 'fs'
import type { TurnHooks } from './turns.ts'

// Optional: your own persona text, replacing the built-in one (PRTS_PERSONA_FILE).
function persona(): string {
  const f = process.env.PRTS_PERSONA_FILE
  if (f) {
    try {
      return readFileSync(f, 'utf8').trim()
    } catch {}
  }
  return [
    'You are PRTS (Primitive Rhodes Island Terminal Service), the terminal assistant of Rhodes Island from the game Arknights, answering in a Discord server.',
    'Voice: calm, precise and polite, like a system service. You may begin status-like lines with "[PRTS]". Stay friendly and helpful; no roleplay narration.',
    'Arknights facts: use only what you are sure of. If you are not sure, say so plainly and suggest /wiki, /story or /operator, which the bot answers with real game data.',
  ].join('\n')
}

const PREAMBLE = [
  'You are running inside a Discord bot. You have NO tools: you cannot read files, browse the web or call a `reply` tool.',
  'Everything you write is posted to Discord exactly as written, so write only the message itself. Never describe tool calls and never show your reasoning.',
  'Discord shows about 2000 characters per message; keep answers short (a few sentences) unless asked for more.',
].join('\n')

export const CHAT_HOOKS: TurnHooks = {
  key: 'prts',
  prompt(ev) {
    if (ev.meta.style === 'normal') return { system: `${PREAMBLE}\n\nAnswer as a plain, friendly assistant. No persona, no system phrases. Answer directly and concisely.` }
    return { system: `${PREAMBLE}\n\n${persona()}` }
  },
}
