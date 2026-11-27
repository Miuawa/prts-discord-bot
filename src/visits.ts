// When each person last talked to PRTS, so it can greet like the game does:
// "Good morning, Dr. {nickname}." on the first visit of the day, and the exact
// time since the last visit after a long absence ("Since your last visit, it
// has been ... days."). Only ids and times are stored.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { CACHE_DIR } from './paths.ts'

const FILE = join(CACHE_DIR, 'prts-visits.json')
let seen: Record<string, number> = {}
try {
  seen = JSON.parse(readFileSync(FILE, 'utf8'))
} catch {}

function save(): void {
  try {
    mkdirSync(dirname(FILE), { recursive: true })
    writeFileSync(FILE + '.tmp', JSON.stringify(seen))
    renameSync(FILE + '.tmp', FILE)
  } catch (e) {
    process.stderr.write(`prts visits: could not save: ${e}\n`)
  }
}

const DAY = 86_400_000
/** "12 days, 4 hours" style span. */
export function span(ms: number): string {
  const d = Math.floor(ms / DAY)
  const h = Math.floor((ms % DAY) / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const part = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
  if (d) return h ? `${part(d, 'day')}, ${part(h, 'hour')}` : part(d, 'day')
  if (h) return m ? `${part(h, 'hour')}, ${part(m, 'minute')}` : part(h, 'hour')
  return part(m, 'minute')
}

/** Notes the visit and returns tag attributes describing it. `now` is for tests. */
export function visit(userId: string, now = Date.now()): Record<string, string> {
  const last = seen[userId]
  seen[userId] = now
  save()
  const t = new Date(now)
  const out: Record<string, string> = {
    local_time: `${t.toLocaleDateString('en-GB', { weekday: 'long' })} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`,
  }
  if (!last) out.first_visit = 'true'
  else {
    if (new Date(last).toDateString() !== t.toDateString()) out.first_visit_today = 'true'
    if (now - last >= 7 * DAY) out.away_for = span(now - last)
  }
  return out
}
