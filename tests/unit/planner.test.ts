import { describe, expect, test } from 'vitest'
import type { Anchor } from '../../src/content/loader.js'
import type { ContextState } from '../../src/domain/context-state.js'
import { canAskFirst, decidePlan, type PlanDecision, type PlanInput } from '../../src/planner/decide.js'
import { checkRegister, hasHedgeMarker } from '../../src/planner/register-guard.js'
import { fillMemoryLink, renderFromAnchor } from '../../src/planner/render.js'

const ctx: ContextState = {
  user: 'u1', mode: 'companion', party: 'solo', ageBand: '19_24',
  scene: 'outdoor', sceneId: 'fuzimiao', location: 'fzm_jiangnan_gongyuan',
  locationSource: 'geofence', locationConfidence: 0.9,
  activity: 'still', isMoving: false, isDining: false, accuracyM: 10,
  currentTopic: '科举', interest: 'high', fatigue: 'low',
  dwellHereSec: 100, elapsedMin: 30, timeLeft: 60, timeOfDay: 'evening',
  nextGoal: null, routeRemaining: [], activeTask: null,
  memoryHooks: [], identityTraits: [], preferences: {}, visitedAnchors: [],
  lastSpokeSecAgo: 300, consecutiveIgnored: 0, userIsSpeaking: false,
  journeyId: 'j1', stateVersion: 1, computedAt: '2026-10-25T10:00:00Z',
}

const anchor: Anchor = {
  anchorId: 'a1', name: '号舍', sceneId: 'fuzimiao', poiId: 'p1',
  isTop30: true, topics: ['科举'],
  review: { status: 'approved', reviewedBy: ['内容'], reviewedAt: '2026-10-01', factCheckRequired: [] },
  k1Sources: [{ title: '来源' }],
  elements: {
    openingHook: { companion: '这格子比你宿舍床还窄。', child: '你比划一下。', light: '这里是号舍。' },
    observation: { companion: '看一下进深。', child: '数一数木板。', light: null },
    question: { companion: '想不想知道落榜的人怎么办？', child: '你会带哪三样东西？', light: null },
    explanation: { companion: '号舍是答卷与起居的全部空间。', child: '白天是桌子晚上是床。', light: '号舍为考生答卷空间。' },
    story: '入场要经过搜检——有点像今天进考场交手机。',
    connection: { curriculum: { stage: '初中语文', ref: '某篇' }, presentDay: '你刚才说期末周没出图书馆。' },
    memoryLink: { template: '你上次在{place}问过{topic}，今天正好到了{here}。' },
    nextAction: { suggest: 'p2', reason: '顺着讲' },
  },
}

const input = (patch: Partial<PlanInput> = {}): PlanInput => ({
  context: ctx, anchor, trigger: { kind: 'geofence_arrive' }, heardBefore: [], ...patch,
})

