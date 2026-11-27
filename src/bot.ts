#!/usr/bin/env bun
/**
 * PRTS Discord bot: the always-on half.
 *
 * Owns the Discord connection and answers every instant command (ark.ts,
 * arkplus.ts), music (music.ts) and voice lines (voice.ts) by itself, with no
 * AI needed. AI traffic (/prts, "Ask PRTS", and AI requests from add-on
 * modules) goes to the backend chosen in the settings (src/ai/config.ts):
 * - claude-code: the Claude Code narrator, through a local WebSocket bridge.
 *   server.ts, the MCP server Claude loads, connects to
 *   ws://127.0.0.1:<port>/?key=<bridge.key>.
 * - anthropic / openai-compatible: an API model, called by the bot itself
 *   (src/ai/turns.ts).
 * When nothing can answer, AI requests get a PRTS "offline" notice.
 *
 * Add-on modules (src/modules.ts, modules/<name>/) are loaded from PRTS_MODULES.
 *
 * Start with windows/start-bot.bat on Windows or prts-bot.service on Linux
 * (both restart it after a crash). Only one copy can run: a
 * second one finds the bridge port taken and exits with code 3.
 * Access control (pairing, allowlists) lives in
 * ~/.claude/channels/discord/access.json, managed by /discord:access.
 */

// Must stay the first import: it loads .env files before the other modules read process.env.
import { ENV_FILE, REPO_ENV_FILE } from './env.ts'
import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  MessageFlags,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  Routes,
  type Message,
  type Attachment,
  type Interaction,
  type ChatInputCommandInteraction,
  type MessageContextMenuCommandInteraction,
} from 'discord.js'
import { randomBytes } from 'crypto'
import { MUSIC_COMMAND, handleMusic, handleMusicButton, handleMusicSelect, handleMusicAutocomplete } from './music.ts'
import { SECTION, brand } from './theme.ts'
import { ARK_COMMANDS, ARK_COMMAND_NAMES, handleArk, handleArkAutocomplete, handleArkButton, handleArkSelect, registerHelp, startStoryRefresh } from './ark.ts'
import { ARKPLUS_COMMANDS, ARKPLUS_NAMES, handleArkPlus, handleArkPlusAutocomplete, handleArkPlusButton, startAnnouncements, startReminders } from './arkplus.ts'
import { readAiConfig, aiAvailable, apiBackendFor, describeBackend, type AiConfig } from './ai/config.ts'
import { handleApiTurn, recordUser, recordAssistant, type TurnHooks } from './ai/turns.ts'
import { probe } from './ai/providers.ts'
import { CHAT_HOOKS } from './ai/chat.ts'
import { imageRefs, type ImageRef } from './ai/images.ts'
import { loadModules, type PrtsModule, type AiRequest } from './modules.ts'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync, renameSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { execFile } from 'child_process'
import { join, sep } from 'path'

const STATE_DIR = process.env.DISCORD_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'discord')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const APPROVED_DIR = join(STATE_DIR, 'approved')

const TOKEN = process.env.DISCORD_BOT_TOKEN
const STATIC = process.env.DISCORD_ACCESS_MODE === 'static'

// --help prints the usage. --dry-run loads every module and builds the slash
// command list, then exits without a token, without the bridge and without
// logging in to Discord (useful for CI and for checking a new setup).
const DRY_RUN = process.argv.includes('--dry-run')
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(
    'PRTS Discord bot\n\n' +
      'Usage: bun bot.ts [--dry-run | --help]\n\n' +
      '  (no flag)   connect to Discord and open the Claude bridge on 127.0.0.1\n' +
      '  --dry-run   load all modules, list the slash commands, exit (no token needed)\n' +
      '  --help      show this text\n\n' +
      `Settings: environment, then ${REPO_ENV_FILE}, then ${ENV_FILE}.\n` +
      'See .env.example and README.md for every setting.\n',
  )
  process.exit(0)
}

if (!TOKEN && !DRY_RUN) {
  process.stderr.write(`prts bot: DISCORD_BOT_TOKEN required\n` + `  set it in ${REPO_ENV_FILE} or ${ENV_FILE}\n` + `  format: DISCORD_BOT_TOKEN=MTIz...\n`)
  process.exit(1)
}
const INBOX_DIR = join(STATE_DIR, 'inbox')

// Who answers /prts (PRTS_* settings), and the enabled add-on modules.
const CORE_AI = readAiConfig('PRTS')
const MODULES = await loadModules()
const moduleByName = new Map(MODULES.map(m => [m.name, m]))
const moduleByCommand = new Map<string, PrtsModule>()
for (const m of MODULES) for (const c of (m.commands ?? []) as { name: string }[]) moduleByCommand.set(c.name, m)
for (const m of MODULES) if (m.help?.length) registerHelp(m.help)
const aiFor = (m?: PrtsModule): AiConfig => m?.ai ?? CORE_AI
const hooksFor = (m?: PrtsModule): TurnHooks => (m?.turns ? { key: m.name, ...m.turns } : CHAT_HOOKS)
/** The module that owns a channel (threads count as their parent), and its state. */
function channelOwner(channelId: string): { mod: PrtsModule; state: 'active' | 'paused' } | null {
  for (const mod of MODULES) {
    const state = mod.channelState?.(channelId)
    if (state) return { mod, state }
  }
  return null
}

// Last-resort safety net — without these the process dies silently on any
// unhandled promise rejection. With them it logs and keeps serving tools.
process.on('unhandledRejection', err => {
  process.stderr.write(`prts bot: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`prts bot: uncaught exception: ${err}\n`)
})

// Permission-reply spec from anthropics/claude-cli-internal
// src/services/mcp/channelPermissions.ts — inlined (no CC repo dep).
// 5 lowercase letters a-z minus 'l'. Case-insensitive for phone autocorrect.
// Strict: no bare yes/no (conversational), no prefix/suffix chatter.
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

const client = new Client({
  intents: [GatewayIntentBits.DirectMessages, GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates],
  // DMs arrive as partial channels — messageCreate never fires without this.
  partials: [Partials.Channel],
})

type PendingEntry = {
  senderId: string
  chatId: string // DM channel ID — where to send the approval confirm
  createdAt: number
  expiresAt: number
  replies: number
}

type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
}

type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  /** Keyed on channel ID (snowflake), not guild ID. One entry per guild channel. */
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  // delivery/UX config — optional, defaults live in the reply handler
  /** Emoji to react with on receipt. Empty string disables. Unicode char or custom emoji ID. */
  ackReaction?: string
  /** Which chunks get Discord's reply reference when reply_to is passed. Default: 'first'. 'off' = never thread. */
  replyToMode?: 'off' | 'first' | 'all'
  /** Max chars per outbound message before splitting. Default: 2000 (Discord's hard cap). */
  textChunkLimit?: number
  /** Split on paragraph boundaries instead of hard char count. */
  chunkMode?: 'length' | 'newline'
}

function defaultAccess(): Access {
  return {
    dmPolicy: 'pairing',
    allowFrom: [],
    groups: {},
    pending: {},
  }
}

const MAX_CHUNK_LIMIT = 2000
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

// reply's files param takes any path. .env is ~60 bytes and ships as an
// upload. Claude can already Read+paste file contents, so this isn't a new
// exfil channel for arbitrary paths — but the server's own state is the one
// thing Claude has no reason to ever send.
function assertSendable(f: string): void {
  let real, stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(STATE_DIR)
  } catch {
    return
  } // statSync will fail properly; or STATE_DIR absent → nothing to leak
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
  // The repo's .env may hold the token too.
  try {
    if (real === realpathSync(REPO_ENV_FILE)) throw new Error(`refusing to send settings file: ${f}`)
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('refusing')) throw e
  }
}

function readAccessFile(): Access {
  try {
    const raw = readFileSync(ACCESS_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
      replyToMode: parsed.replyToMode,
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try {
      renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`)
    } catch {}
    process.stderr.write(`discord: access.json is corrupt, moved aside. Starting fresh.\n`)
    return defaultAccess()
  }
}

