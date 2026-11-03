import { uuidv7 } from 'uuidv7'
import { distillation as cfg } from '../config/index.js'
import { buildPlaceIndex, type PlaceIndex } from '../content/loader.js'
import { pool } from '../db/pool.js'
import type { PreferenceDimension, PromotableSource } from '../domain/enums.js'
import * as repo from './repo.js'

/**
 * 蒸馏管线 —— 规格 01 §4。行后触发，不是实时。
 *
 * D2 旅程→偏好：同类信号本次 ≥ d2SignalCountMin，或用户确认
 * D3 偏好→身份：跨 ≥ d3JourneyCountMin 次旅程且 party_invariant
 * D4 轨迹→足迹：生成语义足迹，原始点标记 7 天后销毁
 * D5 个人↔家庭：家庭旅程分别写入各成员档案，互不合并（由调用方按成员各跑一次）
 *
 * 以 journey.distilled_at 幂等，可重放。
 */

type SignalGroup = {
  readonly dimension: PreferenceDimension
  readonly value: string
  readonly count: number
  readonly weight: number
  readonly hasConfirmed: boolean
}

type EvidenceEntry = {
  readonly journeyId: string
  readonly party: string
  readonly signalCount: number
  readonly at: string
}

export type DistillReport = {
  readonly journeyId: string
  readonly skipped: boolean
  readonly footprints: number
  readonly preferencesCreated: number
  readonly preferencesMentionedOnce: number
  readonly traitsPromoted: number
  readonly traitsCandidate: number
}

/** 规格 01 §4.4 */
export const computeStrength = (input: {
  readonly journeyCount: number
  readonly signalTotal: number
  readonly source: PromotableSource
  readonly daysSinceLastSeen: number
}): number => {
  const decay = input.daysSinceLastSeen <= 0
    ? 0
    : 0.5 * (1 - Math.pow(0.5, input.daysSinceLastSeen / cfg.preferenceDecayHalfLifeDays))
  const raw =
    0.5 +
    0.15 * Math.min(input.journeyCount - 1, 3) +
    0.10 * Math.min(input.signalTotal / 5, 1) +
    0.15 * (input.source === 'user_confirmed' ? 1 : 0) -
    decay
  return Math.min(1, Math.max(0, Number(raw.toFixed(2))))
}

const loadSignals = async (journeyId: string): Promise<readonly SignalGroup[]> => {
  const { rows } = await pool.query<{
    dimension: PreferenceDimension; value: string
    count: string; weight: string; has_confirmed: boolean
  }>(
    `SELECT dimension, value, COUNT(*)::text AS count, SUM(weight)::text AS weight,
            bool_or(source = 'user_confirmed') AS has_confirmed
       FROM journey_signal WHERE journey_id = $1
       GROUP BY dimension, value`,
    [journeyId],
  )
  return rows.map((r) => ({
    dimension: r.dimension,
    value: r.value,
    count: Number(r.count),
    weight: Number(r.weight),
    hasConfirmed: r.has_confirmed,
  }))
}

/** D4：从 location_event + interaction 压出语义足迹 */
const buildFootprints = async (
  journey: repo.JourneyRow, places: PlaceIndex,
): Promise<number> => {
  const { rows } = await pool.query<{ place_id: string; dwell_sec: string }>(
    `SELECT COALESCE(le.poi_id, le.exhibit_id) AS place_id,
            COALESCE(SUM(le.dwell_sec), 0)::text AS dwell_sec
       FROM location_event le
      WHERE le.journey_id = $1
        AND le.source <> 'inferred'
        AND COALESCE(le.poi_id, le.exhibit_id) IS NOT NULL
      GROUP BY COALESCE(le.poi_id, le.exhibit_id)`,
    [journey.id],
  )

  const city = journey.scene_id === 'nanjing_museum' || journey.scene_id === 'fuzimiao'
    ? '南京' : '未知'

  for (const row of rows) {
    const entry = places.get(row.place_id)
    // 锚点 ID 与 POI ID 不同一个空间，靠 PlaceIndex 搭桥取提问数与主题
    const anchorIds = entry?.anchorIds ?? []
    const { rows: iRows } = await pool.query<{ questions: string; topics: string[] }>(
      `SELECT COUNT(DISTINCT i.id) FILTER (WHERE i.role = 'user')::text AS questions,
              COALESCE(array_agg(DISTINCT t) FILTER (WHERE t IS NOT NULL), '{}') AS topics
         FROM interaction i LEFT JOIN unnest(i.topic_tags) t ON true
        WHERE i.journey_id = $1
          AND ${repo.notSilentCard()}
          AND (i.anchor_id = ANY($2::text[]) OR i.anchor_id = $3)`,
      [journey.id, anchorIds, row.place_id],
    )

    const dwell = Number(row.dwell_sec)
    const questions = Number(iRows[0]?.questions ?? 0)
    const interest = questions >= 2 || dwell >= cfg.d2DwellSecAsSignal
      ? 'high' : questions >= 1 ? 'medium' : 'low'

    await repo.insertFootprint({
      userId: journey.user_id,
      journeyId: journey.id,
      city,
      place: entry?.name ?? row.place_id,
      dwellSec: dwell,
      questionCount: questions,
      interestSignal: interest,
      topics: iRows[0]?.topics ?? [],
      occurredOn: journey.started_at,
    })
  }
  return rows.length
}

