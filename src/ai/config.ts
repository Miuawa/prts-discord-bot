// Who answers AI turns, and how to reach an API model. The core reads the
// PRTS_* settings; a module can read its own prefix (for example RP_*) and
// fall back to the core's values for anything it does not set.
//
//   <P>_BACKEND        claude-code | anthropic | openai-compatible | auto
//   <P>_AUTO_FALLBACK  backend for "auto" while no Claude Code narrator is connected
//                      (anthropic | openai-compatible, default openai-compatible)
//   <P>_MODEL          model id for the API backend
//   <P>_BASE_URL       openai-compatible: server URL up to /v1 (default http://127.0.0.1:8081/v1)
//   <P>_API_KEY        openai-compatible: bearer key (optional for local servers)
//   <P>_TEMPERATURE    openai-compatible: sampling temperature (default 0.7; "none" leaves it out)
//   <P>_MAX_TOKENS_FIELD openai-compatible: name of the length field (default max_tokens;
//                      newer OpenAI models want max_completion_tokens)
//   <P>_EXTRA_BODY     openai-compatible: JSON merged into the request body
//   <P>_EFFORT         anthropic: low | medium | high | xhigh | max (default medium)
//   <P>_MAX_TOKENS     output limit per reply
//   <P>_TIMEOUT        seconds to wait for a reply (default 300)
//   <P>_REFUSAL_FALLBACK anthropic: on = re-run a declined turn on a fallback model chosen
//                      by the API (server-side fallbacks beta); default off
//   <P>_LABEL          name for this model in logs and /status
//   <P>_VISION         auto | on | off: send image attachments to the model (default auto:
//                      send them, and answer without them if the model rejects images)
// The Anthropic key is ANTHROPIC_API_KEY (or <P>_ANTHROPIC_API_KEY).

export type Backend = 'claude-code' | 'anthropic' | 'openai-compatible' | 'auto'
export type ApiBackend = Exclude<Backend, 'claude-code' | 'auto'>

export type AiConfig = {
  /** Setting prefix this config was read from, for messages. */
  prefix: string
  backend: Backend
  fallback: ApiBackend
  model?: string
  baseUrl: string
  apiKey?: string
  anthropicKey?: string
  temperature: number | null
  maxTokensField: string
  extraBody: Record<string, unknown>
  effort: string
  maxTokens?: number
  label?: string
  vision: 'auto' | 'on' | 'off'
  timeout?: number
  refusalFallback: boolean
}

const BACKENDS: Backend[] = ['claude-code', 'anthropic', 'openai-compatible', 'auto']
// Short names people are likely to type.
const ALIASES: Record<string, Backend> = { claude: 'claude-code', local: 'openai-compatible', openai: 'openai-compatible', api: 'openai-compatible' }

function parseBackend(v: string | undefined, name: string): Backend | undefined {
  if (!v?.trim()) return undefined
  const s = v.trim().toLowerCase()
  const b = ALIASES[s] ?? ((BACKENDS as string[]).includes(s) ? (s as Backend) : undefined)
  if (!b) process.stderr.write(`prts ai: ${name}=${v} is not one of ${BACKENDS.join(', ')}; ignoring it\n`)
  return b
}

function parseJson(v: string | undefined, name: string): Record<string, unknown> | undefined {
  if (!v?.trim()) return undefined
  try {
    const o = JSON.parse(v)
    if (o && typeof o === 'object' && !Array.isArray(o)) return o
  } catch {}
  process.stderr.write(`prts ai: ${name} is not a JSON object; ignoring it\n`)
  return undefined
}

/** Read <prefix>_* settings. Anything unset comes from `base` (the core config) or the defaults. */
export function readAiConfig(prefix: string, base?: AiConfig): AiConfig {
  const env = (k: string) => process.env[`${prefix}_${k}`]?.trim() || undefined
  const num = (k: string) => (env(k) !== undefined && Number.isFinite(Number(env(k))) ? Number(env(k)) : undefined)
  const backend = parseBackend(env('BACKEND'), `${prefix}_BACKEND`) ?? base?.backend ?? 'claude-code'
  const fb = parseBackend(env('AUTO_FALLBACK'), `${prefix}_AUTO_FALLBACK`)
  return {
    prefix,
    backend,
    fallback: fb === 'anthropic' || fb === 'openai-compatible' ? fb : (base?.fallback ?? 'openai-compatible'),
    model: env('MODEL') ?? base?.model,
    baseUrl: (env('BASE_URL') ?? base?.baseUrl ?? 'http://127.0.0.1:8081/v1').replace(/\/+$/, ''),
    apiKey: env('API_KEY') ?? base?.apiKey,
    anthropicKey: env('ANTHROPIC_API_KEY') ?? base?.anthropicKey ?? (process.env.ANTHROPIC_API_KEY?.trim() || undefined),
    temperature: env('TEMPERATURE')?.toLowerCase() === 'none' ? null : (num('TEMPERATURE') ?? (base ? base.temperature : 0.7)),
    maxTokensField: env('MAX_TOKENS_FIELD') ?? base?.maxTokensField ?? 'max_tokens',
    extraBody: parseJson(env('EXTRA_BODY'), `${prefix}_EXTRA_BODY`) ?? base?.extraBody ?? {},
    effort: env('EFFORT') ?? base?.effort ?? 'medium',
    maxTokens: num('MAX_TOKENS') ?? base?.maxTokens,
    label: env('LABEL') ?? base?.label,
    timeout: num('TIMEOUT') ?? base?.timeout,
    refusalFallback: env('REFUSAL_FALLBACK') !== undefined ? /^(on|1|true|yes)$/i.test(env('REFUSAL_FALLBACK')!) : (base?.refusalFallback ?? false),
    vision: ((v): AiConfig['vision'] => (v === 'on' || v === 'off' || v === 'auto' ? v : (base?.vision ?? 'auto')))(env('VISION')?.toLowerCase()),
  }
}

/** Can AI turns be answered at all right now? */
export const aiAvailable = (c: AiConfig, claudeConnected: boolean) => claudeConnected || c.backend !== 'claude-code'
/** The API backend to use for this turn, or null when the Claude Code narrator answers. */
export function apiBackendFor(c: AiConfig, claudeConnected: boolean): ApiBackend | null {
  if (c.backend === 'claude-code') return null
  if (c.backend === 'auto') return claudeConnected ? null : c.fallback
  return c.backend
}
/** Model id actually used for an API backend. */
export const modelFor = (c: AiConfig, b: ApiBackend) => c.model ?? (b === 'anthropic' ? 'claude-sonnet-5-5' : 'local')
/** Human-readable name of the backend, for /status. */
export function describeBackend(c: AiConfig): string {
  const api = (b: ApiBackend) => `${b === 'anthropic' ? 'Anthropic API' : 'OpenAI-compatible API'} (${c.label ?? modelFor(c, b)})`
  if (c.backend === 'claude-code') return 'Claude Code narrator'
  if (c.backend === 'auto') return `Claude Code narrator, else ${api(c.fallback)}`
  return api(c.backend)
}
