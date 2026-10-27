import { resolve, sep } from 'node:path'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { uuidv7 } from 'uuidv7'
import { z } from 'zod'
import { onArrive, onQuestion } from '../agent/respond.js'
import { streamQuestion } from '../agent/respond-stream.js'
import { endJourney, purgeJourneyData, startJourney } from '../context/journey.js'
import { ingestFixes } from '../context/ingest.js'
import { decideProactivity } from '../context/proactivity.js'
import { buildContextState } from '../context/state.js'
import { loadAnchors } from '../content/loader.js'
import { pool } from '../db/pool.js'
import {
  AGE_BANDS, MODES, PARTIES, PREFERENCE_DIMENSIONS, TRACK_CONSENTS,
} from '../domain/enums.js'
import { distillJourney } from '../memory/distill.js'
import { getProfile, updateProfile } from '../memory/profile.js'
import {
  deleteAllMemory, deleteMemory, exportMemory, getMemoryWhy, patchMemory,
} from '../memory/rights.js'
import { generateTravelogue } from '../agent/travelogue.js'
import { writeMemory } from '../memory/gateway.js'
import { getMemoryHooks } from '../memory/retrieval.js'
import * as repo from '../memory/repo.js'
import { readLedger } from '../models/router.js'
import { CACHE_DIR, readCached } from '../tts/cache.js'
import { code2Session } from '../auth/wx.js'
import { bearerToken, createSession, revokeSession } from '../auth/session.js'
import { isAuthRequired, requireWxConfig } from '../auth/policy.js'
import {
  AuthError, currentUser, registerAuthHook, requireJourneyOwner, requireLogin, requireSelf,
} from './auth.js'
import { classifyError } from './errors.js'
import { checkDependencies } from './health.js'
import { ttsAvailability } from '../tts/availability.js'
import { decideVisionAnchor, recordVisionOutcome, visionHitRate } from '../vision/anchor.js'

/** HTTP 接口 —— 规格 02 §8、01 §5.5、01 §7。M3 小程序接的就是这一套。 */

const startSchema = z.object({
  userId: z.string().uuid(),
  mode: z.enum(MODES),
  party: z.enum(PARTIES),
  sceneId: z.string(),
  trackConsent: z.enum(TRACK_CONSENTS),
  coTravelers: z.array(z.string().uuid()).optional(),
})

const fixSchema = z.object({
  lat: z.number(), lng: z.number(),
  accuracyM: z.number(), at: z.string(), speedMps: z.number().optional(),
})

/** 分层展示（规格 01 §7）。两条路由共用：/me/memory 与 /me/:userId/memory */
const readMemory = async (userId: string) => {
  const [preferences, traits, footprints] = await Promise.all([
    repo.listPreferences(userId),
    repo.listIdentityTraits(userId),
    repo.listFootprints(userId, 30),
  ])
  return {
    identity: traits,
    preferences: preferences.map((p) => ({
      id: p.id, dimension: p.dimension, value: p.value,
      strength: Number(p.strength), status: p.status,
      journeyCount: p.journey_count, source: p.source,
      why: p.evidence_refs,
    })),
    footprints,
  }
}

