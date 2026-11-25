// AI turns answered by an API backend (Anthropic or OpenAI-compatible)
// instead of the Claude Code narrator. The bot builds the prompt itself,
// keeps a short per-channel history, and posts the reply split for Discord.
//
// The history is also fed while Claude Code answers, so a switch between
// backends (PRTS_BACKEND=auto) keeps the thread.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { CACHE_DIR } from '../paths.ts'
import type { AiConfig, ApiBackend } from './config.ts'
import { complete, type Msg } from './providers.ts'
import { loadImages, type ImageRef, type LoadedImage } from './images.ts'

/** An AI event. `images` (bot-internal, never sent to Claude Code) are the message's image attachments. */
export type ChannelEvent = { content: string; meta: Record<string, string | undefined>; images?: ImageRef[] }
export type Prompt = { system: string; maxTokens?: number }
/** What a module (or the core /prts chat) contributes to an API turn. */
export type TurnHooks = {
  /** History namespace, so different features never share a thread. */
  key: string
  /** System prompt for this turn. `history` is the recent history as plain text. */
  prompt(ev: ChannelEvent, history: string): Prompt
  /** How a speaker is named in the history (default: the Discord username). */
  speaker?(username: string): string
  /** Runs after the reply was posted. */
  after?(ev: ChannelEvent, userLine: string, reply: string, label: string): void
}
export type Send = (chat_id: string, text: string) => Promise<{ isError?: boolean; content: { text: string }[] }>

const log = (s: string): void => {
  process.stderr.write(`prts ai: ${s}\n`)
}
const HISTORY_FILE = process.env.PRTS_AI_HISTORY ?? join(CACHE_DIR, 'ai-history.json')
const HISTORY_CHARS = 26_000 // per channel

// ---------- per-channel history ----------
let history: Record<string, Msg[]> = {}
try {
  history = JSON.parse(readFileSync(HISTORY_FILE, 'utf8'))
} catch {}
let saveTimer: ReturnType<typeof setTimeout> | null = null
function saveHistory(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      mkdirSync(dirname(HISTORY_FILE), { recursive: true })
      writeFileSync(HISTORY_FILE + '.tmp', JSON.stringify(history))
      renameSync(HISTORY_FILE + '.tmp', HISTORY_FILE)
    } catch (e) {
      log(`could not save history: ${e}`)
    }
  }, 1000)
  saveTimer.unref?.()
}
function push(key: string, m: Msg): void {
  const h = (history[key] ??= [])
  // Merge consecutive user messages (several people writing before a reply).
  const last = h[h.length - 1]
  if (last && last.role === m.role && m.role === 'user') last.content += '\n' + m.content
  else h.push(m)
  let total = h.reduce((n, x) => n + x.content.length, 0)
  while (h.length > 2 && total > HISTORY_CHARS) total -= h.shift()!.content.length
  // A conversation must start with a user turn.
  while (h.length && h[0].role !== 'user') h.shift()
  saveHistory()
}

const keyOf = (hooks: TurnHooks, meta: ChannelEvent['meta']) => `${hooks.key}:${meta.channel_id ?? meta.chat_id ?? 'unknown'}`
const chatKeys = new Map<string, string>() // chat_id (slash:... or channel id) -> history key

export function userLine(ev: ChannelEvent, hooks: TurnHooks): string {
  const m = ev.meta
  const user = m.user ?? 'unknown'
  const who = hooks.speaker?.(user) ?? user
  const tag = m.command ? ` /${m.command}${m.subcommand ? ' ' + m.subcommand : ''}` : ''
  const extra = [
    m.reply_to_text ? `(replying to ${m.reply_to_user ?? 'someone'}: "${m.reply_to_text.slice(0, 300)}")` : '',
    m.attachment_count ? `(attached: ${m.attachments ?? `${m.attachment_count} file(s)`})` : '',
    m.reply_to_attachments ? `(the replied-to message has: ${m.reply_to_attachments})` : '',
  ]
    .filter(Boolean)
    .join(' ')
  return `[${who}${tag}] ${ev.content}${extra ? ' ' + extra : ''}`
}

/** Record a message that went to the Claude Code narrator. */
export function recordUser(ev: ChannelEvent, hooks: TurnHooks): void {
  const key = keyOf(hooks, ev.meta)
  if (ev.meta.chat_id) chatKeys.set(ev.meta.chat_id, key)
  if (chatKeys.size > 500) chatKeys.delete(chatKeys.keys().next().value!)
  push(key, { role: 'user', content: userLine(ev, hooks) })
}
/** Record a reply the Claude Code narrator sent with the reply tool. */
export function recordAssistant(chat_id: string, text: string): void {
  const key = chatKeys.get(chat_id)
  if (!key || !text || !history[key]?.length) return
  const h = history[key]
  const last = h[h.length - 1]
  if (last.role === 'assistant') last.content += '\n' + text
  else push(key, { role: 'assistant', content: text })
  saveHistory()
}

