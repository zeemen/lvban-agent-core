import { retrieval as budget } from '../config/index.js'
import * as repo from './repo.js'

/**
 * 记忆检索 —— 规格 01 §5。
 *
 * 输出 memory_hooks（格式 <city>·<place>·<topic>），每条都带 evidence：
 * Memory-visible 原则要求「为什么这样推荐」随时可答，所以证据必须跟检索结果
 * 一起返回，而不是另外再查一次（规格 01 §5.5）。
 */

export type MemoryHook = {
  readonly text: string
  readonly layer: 'L1' | 'L2' | 'L3'
  readonly score: number
  readonly strength?: number
  readonly topics: readonly string[]
  readonly evidence: Record<string, unknown>
}

export type IdentityHook = { readonly trait: string; readonly explanation: string }

export type HookQuery = {
  readonly userId: string
  readonly currentPlace?: string | null
  readonly currentCity?: string | null
  readonly topic?: string | null
  readonly limit?: number
  /** 24h 内已被念过的 hook 文本，用于施加重复惩罚（规格 01 §5.3） */
  readonly recentlySurfaced?: readonly string[]
}

const LAYER_WEIGHT = { L3: 1.0, L2: 0.8, L1: 0.6 } as const
const APPROX_TOKENS_PER_HOOK = 30

/** 场景类型归并：让"苏州园林 → 秦淮河沿岸建筑"这类跨城市连接成立（规格 01 §5.4） */
const PLACE_KIND: readonly { readonly pattern: RegExp; readonly kind: string }[] = [
  { pattern: /园|林|庭/, kind: 'garden' },
  { pattern: /博物院|博物馆|馆/, kind: 'museum' },
  { pattern: /贡院|学宫|书院|文庙|夫子庙/, kind: 'academia' },
  { pattern: /桥|河|湖|江/, kind: 'water' },
  { pattern: /巷|街|坊/, kind: 'street' },
]

const placeKind = (place: string): string | null =>
  PLACE_KIND.find((p) => p.pattern.test(place))?.kind ?? null

/** 三级匹配：同一地点 1.0 / 同类场景（跨城市）0.7 / 同主题（跨场景）0.5 */
export const placeAffinity = (
  currentPlace: string | null | undefined,
  memoryPlace: string,
  topicMatched: boolean,
): number => {
  if (currentPlace == null) return topicMatched ? 0.5 : 0
  if (currentPlace === memoryPlace) return 1.0
  const a = placeKind(currentPlace)
  const b = placeKind(memoryPlace)
  if (a !== null && a === b) return 0.7
  return topicMatched ? 0.5 : 0
}

/** M2 用主题重叠度代替向量相似度；接入 embedding 后替换此函数即可（规格 01 §5.3） */
export const topicSimilarity = (
  topic: string | null | undefined, memoryTopics: readonly string[],
): number => {
  if (topic == null || topic === '' || memoryTopics.length === 0) return 0
  if (memoryTopics.includes(topic)) return 1
  const partial = memoryTopics.some((t) => t.includes(topic) || topic.includes(t))
  return partial ? 0.6 : 0
}

const recencyDecay = (lastSeen: Date, now: Date): number => {
  const days = (now.getTime() - lastSeen.getTime()) / 86_400_000
  return Math.max(0, 1 - days / 365)
}

export const scoreHook = (input: {
  readonly similarity: number
  readonly affinity: number
  readonly layer: 'L1' | 'L2' | 'L3'
  readonly recency: number
  readonly strength: number
  readonly repeated: boolean
}): number =>
  0.30 * input.similarity +
  0.20 * input.affinity +
  0.20 * LAYER_WEIGHT[input.layer] +
  0.15 * input.recency +
  0.15 * input.strength -
  (input.repeated ? 0.25 : 0)

export type HookResult = {
  readonly hooks: readonly MemoryHook[]
  readonly identity: readonly IdentityHook[]
  readonly preferences: Readonly<Record<string, string>>
  readonly tokenEstimate: number
}

export const getMemoryHooks = async (query: HookQuery): Promise<HookResult> => {
  const now = new Date()
  const limit = query.limit ?? budget.inJourneyMaxHooks
  const recent = new Set(query.recentlySurfaced ?? [])

  const [footprints, preferences, traits] = await Promise.all([
    repo.listFootprints(query.userId, budget.postJourneyMaxHooks),
    repo.listPreferences(query.userId),
    repo.listIdentityTraits(query.userId),
  ])

  // 用户已成立的兴趣偏好，用来挑足迹里最有代表性的那个主题
  const salientTopics = new Set(
    preferences
      .filter((p) => p.dimension === 'topic_interest' && p.status === 'active')
      .map((p) => p.value),
  )

  // L1：语义足迹 → hook
  const footprintHooks: readonly MemoryHook[] = footprints.map((f) => {
    const topics = f.topics
    const similarity = topicSimilarity(query.topic, topics)
    // 主题优先级：命中当前话题 > 已成立的兴趣偏好 > 数组首项
    const headline =
      topics.find((t) => t === query.topic) ??
      topics.find((t) => salientTopics.has(t)) ??
      topics[0]
    const text = `${f.city}·${f.place}${headline === undefined ? '' : `·${headline}`}`
    const strength = f.interest_signal === 'high' ? 0.9 : f.interest_signal === 'medium' ? 0.6 : 0.3
    return {
      text,
      layer: 'L1' as const,
      topics,
      strength,
      score: scoreHook({
        similarity,
        affinity: placeAffinity(query.currentPlace, f.place, similarity > 0),
        layer: 'L1',
        recency: recencyDecay(f.occurred_on, now),
        strength,
        repeated: recent.has(text),
      }),
      evidence: {
        journeyId: f.journey_id,
        occurredOn: f.occurred_on.toISOString().slice(0, 10),
        dwellSec: f.dwell_sec,
        questionCount: f.question_count,
      },
    }
  })

  // L2：偏好 → hook（只取主题类偏好，其余作为 preferences 字段直接给 Planner）
  const topicPrefs = preferences.filter(
    (p) => p.dimension === 'topic_interest' && p.status === 'active',
  )
  const preferenceHooks: readonly MemoryHook[] = topicPrefs.map((p) => {
    const topics = [p.value]
    const similarity = topicSimilarity(query.topic, topics)
    const text = `${query.currentCity ?? '历次'}·兴趣·${p.value}`
    const strength = Number(p.strength)
    return {
      text,
      layer: 'L2' as const,
      topics,
      strength,
      score: scoreHook({
        similarity,
        affinity: similarity > 0 ? 0.5 : 0,
        layer: 'L2',
        recency: recencyDecay(p.last_seen_at, now),
        strength,
        repeated: recent.has(text),
      }),
      evidence: { journeyCount: p.journey_count, source: p.source, refs: p.evidence_refs },
    }
  })

  const hooks = [...footprintHooks, ...preferenceHooks]
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  const prefMap = Object.fromEntries(
    preferences
      .filter((p) => p.dimension !== 'topic_interest' && p.status === 'active')
      .map((p) => [p.dimension, p.value]),
  )

  return {
    hooks,
    identity: traits
      .filter((t) => t.status === 'active')
      .map((t) => ({ trait: t.trait, explanation: t.explanation })),
    preferences: prefMap,
    tokenEstimate: hooks.length * APPROX_TOKENS_PER_HOOK,
  }
}
