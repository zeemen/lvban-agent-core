import { writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { startJourney } from '../../src/context/journey.js'
import { redis } from '../../src/db/redis.js'
import { registerRoutes } from '../../src/http/routes.js'
import { ModelError } from '../../src/models/errors.js'
import { registerAdapter, visionAvailability } from '../../src/models/router.js'
import type { ModelAdapter } from '../../src/models/types.js'
import {
  decideVisionAnchor, recordVisionOutcome, visionHitRate,
} from '../../src/vision/anchor.js'
import { createUser, pool, teardown } from '../helpers/db.js'

/**
 * 视觉锚点与命中率熔断 —— 规格 02 §4。
 * 企划书硬要求：命中率低于八成就把「拍一下」改成「问一句」为主。
 * 这里验证它是运行时开关，而不是一次性的开发期决策。
 */

/*
 * 命中率窗口 vision:outcomes 是一个全局键，Redis 不随测试文件隔离，
 * 所以凡是会写这个键的用例都放在本文件里——换句话说，调
 * /v1/vision/anchor/outcome 的用例不要散到别处去（§4.3 是本文件的题）。
 */

let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  registerRoutes(app)
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await teardown()
})

const CANDIDATES = [
  { exhibitId: 'njm_cuojinyin_hu', name: '错金银重络铜壶' },
  { exhibitId: 'njm_zhulin_qixian', name: '竹林七贤与荣启期砖画' },
]

/** 覆盖同名的 mock 适配器，用来控制置信度 */
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

beforeEach(async () => {
  await redis.del('vision:outcomes')
})

describe('三档决策 —— 规格 02 §4.1', () => {
  test('置信度 ≥ 0.75 直接采纳，但仍提供纠正入口', async () => {
    withConfidence(0.9)

    const result = await decideVisionAnchor({ imageKey: 'k1', candidates: CANDIDATES })

    expect(result.decision).toBe('auto_accept')
    expect(result.correctionToken).toBe('k1')
  })

  test('置信度在 0.45–0.75 之间时让用户点选', async () => {
    withConfidence(0.6)

    const result = await decideVisionAnchor({ imageKey: 'k2', candidates: CANDIDATES })

    expect(result.decision).toBe('ask_user_pick')
  })

  test('置信度低于 0.45 降级为「问一句」', async () => {
    withConfidence(0.2)

    const result = await decideVisionAnchor({ imageKey: 'k3', candidates: CANDIDATES })

    expect(result.decision).toBe('fallback_ask')
  })

  test('候选集为空时直接降级，不做开放域识别', async () => {
    withConfidence(0.9)

    const result = await decideVisionAnchor({ imageKey: 'k4', candidates: [] })

    expect(result.decision).toBe('fallback_ask')
    expect(result.candidates).toEqual([])
  })
})

describe('命中率熔断 —— 规格 02 §4.3', () => {
  test('无样本时不报命中率，也不熔断', async () => {
    const report = await visionHitRate()

    expect(report.samples).toBe(0)
    expect(report.hitRate).toBeNull()
    expect(report.fallbackActive).toBe(false)
  })

  test('命中率按「1 − 用户纠正率」计算，不看模型自评分', async () => {
    // 10 次识别中 3 次被用户纠正
    for (let i = 0; i < 7; i += 1) await recordVisionOutcome(false)
    for (let i = 0; i < 3; i += 1) await recordVisionOutcome(true)

    const report = await visionHitRate()

    expect(report.samples).toBe(10)
    expect(report.hitRate).toBeCloseTo(0.7, 2)
  })

  test('样本不足 20 条时不熔断，避免冷启动误判', async () => {
    for (let i = 0; i < 10; i += 1) await recordVisionOutcome(true)

    const report = await visionHitRate()

    expect(report.hitRate).toBe(0)
    expect(report.fallbackActive).toBe(false)
  })

  test('样本足够且命中率跌破 0.8 时熔断生效', async () => {
    for (let i = 0; i < 15; i += 1) await recordVisionOutcome(false)
    for (let i = 0; i < 10; i += 1) await recordVisionOutcome(true)

    const report = await visionHitRate()

    expect(report.hitRate).toBeCloseTo(0.6, 2)
    expect(report.fallbackActive).toBe(true)
  })

  test('命中率达标时不熔断', async () => {
    for (let i = 0; i < 24; i += 1) await recordVisionOutcome(false)
    await recordVisionOutcome(true)

    const report = await visionHitRate()

    expect(report.hitRate).toBeCloseTo(0.96, 2)
    expect(report.fallbackActive).toBe(false)
  })

  test('熔断状态会随识别结果一起返回，供前端切换主入口', async () => {
    for (let i = 0; i < 25; i += 1) await recordVisionOutcome(true)
    withConfidence(0.9)

    const result = await decideVisionAnchor({ imageKey: 'k5', candidates: CANDIDATES })

    expect(result.fallbackActive).toBe(true)
  })

  test('滚动窗口只保留最近 200 条', async () => {
    for (let i = 0; i < 210; i += 1) await recordVisionOutcome(false)

    const report = await visionHitRate()

    expect(report.samples).toBe(200)
  })
})

