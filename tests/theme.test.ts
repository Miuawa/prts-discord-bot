import { describe, expect, test } from 'bun:test'
import { EmbedBuilder } from 'discord.js'
import { brand, stampEmbeds } from '../src/theme.ts'

describe('PRTS theme', () => {
  test('adds the section header only where none is set', () => {
    const a = new EmbedBuilder().setTitle('a')
    const b = new EmbedBuilder().setAuthor({ name: 'Wiki record' })
    stampEmbeds({ embeds: [a, b] }, 'Operator Archives')
    expect(a.data.author?.name).toBe('PRTS · Operator Archives')
    expect(b.data.author?.name).toBe('Wiki record')
    expect(stampEmbeds('plain text', 'X')).toBe('plain text')
  })
  test('brand stamps every reply an interaction sends', async () => {
    const sent: any[] = []
    const i = brand({ reply: async (p: any) => sent.push(p), editReply: async (p: any) => sent.push(p), followUp: async (p: any) => sent.push(p) }, 'Combat Records')
    await i.reply({ embeds: [new EmbedBuilder()] })
    await i.editReply({ embeds: [{ title: 'raw' }] })
    expect(sent[0].embeds[0].data.author.name).toBe('PRTS · Combat Records')
    expect(sent[1].embeds[0].author.name).toBe('PRTS · Combat Records')
  })
})
