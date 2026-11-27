// Runs before every test file (bunfig.toml). The roleplay module reads its kit
// folder once, when it is first imported, and any test file may import it
// first, so the throwaway kit with a two-player table is set up here.
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const kit = mkdtempSync(join(tmpdir(), 'prts-kit-'))
writeFileSync(join(kit, 'CLAUDE.md'), '| Discord username | Plays |\n|---|---|\n| alice | Amiya |\n| bob | Texas |\n')
writeFileSync(join(kit, 'rp-channels.json'), '{"channels":{}}\n')
process.env.RP_KIT_DIR = kit
