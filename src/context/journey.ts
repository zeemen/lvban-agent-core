import { uuidv7 } from 'uuidv7'
import { pool } from '../db/pool.js'
import type { Mode, Party, TrackConsent } from '../domain/enums.js'
import * as repo from '../memory/repo.js'
import { purgeJourney } from '../memory/ephemeral.js'

/**
 * Journey 状态机 —— 规格 02 §1。
 *
 * Journey 是采集的最小授权单元：没有 open 的 Journey，采集层一个点都不传。
 * 自动结束必须通知用户（规格 02 §1）—— 悄悄结束等于悄悄停止服务。
 */

const IDLE_AFTER_MIN = 30
const AUTO_END_AFTER_IDLE_MIN = 60

export type StartJourneyInput = {
  readonly userId: string
  readonly mode: Mode
  readonly party: Party
  readonly sceneId: string
  readonly trackConsent: TrackConsent
  readonly coTravelers?: readonly string[]
}

export const startJourney = async (input: StartJourneyInput): Promise<repo.JourneyRow> => {
  const existing = await repo.findActiveJourney(input.userId)
  if (existing !== null) {
    throw new Error(`该用户已有进行中的旅程：${existing.id}（先结束它）`)
  }

  const id = uuidv7()
  const consentSnapshot = {
    trackConsent: input.trackConsent,
    grantedAt: new Date().toISOString(),
    locationPermission: input.trackConsent !== 'none',
  }

  await pool.query(
    `INSERT INTO journey
       (id, user_id, mode, party, co_travelers, scene_id, state,
        track_consent, consent_snapshot, started_at)
     VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE',$7,$8, now())`,
    [id, input.userId, input.mode, input.party, input.coTravelers ?? [],
      input.sceneId, input.trackConsent, JSON.stringify(consentSnapshot)],
  )

  const journey = await repo.findJourney(id)
  if (journey === null) throw new Error('旅程创建后读取失败')
  return journey
}

export const endJourney = async (
  journeyId: string, options: { readonly auto?: boolean } = {},
): Promise<repo.JourneyRow> => {
  const state = options.auto === true ? 'AUTO_ENDED' : 'ENDED'
  await pool.query(
    `UPDATE journey SET state = $2, ended_at = COALESCE(ended_at, now())
      WHERE id = $1 AND state IN ('ACTIVE','IDLE')`,
    [journeyId, state],
  )
  const journey = await repo.findJourney(journeyId)
  if (journey === null) throw new Error(`旅程不存在：${journeyId}`)
  return journey
}

/** 任意交互把 IDLE 拉回 ACTIVE（规格 02 §1 状态图） */
export const touchJourney = async (journeyId: string): Promise<void> => {
  await pool.query(`UPDATE journey SET state = 'ACTIVE' WHERE id = $1 AND state = 'IDLE'`, [journeyId])
}

/**
 * 空闲/超时扫描。返回需要通知用户的自动结束旅程。
 * 判定依据：最后一次交互距今的时长。
 */
export const sweepIdleJourneys = async (): Promise<readonly string[]> => {
  await pool.query(
    `UPDATE journey j SET state = 'IDLE'
      WHERE j.state = 'ACTIVE'
        AND COALESCE(
              (SELECT MAX(i.occurred_at) FROM interaction i WHERE i.journey_id = j.id),
              j.started_at
            ) < now() - make_interval(mins => $1::int)`,
    [IDLE_AFTER_MIN],
  )

  const { rows } = await pool.query<{ id: string }>(
    `UPDATE journey j SET state = 'AUTO_ENDED', ended_at = now()
      WHERE j.state = 'IDLE'
        AND COALESCE(
              (SELECT MAX(i.occurred_at) FROM interaction i WHERE i.journey_id = j.id),
              j.started_at
            ) < now() - make_interval(mins => $1::int)
      RETURNING j.id`,
    [IDLE_AFTER_MIN + AUTO_END_AFTER_IDLE_MIN],
  )
  return rows.map((r) => r.id)
}

/** 规格 01 §7：一键删除本次全部记录。级联由外键完成，L0 单独清。 */
export const purgeJourneyData = async (journeyId: string): Promise<void> => {
  const journey = await repo.findJourney(journeyId)
  if (journey === null) return
  await purgeJourney(journeyId)
  await pool.query(`UPDATE journey SET state = 'PURGED', deleted_at = now() WHERE id = $1`, [journeyId])
  await pool.query('DELETE FROM raw_track_point WHERE journey_id = $1', [journeyId])
  await pool.query('DELETE FROM semantic_footprint WHERE journey_id = $1', [journeyId])
  await pool.query('DELETE FROM journey_signal WHERE journey_id = $1', [journeyId])
  await pool.query('DELETE FROM location_event WHERE journey_id = $1', [journeyId])
  await pool.query('DELETE FROM interaction WHERE journey_id = $1', [journeyId])
  await repo.audit({
    userId: journey.user_id, action: 'purge', layer: 'L1',
    reason: 'user requested journey deletion', actor: 'user',
  })
}