describe('无可用 VLM 时的降级 —— 不能在用户按下快门后抛错', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('视觉模型配成 deepseek-v4-pro（不吃图片）时降级到「问一句」', async () => {
    vi.stubEnv('MODEL_PROVIDER', 'deepseek')
    vi.stubEnv('MODEL_ID_VISION', 'deepseek-v4-pro')
    // 给假 Key 以隔离变量：这里要测的是「模型不吃图片」，不是「缺 Key」
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-fake-for-availability-check')

    const result = await decideVisionAnchor({ imageKey: 'k', candidates: CANDIDATES })

    expect(result.decision).toBe('fallback_ask')
    expect(result.fallbackActive).toBe(true)
    expect(result.fallbackReason).toContain('deepseek-flash')
  })

  test('换成 deepseek-flash 后视觉链路判定为可用', () => {
    vi.stubEnv('MODEL_PROVIDER', 'deepseek')
    vi.stubEnv('MODEL_ID_VISION', 'deepseek-flash')
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-fake-for-availability-check')

    const verdict = visionAvailability()

    expect(verdict).toEqual({ available: true, modelId: 'deepseek-flash', certain: true })
  })

  test('文本走 DeepSeek、视觉单独走通义千问的混搭配置被认可', () => {
    vi.stubEnv('MODEL_PROVIDER', 'deepseek')
    vi.stubEnv('MODEL_PROVIDER_VISION', 'dashscope')
    vi.stubEnv('MODEL_ID_VISION', 'qwen-vl-max')
    vi.stubEnv('DASHSCOPE_API_KEY', 'sk-fake-for-availability-check')

    const verdict = visionAvailability()

    expect(verdict).toEqual({ available: true, modelId: 'qwen-vl-max', certain: true })
  })

  test('配了供应商但没有 Key 时也要提前降级，而不是调用时抛错', async () => {
    vi.stubEnv('MODEL_PROVIDER', 'dashscope')
    vi.stubEnv('MODEL_ID_VISION', 'qwen-vl-max')
    vi.stubEnv('DASHSCOPE_API_KEY', '')
    vi.stubEnv('MODEL_API_KEY', '')

    const result = await decideVisionAnchor({ imageKey: 'k', candidates: CANDIDATES })

    expect(result.decision).toBe('fallback_ask')
    expect(result.fallbackActive).toBe(true)
    expect(result.fallbackReason).toContain('DASHSCOPE_API_KEY')
  })

  test('降级原因会被带出来，供运营后台排查', async () => {
    vi.stubEnv('MODEL_PROVIDER', 'ark')
    vi.stubEnv('MODEL_ID_VISION', '')
    vi.stubEnv('ARK_API_KEY', 'sk-fake-for-availability-check')

    const result = await decideVisionAnchor({ imageKey: 'k', candidates: CANDIDATES })

    expect(result.decision).toBe('fallback_ask')
    expect(result.fallbackReason).toContain('MODEL_ID_VISION')
  })
})

describe('纠正回执同时修落位 —— 规格 02 §4.1 ②「结果允许纠正」', () => {
  const HU = 'njm_cuojinyin_hu'
  const ZHUANHUA = 'njm_zhulin_qixian'

  const anchoredJourney = async (): Promise<{
    journeyId: string; locationEventId: string
  }> => {
    withConfidence(0.9)
    const userId = await createUser()
    const journey = await startJourney({
      userId, mode: 'light_guide', party: 'solo',
      sceneId: 'nanjing_museum', trackConsent: 'visited_points_only',
    })
    const res = await app.inject({
      method: 'POST', url: '/v1/vision/anchor',
      payload: { imageKey: 'oc', journeyId: journey.id, zoneHint: 'nanjing_museum' },
    })
    const { locationEventId } = JSON.parse(res.payload) as { locationEventId: string }
    return { journeyId: journey.id, locationEventId }
  }

  const eventsOf = async (journeyId: string): Promise<readonly {
    source: string; exhibit_id: string | null
  }[]> => {
    const { rows } = await pool.query<{ source: string; exhibit_id: string | null }>(
      `SELECT source, exhibit_id FROM location_event
        WHERE journey_id = $1 ORDER BY occurred_at, id`,
      [journeyId],
    )
    return rows
  }

  test('纠正时撤回认错的那条，并落上游客选的那件', async () => {
    const { journeyId, locationEventId } = await anchoredJourney()
    expect((await eventsOf(journeyId))[0]?.exhibit_id).toBe(HU)

    const res = await app.inject({
      method: 'POST', url: '/v1/vision/anchor/outcome',
      payload: { corrected: true, journeyId, locationEventId, exhibitId: ZHUANHUA },
    })

    expect(res.statusCode).toBe(200)
    const events = await eventsOf(journeyId)
    expect(events).toHaveLength(1)
    expect(events[0]?.source).toBe('user_confirmed')
    expect(events[0]?.exhibit_id).toBe(ZHUANHUA)
  })

  test('没纠正时落位留着不动，只记一条命中率样本', async () => {
    const { journeyId, locationEventId } = await anchoredJourney()

    const res = await app.inject({
      method: 'POST', url: '/v1/vision/anchor/outcome',
      payload: { corrected: false, journeyId, locationEventId },
    })

    expect((JSON.parse(res.payload) as { samples: number }).samples).toBe(1)
    const events = await eventsOf(journeyId)
    expect(events).toHaveLength(1)
    expect(events[0]?.source).toBe('vision_anchor')
  })

  test('只报命中率、不带旅程的用法仍然可用：熔断统计不该因为缺旅程就记不上', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/vision/anchor/outcome',
      payload: { corrected: true },
    })

    expect(res.statusCode).toBe(200)
    expect((JSON.parse(res.payload) as { samples: number }).samples).toBe(1)
  })
})

