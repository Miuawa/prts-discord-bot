// Offline test for the roleplay guard that removes dialogue lines a small model
// wrote for player characters. Uses a throwaway kit with a two-player table.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const kit = mkdtempSync(join(tmpdir(), 'prts-kit-'))
writeFileSync(join(kit, 'CLAUDE.md'), '| Discord username | Plays |\n|---|---|\n| alice | Amiya |\n| bob | Texas |\n')
writeFileSync(join(kit, 'rp-channels.json'), '{"channels":{}}\n')
process.env.RP_KIT_DIR = kit
const { stripPlayerLines } = await import('../modules/roleplay/prompt.ts')

const turn = [
  '*The greenhouse hums.*',
  '',
  '**Texas:** "They will survive."',
  "**Kal'tsit:** \"Hm.\"",
  'Amiya: I suppose.',
  '**Texas (quietly):** "Probably."',
  '',
  '**What does Texas do?**',
  'E. Follow along, and let them decide.',
].join('\n')

describe('stripPlayerLines', () => {
  test('drops lines spoken by player characters, keeps NPCs and choice blocks', () => {
    const out = stripPlayerLines({ content: '', meta: {} }, turn)
    expect(out).not.toContain('They will survive')
    expect(out).not.toContain('I suppose')
    expect(out).not.toContain('Probably')
    expect(out).toContain("**Kal'tsit:**")
    expect(out).toContain('**What does Texas do?**')
  })
  test('keeps lines for players who are away (/rp afk)', () => {
    const out = stripPlayerLines({ content: '', meta: { afk: 'Texas' } }, turn)
    expect(out).toContain('They will survive')
    expect(out).not.toContain('I suppose')
  })
  test('returns the text unchanged when nothing matches', () => {
    expect(stripPlayerLines({ content: '', meta: {} }, 'Just narration.')).toBe('Just narration.')
  })
})
