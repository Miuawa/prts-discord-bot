import { ephFlag } from '../common.ts'
import { EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js'
import { COLOR, FOOTER } from '../theme.ts'

export const TIMO = 'https://arknights.timo.beer'
export const MYRTLE = 'https://myrtle.moe'

export const log = (s: string) => process.stderr.write(`prts ark: ${s}\n`)

// ───────────────────────── helpers ─────────────────────────

export const stars = (n: number) => '★'.repeat(n)
export const randInt = (n: number) => {
  const buf = new Uint32Array(1)
  const lim = Math.floor(0x100000000 / n) * n
  do crypto.getRandomValues(buf)
  while (buf[0] >= lim)
  return buf[0] % n
}

export function embed(title?: string): EmbedBuilder {
  const e = new EmbedBuilder().setColor(COLOR.info).setFooter({ text: FOOTER })
  if (title) e.setTitle(title)
  return e
}

export async function notReady(i: ChatInputCommandInteraction, eph: boolean) {
  await i.reply({
    embeds: [
      embed('Records loading')
        .setColor(COLOR.warn)
        .setDescription('Operator records are being downloaded from the game data archive. Estimated time: under 60 seconds. Please try again shortly. I apologize for the delay.'),
    ],
    flags: ephFlag(eph),
  })
}