// In static mode, access is snapshotted at boot and never re-read or written.
// Pairing requires runtime mutation, so it's downgraded to allowlist with a
// startup warning — handing out codes that never get approved would be worse.
const BOOT_ACCESS: Access | null = STATIC
  ? (() => {
      const a = readAccessFile()
      if (a.dmPolicy === 'pairing') {
        process.stderr.write('prts bot: static mode — dmPolicy "pairing" downgraded to "allowlist"\n')
        a.dmPolicy = 'allowlist'
      }
      a.pending = {}
      return a
    })()
  : null

// loadAccess runs on every message, command and reply; re-parse access.json
// only when the file changed on disk.
let accessCache: { sig: string; access: Access } | null = null
function loadAccess(): Access {
  if (BOOT_ACCESS) return BOOT_ACCESS
  let sig = ''
  try {
    const st = statSync(ACCESS_FILE)
    sig = `${st.mtimeMs}:${st.size}`
  } catch {}
  if (!sig || accessCache?.sig !== sig) accessCache = sig ? { sig, access: readAccessFile() } : null
  return accessCache?.access ?? readAccessFile()
}

function saveAccess(a: Access): void {
  if (STATIC) return
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}

function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

type GateResult = { action: 'deliver'; access: Access; mod?: PrtsModule } | { action: 'drop' } | { action: 'pair'; code: string; isResend: boolean }

// Track message IDs we recently sent, so reply-to-bot in guild channels
// counts as a mention without needing fetchReference().
const recentSentIds = new Set<string>()
const RECENT_SENT_CAP = 200

const dmChannelUsers = new Map<string, string>()

// Open slash-command conversations, keyed by the chat_id we hand Claude
// ("slash:<interaction id>"). Discord lets us post through an interaction
// for 15 minutes after it was created; after that the token is dead.
type SlashChat = {
  interaction: ChatInputCommandInteraction | MessageContextMenuCommandInteraction
  ephemeral: boolean
  answered: boolean // false until the "thinking…" placeholder is replaced
  noticed?: boolean // the slow-response notice has been shown
  expiresAt: number
  api?: boolean // answered by an API model rather than the Claude Code narrator
}
const ephFlag = (on: boolean): MessageFlags.Ephemeral | undefined => (on ? MessageFlags.Ephemeral : undefined)

const SLASH_PREFIX = 'slash:'
const SLASH_TTL_MS = 15 * 60 * 1000
const slashChats = new Map<string, SlashChat>()

function getSlashChat(chatId: string): SlashChat {
  const s = slashChats.get(chatId)
  if (!s) throw new Error(`slash-command chat ${chatId} is unknown (the session may have restarted)`)
  if (Date.now() > s.expiresAt) {
    slashChats.delete(chatId)
    throw new Error(`slash-command chat ${chatId} expired: Discord only allows replies for 15 minutes after a command`)
  }
  return s
}

// A chat Claude never answered would show "thinking…" forever, so replace
// the placeholder with a notice while the token still works.
const UNANSWERED_TEXT = '[PRTS] Response timeout. The narrative core did not answer within the 15-minute window.\n' + 'Please send the request again. I apologize for the inconvenience.'

// Early notice: if Claude is unreachable (session closed, usage limit hit),
// the user learns that after 2 minutes instead of waiting 15. The notice
// replaces the placeholder; a real answer still replaces the notice.
const SLOW_NOTICE_MS = 2 * 60 * 1000
const SLOW_TEXT =
  '[PRTS] Processing is taking longer than expected.\n' +
  'The narrative core may be busy or temporarily offline (for example, its usage limit has been reached). ' +
  'If an answer arrives, it will replace this notice. Otherwise, please try again later. I apologize for the inconvenience.'

// The same notice when an API model (for example a local one) is still working.
const SLOW_API_TEXT =
  '[PRTS] Processing is taking longer than expected.\n' +
  'The language model is still working on it (images and long scenes take longer on a local model). ' +
  'If an answer arrives, it will replace this notice. I apologize for the inconvenience.'

function pruneSlashChats(): void {
  const now = Date.now()
  for (const [id, s] of slashChats) {
    if (!s.answered && !s.noticed && now >= s.expiresAt - SLASH_TTL_MS + 30_000 + SLOW_NOTICE_MS) {
      s.noticed = true
      void s.interaction.editReply({ content: s.api ? SLOW_API_TEXT : SLOW_TEXT }).catch(() => {})
    }
    if (now <= s.expiresAt) continue
    if (!s.answered) void s.interaction.editReply({ content: UNANSWERED_TEXT }).catch(() => {})
    slashChats.delete(id)
  }
}
setInterval(pruneSlashChats, 60_000).unref()

function noteSent(id: string): void {
  recentSentIds.add(id)
  if (recentSentIds.size > RECENT_SENT_CAP) {
    // Sets iterate in insertion order — this drops the oldest.
    const first = recentSentIds.values().next().value
    if (first) recentSentIds.delete(first)
  }
}

// Channels that are not opted in but where a listed user just replied to PRTS: id -> allowed until.
const repliedChannels = new Map<string, number>()

async function gate(msg: Message): Promise<GateResult> {
  const access = loadAccess()
  const pruned = pruneExpired(access)
  if (pruned) saveAccess(access)

  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  const senderId = msg.author.id
  const isDM = msg.channel.type === ChannelType.DM

  if (isDM) {
    if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }

    // pairing mode — check for existing non-expired code for this sender
    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        // Reply twice max (initial + one reminder), then go silent.
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        saveAccess(access)
        return { action: 'pair', code, isResend: true }
      }
    }
    // Cap pending at 3. Extra attempts are silently dropped.
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

    const code = randomBytes(3).toString('hex') // 6 hex chars
    const now = Date.now()
    access.pending[code] = {
      senderId,
      chatId: msg.channelId, // DM channel ID — used later to confirm approval
      createdAt: now,
      expiresAt: now + 60 * 60 * 1000, // 1h
      replies: 1,
    }
    saveAccess(access)
    return { action: 'pair', code, isResend: false }
  }

  // We key on channel ID (not guild ID) — simpler, and lets the user
  // opt in per-channel rather than per-server. Threads inherit their
  // parent channel's opt-in; the reply still goes to msg.channelId
  // (the thread), this is only the gate lookup.
  const channelId = msg.channel.isThread() ? (msg.channel.parentId ?? msg.channelId) : msg.channelId
  // Channels owned by an add-on module: allowlisted users are heard without an
  // @mention; a paused channel is ignored.
  const owner = channelOwner(channelId)
  if (owner) {
    if (owner.state === 'paused' || !access.allowFrom.includes(senderId)) return { action: 'drop' }
    return { action: 'deliver', access, mod: owner.mod }
  }
  const policy = access.groups[channelId]
  if (!policy) {
    // Replying to one of PRTS's own messages talks to PRTS, even in a channel that is not opted in.
    if (access.allowFrom.includes(senderId) && (await isReplyToBot(msg))) {
      repliedChannels.set(channelId, Date.now() + 60 * 60 * 1000) // so the reply tool may answer there
      return { action: 'deliver', access }
    }
    return { action: 'drop' }
  }
  const groupAllowFrom = policy.allowFrom ?? []
  const requireMention = policy.requireMention ?? true
  if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) {
    return { action: 'drop' }
  }
  if (requireMention && !(await isMentioned(msg, access.mentionPatterns))) {
    return { action: 'drop' }
  }
  return { action: 'deliver', access }
}

