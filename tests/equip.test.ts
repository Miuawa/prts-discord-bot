import { describe, expect, test } from 'bun:test'
import { fillTemplate, gradeWord, parseModule, recLevel, statLine } from '../src/equip.ts'

const bb = (o: Record<string, number>) => Object.entries(o).map(([key, value]) => ({ key, value }))
const part = (target: string, extra: any) => ({ target, isToken: false, overrideTraitDataBundle: { candidates: null }, addOrOverrideTalentDataBundle: { candidates: null }, ...extra })

// Shaped like Ch'en's module Y in battle_equip_table.json (EN).
const chenY = {
  phases: [1, 2, 3].map((lv, i) => ({
    equipLevel: lv,
    attributeBlackboard: bb({ atk: [52, 68, 85][i], def: [28, 36, 42][i] }),
    parts: [
      part('TRAIT', {
        overrideTraitDataBundle: {
          candidates: [
            {
              additionalDescription: 'Attacks ignore <@ba.vup>{def_penetrate_fixed}</> DEF',
              unlockCondition: { phase: 'PHASE_2', level: 60 },
              requiredPotentialRank: 0,
              blackboard: bb({ def_penetrate_fixed: 70 }),
            },
          ],
        },
      }),
      ...(lv > 1
        ? [
            part('TALENT_DATA_ONLY', {
              addOrOverrideTalentDataBundle: {
                candidates: [
                  { name: 'Blade Art', upgradeDescription: lv === 3 ? 'ATK +15%, DEF +15%, Physical dodge +18%' : 'ATK +11%', requiredPotentialRank: 0, blackboard: [] },
                  { name: 'Blade Art', upgradeDescription: 'ATK +16% <@ba.talpu>(+1%)</>', requiredPotentialRank: 4, blackboard: [] },
                ],
              },
            }),
          ]
        : []),
    ],
  })),
}

describe('module effects', () => {
  test('fills templates and strips tags', () => {
    expect(fillTemplate('Deals <@ba.vup>{value:0%}</> more damage', bb({ value: 0.1 }))).toBe('Deals 10% more damage')
    expect(fillTemplate('Cost {cost:0}, {missing}', bb({ cost: -2 }))).toBe('Cost -2, {missing}')
  })
  test('parses trait, stats and the stage 3 talent at potential 1', () => {
    const m = parseModule(chenY)!
    expect(m.trait).toEqual({ kind: 'add', text: 'Attacks ignore 70 DEF' })
    expect(m.unlock).toBe('Elite 2, Lv. 60')
    expect(m.talents).toEqual([{ name: 'Blade Art', text: 'ATK +15%, DEF +15%, Physical dodge +18%' }])
    expect(statLine(m.stats)).toBe('ATK +52 → +85 · DEF +28 → +42')
  })
  test('no battle data', () => expect(parseModule(undefined)).toBeNull())
  test('ratings in words', () => {
    expect(gradeWord('A+')).toBe('strong (A+)')
    expect(gradeWord('')).toBe('')
    expect(recLevel('LEVEL 1+')).toBe('stage 1 is the key step, higher stages are a smaller extra')
    expect(recLevel('LEVEL 3')).toBe('worth taking to stage 3')
    expect(recLevel('LEVEL 0')).toBe('not a priority to unlock')
  })
})