export const registerRoutes = (app: FastifyInstance): void => {
  registerAuthHook(app)

  // 依赖探活要真打一下 PG 和 Redis：容器停了而进程还在，是联调时最容易看岔的一种故障
  app.get('/health', async (_request, reply) => {
    const health = await checkDependencies()
    return reply.code(health.ok ? 200 : 503).send({ ...health, ledger: readLedger() })
  })

  app.setErrorHandler((error, request, reply) => {
    // SSE 已经开始推了就改不动状态码，只能留日志
    if (reply.raw.headersSent) { request.log.error(error); return }
    const { status, body } = classifyError(error)
    if (status >= 500) request.log.error(error)
    return reply.code(status).send(body)
  })

  /**
   * 微信登录（PRD U01）。只取 openid：不索取手机号，也不留存 session_key。
   *
   * code 一次性且约 5 分钟过期，所以小程序必须在用户真正触发登录时
   * 才调 wx.login，不能在页面 onLoad 就先换好放着。
   */
  app.post('/v1/auth/wx-login', async (request, reply) => {
    const { code } = z.object({ code: z.string().min(1) }).parse(request.body)
    const session = await code2Session(code, requireWxConfig())

    const { rows } = await pool.query<{ id: string; created: boolean }>(
      `INSERT INTO app_user (id, wx_openid, wx_unionid)
       VALUES ($1,$2,$3)
       ON CONFLICT (wx_openid) DO UPDATE
         SET wx_unionid = COALESCE(EXCLUDED.wx_unionid, app_user.wx_unionid)
       RETURNING id, (xmax = 0) AS created`,
      [uuidv7(), session.openid, session.unionid ?? null],
    )
    const user = rows[0]
    if (user === undefined) throw new Error('登录写账号失败')

    const issued = await createSession(user.id)
    return reply.code(200).send({
      userId: user.id,
      token: issued.token,
      expiresIn: issued.expiresInSeconds,
      isNew: user.created,
    })
  })

  app.post('/v1/auth/logout', async (request) => {
    await revokeSession(bearerToken(request.headers.authorization))
    return { ok: true }
  })

  // 开发辅助：建用户。强制鉴权时必须下线——它是无需凭证凭空造身份的后门。
  app.post('/v1/dev/users', async (request, reply) => {
    if (isAuthRequired()) {
      return reply.code(404).send({ error: 'not_found' })
    }
    const body = z.object({
      openid: z.string(),
      ageBand: z.string().default('19_24'),
      nickname: z.string().default('测试用户'),
    }).parse(request.body)
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO app_user (id, wx_openid, nickname, age_band)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (wx_openid) DO UPDATE SET nickname = EXCLUDED.nickname
       RETURNING id`,
      [uuidv7(), body.openid, body.nickname, body.ageBand],
    )
    const userId = rows[0]?.id
    if (userId === undefined) throw new Error('建测试用户失败')
    // 一并发令牌：这样联调链路和线上链路走的是同一套鉴权，不会只在真机上才暴露问题
    const issued = await createSession(userId)
    return reply.code(201).send({ userId, token: issued.token })
  })

  app.post('/v1/journeys', async (request, reply) => {
    const body = startSchema.parse(request.body)
    // 身份以会话为准：请求体里的 userId 只在匿名联调时作数
    const userId = requireSelf(request, body.userId)
    const journey = await startJourney({ ...body, userId })
    return reply.code(201).send({
      journeyId: journey.id,
      state: journey.state,
      trackConsent: journey.track_consent,
    })
  })

  app.post('/v1/journeys/:id/end', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    await requireJourneyOwner(request, id)
    const journey = await endJourney(id)
    const report = await distillJourney(id)
    return { journeyId: journey.id, state: journey.state, distillation: report }
  })

  app.delete('/v1/journeys/:id', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    await requireJourneyOwner(request, id)
    await purgeJourneyData(id)
    return { purged: true, journeyId: id }
  })

  app.post('/v1/journeys/:id/signals', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    await requireJourneyOwner(request, id)
    const body = z.object({ points: z.array(fixSchema).default([]) }).parse(request.body)
    return ingestFixes({
      journeyId: id,
      fixes: body.points.map((p) => ({ ...p, at: new Date(p.at) })),
    })
  })

  app.get('/v1/journeys/:id/context', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    await requireJourneyOwner(request, id)
    const query = z.object({ poiId: z.string().optional() }).parse(request.query)
    return buildContextState({ journeyId: id, poiId: query.poiId ?? null })
  })

  app.post('/v1/journeys/:id/arrive', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    await requireJourneyOwner(request, id)
    const body = z.object({
      poiId: z.string(),
      heardBefore: z.array(z.string()).optional(),
      safetySensitive: z.boolean().optional(),
    }).parse(request.body)
    return onArrive({ journeyId: id, ...body })
  })

  app.post('/v1/journeys/:id/ask', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    await requireJourneyOwner(request, id)
    const body = z.object({ text: z.string().min(1), poiId: z.string().optional() })
      .parse(request.body)
    return onQuestion({ journeyId: id, ...body })
  })

  /**
   * 流式应答（SSE）。M3 小程序的「问一句」走这条。
   *
   * 事件顺序即用户体感：filler 立刻到（前端播本地预合成音频），
   * 之后每凑齐一句就发一个 sentence 事件供 TTS 分句合成。
   */
  app.post('/v1/journeys/:id/ask/stream', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    await requireJourneyOwner(request, id)
    const body = z.object({
      text: z.string().min(1),
      poiId: z.string().optional(),
      situation: z.enum(['question', 'photo', 'arrive']).optional(),
    }).parse(request.body)

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // 小程序侧经过的代理常会缓冲 SSE，这个头能让多数反代放行
      'x-accel-buffering': 'no',
    })

    try {
      for await (const event of streamQuestion({ journeyId: id, ...body })) {
        reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      reply.raw.write(
        `event: error\ndata: ${JSON.stringify({ type: 'error', message })}\n\n`,
      )
    } finally {
      reply.raw.end()
    }
    return reply
  })

  app.post('/v1/vision/anchor', async (request) => {
    const { imageKey, zoneHint } = z.object({
      imageKey: z.string(), zoneHint: z.string().optional(),
    }).parse(request.body)
    const anchors = await loadAnchors()
    const candidates = [...anchors.values()]
      .filter((a) => a.exhibitId !== undefined)
      .filter((a) => zoneHint === undefined || a.sceneId === zoneHint)
      .map((a) => ({ exhibitId: a.exhibitId as string, name: a.name }))
    return decideVisionAnchor({ imageKey, candidates })
  })

  app.post('/v1/vision/anchor/outcome', async (request) => {
    const body = z.object({ corrected: z.boolean() }).parse(request.body)
    await recordVisionOutcome(body.corrected)
    return visionHitRate()
  })

  app.get('/v1/vision/hit-rate', async () => visionHitRate())

  /**
   * 取预合成/实时合成的音频。audioKey 由 filler 与 audio 事件给出。
   *
   * key 来自客户端，所以必须防路径穿越：解析后必须仍在缓存目录内。
   * 生产环境这条路由应由 CDN 接管，这里是本地开发与 M3 联调用。
   */
  app.get('/v1/audio/*', async (request, reply) => {
    const raw = (request.params as Record<string, string>)['*'] ?? ''
    const resolved = resolve(CACHE_DIR, raw)
    const root = resolve(CACHE_DIR)
    if (resolved !== root && !resolved.startsWith(`${root}sep`.replace('sep', sep))) {
      return reply.code(400).send({ error: 'audioKey 越出缓存目录' })
    }

    const audio = await readCached(resolved)
    if (audio === null) return reply.code(404).send({ error: '音频未合成', audioKey: raw })

    const type = raw.endsWith('.wav') ? 'audio/wav'
      : raw.endsWith('.pcm') ? 'audio/L16'
        : raw.endsWith('.ogg') ? 'audio/ogg' : 'audio/mpeg'
    return reply
      // 内容寻址 + 固定台词：可以放心长缓存
      .header('cache-control', 'public, max-age=31536000, immutable')
      .type(type)
      .send(audio)
  })

  app.get('/v1/tts/status', async () => {
    const verdict = ttsAvailability()
    return verdict.available
      ? { available: true, provider: verdict.provider }
      : { available: false, reason: verdict.reason }
  })

  app.get('/internal/memory/hooks', async (request) => {
    const query = z.object({
      userId: z.string().uuid(),
      poiId: z.string().optional(),
      topic: z.string().optional(),
      limit: z.coerce.number().int().positive().optional(),
    }).parse(request.query)
    return getMemoryHooks({
      userId: query.userId,
      currentPlace: query.poiId ?? null,
      currentCity: '南京',
      topic: query.topic ?? null,
      limit: query.limit,
    })
  })

  app.post('/internal/proactivity/decide', async (request) => {
    const body = z.object({
      journeyId: z.string().uuid(),
      poiId: z.string().optional(),
      trigger: z.object({
        kind: z.enum(['geofence_arrive', 'photo', 'user_question', 'task_step', 'route_hint']),
        anchorIsTop30: z.boolean().optional(),
        isFirstVisit: z.boolean().optional(),
        safetySensitive: z.boolean().optional(),
      }),
    }).parse(request.body)
    const ctx = await buildContextState({
      journeyId: body.journeyId, poiId: body.poiId ?? null,
    })
    return decideProactivity(ctx, body.trigger)
  })

  /** PRD U02：3 分钟建档。三个问题都可跳过，未作答的字段保持原样 */
  app.get('/me/profile', async (request) => {
    const profile = await getProfile(requireLogin(request))
    if (profile === null) throw new Error('档案不存在')
    return profile
  })

  /**
   * PATCH 与 PUT 指向同一个处理函数。
   * 原因：wx.request 的 method 合法值只有
   * OPTIONS/GET/HEAD/POST/PUT/DELETE/TRACE/CONNECT —— 没有 PATCH，
   * 小程序发不出 PATCH 请求。规格写的是 PATCH，所以两个都留着。
   */
  const patchProfile = async (request: FastifyRequest) => {
    const userId = requireLogin(request)
    const body = z.object({
      nickname: z.string().min(1).max(20).optional(),
      ageBand: z.enum(AGE_BANDS).optional(),
      defaultMode: z.enum(MODES).optional(),
      voicePref: z.enum(['voice', 'text']).optional(),
    }).parse(request.body)
    await updateProfile(userId, body)
    return getProfile(userId)
  }
  app.patch('/me/profile', patchProfile)
  app.put('/me/profile', patchProfile)

  /** 首页：最近的旅程，用来决定「继续上次」还是「开始新的」 */
  app.get('/me/journeys', async (request) => {
    const userId = requireLogin(request)
    const { rows } = await pool.query<{
      id: string; scene_id: string; state: string; mode: string
      started_at: Date; ended_at: Date | null; distilled_at: Date | null
    }>(
      `SELECT id, scene_id, state, mode, started_at, ended_at, distilled_at
         FROM journey WHERE user_id = $1 AND state <> 'PURGED'
        ORDER BY started_at DESC LIMIT 20`,
      [userId],
    )
    return {
      journeys: rows.map((r) => ({
        journeyId: r.id, sceneId: r.scene_id, state: r.state, mode: r.mode,
        startedAt: r.started_at.toISOString(),
        endedAt: r.ended_at?.toISOString() ?? null,
        hasTravelogue: r.distilled_at !== null,
      })),
    }
  })

  /** 行后游记（规格 04 §7.1）。史实只取已审校锚点，未过审的会被排除并计数 */
  app.get('/v1/journeys/:id/travelogue', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    await requireJourneyOwner(request, id)
    const query = z.object({
      allowDraftAnchors: z.enum(['true', 'false']).optional(),
    }).parse(request.query)
    return generateTravelogue(id, {
      allowDraftAnchors: query.allowDraftAnchors === 'true',
    })
  })

  /** 规格 01 §7：用户权利接口 */
  app.get('/me/memory', async (request) => {
    const userId = requireLogin(request)
    return readMemory(userId)
  })

  app.get('/me/memory/:id/why', async (request) => {
    const userId = requireLogin(request)
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const why = await getMemoryWhy(userId, id)
    if (why === null) throw new AuthError(404, '没有这条记忆')
    return why
  })

  const patchOneMemory = async (request: FastifyRequest) => {
    const userId = requireLogin(request)
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const body = z.object({
      value: z.string().min(1).max(40).optional(),
      strength: z.number().min(0).max(1).optional(),
      status: z.literal('user_removed').optional(),
    }).parse(request.body)
    const result = await patchMemory(userId, id, body)
    if (!result.updated) throw new AuthError(404, '没有这条记忆')
    return result
  }
  app.patch('/me/memory/:id', patchOneMemory)
  app.put('/me/memory/:id', patchOneMemory)

  /**
   * 清空全部记忆。确认标记走查询串而不是请求体：
   * wx.request 的文档只定义了 GET 与 POST 的 data 转换规则，
   * DELETE 带 body 的行为未定义，不能指望它被序列化成 JSON。
   */
  app.delete('/me/memory/all', async (request) => {
    const userId = requireLogin(request)
    z.object({ confirm: z.literal('true') }).parse(request.query)
    return deleteAllMemory(userId)
  })

  app.delete('/me/memory/:id', async (request) => {
    const userId = requireLogin(request)
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const result = await deleteMemory(userId, id)
    if (!result.deleted) throw new AuthError(404, '没有这条记忆')
    return result
  })

  app.post('/me/memory/export', async (request) => exportMemory(requireLogin(request)))

  /**
   * 确认一条推断出来的偏好（规格 01 D2）。
   * 推断信号只在 L0，用户点了确认才以 user_confirmed 落 L2 —— 这是红线 1 的正门。
   */
  app.post('/me/memory/confirm', async (request) => {
    const userId = requireLogin(request)
    const body = z.object({
      journeyId: z.string().uuid(),
      dimension: z.enum(PREFERENCE_DIMENSIONS),
      value: z.string().min(1).max(40),
    }).parse(request.body)
    await requireJourneyOwner(request, body.journeyId)
    const result = await writeMemory({
      kind: 'signal',
      userId,
      journeyId: body.journeyId,
      dimension: body.dimension,
      value: body.value,
      source: 'user_confirmed',
      occurredAt: new Date(),
    })
    return { confirmed: result.ok }
  })

  app.get('/me/:userId/memory', async (request) => {
    const { userId: claimed } = z.object({ userId: z.string().uuid() }).parse(request.params)
    return readMemory(requireSelf(request, claimed))
  })
}
