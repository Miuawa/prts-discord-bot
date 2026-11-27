import { clip, ephFlag } from '../common.ts'
import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js'
import { embed, randInt } from './helpers.ts'

// ───────────────────────── /roll /coin /choose ─────────────────────────

function rollDice(expr: string): { text: string; total: number } | string {
  const src = expr.replace(/\s+/g, '').toLowerCase() || '1d20'
  const re = /([+-]?)(?:(\d*)d(\d+|%)(?:(kh|kl)(\d+))?|(\d+))/gy
  let pos = 0,
    total = 0,
    dice = 0
  const parts: string[] = []
  while (pos < src.length) {
    re.lastIndex = pos
    const m = re.exec(src)
    if (!m || m[0] === '' || (pos > 0 && !m[1])) return 'Unable to parse the dice expression. Examples: 1d20, 2d6+3, 4d6kh3, d%.'
    pos = re.lastIndex
    const sign = m[1] === '-' ? -1 : 1
    if (m[6] !== undefined) {
      total += sign * parseInt(m[6], 10)
      parts.push(`${sign < 0 ? '−' : parts.length ? '+' : ''} ${m[6]}`)
      continue
    }
    const count = m[2] ? parseInt(m[2], 10) : 1
    const sides = m[3] === '%' ? 100 : parseInt(m[3], 10)
    dice += count
    if (count < 1 || sides < 2 || sides > 10000 || dice > 100) return 'Request exceeds limits: at most 100 dice, 2 to 10000 sides each.'
    const rolls = Array.from({ length: count }, () => randInt(sides) + 1)
    let kept = rolls.map((_, idx) => idx)
    if (m[4]) {
      const k = Math.min(parseInt(m[5], 10), count)
      kept = kept.sort((a, b) => (m[4] === 'kh' ? rolls[b] - rolls[a] : rolls[a] - rolls[b])).slice(0, k)
    }
    const keep = new Set(kept)
    const sum = rolls.reduce((acc, r, idx) => acc + (keep.has(idx) ? r : 0), 0)
    total += sign * sum
    const shown = rolls
      .map((r, idx) => {
        const t = keep.has(idx) ? String(r) : `~~${r}~~`
        return r === sides && keep.has(idx) ? `**${t}**` : t
      })
      .join(', ')
    parts.push(`${sign < 0 ? '−' : parts.length ? '+' : ''} ${count}d${m[3]}${m[4] ? m[4] + m[5] : ''} [${shown}]`)
  }
  return { text: parts.join(' ').trim(), total }
}

export async function cmdRoll(i: ChatInputCommandInteraction, eph: boolean) {
  const expr = i.options.getString('dice') ?? '1d20'
  const reason = i.options.getString('reason')
  const r = rollDice(expr)
  if (typeof r === 'string') return i.reply({ content: `[PRTS] ${r}`, flags: MessageFlags.Ephemeral })
  const e = embed(reason ? clip(reason, 200) : 'Dice roll')
    .setDescription(`Result: **${r.total}**\n\n\`${expr}\` · ${clip(r.text, 3400)}`)
    .addFields({ name: 'What this roll means', value: clip(diceExplain(expr), 1024) })
  return i.reply({ embeds: [e], flags: ephFlag(eph) })
}

/** "2d6+3" -> "2 six-sided dice, added together, plus 3" — so the notation is understandable at a glance. */
function diceExplain(expr: string): string {
  const parts: string[] = []
  const re = /([+-]?)\s*(?:(\d*)d(\d+|%)(?:(kh|kl)(\d+))?|(\d+))/gi
  for (const m of expr.replace(/\s+/g, '').matchAll(re)) {
    const sign = m[1] === '-' ? 'minus ' : parts.length ? 'plus ' : ''
    if (m[6] !== undefined) {
      parts.push(`${sign}${m[6]}`)
      continue
    }
    const n = Number(m[2] || 1)
    const sides = m[3] === '%' ? 'percentile (1-100)' : `${m[3]}-sided`
    const keep = m[4] ? `, keep the ${m[4] === 'kh' ? 'highest' : 'lowest'} ${m[5]}` : ''
    parts.push(`${sign}${n} ${sides} ${n === 1 ? 'die' : 'dice'}${keep}`)
  }
  // Explain only the notation this roll actually uses.
  const e = expr.replace(/\s+/g, '').toLowerCase()
  const notes = [
    /\d*d\d/.test(e) ? '**XdY** = X dice with Y sides' : '',
    /[+-]\d+(?![d\d])|[+-]\d+$/.test(e) || /^\d+[+-]/.test(e) ? '**+N / -N** adds or subtracts N' : '',
    /kh/.test(e) ? '**khN** keeps the highest N dice' : '',
    /kl/.test(e) ? '**klN** keeps the lowest N dice' : '',
    /d%/.test(e) ? '**d%** = a number from 1 to 100' : '',
  ].filter(Boolean)
  return `${parts.join(', ')}.${notes.length ? `\nNotation: ${notes.join(' · ')}.` : ''}`
}

export async function cmdCoin(i: ChatInputCommandInteraction, eph: boolean) {
  const n = i.options.getInteger('count') ?? 1
  const call = i.options.getString('call')
  const pct = i.options.getInteger('heads') ?? 50
  const flips = Array.from({ length: n }, () => (randInt(100) < pct ? 'Heads' : 'Tails'))
  const heads = flips.filter(f => f === 'Heads').length
  let desc: string
  if (n === 1) {
    desc = `The coin lands on **${flips[0]}**.`
    if (call) desc += flips[0].toLowerCase() === call ? '\nYour call was correct. Congratulations.' : '\nYour call was incorrect. I apologize on behalf of probability.'
  } else {
    desc = `${flips.map(f => (f === 'Heads' ? 'H' : 'T')).join(' ')}\n\nHeads: **${heads}** · Tails: **${n - heads}** (${((heads / n) * 100).toFixed(1)}% heads)`
    if (call) desc += `\nYour call (${call}) was correct ${call === 'heads' ? heads : n - heads} of ${n} times.`
  }
  if (pct !== 50) desc += `\nWeighted coin: ${pct}% heads, ${100 - pct}% tails.`
  const reason = i.options.getString('reason')
  return i.reply({ embeds: [embed(`${reason ? clip(reason, 200) : 'Coin toss'}${n > 1 ? ` ×${n}` : ''}`).setDescription(desc)], flags: ephFlag(eph) })
}

export async function cmdChoose(i: ChatInputCommandInteraction, eph: boolean) {
  const raw = i.options.getString('options', true)
  const opts = raw
    .split(raw.includes('|') ? '|' : ',')
    .map(s => s.trim())
    .filter(Boolean)
  if (opts.length < 2) return i.reply({ content: '[PRTS] Please provide at least two options, separated by | or commas.', flags: MessageFlags.Ephemeral })
  const pick = opts[randInt(opts.length)]
  const reason = i.options.getString('reason')
  const e = embed(reason ? clip(reason, 200) : 'Decision support').setDescription(
    `Options evaluated: ${opts.length}. Probability for each option: ${(100 / opts.length).toFixed(2)}%.\n\nSelected, without hesitation: **${clip(pick, 500)}**`,
  )
  return i.reply({ embeds: [e], flags: ephFlag(eph) })
}
