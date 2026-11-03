import { describe, expect, test } from 'vitest'
import type { Anchor } from '../../src/content/loader.js'
import { buildSilentCard } from '../../src/planner/soft-hint.js'
import { anchorHookAudioKey, presynthPlan } from '../../src/tts/plan.js'

/**
 * 静默卡片 —— 规格 02 §7.1 的 SOFT_HINT 那一档「气泡/震动，不出声」。
 *
 * 卡片刻意**不生成新文案**：气泡上那一句就是锚点八要素里精调过的开场钩子。
 * 两个好处——锚点命中仍然零模型调用，而且 Top 30 的钩子已经预合成过，
 * 点一下就能出声、零延迟。
 */

const review: Anchor['review'] = {
  status: 'approved',
  reviewedBy: [
    { role: 'content_owner', account: 'owner@example.com' },
    { role: 'history_advisor', account: 'advisor@example.com' },
  ],
  reviewedAt: '2026-10-01',
  factCheckRequired: [],
}

const anchor = (patch: Partial<Anchor> = {}): Anchor => ({
  anchorId: 'a1', name: '号舍', sceneId: 'fuzimiao', poiId: 'p1',
  isTop30: true, topics: ['科举'],
  review,
  k1Sources: [{ title: '来源' }],
  elements: {
    openingHook: { companion: '这格子比你宿舍床还窄。', child: '你比划一下。', light: '这里是号舍。' },
    observation: { companion: '看一下进深。', child: '数一数木板。', light: null },
    question: { companion: '想不想知道落榜的人怎么办？', child: null, light: null },
    explanation: { companion: '号舍是答卷与起居的全部空间。', child: '白天是桌子晚上是床。', light: '号舍为考生答卷空间。' },
    story: null,
    connection: { curriculum: null, presentDay: null },
    memoryLink: { template: '你上次在{place}问过{topic}。' },
    nextAction: { suggest: null, reason: '' },
  },
  ...patch,
})

describe('buildSilentCard', () => {
  test.each([
    ['peer', '这格子比你宿舍床还窄。'],
    ['storyteller', '你比划一下。'],
    ['concise', '这里是号舍。'],
  ] as const)('%s 档取对应那条开场钩子', (register, expected) => {
    expect(buildSilentCard(anchor(), register)?.card.hint).toBe(expected)
  })

  test('带上锚点标识与名字：客户端要能点开它', () => {
    const built = buildSilentCard(anchor(), 'peer')
    expect(built?.card).toMatchObject({ anchorId: 'a1', name: '号舍' })
    expect(built?.element).toBe('openingHook')
  })

  test('Top 30 的卡片带 audioKey，而且与预合成清单里那条完全一致', () => {
    const a = anchor()
    const built = buildSilentCard(a, 'peer')
    const planned = presynthPlan([], new Map([[a.anchorId, a]]))
      .find((item) => item.label === 'a1/companion')

    expect(planned?.audioKey).toBeDefined()
    // 两边必须同源：各写一套命名规则，结果是点一下取到 404 而且不报错
    expect(built?.card.audioKey).toBe(planned?.audioKey)
    expect(built?.card.audioKey).toBe(anchorHookAudioKey('a1', 'peer'))
  })

  test('非 Top 30 不给 audioKey —— 预合成只覆盖 Top 30，给了就是指向一个 404', () => {
    expect(buildSilentCard(anchor({ isTop30: false }), 'peer')?.card.audioKey).toBeNull()
  })

  test.each([
    ['这档口吻没有钩子', null],
    ['钩子是空串', ''],
  ])('%s → 整张卡片为 null，不临时编一句', (_label, hook) => {
    const a = anchor()
    const withoutLight = {
      ...a,
      elements: { ...a.elements, openingHook: { ...a.elements.openingHook, light: hook } },
    }
    expect(buildSilentCard(withoutLight, 'concise')).toBeNull()
  })
})

describe('已听过就换一个侧面（规格 03 §3.3）', () => {
  test('重访优先用反问，而不是把开场钩子再推一遍', () => {
    const built = buildSilentCard(anchor(), 'peer', { heard: true })

    expect(built?.element).toBe('question')
    expect(built?.card.hint).toBe('想不想知道落榜的人怎么办？')
  })

  test('没有反问就退到观察提示', () => {
    // child 档这个夹具没写 question，只有 observation
    const built = buildSilentCard(anchor(), 'storyteller', { heard: true })

    expect(built?.element).toBe('observation')
    expect(built?.card.hint).toBe('数一数木板。')
  })

  test('两栏都空着才退回开场钩子 —— 有提示总比没提示好', () => {
    // light 档这个夹具 question 与 observation 都是 null
    const built = buildSilentCard(anchor(), 'concise', { heard: true })

    expect(built?.element).toBe('openingHook')
    expect(built?.card.hint).toBe('这里是号舍。')
  })

  test('换了栏就没有预合成音频 —— presynth 只覆盖开场钩子', () => {
    expect(buildSilentCard(anchor(), 'peer', { heard: true })?.card.audioKey).toBeNull()
    // 退回开场钩子的那条仍然有
    expect(buildSilentCard(anchor(), 'concise', { heard: true })?.card.audioKey)
      .toBe(anchorHookAudioKey('a1', 'concise'))
  })
})
