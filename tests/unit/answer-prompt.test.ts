import { describe, expect, test } from 'vitest'
import { buildAnswerSystemPrompt } from '../../src/agent/prompt.js'
import type { ContextState } from '../../src/domain/context-state.js'
import type { PlanDecision } from '../../src/planner/decide.js'
import type { Passage } from '../../src/knowledge/weknora.js'

/** 自由问答的 system prompt —— K3 资料怎么进去，以及取不到时说什么 */

const ctx = {
  user: 'u1', journeyId: 'j1', mode: 'companion', ageBand: '25_plus',
  party: 'solo', memoryHooks: [], identity: [], preferences: {},
} as unknown as ContextState

const plan = { register: 'peer', maxChars: 120, maxTokens: 220 } as unknown as PlanDecision

const passage = (over: Partial<Passage> = {}): Passage => ({
  chunkId: 'c1', knowledgeId: 'k1', title: 'kb-gongyuan.md',
  text: '江南贡院始建于南宋乾道四年（1168年）。', score: 1, ...over,
})

describe('有 K3 资料时', () => {
  const prompt = buildAnswerSystemPrompt({
    ctx, plan, anchor: null, passages: [passage()],
  })

  test('资料正文和来源都进 prompt——没有来源就没法让它标出处', () => {
    expect(prompt).toContain('江南贡院始建于南宋乾道四年（1168年）。')
    expect(prompt).toContain('kb-gongyuan.md')
  })

  test('明说六类事实只能出自这些资料，不许自己补', () => {
    expect(prompt).toContain('年代')
    expect(prompt).toMatch(/只能来自|不得超出|不要超出/)
  })

  test('资料按给定顺序编号，便于它指名引用', () => {
    const two = buildAnswerSystemPrompt({
      ctx, plan, anchor: null,
      passages: [passage(), passage({ chunkId: 'c2', title: 'kb-wende.md', text: '文德桥在泮池西侧。' })],
    })
    expect(two.indexOf('kb-gongyuan.md')).toBeLessThan(two.indexOf('kb-wende.md'))
  })
})

describe('没有 K3 资料时', () => {
  const prompt = buildAnswerSystemPrompt({ ctx, plan, anchor: null, passages: [] })

  test('不留空的资料区，省得它对着空白编', () => {
    expect(prompt).not.toContain('【可引用的资料】')
  })

  test('照样守着「没把握就说不确定」', () => {
    expect(prompt).toContain('不确定')
  })
})

describe('向后兼容', () => {
  test('不传 passages 等同于没检索到，不崩', () => {
    expect(() => buildAnswerSystemPrompt({ ctx, plan, anchor: null })).not.toThrow()
  })
})