describe('点选落位 —— ask_user_pick 之后从候选里选一件（§4.1 ②）', () => {
  test('点选与 corrected 无关：系统本来没敢认，这不叫纠正，但一样要落位', async () => {
    withConfidence(0.6)
    const userId = await createUser()
    const journey = await startJourney({
      userId, mode: 'light_guide', party: 'solo',
      sceneId: 'nanjing_museum', trackConsent: 'visited_points_only',
    })
    const anchored = await app.inject({
      method: 'POST', url: '/v1/vision/anchor',
      payload: { imageKey: 'pick', journeyId: journey.id, zoneHint: 'nanjing_museum' },
    })
    const body = JSON.parse(anchored.payload) as {
      decision: string; locationEventId: string | null
    }
    expect(body.decision).toBe('ask_user_pick')
    expect(body.locationEventId).toBeNull()

    await app.inject({
      method: 'POST', url: '/v1/vision/anchor/outcome',
      payload: { corrected: false, journeyId: journey.id, exhibitId: 'njm_zhulin_qixian' },
    })

    const { rows } = await pool.query<{ source: string; exhibit_id: string | null }>(
      'SELECT source, exhibit_id FROM location_event WHERE journey_id = $1',
      [journey.id],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.source).toBe('user_confirmed')
    expect(rows[0]?.exhibit_id).toBe('njm_zhulin_qixian')
  })
})

describe('图片用不了是客户端的问题 —— 不该回 500', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  /** 真适配器：toImageUrl 在发请求之前跑，所以这组用例不打网络 */
  const withRealVision = (): void => {
    vi.stubEnv('MODEL_PROVIDER', 'deepseek')
    vi.stubEnv('MODEL_ID_VISION', 'deepseek-flash')
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-fake-for-availability-check')
  }

  test('读不到图时分类成 invalid_input，而不是「我们的请求不对」', async () => {
    withRealVision()

    const error = await decideVisionAnchor({
      imageKey: 'no-such-file.jpg', candidates: CANDIDATES,
    }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ModelError)
    expect((error as ModelError).kind).toBe('invalid_input')
  })

  test('图片超过 300KB 上限同样算客户端问题（§4.2 要求前端先压）', async () => {
    withRealVision()
    const fat = join(tmpdir(), `lvban-fat-${Date.now()}.jpg`)
    await writeFile(fat, Buffer.alloc(400 * 1024, 1))

    const error = await decideVisionAnchor({
      imageKey: fat, candidates: CANDIDATES,
    }).catch((e: unknown) => e)
    await rm(fat, { force: true })

    expect((error as ModelError).kind).toBe('invalid_input')
    expect((error as ModelError).message).toContain('300KB')
  })

  test('路由把它回成 400 并说清是 imageKey 的事，不是服务端崩了', async () => {
    withRealVision()
    const userId = await createUser()
    const journey = await startJourney({
      userId, mode: 'light_guide', party: 'solo',
      sceneId: 'nanjing_museum', trackConsent: 'visited_points_only',
    })

    const res = await app.inject({
      method: 'POST', url: '/v1/vision/anchor',
      payload: { imageKey: 'no-such-file.jpg', journeyId: journey.id, zoneHint: 'nanjing_museum' },
    })

    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.payload) as { error: string; message?: string }
    expect(body.error).toBe('bad_request')
    expect(body.message).toContain('imageKey')
  })

  test('读不到图时什么都不落位：认不出来就是认不出来', async () => {
    withRealVision()
    const userId = await createUser()
    const journey = await startJourney({
      userId, mode: 'light_guide', party: 'solo',
      sceneId: 'nanjing_museum', trackConsent: 'visited_points_only',
    })

    await app.inject({
      method: 'POST', url: '/v1/vision/anchor',
      payload: { imageKey: 'no-such-file.jpg', journeyId: journey.id, zoneHint: 'nanjing_museum' },
    })

    const { rows } = await pool.query(
      'SELECT 1 FROM location_event WHERE journey_id = $1', [journey.id],
    )
    expect(rows).toHaveLength(0)
  })
})
