import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  readIndoorAttention, recordUserPick, recordVisionAnchor, retractVisionAnchor,
} from '../../src/context/attention.js'
import { startJourney } from '../../src/context/journey.js'
import { buildContextState } from '../../src/context/state.js'
import { registerRoutes } from '../../src/http/routes.js'
import { registerAdapter } from '../../src/models/router.js'
import type { ModelAdapter } from '../../src/models/types.js'
import { createUser, pool, teardown } from '../helpers/db.js'

/**
 * 室内注意力落位 —— 规格 02 §4.2 识别链路的最后一步「写 location_event」。
 *
 * 落位要成立，三件事都得对：写得进去、读得回来、认错了能撤。
 * 读不回来，下一句话还得让客户端重报一遍；撤不掉，语义足迹里会留下
 * 一件其实没看过的展品。
 *
 * 这里刻意不碰 /v1/vision/anchor/outcome：那条路由会往 vision:outcomes
 * 这个全局命中率窗口里写样本，而 Redis 不随测试文件隔离，两个文件并行
 * 跑就会互相污染计数。凡是写那个键的用例都归 vision.test.ts（§4.3 是它的题）。
 */

let app: FastifyInstance

const MUSEUM = 'nanjing_museum'
const HU = 'njm_cuojinyin_hu'
const ZHUANHUA = 'njm_zhulin_qixian'

/** 覆盖同名 mock 适配器，控制 VLM 的 top-1 分数 */
const withConfidence = (confidence: number): void => {
  const adapter: ModelAdapter = {
    name: 'mock',
    async complete() {
      return {
        text: '', provider: 'mock', task: 'qa' as const, latencyMs: 1,
        tokensIn: 0, tokensOut: 0, reasoningTokens: 0, costCny: 0, cached: false,
      }
    },
    async *stream() {
      yield { type: 'done' as const, tokensIn: 0, tokensOut: 0, reasoningTokens: 0 }
    },
    async recognize(request) {
      const first = request.candidates[0]
      return {
        candidates: first === undefined
          ? []
          : [{ exhibitId: first.exhibitId, name: first.name, confidence }],
        provider: 'mock', latencyMs: 1, costCny: 0,
      }
    },
  }
  registerAdapter(adapter)
}

const indoorJourney = async (): Promise<string> => {
  const userId = await createUser()
  const journey = await startJourney({
    userId, mode: 'light_guide', party: 'solo',
    sceneId: MUSEUM, trackConsent: 'visited_points_only',
  })
  return journey.id
}

const outdoorJourney = async (): Promise<string> => {
  const userId = await createUser()
  const journey = await startJourney({
    userId, mode: 'companion', party: 'solo',
    sceneId: 'fuzimiao', trackConsent: 'visited_points_only',
  })
  return journey.id
}

const ownerOf = async (journeyId: string): Promise<string> => {
  const { rows } = await pool.query<{ user_id: string }>(
    'SELECT user_id FROM journey WHERE id = $1', [journeyId],
  )
  const userId = rows[0]?.user_id
  if (userId === undefined) throw new Error('旅程不存在')
  return userId
}

const eventsOf = async (journeyId: string): Promise<readonly {
  id: string; kind: string; exhibit_id: string | null
  source: string; confidence: string | null
}[]> => {
  const { rows } = await pool.query<{
    id: string; kind: string; exhibit_id: string | null
    source: string; confidence: string | null
  }>(
    `SELECT id, kind, exhibit_id, source, confidence
       FROM location_event WHERE journey_id = $1 ORDER BY occurred_at, id`,
    [journeyId],
  )
  return rows
}

beforeAll(async () => {
  app = Fastify()
  registerRoutes(app)
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await teardown()
})