async function isReplyToBot(msg: Message): Promise<boolean> {
  const refId = msg.reference?.messageId
  if (!refId) return false
  if (recentSentIds.has(refId)) return true
  // Fallback: fetch the referenced message and check authorship.
  // Can fail if the message was deleted or we lack history perms.
  try {
    const ref = await msg.fetchReference()
    return ref.author.id === client.user?.id
  } catch {
    return false
  }
}

async function isMentioned(msg: Message, extraPatterns?: string[]): Promise<boolean> {
  if (client.user && msg.mentions.has(client.user)) return true

  // Reply to one of our messages counts as an implicit mention.
  if (await isReplyToBot(msg)) return true

  const text = msg.content
  for (const pat of extraPatterns ?? []) {
    try {
      if (new RegExp(pat, 'i').test(text)) return true
    } catch {}
  }
  return false
}

// The /discord:access skill drops a file at approved/<senderId> when it pairs
// someone. Poll for it, send confirmation, clean up. Discord DMs have a
// distinct channel ID ≠ user ID, so we need the chatId stashed in the
// pending entry — but by the time we see the approval file, pending has
// already been cleared. Instead: the approval file's *contents* carry
// the DM channel ID. (The skill writes it.)

function checkApprovals(): void {
  let files: string[]
  try {
    files = readdirSync(APPROVED_DIR)
  } catch {
    return
  }
  if (files.length === 0) return

  for (const senderId of files) {
    const file = join(APPROVED_DIR, senderId)
    let dmChannelId: string
    try {
      dmChannelId = readFileSync(file, 'utf8').trim()
    } catch {
      rmSync(file, { force: true })
      continue
    }
    if (!dmChannelId) {
      // No channel ID — can't send. Drop the marker.
      rmSync(file, { force: true })
      continue
    }

    void (async () => {
      try {
        const ch = await fetchTextChannel(dmChannelId)
        if ('send' in ch) {
          await ch.send('[PRTS] Identity verification complete. Access granted.\nWelcome home. Use `/help` to view available functions.')
        }
        rmSync(file, { force: true })
      } catch (err) {
        process.stderr.write(`prts bot: failed to send approval confirm: ${err}\n`)
        // Remove anyway — don't loop on a broken send.
        rmSync(file, { force: true })
      }
    })()
  }
}

if (!STATIC) setInterval(checkApprovals, 15_000).unref()

// Discord caps messages at 2000 chars (hard limit — larger sends reject).
// Split long replies, preferring paragraph boundaries when chunkMode is
// 'newline'.

function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      // Prefer the last double-newline (paragraph), then single newline,
      // then space. Fall back to hard cut.
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

async function fetchTextChannel(id: string) {
  const ch = await client.channels.fetch(id)
  if (!ch || !ch.isTextBased()) {
    throw new Error(`channel ${id} not found or not text-based`)
  }
  return ch
}

// Outbound gate — tools can only target chats the inbound gate would deliver
// from. DM channel ID ≠ user ID, so we inspect the fetched channel's type.
// Thread → parent lookup mirrors the inbound gate.
async function fetchAllowedChannel(id: string) {
  if (id.startsWith(SLASH_PREFIX)) {
    throw new Error('not available for slash-command chats: only reply and edit_message work there')
  }
  const ch = await fetchTextChannel(id)
  const access = loadAccess()
  if (ch.type === ChannelType.DM) {
    const userId = ch.recipientId ?? dmChannelUsers.get(id)
    if (userId && access.allowFrom.includes(userId)) return ch
  } else {
    const key = ch.isThread() ? (ch.parentId ?? ch.id) : ch.id
    if (key in access.groups) return ch
    if ((repliedChannels.get(key) ?? 0) > Date.now()) return ch
  }
  throw new Error(`channel ${id} is not allowlisted — add via /discord:access`)
}

async function downloadAttachment(att: Attachment): Promise<string> {
  if (att.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`attachment too large: ${(att.size / 1024 / 1024).toFixed(1)}MB, max ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB`)
  }
  const res = await fetch(att.url)
  const buf = Buffer.from(await res.arrayBuffer())
  const name = att.name ?? `${att.id}`
  const rawExt = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : 'bin'
  const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
  const path = join(INBOX_DIR, `${Date.now()}-${att.id}.${ext}`)
  mkdirSync(INBOX_DIR, { recursive: true })
  writeFileSync(path, buf)
  return path
}

// att.name is uploader-controlled. It lands inside a [...] annotation in the
// notification body and inside a newline-joined tool result — both are places
// where delimiter chars let the attacker break out of the untrusted frame.
function safeAttName(att: Attachment): string {
  return (att.name ?? att.id).replace(/[\[\]\r\n;]/g, '_')
}

const run = (cmd: string, args: string[]) => new Promise<string>((res, rej) => execFile(cmd, args, { timeout: 30_000, windowsHide: true }, (e, out) => (e ? rej(e) : res(String(out)))))

// A GIF or video becomes one PNG sheet of evenly spaced frames, so Claude can see the motion (no audio).
async function makeFrameSheet(path: string, contentType: string | null): Promise<string | null> {
  if (!/^(image\/gif|video\/)/.test(contentType ?? '')) return null
  try {
    const dur = parseFloat((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path])).trim())
    const fps = dur > 0 ? Math.min(12 / dur, 12).toFixed(4) : '1'
    const out = path.replace(/\.[^.\\/]+$/, '') + '-frames.png'
    await run('ffmpeg', ['-y', '-v', 'error', '-i', path, '-vf', `fps=${fps},scale=360:-2,tile=4x3`, '-frames:v', '1', out])
    return out
  } catch {
    return null
  }
}

// Up to n messages just before one message, as "user: text" lines, for context.
async function contextBefore(ch: any, id: string, n = 4): Promise<string> {
  try {
    const got = await ch.messages.fetch({ before: id, limit: n })
    return [...got.values()]
      .reverse()
      .map((m: Message) => `${m.author.username}: ${(m.content || (m.attachments.size ? '(attachment)' : '')).replace(/[\r\n;]+/g, ' ').slice(0, 200)}`)
      .join(' | ')
  } catch {
    return ''
  }
}

// Stores full permission details for "See more" expansion keyed by request_id.
const pendingPermissions = new Map<string, { tool_name: string; description: string; input_preview: string }>()

// Receive permission_request from CC → format → send to all allowlisted DMs.
// Groups are intentionally excluded — the security thread resolution was
// "single-user mode for official plugins." Anyone in access.allowFrom
// already passed explicit pairing; group members haven't.
function onPermissionRequest(params: { request_id: string; tool_name: string; description: string; input_preview: string }): void {
  {
    const { request_id, tool_name, description, input_preview } = params
    pendingPermissions.set(request_id, { tool_name, description, input_preview })
    // Unanswered requests would pile up forever; keep the newest 50.
    if (pendingPermissions.size > 50) pendingPermissions.delete(pendingPermissions.keys().next().value!)
    const access = loadAccess()
    const text = `[PRTS] Authorization request: \`${tool_name}\`\nThe narrative core requests permission to proceed. Please confirm.`
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`perm:more:${request_id}`).setLabel('See more').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`perm:allow:${request_id}`).setLabel('Allow').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`perm:deny:${request_id}`).setLabel('Deny').setEmoji('❌').setStyle(ButtonStyle.Danger),
    )
    for (const userId of access.allowFrom) {
      void (async () => {
        try {
          const user = await client.users.fetch(userId)
          await user.send({ content: text, components: [row] })
        } catch (e) {
          process.stderr.write(`permission_request send to ${userId} failed: ${e}\n`)
        }
      })()
    }
  }
}

