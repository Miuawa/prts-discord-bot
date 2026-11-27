import { expect, test } from 'bun:test'
import { parseEnemies, statLines } from '../src/enemy.ts'

const def = (v: unknown) => ({ m_defined: true, m_value: v })
const handbook = {
  raceData: { sarkaz: { raceName: 'Sarkaz' } },
  enemyData: {
    enemy_x: {
      name: 'Test Boss',
      enemyIndex: 'TB',
      enemyLevel: 'BOSS',
      description: 'A <@eb.key>test</>.',
      damageType: ['MAGIC'],
      abilityList: [
        { text: 'Stance', textFormat: 'TITLE' },
        { text: 'Hits hard', textFormat: 'NORMAL' },
      ],
    },
    enemy_hidden: { name: 'Hidden', hideInHandbook: true },
  },
}
const database = {
  enemy_x: [
    {
      level: 0,
      enemyData: {
        applyWay: def('RANGED'),
        motion: def('FLY'),
        enemyTags: def(['sarkaz']),
        lifePointReduce: def(2),
        attributes: {
          maxHp: def(1000),
          atk: def(200),
          def: def(50),
          magicResistance: def(20),
          baseAttackTime: def(2),
          moveSpeed: def(1),
          massLevel: def(3),
          silenceImmune: def(true),
          stunImmune: def(false),
        },
      },
    },
    { level: 1, enemyData: { attributes: { maxHp: def(2000), atk: { m_defined: false, m_value: 0 } } } },
  ],
}

test('parses the handbook and battle stats', () => {
  const all = parseEnemies(handbook, database)
  expect(Object.keys(all)).toEqual(['enemy_x'])
  const e = all.enemy_x
  expect(e).toMatchObject({ name: 'Test Boss', level: 'Leader', races: ['Sarkaz'], damage: ['Arts'], attack: 'Ranged', flying: true, desc: 'A test.', immune: ['Silence'] })
  expect(e.abilities).toEqual([
    { title: true, text: 'Stance' },
    { title: undefined, text: 'Hits hard' },
  ])
  expect(e.stats).toMatchObject({ hp: 1000, atk: 200, lifePoints: 2, weight: 3 })
  expect(e.stronger).toEqual([{ hp: 2000 }])
  expect(statLines(e.stats!)[0]).toBe('**HP** 1,000 · **ATK** 200 · **DEF** 50 · **RES** 20')
})

test('reads infobox images and picks the one that fits the enemy', async () => {
  const { parseInfoboxImages, pickPortrait } = await import('../src/arkplus.ts')
  const npc = '{{NPC tab}}\n{{Character infobox\n|name = Jesselton Williams\n|image = \nJesselton Williams jailer.png:Jailer;\nJesselton Williams killer.png:Killer;\n|othername = X\n}}'
  const j = parseInfoboxImages(npc)!
  expect(j.kind).toBe('character')
  expect(pickPortrait(j.images, 'Jesselton Williams')?.file).toBe('Jesselton Williams jailer.png')
  const story = '{{Character infobox\n|name = Talulah Artorius\n|image = \nTalulah.png:Operator;\nTalulah (Act I).png:NPC (Prologue to Act II);\nTalulah, the Fighter.png:NPC (past)\n|othername = x'
  const t = parseInfoboxImages(story)!.images
  expect(pickPortrait(t, 'Talulah')?.file).toBe('Talulah (Act I).png')
  expect(pickPortrait(t, 'Talulah, the Fighter')?.file).toBe('Talulah, the Fighter.png')
  expect(parseInfoboxImages('{{Operator infobox\n|name = Talulah\n|image = \nTalulah.png:Base\n|cnname = x}}')?.kind).toBe('operator')
  expect(parseInfoboxImages('no infobox')).toBeNull()
})

test('groups enemy variants by base name', async () => {
  const { enemyBaseName } = await import('../src/arkplus.ts')
  expect(enemyBaseName("'Emperor's Blade', Pursuer")).toBe("Emperor's Blade")
  expect(enemyBaseName("'Emperor's Blade'")).toBe("Emperor's Blade")
  expect(enemyBaseName('Originium Slug α')).toBe('Originium Slug')
  expect(enemyBaseName('Talulah, the Fighter')).toBe('Talulah')
})

test('finds the character behind an enemy page', async () => {
  const { enemyCharacter, pickPortrait } = await import('../src/arkplus.ts')
  expect(enemyCharacter('Talulah/Ally', '')).toEqual({ page: 'Talulah', hint: '' })
  const lava = "{{Enemy infobox\n|name = Lava, Flame of Resistance\n|filename = enemy_8017_vcblva}}\n'''[[Lava the Purgatory|Lava]], Flame of Resistance''' is an [[elite enemy]]."
  expect(enemyCharacter('Lava, Flame of Resistance', lava)).toEqual({ page: 'Lava the Purgatory', hint: '' })
  expect(enemyCharacter('Catapult (enemy)', "{{Enemy infobox\n|filename = x}}\nThe '''\"Catapult\"''' is an [[elite enemy]].")).toBeNull()
  expect(enemyCharacter('Amiya (Babel)', "{{Enemy infobox\n|x = y}}\n'''[[Amiya/Story#Babel|'Amiya']]''' is a [[boss enemy]].")).toEqual({ page: 'Amiya/Story', hint: 'Babel' })
  const lavaImgs = [
    { file: 'Lava.png', label: 'Original' },
    { file: 'Lava the Purgatory.png', label: 'The Purgatory' },
  ]
  expect(pickPortrait(lavaImgs, ['Lava, Flame of Resistance', 'Lava the Purgatory'])?.file).toBe('Lava the Purgatory.png')
})
