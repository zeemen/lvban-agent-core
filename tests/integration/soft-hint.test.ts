import { afterAll, describe, expect, test } from 'vitest'
import { onArrive } from '../../src/agent/respond.js'
import { generateTravelogue } from '../../src/agent/travelogue.js'
import { ingestFixes } from '../../src/context/ingest.js'
import { startJourney } from '../../src/context/journey.js'
import {
  readLastProactiveSpoke, readLastSpoke, recordProactiveSpoke,
} from '../../src/memory/ephemeral.js'
import * as repo from '../../src/memory/repo.js'
import { createUser, pool, teardown } from '../helpers/db.js'
import type { Mode } from '../../src/domain/enums.js'

/**
 * SOFT_HINT 的输出通道 —— 规格 02 §7.1「气泡/震动，不出声」。
 *
 * 在这条用例写出来之前，`onArrive` 把任何非 SPEAK 一律当沉默处理：
 * 主动性引擎算得出 SOFT_HINT，但它到不了用户，网关枚举里的
 * silent_card 也没有任何地方产出。
 */

afterAll(teardown)

const GONGYUAN = { lat: 32.0211, lng: 118.7905 }
const POI = 'fzm_jiangnan_gongyuan'
const ANCHOR = 'fzm_jiangnan_gongyuan_haoshe'
const HOOK = '这格子比你宿舍床还窄，九天七夜吃住考都在里面。'
/** 已听过时换的那一栏：companion 档的反问（规格 03 §3.3） */
const REVISIT = '想不想知道当年落榜的人回家怎么跟爸妈交代？'

