import { uuidv7 } from 'uuidv7'
import { pool } from '../db/pool.js'
import type {
  JourneyState, Mode, Party, PreferenceDimension, PromotableSource, TrackConsent,
} from '../domain/enums.js'

/** 记忆相关表的全部 SQL 访问。业务逻辑不直接拼 SQL。 */

export type JourneyRow = {
  readonly id: string
  readonly user_id: string
  readonly mode: Mode
  readonly party: Party
  readonly co_travelers: readonly string[]
  readonly scene_id: string
  readonly state: JourneyState
  readonly started_at: Date
  readonly ended_at: Date | null
  readonly track_consent: TrackConsent
  readonly distilled_at: Date | null
}

export type PreferenceRow = {
  readonly id: string
  readonly dimension: string
  readonly value: string
  readonly strength: string
  readonly status: string
  readonly journey_count: number
  readonly evidence_refs: unknown
  readonly source: string
  readonly last_seen_at: Date
}

export type FootprintRow = {
  readonly id: string
  readonly city: string
  readonly place: string
  readonly parent_place: string | null
  readonly dwell_sec: number
  readonly question_count: number
  readonly interest_signal: string | null
  readonly topics: readonly string[]
  readonly moment: string | null
  readonly occurred_on: Date
  readonly journey_id: string
}

export const findActiveJourney = async (userId: string): Promise<JourneyRow | null> => {
  const { rows } = await pool.query<JourneyRow>(
    `SELECT * FROM journey
      WHERE user_id = $1 AND state IN ('ACTIVE','IDLE') AND deleted_at IS NULL
      ORDER BY started_at DESC LIMIT 1`,
    [userId],
  )
  return rows[0] ?? null
}

export const findJourney = async (journeyId: string): Promise<JourneyRow | null> => {
  const { rows } = await pool.query<JourneyRow>(
    'SELECT * FROM journey WHERE id = $1 AND deleted_at IS NULL',
    [journeyId],
  )
  return rows[0] ?? null
}

export const insertLocationEvent = async (input: {
  readonly journeyId: string
  readonly userId: string
  readonly kind: string
  readonly poiId?: string | null
  readonly exhibitId?: string | null
  readonly source: string
  readonly confidence?: number | null
  readonly dwellSec?: number | null
  readonly occurredAt: Date
}): Promise<string> => {
  const id = uuidv7()
  await pool.query(
    `INSERT INTO location_event
       (id, journey_id, user_id, kind, poi_id, exhibit_id, source, confidence, dwell_sec, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, input.journeyId, input.userId, input.kind, input.poiId ?? null, input.exhibitId ?? null,
      input.source, input.confidence ?? null, input.dwellSec ?? null, input.occurredAt],
  )
  return id
}

export const insertInteraction = async (input: {
  readonly journeyId: string
  readonly userId: string
  readonly turnIndex: number
  readonly role: 'user' | 'agent'
  readonly channel: string
  readonly content: string | null
  readonly anchorId?: string | null
  readonly topicTags?: readonly string[]
  readonly evidenceRefs?: unknown
  readonly occurredAt: Date
}): Promise<string> => {
  const id = uuidv7()
  await pool.query(
    `INSERT INTO interaction
       (id, journey_id, user_id, turn_index, role, channel, content, anchor_id,
        topic_tags, evidence_refs, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, input.journeyId, input.userId, input.turnIndex, input.role, input.channel,
      input.content, input.anchorId ?? null, input.topicTags ?? [],
      input.evidenceRefs === undefined ? null : JSON.stringify(input.evidenceRefs),
      input.occurredAt],
  )
  return id
}

export const nextTurnIndex = async (journeyId: string): Promise<number> => {
  const { rows } = await pool.query<{ next: number }>(
    'SELECT COALESCE(MAX(turn_index), -1) + 1 AS next FROM interaction WHERE journey_id = $1',
    [journeyId],
  )
  return rows[0]?.next ?? 0
}

export const markIgnored = async (journeyId: string, turnIndex: number): Promise<void> => {
  await pool.query(
    'UPDATE interaction SET was_ignored = true WHERE journey_id = $1 AND turn_index = $2',
    [journeyId, turnIndex],
  )
}

/**
 * 该用户历史上已听过哪些锚点（跨旅程）。
 * 规格 02 §7.3 的「首次到访该点位」是跨旅程语义，只看本次旅程会把回头客
 * 永远判成首次访问，H5 的对照就失效了。
 */