describe('decidePlan —— 规格 03 §3.3', () => {
  test('口吻档位由模式决定', () => {
    expect(decidePlan(input()).register).toBe('peer')
    expect(decidePlan(input({ context: { ...ctx, mode: 'family_study' } })).register).toBe('storyteller')
    expect(decidePlan(input({ context: { ...ctx, mode: 'light_guide' } })).register).toBe('concise')
  })

  test('高兴趣 + 首访 → 长讲解并留悬念', () => {
    const plan = decidePlan(input())

    expect(plan.length).toBe('long')
    expect(plan.leaveHook).toBe(true)
  })

  test('高疲劳 → 短讲解、不留悬念、建议休息', () => {
    const plan = decidePlan(input({ context: { ...ctx, fatigue: 'high' } }))

    expect(plan.length).toBe('short')
    expect(plan.leaveHook).toBe(false)
    expect(plan.nextAction).toBe('suggest_rest')
  })

  test('记忆开场优先于提问开场', () => {
    const plan = decidePlan(input({
      context: { ...ctx, memoryHooks: ['南京·拙政园·借景'] },
    }))

    expect(plan.openWith).toBe('memory_link')
    expect(plan.linkMemory).toBe('南京·拙政园·借景')
  })

  test('已听过本锚点时不再重复主讲解', () => {
    const plan = decidePlan(input({ heardBefore: ['a1'] }))

    expect(plan.skipMainExplanation).toBe(true)
    expect(plan.reason).toContain('heard_before')
  })

  test('轻导览模式短讲、事实开场、不留悬念', () => {
    const plan = decidePlan(input({ context: { ...ctx, mode: 'light_guide' } }))

    expect(plan.length).toBe('short')
    expect(plan.openWith).toBe('fact')
    expect(plan.leaveHook).toBe(false)
  })

  test('课标连接只对初中段开启', () => {
    expect(decidePlan(input({ context: { ...ctx, ageBand: '12_15' } })).linkCurriculum).toBe(true)
    expect(decidePlan(input()).linkCurriculum).toBe(false)
  })

  test('低龄段恒定使用故事', () => {
    expect(decidePlan(input({ context: { ...ctx, ageBand: 'under_12' } })).useStory).toBe(true)
  })

  test('maxTokens 随年龄段收紧', () => {
    const young = decidePlan(input({ context: { ...ctx, ageBand: 'under_12' } }))
    const adult = decidePlan(input())

    expect(young.maxTokens).toBeLessThan(adult.maxTokens)
  })
})

describe('canAskFirst —— 规格 03 §3.4 反问边界', () => {
  test('方位类问题直接答，不反问', () => {
    expect(canAskFirst(
      input({ trigger: { kind: 'user_question', text: '洗手间在哪' } }), 0,
    )).toBe(false)
  })

  test('连续反问两次后不再反问', () => {
    expect(canAskFirst(input(), 2)).toBe(false)
  })

  test('高疲劳时不反问', () => {
    expect(canAskFirst(input({ context: { ...ctx, fatigue: 'high' } }), 0)).toBe(false)
  })

  test('正常观察类问题可以先反问', () => {
    expect(canAskFirst(input({
      trigger: { kind: 'user_question', text: '这个金丝怎么嵌进去的' },
    }), 0)).toBe(true)
  })
})

describe('fillMemoryLink', () => {
  test('槽位齐全时正常填充', () => {
    const filled = fillMemoryLink(
      '你上次在{place}问过{topic}，今天正好到了{here}。', '苏州·拙政园·借景', '秦淮河',
    )

    expect(filled).toBe('你上次在拙政园问过借景，今天正好到了秦淮河。')
  })

  test('hook 缺少主题导致槽位填不满时返回 null，不输出残句', () => {
    expect(fillMemoryLink('在{place}问过{topic}', '苏州', '此处')).toBeNull()
  })

  test('槽位填不满时返回 null', () => {
    expect(fillMemoryLink('{place}·{topic}·{missing}', '苏州·拙政园·借景', '此处')).toBeNull()
  })
})

describe('renderFromAnchor', () => {
  const plan = (patch: Partial<PlanDecision> = {}): PlanDecision => ({
    shouldSpeak: true, length: 'long', register: 'peer', openWith: 'question',
    useStory: false, linkCurriculum: false, linkMemory: null, leaveHook: true,
    skipMainExplanation: false, nextAction: null, evidenceRequired: [],
    maxTokens: 220, maxChars: 220, reason: 'test', ...patch,
  })

  test('提问开场按「悬念 → 提问 → 解释」顺序组装', () => {
    const rendered = renderFromAnchor(anchor, plan())

    expect(rendered.usedElements).toEqual(['openingHook', 'question', 'explanation', 'presentDay'])
    expect(rendered.fromCache).toBe(true)
  })

  test('短讲只保留一段', () => {
    const rendered = renderFromAnchor(anchor, plan({ length: 'short' }))

    expect(rendered.segments).toHaveLength(1)
  })

  test('重访时改用故事与当下连接，不重复主讲解', () => {
    const rendered = renderFromAnchor(anchor, plan({
      openWith: 'memory_link', linkMemory: '南京·某地·科举', skipMainExplanation: true,
    }))

    expect(rendered.usedElements).not.toContain('explanation')
    expect(rendered.usedElements).toContain('story')
  })

  test('记忆槽位填不满时退回提问开场，而不是输出半句话', () => {
    const rendered = renderFromAnchor(anchor, plan({
      openWith: 'memory_link', linkMemory: '只有一段',
    }))

    expect(rendered.text).toContain('想不想知道')
  })

  test('轻导览口吻取 light 版本，没有 light 版本的要素被跳过', () => {
    const rendered = renderFromAnchor(anchor, plan({
      register: 'concise', openWith: 'fact', length: 'short',
    }))

    expect(rendered.text).toBe('号舍为考生答卷空间。')
  })
})

