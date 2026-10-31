import { vision as cfg } from '../config/index.js'
import { anchorForPlace, loadAnchors } from '../content/loader.js'
import { pool } from '../db/pool.js'
import { writeMemory } from '../memory/gateway.js'

/**
 * 室内注意力落位 —— 规格 02 §4.2 识别链路的最后一步「写 location_event」。
 *
 * 室内不做空间定位（见 provenance.ts 开头）。这里记的不是「人在哪」，
 * 而是「人正在看哪件」——由游客的动作立起来，所以只有两种来源：
 * 他自己点的（user_confirmed 1.0）或拍照认出来的（vision_anchor = VLM top-1 分）。
 *
 * 落位要成立，三件事都得对：
 *   写得进去 —— 不然下一句话还得让客户端重报一遍
 *   读得回来 —— 拍完就问，服务端自己知道在看哪件
 *   撤得下来 —— 认错了不撤，语义足迹里会留下一件其实没看过的展品
 *
 * 事件 kind 一律用 confirm_zone。室内没有「到达」这种事件（规格 02 §237：
 * 围栏命中是室外的事），arrive 会让人以为室内也有围栏触发。
 * confirm_zone 读作「注意力落到这个点位上了」，是谁立的由 source 说。
 */

/** 落位过的注意力。inferred 不在其中：它的意思本来就是「不知道」 */
export type IndoorAttention = {
  readonly placeId: string
  readonly source: 'user_confirmed' | 'vision_anchor'
  readonly confidence: number
}

/** §4.1 ①：游客自己点的就是 1.0 */
const USER_CONFIRMED = 1

export type AttentionRejection =
  /** 这个 id 指不到任何锚点 */
  | 'unknown_place'
  /** 指得到，但那个锚点不在这趟旅程的场景里 */
  | 'wrong_scene'
  /** 写入网关拒了（旅程没开、监护人授权缺失等） */
  | 'write_rejected'

export type AttentionResult =
  | { readonly ok: true; readonly locationEventId: string }
  | { readonly ok: false; readonly reason: AttentionRejection }

/**
 * 落位前先确认这个 id 指得到东西。
 *
 * 不校验的后果不是报错，是**静默撒谎**：客户端报什么就落什么，Context 会用
 * user_confirmed/1.0 的口气说「正在看这件」，语义足迹也会记上，可
 * anchorForPlace 取不到锚点，K1 和八要素一个都到不了用户。这和语料里那套
 * 指不到的占位编号是同一种病，只是发生在运行时。
 *
 * 刻意用应答路径同一个 anchorForPlace：这里认了，那边就一定取得到锚点。
 * 换成自己写一套匹配规则，两边迟早漂。
 *
 * 不缓存 loadAnchors：落位是一次拍照／一次点选才走一趟，不在热路径上，
 * 而缓存会让新加的锚点必须重启才认。
 */
const checkPlace = async (
  placeId: string, sceneId: string,
): Promise<AttentionRejection | null> => {
  const anchor = anchorForPlace(await loadAnchors(), placeId)
  if (anchor === null) return 'unknown_place'
  if (anchor.sceneId !== sceneId) return 'wrong_scene'
  return null
}

/**
 * 落位一次视觉识别（§4.2 链路末端）。返回事件 id，网关拒了则返回 null。
 *
 * 只在 auto_accept 时该调：候选还没收敛到一件就落位，等于替游客做了决定。
 */
export const recordVisionAnchor = async (input: {
  readonly journeyId: string
  readonly userId: string
  readonly sceneId: string
  readonly exhibitId: string
  readonly confidence: number
  readonly occurredAt?: Date
}): Promise<AttentionResult> => {
  // 候选集理论上不该给出指不到的 id，但不靠它保证——zoneHint 是客户端传的
  const bad = await checkPlace(input.exhibitId, input.sceneId)
  if (bad !== null) return { ok: false, reason: bad }

  const result = await writeMemory({
    kind: 'location_event',
    userId: input.userId,
    journeyId: input.journeyId,
    eventKind: 'confirm_zone',
    exhibitId: input.exhibitId,
    source: 'vision_anchor',
    confidence: input.confidence,
    occurredAt: input.occurredAt ?? new Date(),
  })
  return result.ok && result.id !== null
    ? { ok: true, locationEventId: result.id }
    : { ok: false, reason: 'write_rejected' }
}

