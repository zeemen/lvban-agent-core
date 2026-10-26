import { afterAll, describe, expect, test } from 'vitest'
import { endJourney, purgeJourneyData, startJourney } from '../../src/context/journey.js'
import type { Party } from '../../src/domain/enums.js'
import { distillJourney, purgeExpiredRawTracks } from '../../src/memory/distill.js'
import { writeMemory } from '../../src/memory/gateway.js'
import * as repo from '../../src/memory/repo.js'
import { countRows, createUser, pool, teardown } from '../helpers/db.js'

/** 蒸馏管线 —— 规格 01 §4 的 D2 / D3 / D4 阈值与幂等 */

afterAll(teardown)

const runJourneyWithSignals = async (input: {
  readonly userId: string
  readonly signalCount: number
  readonly party?: Party
  readonly value?: string
  readonly confirmed?: boolean
}): Promise<string> => {
  const journey = await startJourney({
    userId: input.userId, mode: 'companion', party: input.party ?? 'solo',
    sceneId: 'fuzimiao', trackConsent: 'visited_points_only',
  })
  for (let i = 0; i < input.signalCount; i += 1) {
    await writeMemory({
      kind: 'signal', userId: input.userId, journeyId: journey.id,
      dimension: 'topic_interest', value: input.value ?? '科举',
      source: input.confirmed === true ? 'user_confirmed' : 'explicit',
      occurredAt: new Date(),
    })
  }
  await endJourney(journey.id)
  await distillJourney(journey.id)
  return journey.id
}

describe('D2 旅程 → 偏好', () => {
  test('同类信号本次只出现一次时只记 mentioned_once，不升为偏好', async () => {
    const userId = await createUser()

    await runJourneyWithSignals({ userId, signalCount: 1 })

    const prefs = await repo.listPreferences(userId)
    expect(prefs).toHaveLength(1)
    expect(prefs[0]?.status).toBe('mentioned_once')
  })

  test('同类信号出现两次才升为 active 偏好', async () => {
    const userId = await createUser()

    await runJourneyWithSignals({ userId, signalCount: 2 })

    const prefs = await repo.listPreferences(userId)
    expect(prefs[0]?.status).toBe('active')
    expect(prefs[0]?.value).toBe('科举')
  })

  test('用户确认可以绕过次数阈值直接升级', async () => {
    const userId = await createUser()

    await runJourneyWithSignals({ userId, signalCount: 1, confirmed: true })

    const prefs = await repo.listPreferences(userId)
    expect(prefs[0]?.status).toBe('active')
    expect(prefs[0]?.source).toBe('user_confirmed')
  })

  test('证据链记录了是哪次旅程、几个信号', async () => {
    const userId = await createUser()

    const journeyId = await runJourneyWithSignals({ userId, signalCount: 2 })

    const prefs = await repo.listPreferences(userId)
    const evidence = prefs[0]?.evidence_refs as { journeyId: string; signalCount: number }[]
    expect(evidence[0]?.journeyId).toBe(journeyId)
    expect(evidence[0]?.signalCount).toBe(2)
  })
})

describe('D3 偏好 → 身份', () => {
  test('跨旅程不足 3 次时不进身份层', async () => {
    const userId = await createUser()

    await runJourneyWithSignals({ userId, signalCount: 2 })
    await runJourneyWithSignals({ userId, signalCount: 2 })

    expect(await repo.listIdentityTraits(userId)).toHaveLength(0)
  })

  test('同行结构始终相同时只给候选，不自动激活', async () => {
    const userId = await createUser()

    // 三次都是 solo —— 无法证明「与同行结构无关」
    await runJourneyWithSignals({ userId, signalCount: 2, party: 'solo' })
    await runJourneyWithSignals({ userId, signalCount: 2, party: 'solo' })
    await runJourneyWithSignals({ userId, signalCount: 2, party: 'solo' })

    const traits = await repo.listIdentityTraits(userId)
    expect(traits).toHaveLength(1)
    expect(traits[0]?.status).toBe('candidate')
  })

  test('跨 3 次旅程且同行结构变化过，才沉入身份层', async () => {
    const userId = await createUser()

    await runJourneyWithSignals({ userId, signalCount: 2, party: 'solo' })
    await runJourneyWithSignals({ userId, signalCount: 2, party: 'friends' })
    await runJourneyWithSignals({ userId, signalCount: 2, party: 'solo' })

    const traits = await repo.listIdentityTraits(userId)
    expect(traits[0]?.status).toBe('active')
    expect(traits[0]?.explanation).toContain('3 次')
  })

  test('身份层每条都带人话解释，可直接展示给用户', async () => {
    const userId = await createUser()

    await runJourneyWithSignals({ userId, signalCount: 2, party: 'solo' })
    await runJourneyWithSignals({ userId, signalCount: 2, party: 'friends' })
    await runJourneyWithSignals({ userId, signalCount: 2, party: 'group' })

    const traits = await repo.listIdentityTraits(userId)
    expect(traits[0]?.explanation).toMatch(/你在 \d+ 次旅行里/)
  })
})