describe('checkRegister —— 规格 03 §8.1', () => {
  test.each(['接下来', '下面为您介绍', '众所周知', '据史料记载'])(
    '拦住导览腔开场：%s', (opener) => {
      const result = checkRegister(`${opener}这件文物的年代。`, 'peer')

      expect(result.ok).toBe(false)
      expect(result.violations[0]?.rule).toBe('forbidden_opener')
    },
  )

  test.each(['同学', '小朋友', '各位游客', '欢迎来到'])(
    '同游口吻禁止讲课腔词汇：%s', (phrase) => {
      expect(checkRegister(`${phrase}，你猜这是什么？`, 'peer').ok).toBe(false)
    },
  )

  test('含糊其辞被拦住', () => {
    const result = checkRegister('这个可能是明代的吧。', 'peer')

    expect(result.ok).toBe(false)
    expect(result.violations[0]?.rule).toBe('vague_hedging')
  })

  test('连续三句事实被拦住', () => {
    const text = '号舍有两块木板。考试持续九天。监考在明远楼。'

    const result = checkRegister(text, 'peer')

    expect(result.violations.some((v) => v.rule === 'too_many_facts')).toBe(true)
  })

  test('比较句算把用户拉进来，不计入事实连击', () => {
    // 「这格子比你宿舍床还窄」是企划书第 05 节原文举例的好文案
    const text = '这格子比你宿舍床还窄。号舍有两块木板。考试持续九天。'

    expect(checkRegister(text, 'peer').ok).toBe(true)
  })

  test('第二人称记忆回溯同样不计入事实连击', () => {
    const text = '你上次在南博问过科举。号舍有两块木板。考试持续九天。'

    expect(checkRegister(text, 'peer').ok).toBe(true)
  })

  test.each([
    '这格子比你宿舍床还窄',
    '你在号舍里站一会儿就明白',
    '你刚才说期末周没出图书馆',
    '要问具体尺寸，你抬头看说明牌',
  ])('任何对用户开口的句子都不计入事实连击：%s', (engaging) => {
    // 这些都曾被枚举式词表误判成事实堆砌（真实模型输出里抓到的）
    const text = `号舍有两块木板。考试持续九天。${engaging}。监考在明远楼。`

    expect(checkRegister(text, 'peer').ok).toBe(true)
  })

  test('真正的连续事实堆砌仍然被拦住', () => {
    const text = '号舍有两块木板。考试持续九天。监考在明远楼。糊名由誊录官负责。'

    expect(checkRegister(text, 'peer').ok).toBe(false)
  })

  test('轻导览口吻不限制事实密度', () => {
    const text = '号舍有两块木板。考试持续九天。监考在明远楼。'

    expect(checkRegister(text, 'concise').ok).toBe(true)
  })

  test('hasHedgeMarker 识别学术解释标记', () => {
    expect(hasHedgeMarker('一种说法是先刻槽')).toBe(true)
    expect(hasHedgeMarker('先刻槽再嵌丝')).toBe(false)
  })
})