/** Split at blank lines, then lines, then sentences, so no part exceeds Discord's limit. */
export function splitForDiscord(text: string, limit = 1900): string[] {
  const out: string[] = []
  let cur = ''
  const pieces = text
    .split(/\n{2,}/)
    .flatMap(p => (p.length <= limit ? [p] : p.split(/\n/)))
    .flatMap(p => (p.length <= limit ? [p] : (p.match(new RegExp(`[^]{1,${limit}}(?:[.!?…]\\s|$)|[^]{1,${limit}}`, 'g')) ?? [p])))
  for (const p of pieces) {
    const sep = cur ? (cur.endsWith('\n') ? '' : '\n\n') : ''
    if ((cur + sep + p).length > limit && cur) {
      out.push(cur.trim())
      cur = p
    } else cur += sep + p
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

// One turn at a time per channel, and one model call at a time per backend
// URL (a local llama-server usually runs with --parallel 1).
const lanes = new Map<string, Promise<unknown>>()
const queues = new Map<string, Promise<unknown>>()

export function handleApiTurn(ev: ChannelEvent, backend: ApiBackend, cfg: AiConfig, hooks: TurnHooks, send: Send, typing?: () => void): Promise<void> {
  const key = keyOf(hooks, ev.meta)
  const prev = queues.get(key) ?? Promise.resolve()
  const job = prev.then(() => runTurn(ev, backend, cfg, hooks, send, typing)).catch(e => log(`turn failed: ${e}`))
  queues.set(key, job)
  return job
}

async function runTurn(ev: ChannelEvent, backend: ApiBackend, cfg: AiConfig, hooks: TurnHooks, send: Send, typing?: () => void): Promise<void> {
  const chat_id = ev.meta.chat_id!
  const key = keyOf(hooks, ev.meta)
  const line = userLine(ev, hooks)
  push(key, { role: 'user', content: line })
  const msgs = [...(history[key] ?? [])]
  const { system, maxTokens } = hooks.prompt(ev, msgs.map(x => x.content).join('\n'))
  typing?.()
  const tick = typing ? setInterval(typing, 8000) : null
  const lane = backend === 'anthropic' ? 'anthropic' : cfg.baseUrl
  let text: string
  try {
    // Images go with this message only. Say so in the text, so the model knows what it sees.
    const images: LoadedImage[] = cfg.vision === 'off' ? [] : await loadImages(ev.images)
    const note = (imgs: LoadedImage[]) =>
      imgs.length ? `\n(${imgs.length} image(s) included: ${imgs.map(i => i.name).join(', ')})` : ev.images?.length || ev.meta.attachment_count ? '\n(You cannot see the attachments.)' : ''
    const ask = (imgs: LoadedImage[]) => {
      const m = [...msgs]
      const last = m[m.length - 1]
      if (last?.role === 'user') m[m.length - 1] = { role: 'user', content: last.content + note(imgs) }
      return complete(backend, cfg, system, m, maxTokens, imgs)
    }
    const call = async () => {
      if (!images.length || cfg.vision === 'on') return ask(images)
      try {
        return await ask(images)
      } catch (e) {
        // auto: a model without vision rejects images; answer from the text alone.
        log(`request with ${images.length} image(s) failed (${String(e).slice(0, 160)}); retrying without images`)
        return ask([])
      }
    }
    const run = (lanes.get(lane) ?? Promise.resolve()).then(call)
    lanes.set(
      lane,
      run.catch(() => {}),
    )
    const r = await run
    if (r.info) log(r.info)
    text = r.refused ? '[PRTS] I am unable to continue with that request.' : r.text
    if (r.truncated) text += '\n\n`[PRTS] Output truncated at the length limit.`'
  } catch (e) {
    log(`model call failed: ${e}`)
    await send(
      chat_id,
      '[PRTS] Narrative core unavailable. The connection to the language model has been interrupted. Instant functions remain operational: `/help` lists them. I apologize for the inconvenience.',
    )
    return
  } finally {
    if (tick) clearInterval(tick)
  }
  if (!text) text = '[PRTS] ...... No output was produced. Please try again.'
  push(key, { role: 'assistant', content: text })
  for (const part of splitForDiscord(text)) {
    const r = await send(chat_id, part)
    if (r.isError) {
      log(`send failed: ${r.content[0]?.text}`)
      break
    }
  }
  hooks.after?.(ev, line, text, cfg.label ?? backend)
}
