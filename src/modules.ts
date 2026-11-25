// Add-on modules. A module is a folder modules/<name>/ with an index.ts whose
// default export is a PrtsModule (or a function returning one). Enable modules
// with PRTS_MODULES=name1,name2 in .env; a module that is not listed is never
// loaded, and the bot then behaves exactly as without it.
//
// See docs/modules.md for a walkthrough. Everything a module may touch is in
// this file: the bot never calls into a module in any other way.
import type { Client, ChatInputCommandInteraction, Message } from 'discord.js'
import { existsSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import type { HelpEntry } from './ark.ts'
import type { AiConfig } from './ai/config.ts'
import type { ChannelEvent, TurnHooks } from './ai/turns.ts'
import { ROOT } from './paths.ts'

export type { AiConfig, ChannelEvent, HelpEntry, TurnHooks }
export type { Prompt } from './ai/turns.ts'
export { readAiConfig } from './ai/config.ts'

/** What a module command hands to the AI: the text it sees, plus extra attributes. */
export type AiRequest = { text: string; meta?: Record<string, string> }

export interface PrtsModule {
  /** Short id, the same as the folder name. Added to every AI event as meta.module. */
  name: string
  /** Slash commands to register (Discord application command JSON). */
  commands?: object[]
  /** Entries for /help. */
  help?: HelpEntry[]
  /** Who answers this module's AI turns. Default: the core's PRTS_BACKEND settings. */
  ai?: AiConfig
  /** Prompt hooks for API backends (Anthropic, OpenAI-compatible). Default: the core /prts chat prompt. */
  turns?: Omit<TurnHooks, 'key'>
  /** Runs once the bot is connected to Discord. */
  init?(client: Client): void | Promise<void>
  /**
   * Channels the module owns. 'active': plain messages from allowlisted users go to the AI without
   * an @mention. 'paused': they are ignored. undefined: not this module's channel. Threads count
   * as their parent channel.
   */
  channelState?(channelId: string): 'active' | 'paused' | undefined
  /** A plain message in an active channel of this module is about to go to the AI. Return extra meta. */
  onMessage?(msg: Message, channelId: string): Record<string, string> | void
  /**
   * One of this module's slash commands was used by an allowlisted user. Answer it yourself and
   * return nothing, or return an AiRequest to pass it to the AI (the bot shows "thinking...").
   */
  onCommand?(i: ChatInputCommandInteraction, client: Client): Promise<AiRequest | void>
  /** Every reply the bot posts for the AI (any backend), with its channel id. */
  onReply?(channelId: string, text: string): void
}

type Factory = () => PrtsModule | Promise<PrtsModule>
const log = (s: string) => process.stderr.write(`prts modules: ${s}\n`)

export const MODULES_DIR = process.env.PRTS_MODULES_DIR ?? join(ROOT, 'modules')

/** Load the modules named in PRTS_MODULES. Broken or missing modules are logged and skipped. */
export async function loadModules(list = process.env.PRTS_MODULES ?? ''): Promise<PrtsModule[]> {
  const names = [
    ...new Set(
      list
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  ]
  const out: PrtsModule[] = []
  for (const name of names) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      log(`"${name}" is not a valid module name (letters, digits, dashes)`)
      continue
    }
    const file = join(MODULES_DIR, name, 'index.ts')
    if (!existsSync(file)) {
      log(
        existsSync(join(MODULES_DIR, name))
          ? `module "${name}" has no bot part (no index.ts; it may be a desktop tool), so there is nothing to load`
          : `module "${name}" is enabled but ${file} does not exist; skipping it`,
      )
      continue
    }
    try {
      const exp = (await import(pathToFileURL(file).href)).default as PrtsModule | Factory
      const mod = typeof exp === 'function' ? await exp() : exp
      if (!mod?.name) throw new Error('default export is not a PrtsModule')
      out.push(mod)
      log(`loaded "${mod.name}" (${mod.commands?.length ?? 0} command(s))`)
    } catch (e) {
      log(`module "${name}" failed to load: ${e}`)
    }
  }
  return out
}
