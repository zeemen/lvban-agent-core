import { describe, expect, test } from 'vitest'
import { loadFillers, pickFiller, type Filler } from '../../src/content/fillers.js'

/** 预置垫音 —— 盖住首字延迟那一秒。同一句反复出现会非常刺耳 */

const make = (id: string, register: Filler['register'] = 'peer'): Filler => ({
  id, register, situation: 'question', text: `文案 ${id}`, audioKey: `${id}.mp3`,
})

describe('loadFillers', () => {
  test('三种口吻的垫音都能加载，且文案都很短', async () => {
    const all = await loadFillers()

    const registers = new Set(all.map((f) => f.register))
    expect(registers).toEqual(new Set(['peer', 'storyteller', 'concise']))
    for (const filler of all) {
      expect(filler.text.length).toBeLessThanOrEqual(20)
      expect(filler.audioKey).not.toBe('')
    }
  })

  test('问答与拍照两种场景都有垫音', async () => {
    const all = await loadFillers()

    for (const register of ['peer', 'storyteller'] as const) {
      for (const situation of ['question', 'photo'] as const) {
        const hit = all.find((f) => f.register === register && f.situation === situation)
        expect(hit, `${register}/${situation} 缺垫音`).toBeDefined()
      }
    }
  })
})

describe('pickFiller', () => {
  const pool = [make('a'), make('b'), make('c')]

  test('只按口吻与场景匹配', () => {
    const picked = pickFiller([...pool, make('x', 'concise')], {
      register: 'concise', situation: 'question', random: () => 0,
    })

    expect(picked?.id).toBe('x')
  })

  test('排除上一次用过的那条', () => {
    for (let i = 0; i < 20; i += 1) {
      const picked = pickFiller(pool, {
        register: 'peer', situation: 'question', lastUsedId: 'a',
        random: () => i / 20,
      })

      expect(picked?.id).not.toBe('a')
    }
  })

  test('只剩一条可选时宁可重复，也不要沉默', () => {
    const single = [make('only')]

    const picked = pickFiller(single, {
      register: 'peer', situation: 'question', lastUsedId: 'only', random: () => 0,
    })

    expect(picked?.id).toBe('only')
  })

  test('没有匹配项时返回 null，由调用方决定直接开讲', () => {
    expect(pickFiller(pool, { register: 'peer', situation: 'arrive' })).toBeNull()
  })

  test('random 返回 1 时不越界', () => {
    const picked = pickFiller(pool, {
      register: 'peer', situation: 'question', random: () => 1,
    })

    expect(picked).not.toBeNull()
  })
})