// ───────────────────────── bridge to Claude Code ─────────────────────────
// server.ts (inside Claude Code) connects here. Messages are JSON:
//   bot → claude  {type:'event', method, params}        channel notifications
//   claude → bot  {type:'call', id, name, args}          tool call → {type:'result', id, result}
//   claude → bot  {type:'notify', method, params}        permission requests
// Only 127.0.0.1, and only with the key from bridge.key (a credential like
// .env: assertSendable refuses to upload it).
import { randomBytes as bridgeRandom } from 'crypto'
import type { ServerWebSocket } from 'bun'

const BRIDGE_PORT = Number(process.env.PRTS_BRIDGE_PORT ?? 47823)
const BRIDGE_KEY_FILE = join(STATE_DIR, 'bridge.key')
function bridgeKey(): string {
  try {
    const k = readFileSync(BRIDGE_KEY_FILE, 'utf8').trim()
    if (k.length >= 32) return k
  } catch {}
  const k = bridgeRandom(32).toString('hex')
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(BRIDGE_KEY_FILE, k + '\n', { mode: 0o600 })
  return k
}
const BRIDGE_KEY = DRY_RUN ? '' : bridgeKey()
let bridge: ServerWebSocket<unknown> | null = null
export const aiOnline = () => bridge !== null

// Deliver an AI event. The backend settings of the core (or of the module
// named in meta.module) decide whether it goes to the Claude Code narrator or
// to an API model. Rejects when it should go to Claude and no session is
// connected. Permission events always go to Claude.
// PRTS_LOG_CHATS=1 writes each message sent to the AI and each AI reply to the bot's log
// (journalctl / PRTS Control "Logs"), so the conversation can be followed without opening
// the narrator session. Off by default: it puts Discord messages in the log.
const LOG_CHATS = /^(1|true|on|yes)$/i.test(process.env.PRTS_LOG_CHATS ?? '')
const oneLine = (s: string, n = 400) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}
function logChat(line: string): void {
  if (LOG_CHATS) process.stderr.write(`prts chat: ${line}\n`)
}

function emit(n: { method: string; params: unknown }): Promise<void> {
  if (n.method === 'notifications/claude/channel') {
    const { images, ...forClaude } = n.params as { content: string; meta: Record<string, string>; images?: ImageRef[] }
    const p = { ...forClaude, images }
    n = { ...n, params: forClaude } // images are for API backends only; Claude Code uses download_attachment
    const mod = p.meta.module ? moduleByName.get(p.meta.module) : undefined
    const cfg = aiFor(mod)
    const api = apiBackendFor(cfg, bridge !== null)
    const where = p.meta.command ? `/${p.meta.command}${p.meta.subcommand ? ' ' + p.meta.subcommand : ''}` : `#${p.meta.chat_id}`
    logChat(`${p.meta.user ?? '?'} in ${where} → ${api ? (cfg.label ?? api) : bridge ? 'narrator' : 'nobody (offline)'}: ${oneLine(p.content)}`)
    if (api) {
      void handleApiTurn(
        p,
        api,
        cfg,
        hooksFor(mod),
        (chat_id, text) => {
          logChat(`${cfg.label ?? api} replied in ${chat_id}: ${oneLine(text)}`)
          return runTool('reply', { chat_id, text })
        },
        () => {
          if (p.meta.chat_id.startsWith(SLASH_PREFIX)) return
          void fetchTextChannel(p.meta.chat_id)
            .then(ch => ('sendTyping' in ch ? ch.sendTyping() : undefined))
            .catch(() => {})
        },
      )
      return Promise.resolve()
    }
    if (bridge) recordUser(p, hooksFor(mod))
  }
  if (!bridge) return Promise.reject(new Error('no Claude session connected'))
  bridge.send(JSON.stringify({ type: 'event', ...n }))
  return Promise.resolve()
}

if (!DRY_RUN)
  try {
    Bun.serve({
      hostname: '127.0.0.1',
      port: BRIDGE_PORT,
      fetch(req, srv) {
        const u = new URL(req.url)
        if (u.searchParams.get('key') !== BRIDGE_KEY) return new Response('Insufficient permissions.', { status: 403 })
        if (srv.upgrade(req)) return undefined
        return new Response('PRTS bridge. All systems operational.')
      },
      websocket: {
        open(ws) {
          if (bridge && bridge !== ws) bridge.close(4000, 'replaced by a newer session')
          bridge = ws
          bridgeSince = Date.now()
          process.stderr.write('prts bot: Claude session connected\n')
        },
        async message(ws, raw) {
          let m: any
          try {
            m = JSON.parse(String(raw))
          } catch {
            return
          }
          if (m.type === 'call') {
            const result = await runTool(String(m.name), (m.args ?? {}) as Record<string, unknown>)
            if (m.name === 'reply' && !result.isError) recordAssistant(String(m.args?.chat_id ?? ''), String(m.args?.text ?? ''))
            logChat(
              m.name === 'reply'
                ? `narrator replied in ${m.args?.chat_id ?? '?'}${result.isError ? ' (failed)' : ''}: ${oneLine(String(m.args?.text ?? ''))}`
                : `narrator used ${m.name}${result.isError ? ' (failed)' : ''}`,
            )
            try {
              ws.send(JSON.stringify({ type: 'result', id: m.id, result }))
            } catch {}
          } else if (m.type === 'notify' && m.method === 'notifications/claude/channel/permission_request') {
            onPermissionRequest(m.params)
          }
        },
        close(ws) {
          if (bridge === ws) {
            bridge = null
            process.stderr.write('prts bot: Claude session disconnected\n')
          }
        },
      },
    })
    process.stderr.write(`prts bot: bridge listening on 127.0.0.1:${BRIDGE_PORT}\n`)
  } catch (e) {
    process.stderr.write(`prts bot: bridge port ${BRIDGE_PORT} is in use, so another PRTS bot is already running. Exiting.\n`)
    process.exit(3)
  }

// PRTS voice for access refusals (sender not on the allowlist).
const DENIED = '[PRTS] Identity verification failed. Insufficient permissions.\n' + 'This terminal only accepts registered Rhodes Island personnel. Please ask the administrator to grant you access.'

// PRTS voice for the AI half being away (Claude Code not running).
export const OFFLINE_TEXT =
  '[PRTS] Conversation module unavailable. The connection to the narrative core has been interrupted.\n' +
  'Instant functions remain operational: `/help` lists them. Please try again later. I apologize for the inconvenience.'

// When Claude last answered in each chat, and when the bot/bridge came up.
// Used by the slow-reply notice for plain messages and by /status.
const lastReplyAt = new Map<string, number>()
let lastAnyReplyAt = 0
const botStartedAt = Date.now()
let bridgeSince = 0

