import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { registerRoutes } from '../../src/http/routes.js'
import { createUser, teardown } from '../helpers/db.js'

/** HTTP 接口冒烟 —— 这套接口就是 M3 小程序要接的那一套（规格 02 §8） */

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

const json = <T>(payload: string): T => JSON.parse(payload) as T

describe('健康检查', () => {
  test('返回模型账本，便于观察成本', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })

    expect(res.statusCode).toBe(200)
    expect(json<{ ok: boolean }>(res.payload).ok).toBe(true)
  })

  test('逐项报告依赖状态，容器停了能一眼看出是哪个', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })

    const body = json<{ deps: { postgres: { ok: boolean }; redis: { ok: boolean } } }>(res.payload)
    expect(body.deps.postgres.ok).toBe(true)
    expect(body.deps.redis.ok).toBe(true)
  })
})

describe('错误响应', () => {
  test('负载缺字段返回 400，而不是让客户端以为服务端崩了', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/dev/users', payload: {} })

    expect(res.statusCode).toBe(400)
    const body = json<{ error: string; issues: unknown }>(res.payload)
    expect(body.error).toBe('bad_request')
    expect(JSON.stringify(body.issues)).toContain('openid')
  })
})

describe('旅程生命周期接口', () => {
  test('开始旅程返回 journeyId 与授权档位', async () => {
    const userId = await createUser()

    const res = await app.inject({
      method: 'POST', url: '/v1/journeys',
      payload: {
        userId, mode: 'companion', party: 'solo',
        sceneId: 'fuzimiao', trackConsent: 'visited_points_only',
      },
    })

    expect(res.statusCode).toBe(201)
    const body = json<{ journeyId: string; state: string; trackConsent: string }>(res.payload)
    expect(body.state).toBe('ACTIVE')
    expect(body.trackConsent).toBe('visited_points_only')
  })

  test('缺少必填字段时返回 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/journeys', payload: { mode: 'companion' },
    })

    expect(res.statusCode).toBe(400)
  })

  test('结束旅程同时返回蒸馏报告', async () => {
    const userId = await createUser()
    const start = await app.inject({
      method: 'POST', url: '/v1/journeys',
      payload: {
        userId, mode: 'companion', party: 'solo',
        sceneId: 'fuzimiao', trackConsent: 'none',
      },
    })
    const { journeyId } = json<{ journeyId: string }>(start.payload)

    const res = await app.inject({ method: 'POST', url: `/v1/journeys/${journeyId}/end` })

    expect(res.statusCode).toBe(200)
    const body = json<{ distillation: { skipped: boolean } }>(res.payload)
    expect(body.distillation.skipped).toBe(false)
  })
})

