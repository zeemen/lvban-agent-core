import { afterAll, describe, expect, test } from 'vitest'
import { onArrive } from '../../src/agent/respond.js'
import { ingestFixes } from '../../src/context/ingest.js'
import { startJourney } from '../../src/context/journey.js'
import { buildContextState } from '../../src/context/state.js'
import { readProactiveCount, recordSpoke } from '../../src/memory/ephemeral.js'
import { createUser, teardown } from '../helpers/db.js'

/**
 * 主动开口的次数 —— 规格 02 §7.3 第 7 行「本次旅程已开口次数 > 时长/10min」。
 *
 * 在这条用例写出来之前，那一行比的是 `visitedAnchors.length`（去重的到访**点位**数）：
 * 一个默默走过很多点位、系统一次都没开口的用户会被扣 0.20，
 * 而且越是沉默地逛得多就越不可能开口，自我强化。
 *
 * 计数的口径必须和 lastProactiveSecAgo 完全一致，否则两条频次控制会打架：
 * 回答提问不算，出一张静默卡片也不算。
 */

afterAll(teardown)

const GONGYUAN = { lat: 32.0211, lng: 118.7905 }
const POI = 'fzm_jiangnan_gongyuan'
const ANCHOR = 'fzm_jiangnan_gongyuan_haoshe'

const openAndWalkIn = async () => {
  const userId = await createUser()
  const journey = await startJourney({
    userId, mode: 'companion', party: 'solo',
    sceneId: 'fuzimiao', trackConsent: 'visited_points_only',
  })
  const t0 = new Date()
  await ingestFixes({
    journeyId: journey.id,
    fixes: [
      { ...GONGYUAN, accuracyM: 12, at: t0, speedMps: 0.4 },
      { ...GONGYUAN, accuracyM: 14, at: new Date(t0.getTime() + 25_000), speedMps: 0.3 },
    ],
  })
  return journey
}

describe('数的是主动开口', () => {
  test('主动讲解一次，计数就是 1', async () => {
    const journey = await openAndWalkIn()
    expect(await readProactiveCount(journey.id)).toBe(0)

    const turn = await onArrive({ journeyId: journey.id, poiId: POI, heardBefore: [] })

    expect(turn.decision).toBe('SPEAK')
    expect(await readProactiveCount(journey.id)).toBe(1)
  })

  test('出一张气泡不涨计数 —— 它没出声', async () => {
    const journey = await openAndWalkIn()

    const turn = await onArrive({ journeyId: journey.id, poiId: POI, heardBefore: [ANCHOR] })

    expect(turn.decision).toBe('SOFT_HINT')
    expect(await readProactiveCount(journey.id)).toBe(0)
  })

  test('回答用户提问不涨计数 —— 那不是主动', async () => {
    const journey = await openAndWalkIn()

    // 答问那条路径记的就是这一个（src/agent/respond.ts 的 answer 分支、
    // 以及流式的 respond-stream.ts），它只管「刚出过声，别叠话」。
    await recordSpoke(journey.id, new Date())

    expect(await readProactiveCount(journey.id)).toBe(0)
  })
})

describe('装配进 Context State', () => {
  test('计数跨回合累加，并出现在 §6.1 的契约里', async () => {
    const journey = await openAndWalkIn()

    const first = await buildContextState({ journeyId: journey.id, poiId: POI })
    expect(first.proactiveCount).toBe(0)

    await onArrive({ journeyId: journey.id, poiId: POI, heardBefore: [] })

    const after = await buildContextState({ journeyId: journey.id, poiId: POI })
    expect(after.proactiveCount).toBe(1)
    // 到访点位已经记上了，但它不再参与这一项的判断
    expect(after.visitedAnchors.length).toBeGreaterThan(0)
  })
})
