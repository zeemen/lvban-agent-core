import { afterAll, describe, expect, test } from 'vitest'
import { onArrive } from '../../src/agent/respond.js'
import { ingestFixes } from '../../src/context/ingest.js'
import { startJourney } from '../../src/context/journey.js'
import { buildContextState } from '../../src/context/state.js'
import { createUser, teardown } from '../helpers/db.js'

/**
 * 精度 25–50m 的降权档 —— 规格 02 §2.2。
 *
 * 这一档以前整条不产生事件：geofence 拿 trustedAccuracyM（25m）当丢弃线，
 * 于是「只能触发软提示」在代码里等于「什么都不触发」。而夫子庙是密集街巷 +
 * 水体 + 夜间，25–50m 是常态，不是边缘情况。
 *
 * 两件事必须都成立才算接上：
 *   事件产生得出来 —— 不然降权档没有入口
 *   开口压得下去   —— 而且不能依赖客户端自报精度，否则不报就等于不降权
 */

afterAll(teardown)

const GONGYUAN = { lat: 32.0211, lng: 118.7905 }
const POI = 'fzm_jiangnan_gongyuan'

/** 走进围栏：连续两次 + 停够 20s，精度由调用方给 */
const walkIn = async (accuracyM: number) => {
  const userId = await createUser()
  const journey = await startJourney({
    userId, mode: 'companion', party: 'solo',
    sceneId: 'fuzimiao', trackConsent: 'visited_points_only',
  })
  const t0 = new Date()
  const result = await ingestFixes({
    journeyId: journey.id,
    fixes: [
      { ...GONGYUAN, accuracyM, at: t0, speedMps: 0.4 },
      { ...GONGYUAN, accuracyM, at: new Date(t0.getTime() + 25_000), speedMps: 0.3 },
    ],
  })
  return { journey, result }
}

describe('降权档有入口', () => {
  test('精度 35m 的定位现在会产生 arrive 事件', async () => {
    const { result } = await walkIn(35)

    expect(result.dropped).toBe(0)
    expect(result.events).toEqual([{ poiId: POI, kind: 'arrive' }])
  })

  test('精度 60m 仍然连定位都收不下 —— 那一档是「不猜」', async () => {
    const { result } = await walkIn(60)

    expect(result.accepted).toBe(0)
    expect(result.dropReasons).toContain('accuracy_too_low')
    expect(result.events).toEqual([])
  })
})

describe('降权档只能出气泡', () => {
  test('35m 到访只出气泡，哪怕分数够开口', async () => {
    const { journey } = await walkIn(35)

    // 刻意不传 locationConfidence / 任何精度声明：服务端自己得知道
    const turn = await onArrive({ journeyId: journey.id, poiId: POI, heardBefore: [] })

    expect(turn.decision).toBe('SOFT_HINT')
    expect(turn.proactivityReason).toContain('accuracy_degraded')
  })

  test('12m 到访照常开口 —— 对照组', async () => {
    const { journey } = await walkIn(12)

    const turn = await onArrive({ journeyId: journey.id, poiId: POI, heardBefore: [] })

    expect(turn.decision).toBe('SPEAK')
    expect(turn.proactivityReason).not.toContain('accuracy_degraded')
  })

  test('契约里能看到这次定位有多准 —— §6.1 的 accuracyM', async () => {
    const { journey } = await walkIn(35)

    const ctx = await buildContextState({ journeyId: journey.id, poiId: POI })

    expect(ctx.accuracyM).toBe(35)
    // 降权不是「不知道在哪」：§7.2 的 0.6 否决线不该被这一档拖下去
    expect(ctx.locationConfidence).toBeGreaterThanOrEqual(0.6)
  })

  test('客户端报一个更好的精度也压不回去 —— 取更差的那个', async () => {
    const { journey } = await walkIn(35)

    const ctx = await buildContextState({
      journeyId: journey.id, poiId: POI, accuracyM: 5,
    })

    expect(ctx.accuracyM).toBe(35)
  })
})
