import { afterAll, describe, expect, test } from 'vitest'
import { onArrive, onQuestion } from '../../src/agent/respond.js'
import { ingestFixes } from '../../src/context/ingest.js'
import { endJourney, startJourney } from '../../src/context/journey.js'
import { distillJourney } from '../../src/memory/distill.js'
import { getMemoryHooks } from '../../src/memory/retrieval.js'
import * as repo from '../../src/memory/repo.js'
import { readLedger, resetLedger } from '../../src/models/router.js'
import { registerAdapter } from '../../src/models/router.js'
import { createMockAdapter } from '../../src/models/mock.js'
import type { ModelAdapter } from '../../src/models/types.js'
import { createUser, teardown } from '../helpers/db.js'

/**
 * 端到端：Context → Decision → Skill → Response，以及「第二次使用时的分水岭」。
 * 对应规格 04 §3.4 与假设 H5。这是 M2 的验收用例。
 */

afterAll(teardown)

const GONGYUAN = { lat: 32.0211, lng: 118.7905 }
const POI = 'fzm_jiangnan_gongyuan'

const openAndArrive = async (userId: string) => {
  const journey = await startJourney({
    userId, mode: 'companion', party: 'solo',
    sceneId: 'fuzimiao', trackConsent: 'visited_points_only',
  })
  const t0 = new Date()
  await ingestFixes({
    journeyId: journey.id,
    fixes: [
      { ...GONGYUAN, accuracyM: 12, at: t0, speedMps: 0.4 },
      { ...GONGYUAN, accuracyM: 14, at: new Date(t0.getTime() + 25_000), speedMps: 0.3 },
    ],
  })
  return journey
}

describe('采集 → 围栏 → 位置事件', () => {
  test('两次合格定位在江南贡院产生 arrive 事件', async () => {
    const userId = await createUser()

    const journey = await startJourney({
      userId, mode: 'companion', party: 'solo',
      sceneId: 'fuzimiao', trackConsent: 'visited_points_only',
    })
    const t0 = new Date()
    const result = await ingestFixes({
      journeyId: journey.id,
      fixes: [
        { ...GONGYUAN, accuracyM: 12, at: t0, speedMps: 0.4 },
        { ...GONGYUAN, accuracyM: 14, at: new Date(t0.getTime() + 25_000), speedMps: 0.3 },
      ],
    })

    expect(result.accepted).toBe(2)
    expect(result.events).toEqual([{ poiId: POI, kind: 'arrive' }])
  })

  test('精度过低的定位被丢弃并说明原因', async () => {
    const userId = await createUser()
    const journey = await startJourney({
      userId, mode: 'companion', party: 'solo',
      sceneId: 'fuzimiao', trackConsent: 'visited_points_only',
    })

    const result = await ingestFixes({
      journeyId: journey.id,
      fixes: [{ ...GONGYUAN, accuracyM: 80, at: new Date() }],
    })

    expect(result.accepted).toBe(0)
    expect(result.dropped).toBe(1)
    expect(result.dropReasons).toContain('accuracy_too_low')
  })
})

describe('到达即讲解', () => {
  test('首访时以提问开场，且零模型调用（走缓存锚点内容）', async () => {
    resetLedger()
    const userId = await createUser()
    const journey = await openAndArrive(userId)

    const turn = await onArrive({ journeyId: journey.id, poiId: POI })

    expect(turn.spoke).toBe(true)
    expect(turn.plan?.openWith).toBe('question')
    expect(turn.context.memoryHooks).toHaveLength(0)
    expect(turn.fromCache).toBe(true)
    expect(readLedger().calls).toBe(0)
  })

  test('讲解内容不触发口吻守卫', async () => {
    const userId = await createUser()
    const journey = await openAndArrive(userId)

    const turn = await onArrive({ journeyId: journey.id, poiId: POI })

    expect(turn.guardViolations).toEqual([])
  })

  test('安全敏感场景下保持安静，内容让位于安全', async () => {
    const userId = await createUser()
    const journey = await openAndArrive(userId)

    const turn = await onArrive({
      journeyId: journey.id, poiId: POI, safetySensitive: true,
    })

    expect(turn.spoke).toBe(false)
    expect(turn.vetoedBy).toBe('safety_first')
  })

  test('刚讲过 60 秒内不再主动开口', async () => {
    const userId = await createUser()
    const journey = await openAndArrive(userId)
    await onArrive({ journeyId: journey.id, poiId: POI })

    const second = await onArrive({ journeyId: journey.id, poiId: POI })

    expect(second.spoke).toBe(false)
    expect(second.vetoedBy).toBe('just_spoke')
  })

  test('agent 的讲解会带上证据引用', async () => {
    const userId = await createUser()
    const journey = await openAndArrive(userId)
    await onArrive({ journeyId: journey.id, poiId: POI })

    const { rows } = await import('../../src/db/pool.js').then((m) => m.pool.query<{
      evidence_refs: { reviewStatus: string }
    }>(
      `SELECT evidence_refs FROM interaction
        WHERE journey_id = $1 AND role = 'agent' LIMIT 1`,
      [journey.id],
    ))

    expect(rows[0]?.evidence_refs.reviewStatus).toBeDefined()
  })
})

