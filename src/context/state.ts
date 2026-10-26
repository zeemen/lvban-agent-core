import { pool } from '../db/pool.js'
import type { ContextState } from '../domain/context-state.js'
import { contextStateSchema } from '../domain/context-state.js'
import type { AgeBand } from '../domain/enums.js'
import { readIgnored, readLastSpoke, cacheContext } from '../memory/ephemeral.js'
import { getMemoryHooks } from '../memory/retrieval.js'
import * as repo from '../memory/repo.js'
import { deriveActivity, deriveFatigue, deriveInterest } from './proactivity.js'

/**
 * Context State 构建 —— 规格 02 §6。
 * 把位置、视觉、时间、动线、对话和记忆压成一份当前状态，交给 Planner。
 */

export type BuildInput = {
  readonly journeyId: string
  readonly poiId?: string | null
  readonly locationSource?: ContextState['locationSource']
  readonly locationConfidence?: number
  readonly accuracyM?: number | null
  readonly speedMps?: number | null
  readonly isDining?: boolean
  readonly userIsSpeaking?: boolean
  readonly currentTopic?: string | null
  readonly routeRemaining?: readonly string[]
  readonly timeLeftMin?: number | null
  readonly now?: Date
}

const INDOOR_SCENES = new Set(['nanjing_museum'])
const RECENT_WINDOW_MIN = 20

const timeOfDay = (at: Date): ContextState['timeOfDay'] => {
  const h = at.getHours()
  if (h < 12) return 'morning'
  if (h < 17) return 'afternoon'
  if (h < 21) return 'evening'
  return 'night'
}

type Counts = {
  readonly questionsHere: number
  readonly dwellHereSec: number
  readonly recent: number
  readonly prior: number
  readonly saidTired: boolean
  readonly visited: readonly string[]
}

const loadCounts = async (
  journeyId: string, poiId: string | null, now: Date,
): Promise<Counts> => {
  const { rows: qRows } = await pool.query<{ questions: string; said_tired: boolean }>(
    `SELECT COUNT(*) FILTER (WHERE role = 'user' AND anchor_id = $2)::text AS questions,
            bool_or(role = 'user' AND content ~ '累|歇会|走不动|休息') AS said_tired
       FROM interaction WHERE journey_id = $1`,
    [journeyId, poiId],
  )
  const { rows: dRows } = await pool.query<{ dwell: string }>(
    `SELECT COALESCE(SUM(dwell_sec), 0)::text AS dwell
       FROM location_event WHERE journey_id = $1 AND poi_id = $2`,
    [journeyId, poiId],
  )
  const { rows: wRows } = await pool.query<{ recent: string; prior: string }>(
    `SELECT COUNT(*) FILTER (
              WHERE occurred_at > $2::timestamptz - make_interval(mins => $3::int)
            )::text AS recent,
            COUNT(*) FILTER (
              WHERE occurred_at <= $2::timestamptz - make_interval(mins => $3::int)
                AND occurred_at >  $2::timestamptz - make_interval(mins => 2 * $3::int)
            )::text AS prior
       FROM interaction WHERE journey_id = $1`,
    [journeyId, now.toISOString(), String(RECENT_WINDOW_MIN)],
  )
  const { rows: vRows } = await pool.query<{ anchors: string[] }>(
    `SELECT COALESCE(array_agg(DISTINCT COALESCE(poi_id, exhibit_id)), '{}') AS anchors
       FROM location_event
      WHERE journey_id = $1 AND source <> 'inferred'
        AND COALESCE(poi_id, exhibit_id) IS NOT NULL`,
    [journeyId],
  )

  return {
    questionsHere: Number(qRows[0]?.questions ?? 0),
    dwellHereSec: Number(dRows[0]?.dwell ?? 0),
    recent: Number(wRows[0]?.recent ?? 0),
    prior: Number(wRows[0]?.prior ?? 0),
    saidTired: qRows[0]?.said_tired ?? false,
    visited: vRows[0]?.anchors ?? [],
  }
}

export const buildContextState = async (input: BuildInput): Promise<ContextState> => {
  const now = input.now ?? new Date()
  const journey = await repo.findJourney(input.journeyId)
  if (journey === null) throw new Error(`旅程不存在：${input.journeyId}`)

  const { rows: userRows } = await pool.query<{ age_band: AgeBand }>(
    'SELECT age_band FROM app_user WHERE id = $1',
    [journey.user_id],
  )
  const ageBand = userRows[0]?.age_band ?? 'unknown'

  const poiId = input.poiId ?? null
  const counts = await loadCounts(input.journeyId, poiId, now)
  const elapsedMin = Math.max(0, Math.round((now.getTime() - journey.started_at.getTime()) / 60_000))

  const scene = INDOOR_SCENES.has(journey.scene_id) ? 'indoor' : 'outdoor'
  const memory = await getMemoryHooks({
    userId: journey.user_id,
    currentPlace: poiId,
    currentCity: '南京',
    topic: input.currentTopic ?? null,
  })

  const lastSpoke = await readLastSpoke(input.journeyId)
  const ignored = poiId === null ? 0 : await readIgnored(input.journeyId, poiId)

  const state: ContextState = {
    user: journey.user_id,
    mode: journey.mode,
    party: journey.party,
    ageBand,

    scene,
    sceneId: journey.scene_id,
    location: poiId,
    locationSource: input.locationSource ?? (poiId === null ? 'none' : 'geofence'),
    locationConfidence: input.locationConfidence ?? (poiId === null ? 0 : 0.9),

    activity: deriveActivity(input.speedMps ?? null),
    isMoving: (input.speedMps ?? 0) >= 0.5,
    isDining: input.isDining ?? false,
    accuracyM: input.accuracyM ?? null,

    currentTopic: input.currentTopic ?? null,
    interest: deriveInterest({
      questionCount: counts.questionsHere,
      dwellSec: counts.dwellHereSec,
      medianDwellSec: 300,
      skipped: false,
    }),
    fatigue: deriveFatigue({
      elapsedMin,
      saidTired: counts.saidTired,
      recentInteractions: counts.recent,
      priorInteractions: counts.prior,
    }),
    dwellHereSec: counts.dwellHereSec,
    elapsedMin,
    timeLeft: input.timeLeftMin ?? null,
    timeOfDay: timeOfDay(now),

    nextGoal: input.routeRemaining?.[0] ?? null,
    routeRemaining: [...(input.routeRemaining ?? [])],
    activeTask: null,

    memoryHooks: memory.hooks.map((h) => h.text),
    identityTraits: memory.identity.map((i) => i.trait),
    preferences: memory.preferences,
    visitedAnchors: [...counts.visited],

    lastSpokeSecAgo: lastSpoke === null
      ? null
      : Math.round((now.getTime() - lastSpoke.getTime()) / 1000),
    consecutiveIgnored: ignored,
    userIsSpeaking: input.userIsSpeaking ?? false,

    journeyId: journey.id,
    stateVersion: 1,
    computedAt: now.toISOString(),
  }

  const parsed = contextStateSchema.parse(state)
  await cacheContext(input.journeyId, parsed)
  return parsed
}
