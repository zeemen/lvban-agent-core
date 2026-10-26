import type { FastifyInstance } from 'fastify'
import { uuidv7 } from 'uuidv7'
import { z } from 'zod'
import { onArrive, onQuestion } from '../agent/respond.js'
import { endJourney, purgeJourneyData, startJourney } from '../context/journey.js'
import { ingestFixes } from '../context/ingest.js'
import { decideProactivity } from '../context/proactivity.js'
import { buildContextState } from '../context/state.js'
import { loadAnchors } from '../content/loader.js'
import { pool } from '../db/pool.js'
import { MODES, PARTIES, TRACK_CONSENTS } from '../domain/enums.js'
import { distillJourney } from '../memory/distill.js'
import { getMemoryHooks } from '../memory/retrieval.js'
import * as repo from '../memory/repo.js'
import { readLedger } from '../models/router.js'
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

export const registerRoutes = (app: FastifyInstance): void => {
  app.get('/health', async () => ({ ok: true, ledger: readLedger() }))

  // 开发辅助：建用户。生产由微信授权创建。
  app.post('/v1/dev/users', async (request, reply) => {
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
    return reply.code(201).send({ userId: rows[0]?.id })
  })

  app.post('/v1/journeys', async (request, reply) => {
    const body = startSchema.parse(request.body)
    const journey = await startJourney(body)
    return reply.code(201).send({
      journeyId: journey.id,
      state: journey.state,
      trackConsent: journey.track_consent,
    })
  })

  app.post('/v1/journeys/:id/end', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const journey = await endJourney(id)
    const report = await distillJourney(id)
    return { journeyId: journey.id, state: journey.state, distillation: report }
  })

  app.delete('/v1/journeys/:id', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    await purgeJourneyData(id)
    return { purged: true, journeyId: id }
  })

  app.post('/v1/journeys/:id/signals', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const body = z.object({ points: z.array(fixSchema).default([]) }).parse(request.body)
    return ingestFixes({
      journeyId: id,
      fixes: body.points.map((p) => ({ ...p, at: new Date(p.at) })),
    })
  })

  app.get('/v1/journeys/:id/context', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const query = z.object({ poiId: z.string().optional() }).parse(request.query)
    return buildContextState({ journeyId: id, poiId: query.poiId ?? null })
  })

  app.post('/v1/journeys/:id/arrive', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const body = z.object({
      poiId: z.string(),
      heardBefore: z.array(z.string()).optional(),
      safetySensitive: z.boolean().optional(),
    }).parse(request.body)
    return onArrive({ journeyId: id, ...body })
  })

  app.post('/v1/journeys/:id/ask', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const body = z.object({ text: z.string().min(1), poiId: z.string().optional() })
      .parse(request.body)
    return onQuestion({ journeyId: id, ...body })
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

  /** 规格 01 §7：用户权利接口 */
  app.get('/me/:userId/memory', async (request) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params)
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
  })
}
