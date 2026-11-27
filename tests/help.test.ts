import { expect, test } from 'bun:test'
import { ARK_COMMANDS, helpEntries } from '../src/ark.ts'
import { ARKPLUS_COMMANDS } from '../src/arkplus.ts'
import { MUSIC_COMMAND } from '../src/music.ts'

// /help must describe every command and subcommand: adding, renaming or removing one without
// updating /help fails here.
test('/help covers every command and subcommand', () => {
  const help = helpEntries()
  const missing: string[] = []
  for (const c of [...ARK_COMMANDS, ...ARKPLUS_COMMANDS, MUSIC_COMMAND] as any[]) {
    const entries = help.filter(h => h.cmd === c.name || h.cmd.startsWith(`${c.name} `))
    if (!entries.length) {
      missing.push(`/${c.name}`)
      continue
    }
    const text = entries.map(h => `${h.usage} ${h.detail}`).join(' ')
    for (const o of c.options ?? []) {
      if (o.type !== 1 && o.type !== 2) continue
      if (!new RegExp(`\\b${o.name}\\b`).test(text)) missing.push(`/${c.name} ${o.name}`)
    }
  }
  expect(missing).toEqual([])
})