export const listHeardAnchors = async (userId: string): Promise<readonly string[]> => {
  const { rows } = await pool.query<{ anchor_id: string }>(
    `SELECT DISTINCT i.anchor_id
       FROM interaction i
       JOIN journey j ON j.id = i.journey_id
      WHERE i.user_id = $1 AND i.role = 'agent' AND i.anchor_id IS NOT NULL
        AND j.deleted_at IS NULL`,
    [userId],
  )
  return rows.map((r) => r.anchor_id)
}

export const listPreferences = async (userId: string): Promise<readonly PreferenceRow[]> => {
  const { rows } = await pool.query<PreferenceRow>(
    `SELECT * FROM preference
      WHERE user_id = $1 AND status IN ('active','mentioned_once')
      ORDER BY strength DESC`,
    [userId],
  )
  return rows
}

export const upsertPreference = async (input: {
  readonly userId: string
  readonly dimension: PreferenceDimension
  readonly value: string
  readonly strength: number
  readonly status: 'mentioned_once' | 'active'
  readonly source: PromotableSource
  readonly evidence: unknown
  readonly journeyCount: number
  readonly seenAt: Date
}): Promise<string> => {
  const id = uuidv7()
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO preference
       (id, user_id, dimension, value, strength, status, source, evidence_refs,
        journey_count, first_seen_at, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
     ON CONFLICT (user_id, dimension, value) DO UPDATE SET
       strength      = EXCLUDED.strength,
       -- 用户标过「这不对」的不能被后续蒸馏复活（规格 01 §7.1：
       -- 「删了却还记得」会直接击穿信任）。identity_trait 那边本来就这么写
       status        = CASE WHEN preference.status = 'user_removed'
                            THEN 'user_removed' ELSE EXCLUDED.status END,
       source        = EXCLUDED.source,
       evidence_refs = EXCLUDED.evidence_refs,
       journey_count = EXCLUDED.journey_count,
       last_seen_at  = EXCLUDED.last_seen_at
     RETURNING id`,
    [id, input.userId, input.dimension, input.value, input.strength, input.status,
      input.source, JSON.stringify(input.evidence), input.journeyCount, input.seenAt],
  )
  return rows[0]?.id ?? id
}

export const listFootprints = async (
  userId: string, limit: number,
): Promise<readonly FootprintRow[]> => {
  const { rows } = await pool.query<FootprintRow>(
    `SELECT * FROM semantic_footprint
      WHERE user_id = $1 ORDER BY occurred_on DESC, dwell_sec DESC LIMIT $2`,
    [userId, limit],
  )
  return rows
}

export const insertFootprint = async (input: {
  readonly userId: string
  readonly journeyId: string
  readonly city: string
  readonly place: string
  readonly parentPlace?: string | null
  readonly dwellSec: number
  readonly questionCount: number
  readonly interestSignal: 'low' | 'medium' | 'high'
  readonly topics: readonly string[]
  readonly moment?: string | null
  readonly occurredOn: Date
}): Promise<string> => {
  const id = uuidv7()
  await pool.query(
    `INSERT INTO semantic_footprint
       (id, user_id, journey_id, city, place, parent_place, dwell_sec,
        question_count, interest_signal, topics, moment, occurred_on)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, input.userId, input.journeyId, input.city, input.place, input.parentPlace ?? null,
      input.dwellSec, input.questionCount, input.interestSignal, input.topics,
      input.moment ?? null, input.occurredOn],
  )
  return id
}

export const listIdentityTraits = async (
  userId: string,
): Promise<readonly { trait: string; explanation: string; status: string }[]> => {
  const { rows } = await pool.query<{ trait: string; explanation: string; status: string }>(
    `SELECT trait, explanation, status FROM identity_trait
      WHERE user_id = $1 AND status <> 'user_removed'`,
    [userId],
  )
  return rows
}

export const audit = async (input: {
  readonly userId: string | null
  readonly action: 'write' | 'reject' | 'promote' | 'decay' | 'delete' | 'export' | 'purge'
  readonly layer?: string | null
  readonly targetId?: string | null
  readonly reason?: string | null
  readonly actor: string
}): Promise<void> => {
  await pool.query(
    `INSERT INTO memory_audit (id, user_id, action, layer, target_id, reason, actor)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [uuidv7(), input.userId, input.action, input.layer ?? null,
      input.targetId ?? null, input.reason ?? null, input.actor],
  )
}