describe('D4 轨迹 → 足迹', () => {
  test('蒸馏后排定原始轨迹的销毁时点（7 天）', async () => {
    const userId = await createUser()
    const journey = await startJourney({
      userId, mode: 'companion', party: 'solo',
      sceneId: 'fuzimiao', trackConsent: 'full_track',
    })
    await writeMemory({
      kind: 'raw_track', userId, journeyId: journey.id,
      points: [{ lat: 32.02, lng: 118.79, accuracyM: 10, recordedAt: new Date() }],
    })
    await endJourney(journey.id)

    await distillJourney(journey.id)

    const { rows } = await pool.query<{ ended_at: Date; purge_at: Date }>(
      'SELECT ended_at, raw_track_purge_at AS purge_at FROM journey WHERE id = $1',
      [journey.id],
    )
    const gapDays = (rows[0]!.purge_at.getTime() - rows[0]!.ended_at.getTime()) / 86_400_000
    expect(gapDays).toBeCloseTo(7, 1)
  })

  test('到期的原始轨迹被物理删除，语义足迹保留', async () => {
    const userId = await createUser()
    const journey = await startJourney({
      userId, mode: 'companion', party: 'solo',
      sceneId: 'fuzimiao', trackConsent: 'full_track',
    })
    await writeMemory({
      kind: 'location_event', userId, journeyId: journey.id,
      eventKind: 'arrive', poiId: 'fzm_jiangnan_gongyuan',
      source: 'geofence', dwellSec: 300, occurredAt: new Date(),
    })
    await writeMemory({
      kind: 'raw_track', userId, journeyId: journey.id,
      points: [{ lat: 32.02, lng: 118.79, accuracyM: 10, recordedAt: new Date() }],
    })
    await endJourney(journey.id)
    await distillJourney(journey.id)

    // 把销毁时点拨到过去，模拟 7 天后的清理作业
    await pool.query(
      `UPDATE journey SET raw_track_purge_at = now() - interval '1 day' WHERE id = $1`,
      [journey.id],
    )
    await purgeExpiredRawTracks()

    expect(await countRows('raw_track_point', 'journey_id = $1', [journey.id])).toBe(0)
    expect(await countRows('semantic_footprint', 'journey_id = $1', [journey.id])).toBe(1)
  })

  test('语义足迹用展示名而非 POI ID —— 它是要给人看的', async () => {
    const userId = await createUser()
    const journey = await startJourney({
      userId, mode: 'companion', party: 'solo',
      sceneId: 'fuzimiao', trackConsent: 'visited_points_only',
    })
    await writeMemory({
      kind: 'location_event', userId, journeyId: journey.id,
      eventKind: 'arrive', poiId: 'fzm_jiangnan_gongyuan',
      source: 'geofence', dwellSec: 600, occurredAt: new Date(),
    })
    await endJourney(journey.id)
    await distillJourney(journey.id)

    const footprints = await repo.listFootprints(userId, 5)
    expect(footprints[0]?.place).toBe('江南贡院')
    expect(footprints[0]?.city).toBe('南京')
  })

  test('推断来源的位置事件不进入语义足迹', async () => {
    const userId = await createUser()
    const journey = await startJourney({
      userId, mode: 'companion', party: 'solo',
      sceneId: 'nanjing_museum', trackConsent: 'visited_points_only',
    })
    await writeMemory({
      kind: 'location_event', userId, journeyId: journey.id,
      eventKind: 'arrive', exhibitId: 'njm_cuojinyin_hu',
      source: 'inferred', confidence: 0.5, dwellSec: 300, occurredAt: new Date(),
    })
    await endJourney(journey.id)

    const report = await distillJourney(journey.id)

    expect(report.footprints).toBe(0)
  })
})

describe('蒸馏幂等', () => {
  test('重复蒸馏同一旅程会被跳过，不产生重复足迹', async () => {
    const userId = await createUser()
    const journeyId = await runJourneyWithSignals({ userId, signalCount: 2 })

    const second = await distillJourney(journeyId)

    expect(second.skipped).toBe(true)
    const prefs = await repo.listPreferences(userId)
    expect(prefs[0]?.journey_count).toBe(1)
  })

  test('force 可以重跑', async () => {
    const userId = await createUser()
    const journeyId = await runJourneyWithSignals({ userId, signalCount: 2 })

    const forced = await distillJourney(journeyId, { force: true })

    expect(forced.skipped).toBe(false)
  })
})

describe('一键删除 —— 规格 01 §7', () => {
  test('删除旅程会清掉交互、事件、信号与足迹', async () => {
    const userId = await createUser()
    const journeyId = await runJourneyWithSignals({ userId, signalCount: 2 })

    await purgeJourneyData(journeyId)

    expect(await countRows('interaction', 'journey_id = $1', [journeyId])).toBe(0)
    expect(await countRows('journey_signal', 'journey_id = $1', [journeyId])).toBe(0)
    expect(await countRows('semantic_footprint', 'journey_id = $1', [journeyId])).toBe(0)
    expect(await countRows('location_event', 'journey_id = $1', [journeyId])).toBe(0)
  })

  test('删除会留下审计记录（记录发生过删除，不记录被删内容）', async () => {
    const userId = await createUser()
    const journeyId = await runJourneyWithSignals({ userId, signalCount: 1 })

    await purgeJourneyData(journeyId)

    expect(await countRows(
      'memory_audit', `user_id = $1 AND action = 'purge'`, [userId],
    )).toBe(1)
  })
})

describe('Journey 生命周期', () => {
  test('同一用户不能同时开两段旅程', async () => {
    const userId = await createUser()
    await startJourney({
      userId, mode: 'companion', party: 'solo',
      sceneId: 'fuzimiao', trackConsent: 'none',
    })

    await expect(startJourney({
      userId, mode: 'companion', party: 'solo',
      sceneId: 'fuzimiao', trackConsent: 'none',
    })).rejects.toThrow(/已有进行中的旅程/)
  })

  test('授权快照被留证', async () => {
    const userId = await createUser()
    const journey = await startJourney({
      userId, mode: 'companion', party: 'solo',
      sceneId: 'fuzimiao', trackConsent: 'full_track',
    })

    const { rows } = await pool.query<{ consent_snapshot: { trackConsent: string } }>(
      'SELECT consent_snapshot FROM journey WHERE id = $1', [journey.id],
    )
    expect(rows[0]?.consent_snapshot.trackConsent).toBe('full_track')
  })
})
