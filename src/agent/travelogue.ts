import { pool } from '../db/pool.js'
import { loadAnchors, type Anchor } from '../content/loader.js'
import type { Mode } from '../domain/enums.js'
import { readInferredSignals } from '../memory/ephemeral.js'
import * as repo from '../memory/repo.js'
import { complete } from '../models/router.js'

/**
 * 行后游记（PRD U12、规格 04 §7.1）。
 *
 * 硬约束：**游记里出现的每一条史实，都来自已审校的锚点要素或 K1**，
 * 不由生成模型自由发挥。用户自己说过的话可以原样引用——
 * 这正是「像自己写的」而不是模板填空的来源。
 *
 * 所以这里的做法是先把素材收齐并按可信度分类，再把「能用什么」
 * 明确写进 prompt，而不是把一堆上下文丢给模型让它自己拿捏。
 */

export type TimelineEntry = {
  readonly place: string
  readonly dwellSec: number
  readonly questionCount: number
  readonly interestSignal: string | null
  readonly topics: readonly string[]
}

export type Quote = { readonly text: string; readonly at: string }

export type Fact = {
  readonly anchorId: string
  readonly name: string
  readonly text: string
  readonly source: string
}

export type PendingPreference = {
  readonly dimension: string
  readonly value: string
  readonly reason: string
}

/**
 * 规格 01 §7.2：旅程结束的回顾页必须交代本次记了什么，
 * 并提供一键删除——这个入口「不允许折叠在二级菜单里」。
 */
export type JourneyRecord = {
  readonly pointCount: number
  readonly questionCount: number
  readonly trackConsent: string
}

/** 这次新记住的偏好。列出来是为了让用户当场能说「这不对」 */
export type NewPreference = {
  readonly id: string
  readonly dimension: string
  readonly value: string
  readonly status: string
}

export type TravelogueMaterial = {
  readonly journeyId: string
  readonly sceneId: string
  readonly occurredOn: string
  readonly timeline: readonly TimelineEntry[]
  readonly quotes: readonly Quote[]
  readonly facts: readonly Fact[]
  /** 推断出来但尚未升 L2 的偏好，交用户确认（规格 01 D2） */
  readonly pendingPreferences: readonly PendingPreference[]
  /** 因为审校状态不是 approved 而被排除的锚点数——内容没过审时要能解释史实为何为空 */
  readonly draftAnchorsExcluded: number
  readonly record: JourneyRecord
  readonly newPreferences: readonly NewPreference[]
}

/**
 * 篇幅跟着素材走。
 *
 * 实测教训：素材只有一句用户原话、零条足迹时，不设上限的模型会写出 400 多字的
 * 一整天——地铁站、画舫、大成殿、晒太阳的猫，全是编的。规格管的是「史实」，
 * 而这种编造的是**用户的经历**，对一个记忆产品更糟：它在替人捏造没过过的一天。
 */
const BASE_CHARS = 120
const CHARS_PER_ITEM = 60
const MAX_CHARS = 600

const allowedChars = (material: TravelogueMaterial): number => {
  const items = material.timeline.length + material.quotes.length + material.facts.length
  return Math.min(MAX_CHARS, BASE_CHARS + items * CHARS_PER_ITEM)
}

/** 锚点要素按模式分三副口吻，游记沿用这次旅程的那一副 */
const VOICE_BY_MODE = {
  companion: 'companion', family_study: 'child', light_guide: 'light',
} as const satisfies Record<Mode, 'companion' | 'child' | 'light'>

/** 只取已审校锚点的要素；K1 来源一并带出，游记末尾要能列出处 */
const factsFromAnchor = (anchor: Anchor, mode: Mode): readonly Fact[] => {
  const source = anchor.k1Sources[0]?.title ?? anchor.k1Sources[0]?.publisher ?? '馆方说明'
  const voice = VOICE_BY_MODE[mode]
  const pieces = [
    anchor.elements.explanation[voice],
    anchor.elements.observation[voice],
    anchor.elements.story,
  ].filter((t): t is string => typeof t === 'string' && t.trim() !== '')
  return pieces.map((text) => ({
    anchorId: anchor.anchorId, name: anchor.name, text, source,
  }))
}