const openAndWalkIn = async (mode: Mode = 'companion') => {
  const userId = await createUser()
  const journey = await startJourney({
    userId, mode, party: 'solo',
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

const silentCardRows = async (journeyId: string) => {
  const { rows } = await pool.query<{ role: string; content: string; anchor_id: string | null }>(
    `SELECT role, content, anchor_id FROM interaction
      WHERE journey_id = $1 AND channel = 'silent_card'`,
    [journeyId],
  )
  return rows
}

describe('分不够开口、够得上气泡', () => {
  test('已听过本锚点 → 出一张静默卡片，不出声', async () => {
    const journey = await openAndWalkIn()

    const turn = await onArrive({
      journeyId: journey.id, poiId: POI, heardBefore: [ANCHOR],
    })

    expect(turn.decision).toBe('SOFT_HINT')
    expect(turn.spoke).toBe(false)
    expect(turn.text).toBeNull()
    expect(turn.card).toEqual({
      anchorId: ANCHOR,
      name: '江南贡院 · 号舍',
      // 已听过 → 换反问，不重播开场钩子；换了栏就没有预合成音频
      hint: REVISIT,
      audioKey: null,
    })
  })

  test('卡片要留痕：记一条 channel=silent_card 的 interaction', async () => {
    const journey = await openAndWalkIn()

    await onArrive({ journeyId: journey.id, poiId: POI, heardBefore: [ANCHOR] })

    const rows = await silentCardRows(journey.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ role: 'agent', content: REVISIT, anchor_id: ANCHOR })
  })

  test('气泡不占用「刚讲过」那 60 秒——它没出声', async () => {
    const journey = await openAndWalkIn()

    await onArrive({ journeyId: journey.id, poiId: POI, heardBefore: [ANCHOR] })

    expect(await readLastSpoke(journey.id)).toBeNull()
  })

  test('气泡也不消耗主动频次预算——§7.4 数的是「主动开口」', async () => {
    const journey = await openAndWalkIn()

    await onArrive({ journeyId: journey.id, poiId: POI, heardBefore: [ANCHOR] })

    expect(await readLastProactiveSpoke(journey.id)).toBeNull()
  })
})

describe('频次到了就降一档', () => {
  test('刚主动开口过 → 首访也只给气泡，并说明是被频次压的', async () => {
    const journey = await openAndWalkIn()
    await recordProactiveSpoke(journey.id, new Date())

    const turn = await onArrive({ journeyId: journey.id, poiId: POI, heardBefore: [] })

    expect(turn.decision).toBe('SOFT_HINT')
    expect(turn.proactivityReason).toContain('speak_rate_limited')
    expect(turn.text).toBeNull()
    // 首访没听过，所以用开场钩子——它是 Top 30，预合成过，点一下能播
    expect(turn.card).toEqual({
      anchorId: ANCHOR,
      name: '江南贡院 · 号舍',
      hint: HOOK,
      audioKey: `anchors/${ANCHOR}.companion.mp3`,
    })
  })
})

describe('开口那条路没变', () => {
  test('首访照常开口，并同时记下「出过声」与「主动开过口」', async () => {
    const journey = await openAndWalkIn()

    const turn = await onArrive({ journeyId: journey.id, poiId: POI, heardBefore: [] })

    expect(turn.decision).toBe('SPEAK')
    expect(turn.spoke).toBe(true)
    expect(turn.text).not.toBeNull()
    expect(turn.card).toBeNull()
    expect(await readLastSpoke(journey.id)).not.toBeNull()
    expect(await readLastProactiveSpoke(journey.id)).not.toBeNull()
    expect(await silentCardRows(journey.id)).toHaveLength(0)
  })
})

/*
 * 2026-11-03 评审抓到的那一类：卡片进了 interaction 留痕，而每一个
 * 「讲过没有」的读取方都没有排除它。后果不是报错，是一次气泡把 Top 30
 * 锚点永久标成「已听过」——此后每次到访分数都掉到 soft 区间，只剩气泡，
 * 自我强化，而且一个字都不报。下面这组就是钉住它的。
 */
describe('卡片不等于讲过', () => {
  test('出过气泡的锚点不会被记成「已听过」', async () => {
    const journey = await openAndWalkIn()

    await onArrive({ journeyId: journey.id, poiId: POI, heardBefore: [ANCHOR] })

    // 走真实查询，不是用例自己传进去的 heardBefore
    expect(await repo.listHeardAnchors(journey.user_id)).not.toContain(ANCHOR)
  })

  test('所以下一次到访照样能开口，不会卡在只出气泡的循环里', async () => {
    const journey = await openAndWalkIn()
    // 先让频次把一次本该开口的到达压成气泡
    await recordProactiveSpoke(journey.id, new Date())
    const first = await onArrive({ journeyId: journey.id, poiId: POI })
    expect(first.decision).toBe('SOFT_HINT')

    // 「频次过去之后再来」要把旅程本身也往前推：§7.3 第 7 行的预算是
    // 「时长/10min」，旅程才刚开始时预算只有 1 次，不推就变成在考两件事。
    await pool.query(
      `UPDATE journey SET started_at = now() - interval '25 minutes' WHERE id = $1`,
      [journey.id],
    )
    await recordProactiveSpoke(journey.id, new Date(Date.now() - 20 * 60_000))
    // 这里不传 heardBefore，由服务端自己查
    const second = await onArrive({ journeyId: journey.id, poiId: POI })

    expect(second.decision).toBe('SPEAK')
    expect(second.text).not.toBeNull()
  })

  test('只出过气泡的锚点不进游记的素材 —— 没听过的史实不该被当成听过了', async () => {
    const journey = await openAndWalkIn()

    await onArrive({ journeyId: journey.id, poiId: POI, heardBefore: [ANCHOR] })
    const travelogue = await generateTravelogue(journey.id)

    // 四个锚点现在都是 draft：被算成到访过，就会体现为「因未过审而排除 1 个」
    expect(travelogue.draftAnchorsExcluded).toBe(0)
  })
})

describe('记不下来也要把气泡给出去', () => {
  test('写入被拒时仍然返回卡片 —— 记账失败不该让用户少看一句', async () => {
    const journey = await openAndWalkIn()
    // 旅程结束之后网关会拒写（红线 2），模拟一次记账失败
    await pool.query(`UPDATE journey SET state = 'ENDED' WHERE id = $1`, [journey.id])

    const turn = await onArrive({ journeyId: journey.id, poiId: POI, heardBefore: [ANCHOR] })

    expect(turn.decision).toBe('SOFT_HINT')
    expect(turn.card?.hint).not.toBe(undefined)
    // vetoedBy 是 §7.2 的否决者，写入被拒不是否决
    expect(turn.vetoedBy).toBeNull()
  })
})

describe('已听过就换一个侧面（规格 03 §3.3）', () => {
  test('重访时气泡不重播原来那一句', async () => {
    const journey = await openAndWalkIn()

    const turn = await onArrive({ journeyId: journey.id, poiId: POI, heardBefore: [ANCHOR] })

    expect(turn.card).not.toBeNull()
    expect(turn.card?.hint).not.toBe(HOOK)
    expect(turn.usedElements).not.toContain('openingHook')
  })
})
