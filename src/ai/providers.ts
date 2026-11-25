// The two API backends. Both take a system prompt plus a user/assistant
// history and return plain text, so the bot can post it as it is.
import Anthropic from '@anthropic-ai/sdk'
import type { AiConfig, ApiBackend } from './config.ts'
import { modelFor } from './config.ts'
import type { LoadedImage } from './images.ts'

export type Msg = { role: 'user' | 'assistant'; content: string }
export type Completion = { text: string; truncated: boolean; refused: boolean; info?: string }

// How long to wait for a reply (<P>_TIMEOUT in seconds, default 300).
const timeoutMs = (c: AiConfig) => (c.timeout ?? 300) * 1000
const DEFAULT_MAX_TOKENS = { anthropic: 16_000, 'openai-compatible': 1400 }

/** Anthropic Messages API through the official SDK. */
// The prompt's length hint (maxTokens) is only used for OpenAI-compatible
// models: on Claude, thinking also counts toward max_tokens, so it keeps a
// roomy default unless <P>_MAX_TOKENS is set.
async function anthropic(c: AiConfig, system: string, msgs: Msg[], images: LoadedImage[]): Promise<Completion> {
  if (!c.anthropicKey) throw new Error(`no Anthropic API key: set ANTHROPIC_API_KEY (or ${c.prefix}_ANTHROPIC_API_KEY)`)
  const client = new Anthropic({ apiKey: c.anthropicKey, timeout: timeoutMs(c) })
  const res = await client.beta.messages.create({
    model: modelFor(c, 'anthropic'),
    max_tokens: c.maxTokens ?? DEFAULT_MAX_TOKENS.anthropic,
    system,
    messages: withImages(msgs, images, (text, imgs) => [...imgs.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })), { type: 'text', text }]),
    output_config: { effort: c.effort as any },
    // Optional: re-run a declined turn on a fallback model chosen by the API.
    ...(c.refusalFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
    // Cache the long, mostly stable system prompt between turns.
    cache_control: { type: 'ephemeral' },
  } as any)
  const text = (res.content as any[])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim()
  return {
    text,
    truncated: res.stop_reason === 'max_tokens',
    refused: res.stop_reason === 'refusal',
    info: `${res.model}: ${res.usage.input_tokens} in, ${res.usage.output_tokens} out${res.usage.cache_read_input_tokens ? `, ${res.usage.cache_read_input_tokens} cached` : ''}`,
  }
}

/** Any OpenAI-style /chat/completions server: llama.cpp, Ollama, LM Studio, vLLM, OpenRouter, OpenAI... */
async function openaiCompatible(c: AiConfig, system: string, msgs: Msg[], images: LoadedImage[], maxTokens?: number): Promise<Completion> {
  const res = await fetch(`${c.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}) },
    signal: AbortSignal.timeout(timeoutMs(c)),
    body: JSON.stringify({
      model: modelFor(c, 'openai-compatible'),
      messages: [
        { role: 'system', content: system },
        ...withImages(msgs, images, (text, imgs) => [{ type: 'text', text }, ...imgs.map(i => ({ type: 'image_url', image_url: { url: `data:${i.mediaType};base64,${i.data}` } }))]),
      ],
      [c.maxTokensField]: c.maxTokens ?? maxTokens ?? DEFAULT_MAX_TOKENS['openai-compatible'],
      ...(c.temperature === null ? {} : { temperature: c.temperature }),
      ...c.extraBody,
    }),
  })
  if (!res.ok) throw new Error(`${c.baseUrl} answered ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const d: any = await res.json()
  let text: string = d?.choices?.[0]?.message?.content ?? ''
  // Reasoning models may put their thinking inline.
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  const t = d?.timings // llama.cpp extra
  const u = d?.usage
  return {
    text,
    truncated: d?.choices?.[0]?.finish_reason === 'length',
    refused: false,
    info: t ? `${t.prompt_n} tok in, ${t.predicted_n} tok at ${Number(t.predicted_per_second).toFixed(1)} tok/s` : u ? `${u.prompt_tokens} in, ${u.completion_tokens} out` : undefined,
  }
}

/** The messages, with the images put into the last user message in the backend's format. */
function withImages(msgs: Msg[], images: LoadedImage[], parts: (text: string, imgs: LoadedImage[]) => unknown[]): unknown[] {
  if (!images.length) return msgs
  const last = msgs.length - 1
  return msgs.map((m, i) => (i === last && m.role === 'user' ? { role: 'user', content: parts(m.content, images) } : m))
}

/** One model call. `images` go with the last user message. */
export function complete(b: ApiBackend, c: AiConfig, system: string, msgs: Msg[], maxTokens?: number, images: LoadedImage[] = []): Promise<Completion> {
  return b === 'anthropic' ? anthropic(c, system, msgs, images) : openaiCompatible(c, system, msgs, images, maxTokens)
}

/** Quick reachability check for /status. */
export async function probe(b: ApiBackend, c: AiConfig): Promise<string> {
  if (b === 'anthropic') return c.anthropicKey ? 'API key set' : '**no API key** (ANTHROPIC_API_KEY)'
  try {
    const r = await fetch(`${c.baseUrl}/models`, {
      headers: c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {},
      signal: AbortSignal.timeout(3000),
    })
    return r.ok ? `reachable (${c.baseUrl})` : `**answered ${r.status}** (${c.baseUrl})`
  } catch {
    return `**not reachable** (${c.baseUrl})`
  }
}
