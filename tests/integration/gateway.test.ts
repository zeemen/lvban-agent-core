import { afterAll, describe, expect, test } from 'vitest'
import { startJourney, endJourney } from '../../src/context/journey.js'
import { pool } from '../../src/db/pool.js'
import { readInferredSignals } from '../../src/memory/ephemeral.js'
import { writeMemory } from '../../src/memory/gateway.js'
import { countRows, createUser, teardown } from '../helpers/db.js'

/**
 * 写入网关 —— 规格 01 §3 的四条红线。
 * 这组用例是整套系统最不该失败的部分：它们失败等于隐私承诺失效。
 */

afterAll(teardown)

const openJourney = async (
  userId: string, trackConsent: 'none' | 'visited_points_only' | 'full_track' = 'visited_points_only',
) => startJourney({
  userId, mode: 'companion', party: 'solo', sceneId: 'fuzimiao', trackConsent,
})

describe('红线 1：系统推断永不进入长期记忆', () => {
  test('system_inferred 的信号只落 L0，preference 表拿不到它', async () => {
    // Arrange
    const userId = await createUser()
    const journey = await openJourney(userId)

    // Act
    const result = await writeMemory({
      kind: 'signal', userId, journeyId: journey.id,
      dimension: 'topic_interest', value: '青铜器',
      source: 'system_inferred', occurredAt: new Date(),
    })

    // Assert
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.layer).toBe('L0')

    const signals = await readInferredSignals(journey.id)
    expect(signals.map((s) => s.value)).toContain('青铜器')

    // 关键断言：L1 的 journey_signal 里没有它，因此 D2 永远看不到
    expect(await countRows('journey_signal', 'journey_id = $1', [journey.id])).toBe(0)
  })

  test('explicit 的同一个信号会落 L1', async () => {
    const userId = await createUser()
    const journey = await openJourney(userId)

    const result = await writeMemory({
      kind: 'signal', userId, journeyId: journey.id,
      dimension: 'topic_interest', value: '科举',
      source: 'explicit', occurredAt: new Date(),
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.layer).toBe('L1')
    expect(await countRows('journey_signal', 'journey_id = $1', [journey.id])).toBe(1)
  })

  test('preference 表在数据库层面就不接受 system_inferred', async () => {
    const userId = await createUser()

    // 绕过网关直接写库也不行——约束在 schema 上
    await expect(pool.query(
      `INSERT INTO preference (id, user_id, dimension, value, source)
       VALUES (gen_random_uuid(), $1, 'topic_interest', '青铜器', 'system_inferred')`,
      [userId],
    )).rejects.toThrow()
  })
})

describe('红线 2：没有 open 的 Journey 就没有采集', () => {
  test('旅程已结束后的写入被拒绝', async () => {
    const userId = await createUser()
    const journey = await openJourney(userId)
    await endJourney(journey.id)

    const result = await writeMemory({
      kind: 'interaction', userId, journeyId: journey.id,
      role: 'user', channel: 'text', content: '这是什么',
      occurredAt: new Date(),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('no_open_journey')
  })

  test('不存在的旅程被拒绝', async () => {
    const userId = await createUser()

    const result = await writeMemory({
      kind: 'interaction', userId, journeyId: '00000000-0000-7000-8000-000000000000',
      role: 'user', channel: 'text', content: '测试', occurredAt: new Date(),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('journey_not_found')
  })

  test('拒绝会写入审计', async () => {
    const userId = await createUser()
    const journey = await openJourney(userId)
    await endJourney(journey.id)

    await writeMemory({
      kind: 'interaction', userId, journeyId: journey.id,
      role: 'user', channel: 'text', content: '测试', occurredAt: new Date(),
    })

    expect(await countRows(
      'memory_audit', `user_id = $1 AND action = 'reject'`, [userId],
    )).toBeGreaterThan(0)
  })
})

describe('红线 3：黑名单在语义层硬拦截', () => {
  test('健康信息被拦住且不落库', async () => {
    const userId = await createUser()
    const journey = await openJourney(userId)

    const result = await writeMemory({
      kind: 'interaction', userId, journeyId: journey.id,
      role: 'user', channel: 'text', content: '我有高血压，走不了太快',
      occurredAt: new Date(),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('blocked_category')
    expect(await countRows('interaction', 'journey_id = $1', [journey.id])).toBe(0)
  })

  test('封闭集合外的偏好维度被拒绝', async () => {
    const userId = await createUser()
    const journey = await openJourney(userId)

    const result = await writeMemory({
      kind: 'signal', userId, journeyId: journey.id,
      // @ts-expect-error 故意传入集合外的维度，验证运行时也拦得住
      dimension: 'income_level', value: 'high',
      source: 'explicit', occurredAt: new Date(),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unknown_dimension')
  })
})

describe('授权校验：服务端不信任客户端', () => {
  test('track_consent 非 full_track 时原始轨迹被丢弃', async () => {
    const userId = await createUser()
    const journey = await openJourney(userId, 'visited_points_only')

    const result = await writeMemory({
      kind: 'raw_track', userId, journeyId: journey.id,
      points: [{ lat: 32.02, lng: 118.79, accuracyM: 10, recordedAt: new Date() }],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('consent_mismatch')
    expect(await countRows('raw_track_point', 'journey_id = $1', [journey.id])).toBe(0)
  })

  test('full_track 授权下原始轨迹正常写入', async () => {
    const userId = await createUser()
    const journey = await openJourney(userId, 'full_track')

    const result = await writeMemory({
      kind: 'raw_track', userId, journeyId: journey.id,
      points: [
        { lat: 32.02, lng: 118.79, accuracyM: 10, recordedAt: new Date() },
        { lat: 32.021, lng: 118.791, accuracyM: 12, recordedAt: new Date() },
      ],
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.written).toBe(2)
  })
})

describe('未成年人保护', () => {
  test('14 岁以下无监护人授权时写入被拒绝', async () => {
    const childId = await createUser({ ageBand: 'under_12', guardianUserId: null })
    const journey = await openJourney(childId)

    const result = await writeMemory({
      kind: 'interaction', userId: childId, journeyId: journey.id,
      role: 'user', channel: 'text', content: '这是什么神兽', occurredAt: new Date(),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('guardian_consent_missing')
  })

  test('挂上监护人后可以正常写入', async () => {
    const parentId = await createUser({ ageBand: '25_plus' })
    const childId = await createUser({ ageBand: 'under_12', guardianUserId: parentId })
    const journey = await openJourney(childId)

    const result = await writeMemory({
      kind: 'interaction', userId: childId, journeyId: journey.id,
      role: 'user', channel: 'text', content: '这是什么神兽', occurredAt: new Date(),
    })

    expect(result.ok).toBe(true)
  })
})
