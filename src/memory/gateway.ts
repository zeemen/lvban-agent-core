import { uuidv7 } from 'uuidv7'
import { pool } from '../db/pool.js'
import { PREFERENCE_DIMENSIONS, type MemorySource, type PreferenceDimension } from '../domain/enums.js'
import { checkBlocklist } from './blocklist.js'
import { pushInferredSignal } from './ephemeral.js'
import * as repo from './repo.js'

/**
 * Memory Write Gateway —— 规格 01 §3。
 *
 * 所有记忆写入只能经过这里。业务代码不允许直接 INSERT。
 * 这里是四条红线中三条的执行点：
 *   1. 系统推断不进长期记忆（source 分流）
 *   2. 没有 open 的 Journey 就没有采集（journey 校验）
 *   3. 黑名单在语义层硬拦截
 */

export type MemoryCandidate =
  | {
      readonly kind: 'location_event'
      readonly userId: string
      readonly journeyId: string
      readonly eventKind: 'arrive' | 'dwell' | 'leave' | 'skip' | 'confirm_zone'
      readonly poiId?: string | null
      readonly exhibitId?: string | null
      readonly source: 'geofence' | 'user_confirmed' | 'vision_anchor' | 'inferred'
      readonly confidence?: number | null
      readonly dwellSec?: number | null
      readonly occurredAt: Date
    }
  | {
      readonly kind: 'interaction'
      readonly userId: string
      readonly journeyId: string
      readonly role: 'user' | 'agent'
      readonly channel: 'text' | 'voice' | 'photo' | 'tap' | 'silent_card'
      readonly content: string
      readonly anchorId?: string | null
      readonly topicTags?: readonly string[]
      readonly evidenceRefs?: unknown
      readonly occurredAt: Date
    }
  | {
      readonly kind: 'signal'
      readonly userId: string
      readonly journeyId: string
      readonly dimension: PreferenceDimension
      readonly value: string
      readonly source: MemorySource
      readonly weight?: number
      readonly evidenceInteractionId?: string | null
      readonly occurredAt: Date
    }
  | {
      readonly kind: 'raw_track'
      readonly userId: string
      readonly journeyId: string
      readonly points: readonly {
        readonly lat: number; readonly lng: number
        readonly accuracyM: number | null; readonly recordedAt: Date
      }[]
    }

export type WriteResult =
  | { readonly ok: true; readonly layer: 'L0' | 'L1'; readonly id: string | null; readonly written: number }
  | { readonly ok: false; readonly reason: WriteRejection; readonly detail: string }

export type WriteRejection =
  | 'no_open_journey'
  | 'journey_not_found'
  | 'blocked_category'
  | 'consent_mismatch'
  | 'guardian_consent_missing'
  | 'unknown_dimension'

const OPEN_STATES = new Set(['ACTIVE', 'IDLE'])

const reject = async (
  userId: string, reason: WriteRejection, detail: string,
): Promise<WriteResult> => {
  await repo.audit({ userId, action: 'reject', reason: `${reason}: ${detail}`, actor: 'system:gateway' })
  return { ok: false, reason, detail }
}

/** 规格 01 §3.1 第 5 步：14 岁以下需监护人授权在位 */
const guardianOk = async (userId: string): Promise<boolean> => {
  const { rows } = await pool.query<{ age_band: string; guardian_user_id: string | null }>(
    'SELECT age_band, guardian_user_id FROM app_user WHERE id = $1',
    [userId],
  )
  const user = rows[0]
  if (user === undefined) return false
  if (user.age_band !== 'under_12' && user.age_band !== '12_15') return true
  return user.guardian_user_id !== null
}

export const writeMemory = async (candidate: MemoryCandidate): Promise<WriteResult> => {
  const { userId, journeyId } = candidate

  // 步骤 2：Journey 有效性。没有 open journey，一个点都不写。
  const journey = await repo.findJourney(journeyId)
  if (journey === null) return reject(userId, 'journey_not_found', journeyId)
  if (!OPEN_STATES.has(journey.state)) {
    return reject(userId, 'no_open_journey', `journey state=${journey.state}`)
  }

  // 步骤 5：未成年人检查
  if (!(await guardianOk(userId))) {
    return reject(userId, 'guardian_consent_missing', userId)
  }

  switch (candidate.kind) {
    case 'interaction': {
      // 步骤 1：黑名单（语义层）
      const verdict = checkBlocklist(candidate.content)
      if (verdict.blocked) {
        return reject(userId, 'blocked_category', `${verdict.category}:${verdict.matched}`)
      }
      const turnIndex = await repo.nextTurnIndex(journeyId)
      const id = await repo.insertInteraction({ ...candidate, turnIndex })
      await repo.audit({ userId, action: 'write', layer: 'L1', targetId: id, actor: 'system:gateway' })
      return { ok: true, layer: 'L1', id, written: 1 }
    }

    case 'location_event': {
      // candidate.kind 是联合类型的判别字段，事件类型在 eventKind 上
      const id = await repo.insertLocationEvent({ ...candidate, kind: candidate.eventKind })
      await repo.audit({ userId, action: 'write', layer: 'L1', targetId: id, actor: 'system:gateway' })
      return { ok: true, layer: 'L1', id, written: 1 }
    }

    case 'signal': {
      if (!PREFERENCE_DIMENSIONS.includes(candidate.dimension)) {
        return reject(userId, 'unknown_dimension', candidate.dimension)
      }
      const verdict = checkBlocklist(
        `${candidate.dimension} ${candidate.value}`,
        candidate.source === 'system_inferred',
      )
      if (verdict.blocked) {
        return reject(userId, 'blocked_category', `${verdict.category}:${verdict.matched}`)
      }

      // 步骤 4：来源分流。这是红线 1 的执行点。
      if (candidate.source === 'system_inferred') {
        await pushInferredSignal(journeyId, {
          dimension: candidate.dimension,
          value: candidate.value,
          at: candidate.occurredAt.toISOString(),
        })
        return { ok: true, layer: 'L0', id: null, written: 1 }
      }

      const id = uuidv7()
      await pool.query(
        `INSERT INTO journey_signal
           (id, journey_id, user_id, dimension, value, weight, source,
            evidence_interaction_id, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, journeyId, userId, candidate.dimension, candidate.value,
          candidate.weight ?? 1, candidate.source,
          candidate.evidenceInteractionId ?? null, candidate.occurredAt],
      )
      await repo.audit({ userId, action: 'write', layer: 'L1', targetId: id, actor: 'system:gateway' })
      return { ok: true, layer: 'L1', id, written: 1 }
    }

    case 'raw_track': {
      // 步骤 3：授权检查。服务端不信任客户端，非 full_track 直接丢弃。
      if (journey.track_consent !== 'full_track') {
        return reject(userId, 'consent_mismatch', `track_consent=${journey.track_consent}`)
      }
      if (candidate.points.length === 0) return { ok: true, layer: 'L1', id: null, written: 0 }

      const values = candidate.points
        .map((_, i) => `($1, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4}, $${i * 4 + 5})`)
        .join(',')
      const params = [journeyId, ...candidate.points.flatMap(
        (p) => [p.lat, p.lng, p.accuracyM, p.recordedAt] as const,
      )]
      await pool.query(
        `INSERT INTO raw_track_point (journey_id, lat, lng, accuracy_m, recorded_at) VALUES ${values}`,
        params,
      )
      return { ok: true, layer: 'L1', id: null, written: candidate.points.length }
    }
  }
}