describe('行中接口', () => {
  const startJourneyVia = async (
    sceneId = 'fuzimiao',
  ): Promise<{ userId: string; journeyId: string }> => {
    const userId = await createUser()
    const res = await app.inject({
      method: 'POST', url: '/v1/journeys',
      payload: {
        userId, mode: 'companion', party: 'solo',
        sceneId, trackConsent: 'visited_points_only',
      },
    })
    return { userId, journeyId: json<{ journeyId: string }>(res.payload).journeyId }
  }

  test('上报定位返回接受/丢弃统计与围栏事件', async () => {
    const { journeyId } = await startJourneyVia()
    const t0 = new Date()

    const res = await app.inject({
      method: 'POST', url: `/v1/journeys/${journeyId}/signals`,
      payload: {
        points: [
          { lat: 32.0211, lng: 118.7905, accuracyM: 12, at: t0.toISOString(), speedMps: 0.4 },
          {
            lat: 32.0211, lng: 118.7905, accuracyM: 12,
            at: new Date(t0.getTime() + 25_000).toISOString(), speedMps: 0.3,
          },
        ],
      },
    })

    expect(res.statusCode).toBe(200)
    const body = json<{ accepted: number; events: { poiId: string }[] }>(res.payload)
    expect(body.accepted).toBe(2)
    expect(body.events[0]?.poiId).toBe('fzm_jiangnan_gongyuan')
  })

  test('Context State 接口返回完整状态', async () => {
    const { journeyId } = await startJourneyVia()

    const res = await app.inject({
      method: 'GET', url: `/v1/journeys/${journeyId}/context?poiId=fzm_jiangnan_gongyuan`,
    })

    expect(res.statusCode).toBe(200)
    const ctx = json<{ stateVersion: number; mode: string; scene: string }>(res.payload)
    expect(ctx.stateVersion).toBe(1)
    expect(ctx.mode).toBe('companion')
    expect(ctx.scene).toBe('outdoor')
  })

  /**
   * 规格 02 §30：室内不伪造精确位置。
   * 南博没有围栏文件，所以室内的 poiId 必须带着真实来源进来，
   * 客户端不报来源时只能算推断——而不是像以前那样一律记成 geofence/0.9。
   */
  const contextOf = async (journeyId: string, query: string) => {
    const res = await app.inject({
      method: 'GET', url: `/v1/journeys/${journeyId}/context?${query}`,
    })
    expect(res.statusCode).toBe(200)
    return json<{ locationSource: string; locationConfidence: number; scene: string }>(res.payload)
  }

  test('室内不报来源时记成推断，置信度压在否决线以下', async () => {
    const { journeyId } = await startJourneyVia('nanjing_museum')

    const ctx = await contextOf(journeyId, 'poiId=njm_cuojinyin_hu')

    expect(ctx.scene).toBe('indoor')
    expect(ctx.locationSource).toBe('inferred')
    expect(ctx.locationConfidence).toBeLessThanOrEqual(0.6)
  })

  test('室内视觉识别的分数原样带进 Context State', async () => {
    const { journeyId } = await startJourneyVia('nanjing_museum')

    const ctx = await contextOf(
      journeyId, 'poiId=njm_cuojinyin_hu&locationSource=vision_anchor&locationConfidence=0.81',
    )

    expect(ctx.locationSource).toBe('vision_anchor')
    expect(ctx.locationConfidence).toBe(0.81)
  })

  test('室内声明成 geofence 的一律不认', async () => {
    const { journeyId } = await startJourneyVia('nanjing_museum')

    const ctx = await contextOf(
      journeyId, 'poiId=njm_cuojinyin_hu&locationSource=geofence&locationConfidence=0.95',
    )

    expect(ctx.locationSource).toBe('inferred')
    expect(ctx.locationConfidence).toBeLessThanOrEqual(0.6)
  })

  test('室外照旧算围栏，这条路径不受影响', async () => {
    const { journeyId } = await startJourneyVia()

    const ctx = await contextOf(journeyId, 'poiId=fzm_jiangnan_gongyuan')

    expect(ctx.locationSource).toBe('geofence')
    expect(ctx.locationConfidence).toBe(0.9)
  })

  test('到达接口返回讲解与决策依据', async () => {
    const { journeyId } = await startJourneyVia()

    const res = await app.inject({
      method: 'POST', url: `/v1/journeys/${journeyId}/arrive`,
      payload: { poiId: 'fzm_jiangnan_gongyuan' },
    })

    expect(res.statusCode).toBe(200)
    const body = json<{ spoke: boolean; text: string; proactivityReason: string }>(res.payload)
    expect(body.spoke).toBe(true)
    expect(body.text).toContain('号舍')
    expect(body.proactivityReason).toContain('top30_anchor')
  })

  test('主动性决策接口返回可排查的 reason', async () => {
    const { journeyId } = await startJourneyVia()

    const res = await app.inject({
      method: 'POST', url: '/internal/proactivity/decide',
      payload: {
        journeyId, poiId: 'fzm_jiangnan_gongyuan',
        trigger: { kind: 'geofence_arrive', anchorIsTop30: true, isFirstVisit: true },
      },
    })

    expect(res.statusCode).toBe(200)
    const body = json<{ decision: string; reason: string; score: number }>(res.payload)
    expect(body.decision).toBe('SPEAK')
    expect(body.reason).toBeTruthy()
  })

  test('提问接口返回回答', async () => {
    const { journeyId } = await startJourneyVia()

    const res = await app.inject({
      method: 'POST', url: `/v1/journeys/${journeyId}/ask`,
      payload: { text: '古代人怎么考试', poiId: 'fzm_jiangnan_gongyuan' },
    })

    expect(res.statusCode).toBe(200)
    expect(json<{ spoke: boolean }>(res.payload).spoke).toBe(true)
  })

  test('删除旅程接口可用', async () => {
    const { journeyId } = await startJourneyVia()

    const res = await app.inject({ method: 'DELETE', url: `/v1/journeys/${journeyId}` })

    expect(res.statusCode).toBe(200)
    expect(json<{ purged: boolean }>(res.payload).purged).toBe(true)
  })
})

