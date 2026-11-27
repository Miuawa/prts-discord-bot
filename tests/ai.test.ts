// Offline tests: request building for each API backend (fetch is mocked, no
// real keys or servers), backend routing, and the module loader.
import { afterEach, describe, expect, test } from 'bun:test'
import { readAiConfig, apiBackendFor, aiAvailable } from '../src/ai/config.ts'
import { complete } from '../src/ai/providers.ts'
import { loadModules } from '../src/modules.ts'
import { imageRefs, loadImages } from '../src/ai/images.ts'

const realFetch = globalThis.fetch
type Captured = { url: string; headers: Record<string, string>; body: any }
function mockFetch(reply: unknown): Captured[] {
  const calls: Captured[] = []
  globalThis.fetch = (async (input: any, init?: any) => {
    const req = input instanceof Request ? input : new Request(input, init)
    const headers: Record<string, string> = {}
    req.headers.forEach((v, k) => (headers[k] = v))
    calls.push({ url: req.url, headers, body: JSON.parse(await req.text()) })
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return calls
}
afterEach(() => {
  globalThis.fetch = realFetch
})
const withEnv = <T>(vars: Record<string, string | undefined>, fn: () => T): T => {
  const old: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(vars)) {
    old[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

describe('config', () => {
  test('defaults to the Claude Code narrator', () => {
    const c = withEnv({ PRTS_BACKEND: undefined }, () => readAiConfig('PRTS'))
    expect(c.backend).toBe('claude-code')
    expect(apiBackendFor(c, true)).toBeNull()
    expect(aiAvailable(c, false)).toBe(false)
  })
  test('module settings fall back to the core ones', () => {
    const core = withEnv({ PRTS_BACKEND: 'openai-compatible', PRTS_BASE_URL: 'http://core:1/v1', PRTS_MODEL: 'core-model' }, () => readAiConfig('PRTS'))
    const rp = withEnv({ RP_BACKEND: undefined, RP_MODEL: 'rp-model', RP_BASE_URL: undefined }, () => readAiConfig('RP', core))
    expect(rp.backend).toBe('openai-compatible')
    expect(rp.baseUrl).toBe('http://core:1/v1')
    expect(rp.model).toBe('rp-model')
  })
  test('auto uses Claude Code while connected, the fallback otherwise', () => {
    const c = withEnv({ X_BACKEND: 'auto', X_AUTO_FALLBACK: 'anthropic' }, () => readAiConfig('X'))
    expect(apiBackendFor(c, true)).toBeNull()
    expect(apiBackendFor(c, false)).toBe('anthropic')
  })
  test('short aliases are accepted', () => {
    expect(withEnv({ X_BACKEND: 'local' }, () => readAiConfig('X')).backend).toBe('openai-compatible')
    expect(withEnv({ X_BACKEND: 'claude' }, () => readAiConfig('X')).backend).toBe('claude-code')
  })
})

describe('openai-compatible backend', () => {
  test('builds a chat/completions request with key, model and extra body', async () => {
    const calls = mockFetch({ choices: [{ message: { content: '<think>hm</think>Hello there.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } })
    const c = withEnv({ T_BASE_URL: 'http://llm.test/v1/', T_API_KEY: 'test-key', T_MODEL: 'my-model', T_EXTRA_BODY: '{"chat_template_kwargs":{"enable_thinking":false}}' }, () => readAiConfig('T'))
    const r = await complete('openai-compatible', c, 'SYSTEM', [{ role: 'user', content: 'hi' }], 900)
    expect(r.text).toBe('Hello there.')
    expect(calls[0].url).toBe('http://llm.test/v1/chat/completions')
    expect(calls[0].headers.authorization).toBe('Bearer test-key')
    expect(calls[0].body.model).toBe('my-model')
    expect(calls[0].body.max_tokens).toBe(900)
    expect(calls[0].body.messages[0]).toEqual({ role: 'system', content: 'SYSTEM' })
    expect(calls[0].body.chat_template_kwargs).toEqual({ enable_thinking: false })
  })
  test('no Authorization header without a key; length finish is reported', async () => {
    const calls = mockFetch({ choices: [{ message: { content: 'x' }, finish_reason: 'length' }] })
    const c = withEnv({ U_BASE_URL: 'http://127.0.0.1:8081/v1', U_API_KEY: undefined }, () => readAiConfig('U'))
    const r = await complete('openai-compatible', c, 's', [{ role: 'user', content: 'hi' }])
    expect(calls[0].headers.authorization).toBeUndefined()
    expect(r.truncated).toBe(true)
  })
})

test('length field and temperature can be changed for OpenAI models', async () => {
  const calls = mockFetch({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] })
  const c = withEnv({ O_MAX_TOKENS_FIELD: 'max_completion_tokens', O_TEMPERATURE: 'none' }, () => readAiConfig('O'))
  await complete('openai-compatible', c, 's', [{ role: 'user', content: 'hi' }], 500)
  expect(calls[0].body.max_completion_tokens).toBe(500)
  expect(calls[0].body.max_tokens).toBeUndefined()
  expect('temperature' in calls[0].body).toBe(false)
})

describe('anthropic backend', () => {
  test('builds a Messages API request with the model and system prompt', async () => {
    const calls = mockFetch({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5-5',
      content: [{ type: 'text', text: 'The scene opens.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 4 },
    })
    const c = withEnv({ V_ANTHROPIC_API_KEY: 'test-anthropic-key', V_MODEL: undefined, V_EFFORT: 'low' }, () => readAiConfig('V'))
    const r = await complete('anthropic', c, 'SYSTEM', [{ role: 'user', content: 'hi' }], 900)
    expect(r.text).toBe('The scene opens.')
    expect(calls[0].url).toContain('/v1/messages')
    // The SDK sends the key as x-api-key or as a bearer token, depending on its version.
    expect([calls[0].headers['x-api-key'], calls[0].headers.authorization]).toContainEqual(expect.stringContaining('test-anthropic-key'))
    expect(calls[0].headers['anthropic-beta'] ?? '').not.toContain('server-side-fallback')
    expect(calls[0].body.model).toBe('claude-sonnet-5-5')
    expect(calls[0].body.system).toBe('SYSTEM')
    expect(calls[0].body.max_tokens).toBe(16000)
    expect(calls[0].body.output_config).toEqual({ effort: 'low' })
    expect(calls[0].body.fallbacks).toBeUndefined()
    expect(calls[0].body.temperature).toBeUndefined()
  })
  test('refusal fallback is sent only when turned on', async () => {
    const calls = mockFetch({
      id: 'm',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5-5',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    const c = withEnv({ F_ANTHROPIC_API_KEY: 'k', F_REFUSAL_FALLBACK: 'on' }, () => readAiConfig('F'))
    await complete('anthropic', c, 's', [{ role: 'user', content: 'hi' }])
    expect(calls[0].headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01')
    expect(calls[0].body.fallbacks).toBe('default')
  })
  test('a refusal is reported, not posted as text', async () => {
    mockFetch({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: 'refusal', usage: { input_tokens: 1, output_tokens: 0 } })
    const c = withEnv({ W_ANTHROPIC_API_KEY: 'k' }, () => readAiConfig('W'))
    const r = await complete('anthropic', c, 's', [{ role: 'user', content: 'hi' }])
    expect(r.refused).toBe(true)
  })
  test('fails clearly without a key', async () => {
    const c = withEnv({ Y_ANTHROPIC_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, () => readAiConfig('Y'))
    await expect(complete('anthropic', c, 's', [{ role: 'user', content: 'hi' }])).rejects.toThrow(/ANTHROPIC_API_KEY/)
  })
})

describe('modules', () => {
  test('nothing is loaded when PRTS_MODULES is empty', async () => {
    expect(await loadModules('')).toEqual([])
  })
  test('the roleplay module registers /rp and its help', async () => {
    const [rp] = await loadModules('roleplay')
    expect(rp.name).toBe('roleplay')
    expect((rp.commands as any[]).map(c => c.name)).toEqual(['rp'])
    expect(rp.help?.[0].cmd).toBe('rp')
    expect(rp.turns?.prompt({ content: 'I wave.', meta: { rp: 'true', user: 'someone' } }, '').system).toContain('belong to their players')
  })
  test('unknown and invalid module names are skipped', async () => {
    expect(await loadModules('does-not-exist,../evil')).toEqual([])
  })
  test('a desktop module (no index.ts) loads nothing', async () => {
    expect(await loadModules('control')).toEqual([])
  })
})

describe('core without modules', () => {
  test('/help lists no /rp', async () => {
    const { ARK_COMMANDS } = await import('../src/ark.ts')
    const help = (ARK_COMMANDS as any[]).find(c => c.name === 'help')
    expect(help.options[0].choices.some((c: any) => c.value === 'rp')).toBe(false)
  })
})

describe('images', () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const img = [{ name: 'dot.png', mediaType: 'image/png', data: PNG }]
  test('only supported images under the size limit are picked', () => {
    const refs = imageRefs([
      { name: 'a.png', contentType: 'image/png', size: 10, url: 'u1' },
      { name: 'b.txt', contentType: 'text/plain', size: 10, url: 'u2' },
      { name: 'c.jpg', contentType: 'image/jpeg', size: 99 * 1024 * 1024, url: 'u3' },
    ])
    expect(refs.map(r => r.name)).toEqual(['a.png'])
  })
  test('images load from a saved file', async () => {
    const f = `${require('os').tmpdir()}/prts-test-${Date.now()}.png`
    require('fs').writeFileSync(f, Buffer.from(PNG, 'base64'))
    const [i] = await loadImages([{ name: 'dot.png', mediaType: 'image/png', path: f }])
    expect(i.data).toBe(PNG)
  })
  test('openai-compatible: image_url parts on the last user message', async () => {
    const calls = mockFetch({ choices: [{ message: { content: 'A dot.' }, finish_reason: 'stop' }] })
    const c = withEnv({ I_BASE_URL: 'http://llm.test/v1' }, () => readAiConfig('I'))
    await complete(
      'openai-compatible',
      c,
      's',
      [
        { role: 'user', content: 'old' },
        { role: 'assistant', content: 'x' },
        { role: 'user', content: 'What is this?' },
      ],
      100,
      img,
    )
    const msgs = calls[0].body.messages
    expect(msgs[1].content).toBe('old')
    expect(msgs[3].content[0]).toEqual({ type: 'text', text: 'What is this?' })
    expect(msgs[3].content[1].image_url.url).toBe(`data:image/png;base64,${PNG}`)
  })
  test('anthropic: base64 image blocks before the text', async () => {
    const calls = mockFetch({
      id: 'm',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5-5',
      content: [{ type: 'text', text: 'A dot.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    const c = withEnv({ J_ANTHROPIC_API_KEY: 'k' }, () => readAiConfig('J'))
    await complete('anthropic', c, 's', [{ role: 'user', content: 'What is this?' }], undefined, img)
    const content = calls[0].body.messages[0].content
    expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } })
    expect(content[1]).toEqual({ type: 'text', text: 'What is this?' })
  })
  test('vision setting', () => {
    expect(withEnv({ K_VISION: undefined }, () => readAiConfig('K')).vision).toBe('auto')
    expect(withEnv({ K_VISION: 'off' }, () => readAiConfig('K')).vision).toBe('off')
  })
})

import { CHAT_HOOKS, setCharacterLookup } from '../src/ai/chat.ts'
describe('/prts on an API model', () => {
  test('addresses players by their character, others as Doctor', () => {
    setCharacterLookup(u => (u === 'player_one' ? 'Amiya' : undefined))
    const sys = (user: string, extra = {}) => CHAT_HOOKS.prompt({ content: 'hi', meta: { user, ...extra } }, '').system
    expect(sys('player_one', { first_visit_today: 'true', local_time: 'Friday 09:10' })).toContain('"Good morning, Amiya."')
    expect(sys('player_one')).toContain('address and identify them as Amiya')
    expect(sys('stranger', { first_visit: 'true' })).toContain('Terminal Service, Doctor."')
    expect(CHAT_HOOKS.speaker!('player_one')).toBe('Amiya')
    expect(sys('player_one', { style: 'normal' })).not.toContain('Amiya')
    setCharacterLookup(() => undefined)
  })
})