/** 游客点选或纠正后的落位（§4.1 ①）。他说是哪件就是哪件，不打折 */
export const recordUserPick = async (input: {
  readonly journeyId: string
  readonly userId: string
  readonly sceneId: string
  readonly exhibitId: string
  readonly occurredAt?: Date
}): Promise<AttentionResult> => {
  /*
   * 这里是客户端直接报的 id，最需要挡。
   * 「游客说是哪件就是哪件」只在候选集之内成立——候选是我们给的，
   * 报回一个不在里面的 id，不是游客的意思，是客户端出了问题。
   */
  const bad = await checkPlace(input.exhibitId, input.sceneId)
  if (bad !== null) return { ok: false, reason: bad }

  const result = await writeMemory({
    kind: 'location_event',
    userId: input.userId,
    journeyId: input.journeyId,
    eventKind: 'confirm_zone',
    exhibitId: input.exhibitId,
    source: 'user_confirmed',
    confidence: USER_CONFIRMED,
    occurredAt: input.occurredAt ?? new Date(),
  })
  return result.ok && result.id !== null
    ? { ok: true, locationEventId: result.id }
    : { ok: false, reason: 'write_rejected' }
}

/**
 * 撤回一条认错的识别。
 *
 * 真删，不是标记：这条记录是系统猜的，游客已经明说猜错了，留着它
 * 语义足迹就会多出一件没看过的展品（规格 02 §4.4）。
 * 只删 vision_anchor —— 游客自己点的不是系统猜的，没有可撤的道理。
 */
export const retractVisionAnchor = async (input: {
  readonly journeyId: string
  readonly locationEventId: string
}): Promise<boolean> => {
  const { rowCount } = await pool.query(
    `DELETE FROM location_event
      WHERE id = $1 AND journey_id = $2 AND source = 'vision_anchor'`,
    [input.locationEventId, input.journeyId],
  )
  return (rowCount ?? 0) > 0
}

/**
 * 读回当前落位的注意力，没有就是 null。
 *
 * 只看最新那一条：拍了另一件就是把注意力移过去了，不该再翻出更早的点选顶上。
 * 所以最新一条过期时答案是「不知道」，而不是退回上一条。
 *
 * 有效期只管视觉识别。游客自己点的按 §4.1「锁定，直到用户改」不过期——
 * 改的方式就是再点一次或拍一张，那会成为新的最新一条。
 */
export const readIndoorAttention = async (
  journeyId: string, now: Date = new Date(),
): Promise<IndoorAttention | null> => {
  const { rows } = await pool.query<{
    place_id: string
    source: 'user_confirmed' | 'vision_anchor'
    confidence: string | null
    occurred_at: Date
  }>(
    `SELECT COALESCE(poi_id, exhibit_id) AS place_id, source, confidence, occurred_at
       FROM location_event
      WHERE journey_id = $1
        AND source IN ('user_confirmed', 'vision_anchor')
        AND COALESCE(poi_id, exhibit_id) IS NOT NULL
      ORDER BY occurred_at DESC, id DESC
      LIMIT 1`,
    [journeyId],
  )

  const latest = rows[0]
  if (latest === undefined) return null

  if (latest.source === 'vision_anchor') {
    const ageSec = (now.getTime() - latest.occurred_at.getTime()) / 1000
    if (ageSec > cfg.attentionTtlSec) return null
  }

  return {
    placeId: latest.place_id,
    source: latest.source,
    // vision_anchor 的 confidence 由库里的 CHECK 保证非空；点选固定 1.0
    confidence: latest.confidence === null ? USER_CONFIRMED : Number(latest.confidence),
  }
}