describe('提问 → 记忆写入', () => {
  test('用户提问会写入 explicit 兴趣信号，并走 Model Router', async () => {
    resetLedger()
    const userId = await createUser()
    const journey = await openAndArrive(userId)

    const turn = await onQuestion({
      journeyId: journey.id, text: '古代人怎么考试啊', poiId: POI,
    })

    expect(turn.spoke).toBe(true)
    expect(readLedger().byTask.qa).toBe(1)
  })

  test('黑名单内容的提问被拒绝写入，agent 不回应', async () => {
    const userId = await createUser()
    const journey = await openAndArrive(userId)

    const turn = await onQuestion({
      journeyId: journey.id, text: '我有高血压能走多久', poiId: POI,
    })

    expect(turn.spoke).toBe(false)
    expect(turn.vetoedBy).toBe('blocked_category')
  })
})

describe('第二次使用的分水岭 —— H5', () => {
  test('同一点位第二次到访改用记忆开场，且不重复主讲解', async () => {
    const userId = await createUser()

    // 第一次：到达 + 两次关于科举的提问 → 蒸馏出偏好
    const first = await openAndArrive(userId)
    const firstTurn = await onArrive({ journeyId: first.id, poiId: POI })
    await onQuestion({ journeyId: first.id, text: '古代人怎么考试啊', poiId: POI })
    await onQuestion({ journeyId: first.id, text: '考不上怎么办', poiId: POI })
    await endJourney(first.id)
    const report = await distillJourney(first.id)

    // 第一次的产出
    expect(firstTurn.plan?.openWith).toBe('question')
    expect(report.preferencesCreated).toBe(1)
    expect(report.footprints).toBe(1)

    // 第二次：同一点位
    const second = await openAndArrive(userId)
    const secondTurn = await onArrive({ journeyId: second.id, poiId: POI })

    // 关键断言：讲法变了
    expect(secondTurn.plan?.openWith).toBe('memory_link')
    expect(secondTurn.context.memoryHooks.length).toBeGreaterThan(0)
    expect(secondTurn.plan?.skipMainExplanation).toBe(true)
    expect(secondTurn.text).not.toBe(firstTurn.text)
    expect(secondTurn.proactivityReason).toContain('memory_hook_match')
    // 跨旅程「已听过」生效：第二次不再被判成首访
    expect(secondTurn.proactivityReason).not.toContain('first_visit')
  })

  test('记忆线索带证据，可回答「为什么这样推荐」', async () => {
    const userId = await createUser()
    const journey = await openAndArrive(userId)
    await onArrive({ journeyId: journey.id, poiId: POI })
    await onQuestion({ journeyId: journey.id, text: '古代人怎么考试', poiId: POI })
    await onQuestion({ journeyId: journey.id, text: '考不上怎么办', poiId: POI })
    await endJourney(journey.id)
    await distillJourney(journey.id)

    const hooks = await getMemoryHooks({
      userId, currentPlace: POI, currentCity: '南京', topic: '科举',
    })

    expect(hooks.hooks.length).toBeGreaterThan(0)
    expect(hooks.hooks[0]?.evidence).toBeDefined()
    expect(hooks.tokenEstimate).toBeLessThanOrEqual(600)
  })

  test('行中检索不超过 6 条线索的预算', async () => {
    const userId = await createUser()
    for (let i = 0; i < 4; i += 1) {
      const journey = await openAndArrive(userId)
      await onQuestion({ journeyId: journey.id, text: '这里讲讲科举', poiId: POI })
      await onQuestion({ journeyId: journey.id, text: '再讲讲制度', poiId: POI })
      await endJourney(journey.id)
      await distillJourney(journey.id)
    }

    const hooks = await getMemoryHooks({ userId, currentPlace: POI, currentCity: '南京' })

    expect(hooks.hooks.length).toBeLessThanOrEqual(6)
  })

  test('足迹记录的提问数与实际提问数一致', async () => {
    const userId = await createUser()
    const journey = await openAndArrive(userId)
    await onQuestion({ journeyId: journey.id, text: '古代人怎么考试', poiId: POI })
    await onQuestion({ journeyId: journey.id, text: '考不上怎么办', poiId: POI })
    await endJourney(journey.id)
    await distillJourney(journey.id)

    const footprints = await repo.listFootprints(userId, 5)

    expect(footprints[0]?.question_count).toBe(2)
  })
})