describe('写得进去 —— 规格 02 §4.2', () => {
  test('识别结果落成 vision_anchor 事件，置信度就是 VLM 的分', async () => {
    const journeyId = await indoorJourney()

    const id = await recordVisionAnchor({
      journeyId, userId: await ownerOf(journeyId),
      exhibitId: HU, confidence: 0.81,
    })

    expect(id).not.toBeNull()
    const events = await eventsOf(journeyId)
    expect(events).toHaveLength(1)
    expect(events[0]?.source).toBe('vision_anchor')
    expect(events[0]?.exhibit_id).toBe(HU)
    expect(Number(events[0]?.confidence)).toBeCloseTo(0.81, 2)
  })

  test('落的是 confirm_zone 而不是 arrive：室内没有「到达」这种事件', async () => {
    const journeyId = await indoorJourney()

    await recordVisionAnchor({
      journeyId, userId: await ownerOf(journeyId), exhibitId: HU, confidence: 0.9,
    })

    expect((await eventsOf(journeyId))[0]?.kind).toBe('confirm_zone')
  })

  test('游客点选落成 user_confirmed，置信度 1.0（§4.1 ①）', async () => {
    const journeyId = await indoorJourney()

    await recordUserPick({
      journeyId, userId: await ownerOf(journeyId), exhibitId: ZHUANHUA,
    })

    const events = await eventsOf(journeyId)
    expect(events[0]?.source).toBe('user_confirmed')
    expect(Number(events[0]?.confidence)).toBe(1)
  })

  test('旅程已结束时写入被网关挡住，不会偷偷记一笔', async () => {
    const journeyId = await indoorJourney()
    await pool.query("UPDATE journey SET state = 'ENDED' WHERE id = $1", [journeyId])

    const id = await recordVisionAnchor({
      journeyId, userId: await ownerOf(journeyId), exhibitId: HU, confidence: 0.9,
    })

    expect(id).toBeNull()
    expect(await eventsOf(journeyId)).toHaveLength(0)
  })

  test('旅程已结束时游客点选也写不进去：红线 2 对两种来源一样硬', async () => {
    const journeyId = await indoorJourney()
    await pool.query("UPDATE journey SET state = 'ENDED' WHERE id = $1", [journeyId])

    const id = await recordUserPick({
      journeyId, userId: await ownerOf(journeyId), exhibitId: HU,
    })

    expect(id).toBeNull()
    expect(await eventsOf(journeyId)).toHaveLength(0)
  })
})

describe('读得回来 —— 下一句话不用再报一遍', () => {
  test('落位后不带任何参数提问，Context 也知道在看哪件', async () => {
    const journeyId = await indoorJourney()
    await recordVisionAnchor({
      journeyId, userId: await ownerOf(journeyId), exhibitId: HU, confidence: 0.81,
    })

    const ctx = await buildContextState({ journeyId })

    expect(ctx.location).toBe(HU)
    expect(ctx.locationSource).toBe('vision_anchor')
    expect(ctx.locationConfidence).toBeCloseTo(0.81, 2)
  })

  test('视觉落位过了有效期就不再认，回到「不知道」', async () => {
    const journeyId = await indoorJourney()
    await recordVisionAnchor({
      journeyId, userId: await ownerOf(journeyId), exhibitId: HU, confidence: 0.81,
      occurredAt: new Date(Date.now() - 3600_000),
    })

    const ctx = await buildContextState({ journeyId })

    expect(ctx.location).toBeNull()
    expect(ctx.locationSource).toBe('none')
  })

  test('游客自己点的不过期：锁定直到他改（§4.1 ①）', async () => {
    const journeyId = await indoorJourney()
    await recordUserPick({
      journeyId, userId: await ownerOf(journeyId), exhibitId: HU,
      occurredAt: new Date(Date.now() - 3600_000),
    })

    const ctx = await buildContextState({ journeyId })

    expect(ctx.location).toBe(HU)
    expect(ctx.locationSource).toBe('user_confirmed')
    expect(ctx.locationConfidence).toBe(1)
  })

  test('最新一条是过期的识别时，不把更早的点选翻出来顶上', async () => {
    const journeyId = await indoorJourney()
    const userId = await ownerOf(journeyId)
    await recordUserPick({
      journeyId, userId, exhibitId: ZHUANHUA, occurredAt: new Date(Date.now() - 7200_000),
    })
    await recordVisionAnchor({
      journeyId, userId, exhibitId: HU, confidence: 0.8,
      occurredAt: new Date(Date.now() - 3600_000),
    })

    const ctx = await buildContextState({ journeyId })

    expect(ctx.location).toBeNull()
  })

  test('inferred 事件不参与落位：它的意思本来就是「不知道」', async () => {
    const journeyId = await indoorJourney()
    await pool.query(
      `INSERT INTO location_event
         (id, journey_id, user_id, kind, exhibit_id, source, confidence, occurred_at)
       VALUES (gen_random_uuid(), $1, $2, 'confirm_zone', $3, 'inferred', 0.5, now())`,
      [journeyId, await ownerOf(journeyId), HU],
    )

    expect(await readIndoorAttention(journeyId)).toBeNull()
  })

  test('客户端自报的来源优先：当下的动作比落位的历史新', async () => {
    const journeyId = await indoorJourney()
    await recordVisionAnchor({
      journeyId, userId: await ownerOf(journeyId), exhibitId: HU, confidence: 0.81,
    })

    const ctx = await buildContextState({
      journeyId, poiId: HU, locationSource: 'user_confirmed',
    })

    expect(ctx.locationSource).toBe('user_confirmed')
    expect(ctx.locationConfidence).toBe(1)
  })

  test('客户端带的是另一件时，不把落位的置信度套到它头上', async () => {
    const journeyId = await indoorJourney()
    await recordVisionAnchor({
      journeyId, userId: await ownerOf(journeyId), exhibitId: HU, confidence: 0.81,
    })

    const ctx = await buildContextState({ journeyId, poiId: ZHUANHUA })

    expect(ctx.location).toBe(ZHUANHUA)
    expect(ctx.locationSource).toBe('inferred')
    expect(ctx.locationConfidence).toBeLessThanOrEqual(0.6)
  })

  test('室外不读落位：那边的位置由围栏引擎说了算', async () => {
    const journeyId = await outdoorJourney()
    await recordUserPick({
      journeyId, userId: await ownerOf(journeyId), exhibitId: HU,
    })

    const ctx = await buildContextState({ journeyId })

    expect(ctx.location).toBeNull()
    expect(ctx.locationSource).toBe('none')
  })
})