// Tool calls from Claude, relayed by the bridge. Same behaviour as the old
// single-process server.
async function runTool(name: string, args: Record<string, unknown>): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  try {
    switch (name) {
      case 'reply': {
        const chat_id = args.chat_id as string
        lastReplyAt.set(chat_id, Date.now())
        lastAnyReplyAt = Date.now()
        const text = args.text as string
        const replyChannel = chat_id.startsWith(SLASH_PREFIX) ? (slashChats.get(chat_id)?.interaction.channelId ?? '') : chat_id
        for (const m of MODULES) m.onReply?.(replyChannel, text ?? '')
        const reply_to = args.reply_to as string | undefined
        const files = (args.files as string[] | undefined) ?? []

        for (const f of files) {
          assertSendable(f)
          const st = statSync(f)
          if (st.size > MAX_ATTACHMENT_BYTES) {
            throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 25MB)`)
          }
        }
        if (files.length > 10) throw new Error('Discord allows max 10 attachments per message')

        const access = loadAccess()
        const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
        const mode = access.chunkMode ?? 'length'
        const replyMode = access.replyToMode ?? 'first'
        const chunks = chunk(text, limit, mode)
        const sentIds: string[] = []

        if (chat_id.startsWith(SLASH_PREFIX)) {
          const s = getSlashChat(chat_id)
          try {
            for (let i = 0; i < chunks.length; i++) {
              const payload = {
                content: chunks[i],
                ...(i === 0 && files.length > 0 ? { files } : {}),
              }
              let sent
              if (!s.answered) {
                sent = await s.interaction.editReply(payload)
                s.answered = true
              } else {
                sent = await s.interaction.followUp({ ...payload, flags: ephFlag(s.ephemeral) })
              }
              sentIds.push(sent.id)
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            throw new Error(`reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${msg}`)
          }
          const result = sentIds.length === 1 ? `sent (id: ${sentIds[0]})` : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
          return { content: [{ type: 'text', text: result }] }
        }

        const ch = await fetchAllowedChannel(chat_id)
        if (!('send' in ch)) throw new Error('channel is not sendable')

        try {
          for (let i = 0; i < chunks.length; i++) {
            const shouldReplyTo = reply_to != null && replyMode !== 'off' && (replyMode === 'all' || i === 0)
            const sent = await ch.send({
              content: chunks[i],
              ...(i === 0 && files.length > 0 ? { files } : {}),
              ...(shouldReplyTo ? { reply: { messageReference: reply_to, failIfNotExists: false } } : {}),
            })
            noteSent(sent.id)
            sentIds.push(sent.id)
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          throw new Error(`reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${msg}`)
        }

        const result = sentIds.length === 1 ? `sent (id: ${sentIds[0]})` : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
        return { content: [{ type: 'text', text: result }] }
      }
      case 'fetch_messages': {
        const ch = await fetchAllowedChannel(args.channel as string)
        const limit = Math.min((args.limit as number) ?? 20, 100)
        const msgs = await ch.messages.fetch({ limit })
        const me = client.user?.id
        const arr = [...msgs.values()].reverse()
        const out =
          arr.length === 0
            ? '(no messages)'
            : arr
                .map(m => {
                  const who = m.author.id === me ? 'me' : m.author.username
                  const atts = m.attachments.size > 0 ? ` +${m.attachments.size}att` : ''
                  // Tool result is newline-joined; multi-line content forges
                  // adjacent rows. History includes ungated senders (no-@mention
                  // messages in an opted-in channel never hit the gate but
                  // still live in channel history).
                  const text = m.content.replace(/[\r\n]+/g, ' ⏎ ')
                  return `[${m.createdAt.toISOString()}] ${who}: ${text}  (id: ${m.id}${atts})`
                })
                .join('\n')
        return { content: [{ type: 'text', text: out }] }
      }
      case 'react': {
        const ch = await fetchAllowedChannel(args.chat_id as string)
        const msg = await ch.messages.fetch(args.message_id as string)
        await msg.react(args.emoji as string)
        return { content: [{ type: 'text', text: 'reacted' }] }
      }
      case 'edit_message': {
        if ((args.chat_id as string).startsWith(SLASH_PREFIX)) {
          const s = getSlashChat(args.chat_id as string)
          const edited = await s.interaction.webhook.editMessage(args.message_id as string, {
            content: args.text as string,
          })
          return { content: [{ type: 'text', text: `edited (id: ${edited.id})` }] }
        }
        const ch = await fetchAllowedChannel(args.chat_id as string)
        const msg = await ch.messages.fetch(args.message_id as string)
        const edited = await msg.edit(args.text as string)
        return { content: [{ type: 'text', text: `edited (id: ${edited.id})` }] }
      }
      case 'download_attachment': {
        const ch = await fetchAllowedChannel(args.chat_id as string)
        const msg = await ch.messages.fetch(args.message_id as string)
        if (msg.attachments.size === 0) {
          return { content: [{ type: 'text', text: 'message has no attachments' }] }
        }
        const lines: string[] = []
        for (const att of msg.attachments.values()) {
          const path = await downloadAttachment(att)
          const kb = (att.size / 1024).toFixed(0)
          const sheet = await makeFrameSheet(path, att.contentType)
          lines.push(`  ${path}  (${safeAttName(att)}, ${att.contentType ?? 'unknown'}, ${kb}KB)${sheet ? `  frame sheet: ${sheet}` : ''}`)
        }
        return {
          content: [{ type: 'text', text: `downloaded ${lines.length} attachment(s):\n${lines.join('\n')}` }],
        }
      }
      default:
        return {
          content: [{ type: 'text', text: `unknown tool: ${name}` }],
          isError: true,
        }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: `${name} failed: ${msg}` }],
      isError: true,
    }
  }
}

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('prts bot: shutting down\n')
  setTimeout(() => process.exit(0), 2000)
  void Promise.resolve(client.destroy()).finally(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

client.on('error', err => {
  process.stderr.write(`prts bot: client error: ${err}\n`)
})

// Button-click handler for permission requests. customId is
// `perm:allow:<id>`, `perm:deny:<id>`, or `perm:more:<id>`.
// Security mirrors the text-reply path: allowFrom must contain the sender.
// Slash commands. integration_types 0 = installed to a server, 1 = installed
// to a user account; contexts 0 = server channel, 1 = DM with the bot,
// 2 = group DM / DMs between users. Registered as raw JSON through REST so
// these newer fields pass through untouched.
const SLASH_COMMANDS = [
  {
    name: 'prts',
    description: 'Ask PRTS anything: Arknights lore and game help, research, or just talk',
    options: [
      { type: 3, name: 'message', description: 'What you want to say or ask', required: true, max_length: 4000 },
      { type: 11, name: 'file', description: 'An image, GIF or file for PRTS to look at', required: false },
      { type: 5, name: 'private', description: 'Only you can see the reply', required: false },
      {
        type: 3,
        name: 'style',
        description: 'How PRTS answers (default: PRTS persona)',
        required: false,
        choices: [
          { name: 'PRTS (default)', value: 'prts' },
          { name: 'Claude', value: 'normal' },
        ],
      },
    ],
  },
].map(c => ({ ...c, type: 1, integration_types: [0, 1], contexts: [0, 1, 2] }) as any)
// Instant commands answered by the bot itself (ark.ts): dice, coin, operator
// cards, tier list, modules, farming, recruitment, wiki, story links, help.
SLASH_COMMANDS.push(...(ARK_COMMANDS as any[]))
SLASH_COMMANDS.push(...ARKPLUS_COMMANDS)
SLASH_COMMANDS.push(MUSIC_COMMAND as any)
for (const m of MODULES) SLASH_COMMANDS.push(...((m.commands ?? []) as any[]))
SLASH_COMMANDS.push({
  name: 'Ask PRTS',
  type: 3,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
} as any)
SLASH_COMMANDS.push({
  name: 'status',
  description: 'Is the PRTS narrative core online? Shows connection, last reply and uptime',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
} as any)

async function registerSlashCommands(appId: string): Promise<void> {
  try {
    await client.rest.put(Routes.applicationCommands(appId), { body: SLASH_COMMANDS })
    process.stderr.write(`prts bot: registered ${SLASH_COMMANDS.length} slash commands\n`)
  } catch (err) {
    process.stderr.write(`prts bot: slash command registration failed: ${err}\n`)
  }
}

// Gate on the person who used the command or button, never on the channel:
// user installs work in servers we don't control. Sends the refusal itself.
async function denyUnlisted(interaction: Interaction): Promise<boolean> {
  const access = loadAccess()
  if (access.dmPolicy !== 'disabled' && access.allowFrom.includes(interaction.user.id)) return false
  if (interaction.isRepliable()) await interaction.reply({ content: DENIED, flags: MessageFlags.Ephemeral }).catch(() => {})
  return true
}

// Saves attachments from a user into the inbox so Claude can open them with Read.
async function saveAttachments(atts: Attachment[]): Promise<Record<string, string>> {
  if (!atts.length) return {}
  const names: string[] = [],
    paths: string[] = []
  for (const att of atts.slice(0, 5)) {
    names.push(`${safeAttName(att)} (${att.contentType ?? 'unknown'}, ${(att.size / 1024).toFixed(0)}KB)`)
    try {
      const path = await downloadAttachment(att)
      const sheet = await makeFrameSheet(path, att.contentType)
      paths.push(sheet ? `${path} (frame sheet: ${sheet})` : path)
    } catch (e) {
      paths.push(`(download failed: ${String(e).replace(/[\r\n;]/g, ' ')})`)
    }
  }
  return { attachment_count: String(names.length), attachments: names.join('; '), attachment_paths: paths.join('; ') }
}

/** Hands a slash command to the AI. `mod` and `req` are set for a module command that asked for the AI. */
async function handleSlash(interaction: ChatInputCommandInteraction | MessageContextMenuCommandInteraction, mod?: PrtsModule, req?: AiRequest): Promise<void> {
  if (!mod && (await denyUnlisted(interaction))) return

  const command = interaction.commandName
  let text: string
  let subcommand: string | undefined
  let extraMeta: Record<string, string> = {}
  let images: ImageRef[] = []
  if (mod && req) {
    text = req.text
    if (interaction.isChatInputCommand()) subcommand = interaction.options.getSubcommand(false) ?? undefined
    extraMeta = { ...(req.meta ?? {}), module: mod.name }
  } else if (interaction.isMessageContextMenuCommand()) {
    // "Ask PRTS" on a message: PRTS gets that message, its author and its attachments.
    const m = interaction.targetMessage
    const author = m.author?.username ?? 'unknown'
    text = `Ask PRTS on a message by ${author}: ${m.content ? m.content.slice(0, 3500) : '(no text)'}`
    const around = interaction.channel ? await contextBefore(interaction.channel, m.id) : ''
    images = imageRefs([...m.attachments.values()])
    extraMeta = { ...(await saveAttachments([...m.attachments.values()])), target_message_id: m.id, target_author: author, ...(around ? { context_before: around } : {}) }
  } else if (command === 'prts') {
    text = interaction.options.getString('message', true)
    const file = interaction.options.getAttachment('file')
    if (file) {
      images = imageRefs([file])
      extraMeta = await saveAttachments([file])
    }
  } else {
    await interaction
      .reply({ content: '[PRTS] This function has been decommissioned. Please consult `/help` for current functions. I apologize for the inconvenience.', flags: MessageFlags.Ephemeral })
      .catch(() => {})
    return
  }
  const ephemeral = interaction.isChatInputCommand() && command === 'prts' ? (interaction.options.getBoolean('private') ?? false) : false
  if (!aiAvailable(aiFor(mod), aiOnline())) {
    await interaction.reply({ content: OFFLINE_TEXT, flags: MessageFlags.Ephemeral }).catch(() => {})
    return
  }

  // Must acknowledge within 3 seconds; this shows "<bot> is thinking…".
  try {
    await interaction.deferReply({ flags: ephFlag(ephemeral) })
  } catch (err) {
    process.stderr.write(`prts bot: deferReply failed: ${err}\n`)
    return
  }

  const chat_id = SLASH_PREFIX + interaction.id
  slashChats.set(chat_id, {
    interaction,
    ephemeral,
    answered: false,
    expiresAt: Date.now() + SLASH_TTL_MS - 30_000, // small safety margin
    api: apiBackendFor(aiFor(mod), aiOnline()) !== null,
  })

  // Same shape as messageCreate deliveries, so the model treats it alike.
  const content = text
  emit({
    method: 'notifications/claude/channel',
    params: {
      content,
      meta: {
        chat_id,
        message_id: interaction.id,
        user: interaction.user.username,
        user_id: interaction.user.id,
        ts: interaction.createdAt.toISOString(),
        command,
        ...(subcommand ? { subcommand } : {}),
        ...(interaction.isChatInputCommand() && command === 'prts' && interaction.options.getString('style') === 'normal' ? { style: 'normal' } : {}),
        ...extraMeta,
        ...(ephemeral ? { private: 'true' } : {}),
        ...(interaction.guildId ? { guild_id: interaction.guildId } : {}),
        ...(interaction.channelId ? { channel_id: interaction.channelId } : {}),
      },
      images,
    },
  }).catch(err => {
    process.stderr.write(`prts bot: failed to deliver slash command to Claude: ${err}\n`)
  })
}

client.on('interactionCreate', async (interaction: Interaction) => {
  if (interaction.isAutocomplete()) {
    if (interaction.commandName === 'music') {
      await handleMusicAutocomplete(interaction).catch(() => {})
      return
    }
    if (ARKPLUS_NAMES.has(interaction.commandName)) {
      await handleArkPlusAutocomplete(interaction).catch(() => {})
      return
    }
    if (ARK_COMMAND_NAMES.has(interaction.commandName))
      await handleArkAutocomplete(interaction).catch(e =>
        process.stderr.write(`discord: ark autocomplete failed: ${e}
`),
      )
    return
  }
  if (interaction.isChatInputCommand() && ARKPLUS_NAMES.has(interaction.commandName)) {
    if (await denyUnlisted(interaction)) return
    await handleArkPlus(interaction).catch(async e => {
      process.stderr.write(`discord: command ${interaction.commandName} failed: ${e}\n`)
      const msg = { content: '[PRTS] Record retrieval error. I apologize.', flags: MessageFlags.Ephemeral } as const
      await (interaction.deferred || interaction.replied ? interaction.followUp(msg) : interaction.reply(msg)).catch(() => {})
    })
    return
  }
  if (interaction.isChatInputCommand() && ARK_COMMAND_NAMES.has(interaction.commandName)) {
    if (await denyUnlisted(interaction)) return
    await handleArk(interaction).catch(async e => {
      process.stderr.write(`discord: ark command ${interaction.commandName} failed: ${e}
`)
      const msg = { content: '[PRTS] Record retrieval error. I apologize.', flags: MessageFlags.Ephemeral } as const
      await (interaction.deferred || interaction.replied ? interaction.followUp(msg) : interaction.reply(msg)).catch(() => {})
    })
    return
  }
  if (interaction.isChatInputCommand() && interaction.commandName === 'status') {
    if (await denyUnlisted(interaction)) return
    await handleStatus(brand(interaction, SECTION.status)).catch(e => process.stderr.write(`discord: status failed: ${e}\n`))
    return
  }
  if (interaction.isChatInputCommand() && interaction.commandName === 'music') {
    if (await denyUnlisted(interaction)) return
    await handleMusic(interaction).catch(async e => {
      process.stderr.write(`discord: handleMusic failed: ${e}
`)
      const msg = { content: '[PRTS] Music system error. I apologize.', flags: MessageFlags.Ephemeral } as const
      await (interaction.deferred || interaction.replied ? interaction.followUp(msg) : interaction.reply(msg)).catch(() => {})
    })
    return
  }
  const mod = interaction.isChatInputCommand() ? moduleByCommand.get(interaction.commandName) : undefined
  if (mod && interaction.isChatInputCommand()) {
    if (await denyUnlisted(interaction)) return
    let req: AiRequest | void
    try {
      req = await mod.onCommand?.(interaction, client)
    } catch (e) {
      process.stderr.write(`prts bot: module ${mod.name} command /${interaction.commandName} failed: ${e}\n`)
      const msg = { content: `[PRTS] Module error (${mod.name}). I apologize.`, flags: MessageFlags.Ephemeral } as const
      await (interaction.deferred || interaction.replied ? interaction.followUp(msg) : interaction.reply(msg)).catch(() => {})
      return
    }
    if (req) await handleSlash(interaction, mod, req).catch(e => process.stderr.write(`prts bot: handleSlash (${mod.name}) failed: ${e}\n`))
    return
  }
  if (interaction.isChatInputCommand() || (interaction.isMessageContextMenuCommand() && interaction.commandName === 'Ask PRTS')) {
    await handleSlash(interaction).catch(e => process.stderr.write(`discord: handleSlash failed: ${e}\n`))
    return
  }
  if (interaction.isStringSelectMenu() && (interaction.customId.startsWith('ark:outfit:') || interaction.customId === 'ark:help')) {
    if (await denyUnlisted(interaction)) return
    await handleArkSelect(interaction).catch(e => process.stderr.write(`discord: ark select failed: ${e}\n`))
    return
  }
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('music:pick:')) {
    if (await denyUnlisted(interaction)) return
    await handleMusicSelect(interaction).catch(e =>
      process.stderr.write(`discord: music select failed: ${e}
`),
    )
    return
  }
  if (!interaction.isButton()) return
  if (interaction.customId.startsWith('arkp:')) {
    if (await denyUnlisted(interaction)) return
    await handleArkPlusButton(interaction).catch(e => process.stderr.write(`discord: arkplus button failed: ${e}\n`))
    return
  }
  if (interaction.customId.startsWith('ark:')) {
    if (await denyUnlisted(interaction)) return
    await handleArkButton(interaction).catch(e => process.stderr.write(`discord: ark button failed: ${e}\n`))
    return
  }
  if (interaction.customId.startsWith('music:')) {
    if (await denyUnlisted(interaction)) return
    await handleMusicButton(interaction).catch(e =>
      process.stderr.write(`discord: music button failed: ${e}
`),
    )
    return
  }
  const m = /^perm:(allow|deny|more):([a-km-z]{5})$/.exec(interaction.customId)
  if (!m) return
  if (await denyUnlisted(interaction)) return
  const [, behavior, request_id] = m

  if (behavior === 'more') {
    const details = pendingPermissions.get(request_id)
    if (!details) {
      await interaction.reply({ content: '[PRTS] Record expired. The details of this request are no longer available.', flags: MessageFlags.Ephemeral }).catch(() => {})
      return
    }
    const { tool_name, description, input_preview } = details
    let prettyInput: string
    try {
      prettyInput = JSON.stringify(JSON.parse(input_preview), null, 2)
    } catch {
      prettyInput = input_preview
    }
    const expanded = `[PRTS] Authorization request: ${tool_name}\n\n` + `tool_name: ${tool_name}\n` + `description: ${description}\n` + `input_preview:\n${prettyInput}`
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`perm:allow:${request_id}`).setLabel('Allow').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`perm:deny:${request_id}`).setLabel('Deny').setEmoji('❌').setStyle(ButtonStyle.Danger),
    )
    await interaction.update({ content: expanded, components: [row] }).catch(() => {})
    return
  }

  void emit({
    method: 'notifications/claude/channel/permission',
    params: { request_id, behavior },
  })
  pendingPermissions.delete(request_id)
  const label = behavior === 'allow' ? '✅ Authorization granted. Proceeding without hesitation.' : '❌ Authorization denied. The request has been cancelled.'
  // Replace buttons with the outcome so the same request can't be answered
  // twice and the chat history shows what was chosen.
  await interaction.update({ content: `${interaction.message.content}\n\n${label}`, components: [] }).catch(() => {})
})

client.on('messageCreate', msg => {
  if (msg.author.bot) return
  handleInbound(msg).catch(e => process.stderr.write(`discord: handleInbound failed: ${e}\n`))
})

const offlineNoticeAt = new Map<string, number>()

// A plain message Claude never answers (session stuck, usage limit reached)
// gets one notice after 2 minutes, sharing the once-per-10-minutes limit above.
const PLAIN_SLOW_MS = 2 * 60_000
const PLAIN_SLOW_TEXT =
  '[PRTS] Processing is taking longer than expected.\n' +
  'The narrative core may be busy or temporarily offline (for example, its usage limit has been reached). ' +
  'If an answer arrives, it will follow. Otherwise, please try again later. I apologize for the inconvenience.'

function watchPlainReply(msg: Message, chat_id: string, cfg: AiConfig): void {
  const sentAt = Date.now()
  setTimeout(() => {
    if ((lastReplyAt.get(chat_id) ?? 0) >= sentAt) return
    if (Date.now() - (offlineNoticeAt.get(chat_id) ?? 0) <= 10 * 60_000) return
    offlineNoticeAt.set(chat_id, Date.now())
    const text = !aiAvailable(cfg, aiOnline()) ? OFFLINE_TEXT : apiBackendFor(cfg, aiOnline()) ? SLOW_API_TEXT.replace('replace this notice', 'follow') : PLAIN_SLOW_TEXT
    void msg.reply({ content: text, allowedMentions: { repliedUser: false } }).catch(() => {})
  }, PLAIN_SLOW_MS).unref()
}

const fmtSpan = (ms: number) => {
  const m = Math.floor(ms / 60_000)
  const d = Math.floor(m / 1440),
    h = Math.floor((m % 1440) / 60)
  return d > 0 ? `${d} d ${h} h` : h > 0 ? `${h} h ${m % 60} min` : `${m} min`
}
const rel = (t: number) => `<t:${Math.floor(t / 1000)}:R>`

// When the narrator (the Claude Code session) itself started, read from its process.
// The bridge time above only says when it last connected to the bot, which resets on every bot restart.
const narratorStartedAt = (): Promise<number | null> => (process.platform === 'win32' ? narratorStartedAtWindows() : narratorStartedAtLinux())

// Linux: find the claude process started with --dangerously-load-development-channels in /proc;
// its start time is field 22 of /proc/<pid>/stat, in clock ticks since boot.
function narratorStartedAtLinux(): Promise<number | null> {
  try {
    const bootSec = Number(/^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1])
    const HZ = 100 // USER_HZ is 100 on every mainstream Linux build
    let best: number | null = null
    for (const pid of readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue
      let cmd: string
      try {
        cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      } catch {
        continue
      }
      const args = cmd.split('\0')
      if (!args.includes('--dangerously-load-development-channels')) continue
      if (!args.slice(0, 2).some(a => /(^|\/)claude(\.exe|\.js)?$|claude-code/.test(a))) continue
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      const ticks = Number(fields[19]) // field 22 overall; fields[0] is field 3
      const t = (bootSec + ticks / HZ) * 1000
      if (Number.isFinite(t) && (best === null || t < best)) best = t
    }
    return Promise.resolve(best)
  } catch {
    return Promise.resolve(null)
  }
}

const narratorStartedAtWindows = (): Promise<number | null> =>
  new Promise(resolve => {
    const ps =
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'claude.exe' -and $_.CommandLine -like '*--dangerously-load-development-channels*' } | Sort-Object CreationDate | Select-Object -First 1 | ForEach-Object { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() }"
    execFile('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 8000, windowsHide: true }, (err, out) => {
      const t = Number(String(out).trim())
      resolve(err || !Number.isFinite(t) || t <= 0 ? null : t)
    })
  })

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })
  const waiting = [...slashChats.values()].filter(s => !s.answered).length
  const online = aiOnline()
  const started = online ? await narratorStartedAt() : null
  const lines = [
    '[PRTS] System status report.',
    '**Discord bot** (instant commands, `/roll`, `/myrtle` and so on)',
    '• Status: operational',
    `• Running for: ${fmtSpan(Date.now() - botStartedAt)} (started ${rel(botStartedAt)})`,
    '',
    '**Claude Code narrator** (bridge)',
    online ? `• Status: connected${started ? `, running for ${fmtSpan(Date.now() - started)} (started ${rel(started)})` : ''}, since ${rel(bridgeSince)}` : '• Status: not connected',
    '',
    '**AI answers**',
    ...(await Promise.all(
      [{ name: '/prts', cfg: CORE_AI }, ...MODULES.filter(m => m.ai).map(m => ({ name: `${m.name} module`, cfg: m.ai! }))].map(async ({ name, cfg }) => {
        const api = apiBackendFor(cfg, online)
        const now = api ? `${api} (${await probe(api, cfg)})` : online ? 'Claude Code narrator' : '**nobody** (narrator offline)'
        return `• ${name}: ${describeBackend(cfg)}. Now: ${now}`
      }),
    )),
    `• Last reply: ${lastAnyReplyAt ? rel(lastAnyReplyAt) : 'none since the bot started'}`,
    `• Requests awaiting an answer: ${waiting}`,
    '',
    'All systems reported. Is there anything else? I am always happy to help.',
  ].filter((l, i, a) => !(l === '' && a[i - 1] === ''))
  await interaction.editReply({ content: lines.join('\n') })
}

async function handleInbound(msg: Message): Promise<void> {
  const result = await gate(msg)

  if (result.action === 'drop') return

  if (result.action === 'pair') {
    const lead = result.isResend ? '[PRTS] Identity verification still pending.' : '[PRTS] Identity verification required. This terminal does not recognize you yet.'
    try {
      await msg.reply(`${lead}\nPlease give this code to the Rhodes Island administrator, who will run:\n\n/discord:access pair ${result.code}`)
    } catch (err) {
      process.stderr.write(`prts bot: failed to send pairing code: ${err}\n`)
    }
    return
  }

  const chat_id = msg.channelId

  if (msg.channel.type === ChannelType.DM) {
    dmChannelUsers.set(chat_id, msg.author.id)
  }

  // Permission-reply intercept: if this looks like "yes xxxxx" for a
  // pending permission request, emit the structured event instead of
  // relaying as chat. The sender is already gate()-approved at this point
  // (non-allowlisted senders were dropped above), so we trust the reply.
  const permMatch = PERMISSION_REPLY_RE.exec(msg.content)
  if (permMatch) {
    void emit({
      method: 'notifications/claude/channel/permission',
      params: {
        request_id: permMatch[2]!.toLowerCase(),
        behavior: permMatch[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny',
      },
    })
    const emoji = permMatch[1]!.toLowerCase().startsWith('y') ? '✅' : '❌'
    void msg.react(emoji).catch(() => {})
    return
  }

  // Nobody can answer: say so once per channel per 10 minutes, then stay quiet.
  if (!aiAvailable(aiFor(result.mod), aiOnline())) {
    const last = offlineNoticeAt.get(chat_id) ?? 0
    if (Date.now() - last > 10 * 60_000) {
      offlineNoticeAt.set(chat_id, Date.now())
      await msg.reply({ content: OFFLINE_TEXT, allowedMentions: { repliedUser: false } }).catch(() => {})
    }
    return
  }

  // Typing indicator — signals "processing" until we reply (or ~10s elapses).
  if ('sendTyping' in msg.channel) {
    void msg.channel.sendTyping().catch(() => {})
  }

  // Ack reaction — lets the user know we're processing. Fire-and-forget.
  // Default is a satellite dish ("signal received"), in keeping with a terminal service; ackReaction '' turns it off.
  const access = result.access
  if (access.ackReaction !== '') {
    void msg.react(access.ackReaction ?? '\u{1F4E1}').catch(() => {})
  }

  // A message in a module's channel: the module may add attributes for the AI.
  const ownerChannel = msg.channel.isThread() ? (msg.channel.parentId ?? msg.channelId) : msg.channelId
  const modMeta = result.mod ? { ...(result.mod.onMessage?.(msg, ownerChannel) ?? {}), module: result.mod.name } : {}

  // Attachments are listed (name/type/size) but not downloaded — the model
  // calls download_attachment when it wants them. Keeps the notification
  // fast and avoids filling inbox/ with images nobody looked at.
  const atts: string[] = []
  for (const att of msg.attachments.values()) {
    const kb = (att.size / 1024).toFixed(0)
    atts.push(`${safeAttName(att)} (${att.contentType ?? 'unknown'}, ${kb}KB)`)
  }

  // When the message is a reply, tell Claude what it answers (author, text, attachments).
  let replyMeta: Record<string, string> = {}
  // Images for API backends: this message's, then the replied-to message's ("what is this?").
  let images = imageRefs([...msg.attachments.values()])
  if (msg.reference?.messageId) {
    try {
      const ref = await msg.fetchReference()
      images = [...images, ...imageRefs([...ref.attachments.values()])]
      const clean = (v: string) => v.replace(/[\r\n;]+/g, ' ').slice(0, 600)
      const around = await contextBefore(msg.channel, ref.id)
      replyMeta = {
        ...(around ? { reply_context_before: around } : {}),
        reply_to_message_id: ref.id,
        reply_to_user: ref.author.username,
        ...(ref.content ? { reply_to_text: clean(ref.content) } : {}),
        ...(ref.attachments.size ? { reply_to_attachments: [...ref.attachments.values()].map(a => `${safeAttName(a)} (${a.contentType ?? 'unknown'})`).join('; ') } : {}),
      }
    } catch {}
  }

  // Attachment listing goes in meta only — an in-content annotation is
  // forgeable by any allowlisted sender typing that string.
  const content = msg.content || (atts.length > 0 ? '(attachment)' : '')

  emit({
    method: 'notifications/claude/channel',
    params: {
      content,
      meta: {
        chat_id,
        message_id: msg.id,
        user: msg.author.username,
        user_id: msg.author.id,
        ts: msg.createdAt.toISOString(),
        ...modMeta,
        ...(atts.length > 0 ? { attachment_count: String(atts.length), attachments: atts.join('; ') } : {}),
        ...replyMeta,
      },
      images,
    },
  }).catch(err => {
    process.stderr.write(`prts bot: failed to deliver inbound to Claude: ${err}\n`)
  })
  watchPlainReply(msg, chat_id, aiFor(result.mod))
}

client.once('clientReady', c => {
  process.stderr.write(`prts bot: gateway connected as ${c.user.tag}\n`)
  void registerSlashCommands(c.application?.id ?? c.user.id)
  for (const m of MODULES) void Promise.resolve(m.init?.(client)).catch(e => process.stderr.write(`prts bot: module ${m.name} init failed: ${e}\n`))
  startReminders(client)
  startStoryRefresh(client)
  startAnnouncements(client)
})

if (DRY_RUN) {
  const names = SLASH_COMMANDS.map((c: any) => (c.type === 3 ? `"${c.name}"` : `/${c.name}`))
  process.stdout.write(
    `prts bot (dry run): ${SLASH_COMMANDS.length} commands: ${names.join(' ')}\n` +
      `  /prts: ${describeBackend(CORE_AI)} · modules: ${MODULES.map(m => m.name).join(', ') || 'none'} · token: ${TOKEN ? 'set' : 'not set'}\n` +
      MODULES.filter(m => m.ai)
        .map(m => `  ${m.name}: ${describeBackend(m.ai!)}\n`)
        .join(''),
  )
  process.exit(0)
}

client.login(TOKEN).catch(err => {
  process.stderr.write(`prts bot: login failed: ${err}
`)
  process.exit(1)
})
