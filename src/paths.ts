// Shared folder locations. Everything is relative to the repository root
// (the folder above src/), unless a setting points elsewhere.
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

/** The repository root. */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
/** Regenerated data: game data, chat history, reminders (PRTS_CACHE_DIR). */
export const CACHE_DIR = process.env.PRTS_CACHE_DIR ?? join(ROOT, 'cache')
/** Downloaded community data: sheets/, stories.json (PRTS_DATA_DIR). */
export const DATA_DIR = process.env.PRTS_DATA_DIR ?? join(ROOT, 'data')