describe('流式应答接口（SSE）', () => {
  test('返回 text/event-stream，首个事件是垫音', async () => {
    const userId = await createUser()
    const start = await app.inject({
      method: 'POST', url: '/v1/journeys',
      payload: {
        userId, mode: 'companion', party: 'solo',
        sceneId: 'fuzimiao', trackConsent: 'visited_points_only',
      },
    })
    const { journeyId } = json<{ journeyId: string }>(start.payload)

    const res = await app.inject({
      method: 'POST', url: `/v1/journeys/${journeyId}/ask/stream`,
      payload: { text: '古代人怎么考试', poiId: 'fzm_jiangnan_gongyuan' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    const events = res.payload.split('\n\n').filter((b) => b.trim() !== '')
    expect(events[0]).toContain('event: filler')
    expect(res.payload).toContain('event: done')
  })

  test('事件体是可解析的 JSON，带 audioKey 供前端播放', async () => {
    const userId = await createUser()
    const start = await app.inject({
      method: 'POST', url: '/v1/journeys',
      payload: {
        userId, mode: 'companion', party: 'solo',
        sceneId: 'fuzimiao', trackConsent: 'visited_points_only',
      },
    })
    const { journeyId } = json<{ journeyId: string }>(start.payload)

    const res = await app.inject({
      method: 'POST', url: `/v1/journeys/${journeyId}/ask/stream`,
      payload: { text: '号舍多大' },
    })

    const firstData = res.payload.split('\n')
      .find((l) => l.startsWith('data:'))?.slice(5).trim() ?? ''
    const parsed = JSON.parse(firstData) as { type: string; audioKey?: string }
    expect(parsed.type).toBe('filler')
    expect(parsed.audioKey).toMatch(/\.mp3$/)
  })
})

describe('视觉接口', () => {
  // 识别链路最后一步要写 location_event，所以得有旅程（规格 02 §4.2、红线 2）
  test('识别接口按候选集约束返回决策', async () => {
    const userId = await createUser()
    const started = await app.inject({
      method: 'POST', url: '/v1/journeys',
      payload: {
        userId, mode: 'light_guide', party: 'solo',
        sceneId: 'nanjing_museum', trackConsent: 'visited_points_only',
      },
    })
    const { journeyId } = json<{ journeyId: string }>(started.payload)

    const res = await app.inject({
      method: 'POST', url: '/v1/vision/anchor',
      payload: { imageKey: 'test-key', zoneHint: 'nanjing_museum', journeyId },
    })

    expect(res.statusCode).toBe(200)
    const body = json<{ decision: string; correctionToken: string }>(res.payload)
    expect(['auto_accept', 'ask_user_pick', 'fallback_ask']).toContain(body.decision)
  })

  test('命中率接口可查', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/vision/hit-rate' })

    expect(res.statusCode).toBe(200)
    expect(json<{ threshold: number }>(res.payload).threshold).toBe(0.8)
  })
})

describe('音频接口', () => {
  test('TTS 状态可查', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/tts/status' })

    expect(res.statusCode).toBe(200)
    expect(json<{ available: boolean }>(res.payload).available).toBe(true)
  })

  test('取未合成的音频返回 404 而不是 500', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/audio/fillers/nope.mp3' })

    expect(res.statusCode).toBe(404)
  })

  test.each([
    '/v1/audio/../../.env',
    '/v1/audio/..%2f..%2f.env',
    '/v1/audio/fillers/../../../package.json',
  ])('拒绝路径穿越：%s', async (url) => {
    const res = await app.inject({ method: 'GET', url })

    // 400 拒绝，或 404 未命中；绝不能 200 返回仓库里的文件
    expect([400, 404]).toContain(res.statusCode)
    expect(res.payload).not.toContain('DATABASE_URL')
    expect(res.payload).not.toContain('lvban-agent-core')
  })

  test('命中的音频带长缓存头', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/audio/fillers/peer_q_01.mp3' })

    if (res.statusCode === 200) {
      expect(res.headers['cache-control']).toContain('immutable')
      expect(res.headers['content-type']).toContain('audio/mpeg')
    }
  })
})

describe('用户权利接口 —— 规格 01 §7', () => {
  test('我的记忆分层返回，偏好带 why 字段', async () => {
    const userId = await createUser()

    const res = await app.inject({ method: 'GET', url: `/me/${userId}/memory` })

    expect(res.statusCode).toBe(200)
    const body = json<{
      identity: unknown[]; preferences: unknown[]; footprints: unknown[]
    }>(res.payload)
    expect(body.identity).toEqual([])
    expect(body.preferences).toEqual([])
    expect(body.footprints).toEqual([])
  })

  test('记忆线索接口返回证据与 token 预算', async () => {
    const userId = await createUser()

    const res = await app.inject({
      method: 'GET', url: `/internal/memory/hooks?userId=${userId}&topic=科举`,
    })

    expect(res.statusCode).toBe(200)
    const body = json<{ tokenEstimate: number; hooks: unknown[] }>(res.payload)
    expect(body.tokenEstimate).toBe(0)
    expect(body.hooks).toEqual([])
  })
})