describe('口吻守卫触发重写 —— 规格 03 §9.1「命中即打回重写」', () => {
  /** 按调用次数依次返回预设文本的适配器 */
  const scriptedAdapter = (replies: readonly string[]): ModelAdapter => {
    let call = 0
    return {
      name: 'mock',
      async complete(request) {
        const text = replies[Math.min(call, replies.length - 1)] ?? ''
        call += 1
        return {
          text, provider: 'mock', task: request.task, latencyMs: 1,
          tokensIn: 10, tokensOut: 20, reasoningTokens: 0, costCny: 0, cached: false,
        }
      },
      async *stream(request) {
        const text = replies[Math.min(call, replies.length - 1)] ?? ''
        call += 1
        yield { type: 'delta' as const, text }
        yield {
          type: 'done' as const,
          tokensIn: 10, tokensOut: 20, reasoningTokens: 0,
        }
        void request
      },
      async recognize() {
        return { candidates: [], provider: 'mock', latencyMs: 1, costCny: 0 }
      },
    }
  }

  afterAll(() => {
    // 把共享的 mock 适配器还原，避免污染同文件的其他用例
    registerAdapter(createMockAdapter())
  })

  test('连说三句事实会被打回重写一次，并采用重写结果', async () => {
    const dump = '号舍有两块木板。考试持续九天。监考在明远楼。'
    const good = '号舍有两块木板，你张开手臂就知道有多窄。'
    registerAdapter(scriptedAdapter([dump, good]))
    const userId = await createUser()
    const journey = await openAndArrive(userId)

    const turn = await onQuestion({
      journeyId: journey.id, text: '号舍多大', poiId: POI,
    })

    expect(turn.text).toBe(good)
    expect(turn.usedElements).toContain('model:qa:rewrite')
    expect(turn.guardViolations).toEqual([])
  })

  test('一次通过时不触发重写，不浪费一次调用', async () => {
    registerAdapter(scriptedAdapter(['号舍有两块木板，你张开手臂就知道有多窄。']))
    const userId = await createUser()
    const journey = await openAndArrive(userId)

    const turn = await onQuestion({
      journeyId: journey.id, text: '号舍多大', poiId: POI,
    })

    expect(turn.usedElements).toEqual(['model:qa'])
  })

  test('重写后仍然命中时带着记录输出，不无限重试', async () => {
    const dump = '号舍有两块木板。考试持续九天。监考在明远楼。'
    registerAdapter(scriptedAdapter([dump, dump]))
    const userId = await createUser()
    const journey = await openAndArrive(userId)

    const turn = await onQuestion({
      journeyId: journey.id, text: '号舍多大', poiId: POI,
    })

    expect(turn.spoke).toBe(true)
    expect(turn.guardViolations.length).toBeGreaterThan(0)
    expect(turn.usedElements).toContain('model:qa:rewrite')
  })
})