const mergeEvidence = (existing: unknown, entry: EvidenceEntry): readonly EvidenceEntry[] => {
  const prior = Array.isArray(existing) ? (existing as EvidenceEntry[]) : []
  const withoutThis = prior.filter((e) => e.journeyId !== entry.journeyId)
  return [...withoutThis, entry]
}

/** D3：偏好 → 身份 */
const promoteIdentity = async (
  userId: string,
): Promise<{ promoted: number; candidate: number }> => {
  const prefs = await repo.listPreferences(userId)
  let promoted = 0
  let candidate = 0

  for (const pref of prefs) {
    if (pref.status !== 'active' || pref.dimension !== 'topic_interest') continue

    const evidence = Array.isArray(pref.evidence_refs)
      ? (pref.evidence_refs as EvidenceEntry[]) : []
    const journeyIds = [...new Set(evidence.map((e) => e.journeyId))]
    if (journeyIds.length < cfg.d3JourneyCountMin) continue

    const parties = new Set(evidence.map((e) => e.party))
    const partyInvariant = parties.size >= 2
    const active = partyInvariant || !cfg.d3RequirePartyInvariant

    const trait = `${pref.value}爱好者`
    const explanation = `你在 ${journeyIds.length} 次旅行里都围着「${pref.value}」问得最多`
    await pool.query(
      `INSERT INTO identity_trait
         (id, user_id, trait, status, supporting_journeys, party_invariant, promoted_at, explanation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (user_id, trait) DO UPDATE SET
         status = CASE WHEN identity_trait.status = 'user_removed'
                       THEN 'user_removed' ELSE EXCLUDED.status END,
         supporting_journeys = EXCLUDED.supporting_journeys,
         party_invariant = EXCLUDED.party_invariant,
         promoted_at = EXCLUDED.promoted_at,
         explanation = EXCLUDED.explanation`,
      [uuidv7(), userId, trait, active ? 'active' : 'candidate', journeyIds,
        partyInvariant, active ? new Date() : null, explanation],
    )
    await repo.audit({
      userId, action: 'promote', layer: 'L3',
      reason: `${trait} journeys=${journeyIds.length} partyInvariant=${partyInvariant}`,
      actor: 'system:distiller',
    })
    if (active) promoted += 1
    else candidate += 1
  }
  return { promoted, candidate }
}

export const distillJourney = async (
  journeyId: string, options: { readonly force?: boolean } = {},
): Promise<DistillReport> => {
  const journey = await repo.findJourney(journeyId)
  if (journey === null) throw new Error(`旅程不存在：${journeyId}`)

  const empty = {
    journeyId, footprints: 0, preferencesCreated: 0,
    preferencesMentionedOnce: 0, traitsPromoted: 0, traitsCandidate: 0,
  }
  if (journey.distilled_at !== null && options.force !== true) {
    return { ...empty, skipped: true }
  }

  await pool.query(`UPDATE journey SET state = 'DISTILLING' WHERE id = $1`, [journeyId])

  const places = await buildPlaceIndex()
  const footprints = await buildFootprints(journey, places)

  // D2
  const groups = await loadSignals(journeyId)
  const existing = new Map(
    (await repo.listPreferences(journey.user_id)).map(
      (p) => [`${p.dimension}::${p.value}`, p] as const,
    ),
  )
  let created = 0
  let mentionedOnce = 0
  const now = new Date()

  for (const group of groups) {
    const promotes = group.count >= cfg.d2SignalCountMin || group.hasConfirmed
    const prior = existing.get(`${group.dimension}::${group.value}`)
    const entry: EvidenceEntry = {
      journeyId,
      party: journey.party,
      signalCount: group.count,
      at: now.toISOString(),
    }
    const evidence = mergeEvidence(prior?.evidence_refs, entry)
    const journeyCount = new Set(evidence.map((e) => e.journeyId)).size
    const signalTotal = evidence.reduce((sum, e) => sum + e.signalCount, 0)
    const source: PromotableSource = group.hasConfirmed ? 'user_confirmed' : 'explicit'

    await repo.upsertPreference({
      userId: journey.user_id,
      dimension: group.dimension,
      value: group.value,
      strength: computeStrength({ journeyCount, signalTotal, source, daysSinceLastSeen: 0 }),
      status: promotes ? 'active' : 'mentioned_once',
      source,
      evidence,
      journeyCount,
      seenAt: now,
    })
    if (promotes) created += 1
    else mentionedOnce += 1
  }

  // D3
  const identity = await promoteIdentity(journey.user_id)

  // D4：原始轨迹销毁时点
  await pool.query(
    `UPDATE journey
        SET distilled_at = now(), state = 'CLOSED',
            raw_track_purge_at = COALESCE(ended_at, now()) + make_interval(days => $2::int)
      WHERE id = $1`,
    [journeyId, cfg.d4RawTrackTtlDays],
  )

  return {
    journeyId,
    skipped: false,
    footprints,
    preferencesCreated: created,
    preferencesMentionedOnce: mentionedOnce,
    traitsPromoted: identity.promoted,
    traitsCandidate: identity.candidate,
  }
}

/** D4 的销毁作业：到期分区物理删除（M2 用 DELETE，生产改按天分区 DROP） */
export const purgeExpiredRawTracks = async (): Promise<number> => {
  const { rowCount } = await pool.query(
    `DELETE FROM raw_track_point rtp
      USING journey j
      WHERE rtp.journey_id = j.id
        AND j.raw_track_purge_at IS NOT NULL
        AND j.raw_track_purge_at <= now()`,
  )
  return rowCount ?? 0
}