describe('认错了能撤 —— 别让语义足迹留下没看过的展品', () => {
  test('撤回只删那一条识别记录', async () => {
    const journeyId = await indoorJourney()
    const id = await recordVisionAnchor({
      journeyId, userId: await ownerOf(journeyId), exhibitId: HU, confidence: 0.81,
    })

    expect(await retractVisionAnchor({ journeyId, locationEventId: id as string })).toBe(true)
    expect(await eventsOf(journeyId)).toHaveLength(0)
  })

  test('撤不掉游客自己点的：那不是系统猜的', async () => {
    const journeyId = await indoorJourney()
    const id = await recordUserPick({
      journeyId, userId: await ownerOf(journeyId), exhibitId: HU,
    })

    expect(await retractVisionAnchor({ journeyId, locationEventId: id as string })).toBe(false)
    expect(await eventsOf(journeyId)).toHaveLength(1)
  })

  test('撤不到别人旅程的事件', async () => {
    const mine = await indoorJourney()
    const theirs = await indoorJourney()
    const id = await recordVisionAnchor({
      journeyId: theirs, userId: await ownerOf(theirs), exhibitId: HU, confidence: 0.81,
    })

    expect(await retractVisionAnchor({ journeyId: mine, locationEventId: id as string }))
      .toBe(false)
    expect(await eventsOf(theirs)).toHaveLength(1)
  })
})

describe('路由接线 —— 规格 02 §8', () => {
  test('auto_accept 时顺手落位，并把事件 id 交回去供纠正', async () => {
    withConfidence(0.9)
    const journeyId = await indoorJourney()

    const res = await app.inject({
      method: 'POST', url: '/v1/vision/anchor',
      payload: { imageKey: 'k1', journeyId, zoneHint: MUSEUM },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as {
      decision: string; locationEventId: string | null
    }
    expect(body.decision).toBe('auto_accept')
    expect(body.locationEventId).not.toBeNull()
    expect(await eventsOf(journeyId)).toHaveLength(1)
  })

  test('ask_user_pick 不落位：还没定下来是哪件', async () => {
    withConfidence(0.6)
    const journeyId = await indoorJourney()

    const res = await app.inject({
      method: 'POST', url: '/v1/vision/anchor',
      payload: { imageKey: 'k2', journeyId, zoneHint: MUSEUM },
    })

    const body = JSON.parse(res.payload) as {
      decision: string; locationEventId: string | null
    }
    expect(body.decision).toBe('ask_user_pick')
    expect(body.locationEventId).toBeNull()
    expect(await eventsOf(journeyId)).toHaveLength(0)
  })

  test('fallback_ask 不落位', async () => {
    withConfidence(0.2)
    const journeyId = await indoorJourney()

    const res = await app.inject({
      method: 'POST', url: '/v1/vision/anchor',
      payload: { imageKey: 'k3', journeyId, zoneHint: MUSEUM },
    })

    expect((JSON.parse(res.payload) as { decision: string }).decision).toBe('fallback_ask')
    expect(await eventsOf(journeyId)).toHaveLength(0)
  })

  test('缺 journeyId 返回 400：没有旅程就没有采集（红线 2）', async () => {
    withConfidence(0.9)

    const res = await app.inject({
      method: 'POST', url: '/v1/vision/anchor',
      payload: { imageKey: 'k4', zoneHint: MUSEUM },
    })

    expect(res.statusCode).toBe(400)
  })

  test('撤回后 Context 不再说是那件认错的', async () => {
    withConfidence(0.9)
    const journeyId = await indoorJourney()
    const anchored = await app.inject({
      method: 'POST', url: '/v1/vision/anchor',
      payload: { imageKey: 'k5', journeyId, zoneHint: MUSEUM },
    })
    const { locationEventId } = JSON.parse(anchored.payload) as { locationEventId: string }

    await retractVisionAnchor({ journeyId, locationEventId })
    await recordUserPick({
      journeyId, userId: await ownerOf(journeyId), exhibitId: ZHUANHUA,
    })

    const ctx = await buildContextState({ journeyId })

    expect(ctx.location).toBe(ZHUANHUA)
    expect(ctx.locationSource).toBe('user_confirmed')
  })
})