export const collectMaterial = async (
  journeyId: string, options: { readonly allowDraftAnchors?: boolean } = {},
): Promise<TravelogueMaterial> => {
  const journey = await repo.findJourney(journeyId)
  if (journey === null) throw new Error(`旅程不存在：${journeyId}`)

  const { rows: footprints } = await pool.query<{
    place: string; dwell_sec: number; question_count: number
    interest_signal: string | null; topics: string[]
  }>(
    `SELECT place, dwell_sec, question_count, interest_signal, topics
       FROM semantic_footprint WHERE journey_id = $1
      ORDER BY dwell_sec DESC`,
    [journeyId],
  )

  const { rows: quotes } = await pool.query<{ content: string; occurred_at: Date }>(
    `SELECT content, occurred_at FROM interaction
      WHERE journey_id = $1 AND role = 'user' AND content IS NOT NULL AND content <> ''
      ORDER BY turn_index`,
    [journeyId],
  )

  const { rows: visited } = await pool.query<{ anchor_id: string }>(
    `SELECT DISTINCT anchor_id FROM interaction
      WHERE journey_id = $1 AND anchor_id IS NOT NULL`,
    [journeyId],
  )

  const anchorMap = await loadAnchors()
  let excluded = 0
  const facts: Fact[] = []
  for (const row of visited) {
    const anchor = anchorMap.get(row.anchor_id)
    if (anchor === undefined) continue
    // 没过审的内容不能进游记：这是规格 04 §7.1 的硬约束，
    // 本地预览可以显式放开，但默认必须挡住
    if (anchor.review.status !== 'approved' && options.allowDraftAnchors !== true) {
      excluded += 1
      continue
    }
    facts.push(...factsFromAnchor(anchor, journey.mode))
  }

  const { rows: counts } = await pool.query<{ points: string; questions: string }>(
    `SELECT
       (SELECT COUNT(DISTINCT COALESCE(poi_id, exhibit_id))::text
          FROM location_event WHERE journey_id = $1
           AND COALESCE(poi_id, exhibit_id) IS NOT NULL) AS points,
       (SELECT COUNT(*)::text FROM interaction
         WHERE journey_id = $1 AND role = 'user') AS questions`,
    [journeyId],
  )

  // 本次新记住的偏好：证据链里含这个 journeyId 的那些。
  // 用 jsonb 包含判断，证据条目形如 {journeyId, party, signalCount, at}
  const { rows: newPrefs } = await pool.query<NewPreference>(
    `SELECT id, dimension, value, status FROM preference
      WHERE user_id = $1 AND status <> 'user_removed'
        AND evidence_refs @> jsonb_build_array(jsonb_build_object('journeyId', $2::text))
      ORDER BY value`,
    [journey.user_id, journeyId],
  )

  const signals = await readInferredSignals(journeyId)
  const seen = new Set<string>()
  const pendingPreferences: PendingPreference[] = []
  for (const signal of signals) {
    const key = `${signal.dimension}:${signal.value}`
    if (seen.has(key)) continue
    seen.add(key)
    pendingPreferences.push({
      dimension: signal.dimension,
      value: signal.value,
      reason: '这条是系统从你的行为里猜的，只有你确认之后才会被记住',
    })
  }

  return {
    journeyId,
    sceneId: journey.scene_id,
    occurredOn: journey.started_at.toISOString().slice(0, 10),
    timeline: footprints.map((f) => ({
      place: f.place, dwellSec: f.dwell_sec, questionCount: f.question_count,
      interestSignal: f.interest_signal, topics: f.topics,
    })),
    quotes: quotes.map((q) => ({ text: q.content, at: q.occurred_at.toISOString() })),
    facts,
    pendingPreferences,
    draftAnchorsExcluded: excluded,
    record: {
      pointCount: Number(counts[0]?.points ?? 0),
      questionCount: Number(counts[0]?.questions ?? 0),
      trackConsent: journey.track_consent,
    },
    newPreferences: newPrefs,
  }
}

