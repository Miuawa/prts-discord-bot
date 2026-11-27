import { describe, expect, test } from 'bun:test'
import { EmbedBuilder } from 'discord.js'
import { CHAT_FOOTER, CHAT_HEADER, brand, frameChunks, stampEmbeds } from '../src/theme.ts'

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
  test('frames /prts replies: header on the first message, footer under each reply', () => {
    expect(frameChunks(['Understood.'], true)).toEqual([`${CHAT_HEADER}\nUnderstood.`.concat(`\n${CHAT_FOOTER}`)])
    const two = frameChunks(['part one', 'part two'], true)
    expect(two[0]).toBe(`${CHAT_HEADER}\npart one`)
    expect(two[1]).toBe(`part two\n${CHAT_FOOTER}`)
    expect(frameChunks(['later'], false)).toEqual([`later\n${CHAT_FOOTER}`])
    // A frame the model wrote itself is not doubled.
    expect(frameChunks(['-# PRTS · Terminal Interface\nHi\n-# Primitive Rhodes Island Terminal Service'], true)).toEqual([`${CHAT_HEADER}\nHi\n${CHAT_FOOTER}`])
  })
})

import { span, visit } from '../src/visits.ts'
describe('PRTS visits', () => {
  test('first visit, same day, next day, long absence', () => {
    const id = `test-${Math.random()}`
    const t0 = new Date(2026, 10, 1, 9, 0).getTime()
    expect(visit(id, t0).first_visit).toBe('true')
    expect(visit(id, t0 + 3_600_000).first_visit_today).toBeUndefined()
    expect(visit(id, t0 + 86_400_000).first_visit_today).toBe('true')
    expect(visit(id, t0 + 13 * 86_400_000 + 4 * 3_600_000).away_for).toBe('12 days, 4 hours')
    expect(span(60_000)).toBe('1 minute')
  })
})
