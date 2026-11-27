// Page buttons (◀ 2 / 5 ▶) for replies too long for one embed. The pages live in memory for a few hours;
// pressing a button switches the same message to that page. Custom ids: `page:<key>:<index>`.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type ButtonInteraction, type EmbedBuilder, MessageFlags } from 'discord.js'

type Book = { pages: EmbedBuilder[]; rows: ActionRowBuilder<any>[]; at: number }
const books = new Map<string, Book>()
const TTL = 6 * 3600_000

function prune() {
  const now = Date.now()
  for (const [k, b] of books) if (now - b.at > TTL) books.delete(k)
  while (books.size > 500) books.delete(books.keys().next().value as string)
}

function nav(key: string, n: number, total: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`page:${key}:${n - 1}`)
      .setLabel('◀')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(n === 0),
    new ButtonBuilder()
      .setCustomId(`page:${key}:info`)
      .setLabel(`${n + 1} / ${total}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`page:${key}:${n + 1}`)
      .setLabel('▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(n >= total - 1),
  )
}

/** A reply showing the first page, with page buttons when there is more than one. `rows` stay under every page. */
export function paged(pages: EmbedBuilder[], rows: ActionRowBuilder<any>[] = []): { embeds: EmbedBuilder[]; components: ActionRowBuilder<any>[] } {
  if (pages.length <= 1) return { embeds: pages.slice(0, 1), components: rows }
  prune()
  const key = Math.random().toString(36).slice(2, 10)
  books.set(key, { pages, rows, at: Date.now() })
  return { embeds: [pages[0]], components: [nav(key, 0, pages.length), ...rows] }
}

/** Splits lines into embed pages of at most `max` characters (and `perPage` lines), built by `make`. */
export function linePages(lines: string[], make: (body: string, page: number, total: number) => EmbedBuilder, max = 3600, perPage = 40): EmbedBuilder[] {
  const chunks: string[][] = [[]]
  let len = 0
  for (const l of lines) {
    const cur = chunks[chunks.length - 1]
    if (cur.length && (len + l.length + 1 > max || cur.length >= perPage)) {
      chunks.push([])
      len = 0
    }
    chunks[chunks.length - 1].push(l)
    len += l.length + 1
  }
  return chunks.map((c, k) => make(c.join('\n'), k, chunks.length))
}

export async function handlePageButton(i: ButtonInteraction): Promise<void> {
  const m = /^page:([^:]+):(\d+)$/.exec(i.customId)
  const book = m && books.get(m[1])
  if (!m || !book) {
    await i.reply({ content: '[PRTS] This list has expired. Please run the command again.', flags: MessageFlags.Ephemeral })
    return
  }
  const n = Math.max(0, Math.min(Number(m[2]), book.pages.length - 1))
  const page = book.pages[n]
  // Only the first page was stamped with the "PRTS · <module>" header when it was sent.
  const head = book.pages[0].data.author
  if (head && !page.data.author) page.setAuthor(head)
  book.at = Date.now()
  await i.update({ embeds: [page], components: [nav(m[1], n, book.pages.length), ...book.rows] })
}