const minutes = (sec: number): number => Math.max(1, Math.round(sec / 60))

export const buildTraveloguePrompt = (material: TravelogueMaterial): string => {
  const timeline = material.timeline.length === 0
    ? '（没有记录到停留点）'
    : material.timeline
        .map((t) => `${t.place}：停留约 ${minutes(t.dwellSec)} 分钟，`
          + `提问 ${t.questionCount} 次${t.topics.length === 0 ? '' : `，话题 ${t.topics.join('、')}`}`)
        .join('；')

  const quotes = material.quotes.length === 0
    ? '（这次没有留下原话）'
    : material.quotes.map((q, i) => `${i + 1}. ${q.text}`).join('\n')

  const facts = material.facts.length === 0
    ? ''
    : material.facts.map((f, i) => `${i + 1}. [${f.name}] ${f.text}（出处：${f.source}）`).join('\n')

  const limit = allowedChars(material)
  const nothing = material.timeline.length === 0
    && material.quotes.length === 0 && material.facts.length === 0

  return [
    '你在帮一个人把今天的旅行写成一篇游记。写成他自己写的样子，不是导游词，也不是模板填空。',
    '',
    `【这次去了哪儿】${material.sceneId}，${material.occurredOn}。`,
    `【足迹】${timeline}`,
    '',
    '【他自己说过的话 —— 可以原样引用，这是这篇文章像他写的关键】',
    quotes,
    '',
    facts === ''
      ? '【史实】没有可用的史实材料（相关内容尚未通过审校）。'
        + '因此这篇游记里不要写任何史实：年代、名称、尺寸、出土地点、人物关系、历史事件一律不要出现。'
      : '【可用的史实 —— 只能使用下面这些，不要补充任何其他史实】\n' + facts,
    '',
    '【这是最重要的一条：不要编】',
    '这篇文章会作为这个人的记忆保存下来，所以里面的每一件事都必须真的发生过。',
    '上面没有列出的，一律不要写。具体地说，不要虚构：',
    '- 地点：没出现在足迹里的地方不要提，哪怕它就在旁边',
    '- 动线：怎么来的、从哪进、往哪走、几点离开，这些都没有记录，不要编',
    '- 天气、光线、时辰',
    '- 同行人、路人、店铺、动物、吃喝',
    '- 他的心情和想法：除非他自己说过，否则不要替他写感受',
    nothing
      ? '本次素材不足以写成文章。直接说明这次没有记录到什么，不要凭空补一段。'
      : `素材只有上面这些。素材少就写短，${limit} 字以内，不要为了凑篇幅而展开。`,
    '',
    '【写法】',
    `- ${limit} 字以内，可以分段。`,
    '- 第二人称或第一人称都行，跟着他说话的口气走。',
    '- 不要出现分数、评分、等级、排名，也不要和别人比较。',
    '- 不要夸张他的收获。',
  ].join('\n')
}

export type Travelogue = {
  readonly journeyId: string
  readonly text: string
  readonly timeline: readonly TimelineEntry[]
  readonly facts: readonly Fact[]
  readonly pendingPreferences: readonly PendingPreference[]
  readonly draftAnchorsExcluded: number
  readonly record: JourneyRecord
  readonly newPreferences: readonly NewPreference[]
}

export const generateTravelogue = async (
  journeyId: string, options: { readonly allowDraftAnchors?: boolean } = {},
): Promise<Travelogue> => {
  const material = await collectMaterial(journeyId, options)
  // 中文约 1.5 token/字，留一倍余量；篇幅小的时候也别给大额度，
  // 额度本身就是一种「可以多写点」的暗示
  const maxTokens = Math.ceil(allowedChars(material) * 3)
  const result = await complete({
    task: 'travelogue',
    system: buildTraveloguePrompt(material),
    user: '把这次旅行写成游记。',
    maxTokens,
  })
  return {
    journeyId,
    text: result.text,
    timeline: material.timeline,
    facts: material.facts,
    pendingPreferences: material.pendingPreferences,
    draftAnchorsExcluded: material.draftAnchorsExcluded,
    record: material.record,
    newPreferences: material.newPreferences,
  }
}
