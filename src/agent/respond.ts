import { buildContextState } from '../context/state.js'
import { touchJourney } from '../context/journey.js'
import { decideProactivity, type Trigger } from '../context/proactivity.js'
import type { DeclaredSource } from '../context/provenance.js'
import { anchorForPlace, loadAnchors, type Anchor } from '../content/loader.js'
import type { ContextState } from '../domain/context-state.js'
import type { ProactivityDecision } from '../domain/enums.js'
import { retrievePassages } from '../knowledge/weknora.js'
import { recordProactiveSpoke, recordSpoke } from '../memory/ephemeral.js'
import { writeMemory } from '../memory/gateway.js'
import * as repo from '../memory/repo.js'
import { complete } from '../models/router.js'
import { buildCiteRewriteSuffix, checkCitations } from '../planner/cite-guard.js'
import { decidePlan, registerForMode, type PlanDecision } from '../planner/decide.js'
import { checkRegister } from '../planner/register-guard.js'
import { renderFromAnchor } from '../planner/render.js'
import { buildSilentCard, type SilentCard } from '../planner/soft-hint.js'
import { evidenceTexts } from './evidence.js'
import { buildAnswerSystemPrompt, buildRewriteSuffix } from './prompt.js'

/**
 * 端到端编排：Context → Decision → Skill → Response。
 *
 * 这是 M2 的主链路，也是 M3 小程序要调的同一套逻辑。
 * 链路顺序严格对应企划书第 06 节的五个问题。
 */

/**
 * 回查两次都拿不出依据时说的话（规格 03 §5.3）。
 * 刻意不留任何具体数字：这句话存在的理由就是「没有可引用的事实」。
 */
const DEGRADED_ANSWER =
  '这个我手头的资料对不上，不敢跟你瞎说。现场说明牌写得比我准，你要是拍一张给我，我帮你看看。'

let anchorCache: ReadonlyMap<string, Anchor> | null = null

const anchors = async (): Promise<ReadonlyMap<string, Anchor>> => {
  anchorCache ??= await loadAnchors()
  return anchorCache
}

export type AgentTurn = {
  readonly spoke: boolean
  readonly decision: ProactivityDecision
  readonly proactivityReason: string
  readonly vetoedBy: string | null
  readonly plan: PlanDecision | null
  readonly text: string | null
  /** SOFT_HINT 那一档的输出：不出声的气泡（规格 02 §7.1）。其余情况为 null */
  readonly card: SilentCard | null
  readonly usedElements: readonly string[]
  readonly guardViolations: readonly string[]
  readonly context: ContextState
  readonly fromCache: boolean
}

const silent = (
  ctx: ContextState, decision: ProactivityDecision, reason: string, vetoedBy: string | null,
): AgentTurn => ({
  spoke: false,
  decision,
  proactivityReason: reason,
  vetoedBy,
  plan: null,
  text: null,
  card: null,
  usedElements: [],
  guardViolations: [],
  context: ctx,
  fromCache: false,
})

/**
 * 出一张静默卡片（规格 02 §7.1 的 SOFT_HINT）。
 *
 * 三件刻意不做的事：
 *   · 不记 recordSpoke —— 它没出声，那 60 秒的「刚讲过」要留给真的开口
 *   · 不记 recordProactiveSpoke —— §7.4 的最大主动频次数的是开口
 *   · 不生成新文案 —— 气泡上那句取自锚点的八要素，零模型调用
 *
 * 但一定要留痕：这是 agent 的一次输出，走同一个写入门记成
 * channel=silent_card，否则运营后台回答不了「这儿到底给过提示没有」。
 * 那个 channel 2026-11-03 之前在枚举里空等着，没有任何地方产出。
 *
 * 留痕失败**不吞卡片**。气泡是用户看得见的输出，写 interaction 是记账；
 * 记账挂了还把输出删掉，等于让一次记账故障变成一次「该提示没提示」。
 * 开口那条路径同样不看写入结果，两边一致。被拒这件事网关自己已经记进
 * memory_audit（gateway 的 reject()），追得到，不必在这里编一个 vetoedBy——
 * vetoedBy 是 §7.2 的否决者，写入被拒不是否决。
 */
const emitSilentCard = async (input: {
  readonly ctx: ContextState
  readonly journeyId: string
  readonly anchor: Anchor
  readonly heard: boolean
  readonly proactivity: { readonly reason: string; readonly score: number }
}): Promise<AgentTurn> => {
  const { ctx, anchor, proactivity } = input
  const built = buildSilentCard(anchor, registerForMode(ctx.mode), { heard: input.heard })
  // 这档口吻一栏都没写：没东西可提示，就老实沉默
  if (built === null) {
    return silent(ctx, 'SOFT_HINT', `${proactivity.reason} + no_hook`, null)
  }
  const { card, element } = built

  await writeMemory({
    kind: 'interaction',
    userId: ctx.user,
    journeyId: input.journeyId,
    role: 'agent',
    channel: 'silent_card',
    content: card.hint,
    anchorId: anchor.anchorId,
    topicTags: anchor.topics,
    evidenceRefs: {
      decision: 'SOFT_HINT',
      score: proactivity.score,
      reason: proactivity.reason,
      element,
      audioKey: card.audioKey,
      k1Sources: anchor.k1Sources,
      reviewStatus: anchor.review.status,
    },
    occurredAt: new Date(),
  })

  return {
    spoke: false,
    decision: 'SOFT_HINT',
    proactivityReason: proactivity.reason,
    vetoedBy: null,
    // 没有讲解计划，只有一张卡片：这里填一个 plan 会让运营后台误以为讲过
    plan: null,
    text: null,
    card,
    usedElements: [element],
    guardViolations: [],
    context: ctx,
    fromCache: true,
  }
}

/** 到达点位：围栏触发后走这里。产生 arrive 事件 ≠ 开口。 */
export const onArrive = async (input: {
  readonly journeyId: string
  readonly poiId: string
  readonly heardBefore?: readonly string[]
  readonly safetySensitive?: boolean
  readonly locationSource?: DeclaredSource
  readonly locationConfidence?: number
}): Promise<AgentTurn> => {
  const anchorMap = await anchors()
  const anchor = anchorForPlace(anchorMap, input.poiId)

  const ctx = await buildContextState({
    journeyId: input.journeyId,
    poiId: input.poiId,
    currentTopic: anchor?.topics[0] ?? null,
    locationSource: input.locationSource,
    locationConfidence: input.locationConfidence,
  })

  // 「已听过」是跨旅程语义：调用方不传时从库里查，否则回头客会被永远判成首次访问
  const heardBefore = input.heardBefore ?? await repo.listHeardAnchors(ctx.user)

  const heard = anchor !== null && heardBefore.includes(anchor.anchorId)

  const trigger: Trigger = {
    kind: 'geofence_arrive',
    poiId: input.poiId,
    anchorIsTop30: anchor?.isTop30 ?? false,
    isFirstVisit: anchor !== null && !heard,
    safetySensitive: input.safetySensitive ?? false,
  }

  const proactivity = decideProactivity(ctx, trigger)
  // 没有锚点就没有可提示的内容，连气泡都出不了
  if (anchor === null || proactivity.decision === 'SILENT') {
    return silent(ctx, proactivity.decision, proactivity.reason, proactivity.vetoedBy)
  }
  if (proactivity.decision === 'SOFT_HINT') {
    return emitSilentCard({ ctx, journeyId: input.journeyId, anchor, heard, proactivity })
  }

  const plan = decidePlan({
    context: ctx,
    anchor,
    trigger: { kind: 'geofence_arrive' },
    heardBefore,
  })

  const rendered = renderFromAnchor(anchor, plan)
  const guard = checkRegister(rendered.text, plan.register)

  await writeMemory({
    kind: 'interaction',
    userId: ctx.user,
    journeyId: input.journeyId,
    role: 'agent',
    channel: 'voice',
    content: rendered.text,
    anchorId: anchor.anchorId,
    topicTags: anchor.topics,
    evidenceRefs: { k1Sources: anchor.k1Sources, reviewStatus: anchor.review.status },
    occurredAt: new Date(),
  })
  const spokeAt = new Date()
  await recordSpoke(input.journeyId, spokeAt)
  // 这一句是主动开的口，要进 §7.4 的频次预算；回答提问的那条路径不记
  await recordProactiveSpoke(input.journeyId, spokeAt)

  return {
    spoke: true,
    decision: 'SPEAK',
    proactivityReason: proactivity.reason,
    vetoedBy: null,
    plan,
    text: rendered.text,
    card: null,
    usedElements: rendered.usedElements,
    guardViolations: guard.violations.map((v) => `${v.rule}:${v.matched}`),
    context: ctx,
    fromCache: rendered.fromCache,
  }
}

/** 用户主动提问：不走主动性引擎（用户问了就一定答），走 Model Router */
export const onQuestion = async (input: {
  readonly journeyId: string
  readonly text: string
  readonly poiId?: string | null
  readonly locationSource?: DeclaredSource
  readonly locationConfidence?: number
}): Promise<AgentTurn> => {
  await touchJourney(input.journeyId)
  const anchorMap = await anchors()
  const anchor = input.poiId == null ? null : anchorForPlace(anchorMap, input.poiId)

  const ctx = await buildContextState({
    journeyId: input.journeyId,
    poiId: input.poiId ?? null,
    currentTopic: anchor?.topics[0] ?? null,
    locationSource: input.locationSource,
    locationConfidence: input.locationConfidence,
  })

  const userWrite = await writeMemory({
    kind: 'interaction',
    userId: ctx.user,
    journeyId: input.journeyId,
    role: 'user',
    channel: 'text',
    content: input.text,
    anchorId: anchor?.anchorId ?? null,
    topicTags: anchor?.topics ?? [],
    occurredAt: new Date(),
  })
  if (!userWrite.ok) {
    return silent(ctx, 'SILENT', `write_rejected:${userWrite.reason}`, userWrite.reason)
  }

  // 明确提问即 explicit 兴趣信号 → 进 L1，参与 D2
  if (anchor?.topics[0] !== undefined) {
    await writeMemory({
      kind: 'signal',
      userId: ctx.user,
      journeyId: input.journeyId,
      dimension: 'topic_interest',
      value: anchor.topics[0],
      source: 'explicit',
      evidenceInteractionId: userWrite.id,
      occurredAt: new Date(),
    })
  }

  const plan = decidePlan({
    context: ctx,
    anchor,
    trigger: { kind: 'user_question', text: input.text },
    heardBefore: [],
  })

  // K3 长尾证据（规格 03 §5 第三级）。取不到就空着：建档可以跳过，证据也可以没有，
  // 但没有的时候 prompt 会让它说不确定，而不是自己补。
  const passages = await retrievePassages({
    query: input.text, sceneId: anchor?.sceneId ?? null,
  })
  const system = buildAnswerSystemPrompt({ ctx, plan, anchor, passages })
  const evidence = evidenceTexts(passages, anchor)

  const first = await complete({
    task: 'qa',
    system,
    user: input.text,
    maxTokens: plan.maxTokens,
  })

  /*
   * 两道守卫，都是命中即打回重写，不是只告警。
   *
   * 口吻（规格 03 §9.1）：实测 deepseek-flash 会连说三句事实而不对用户开口一次
   * （too_many_facts），只记日志的话这种退化会一路漏到用户耳朵里。
   *
   * 回查（规格 03 §5.1）：说出资料里查不到的年代、尺寸、出土地点就打回。
   *
   * 重写只给一次机会。口吻再不过就带着命中记录输出，由运营后台看见；
   * 但回查再不过不能放行——那是在念一个没有出处的事实，只能降级（见下）。
   */
  const firstGuard = checkRegister(first.text, plan.register)
  const firstCite = checkCitations(first.text, evidence)
  const rewritten = firstGuard.ok && firstCite.ok
    ? null
    : await complete({
        task: 'qa',
        system: system
          + (firstGuard.ok ? '' : buildRewriteSuffix(
              firstGuard.violations.map((v) => v.rule), plan.maxChars,
            ))
          + buildCiteRewriteSuffix(firstCite.violations, plan.maxChars),
        user: input.text,
        maxTokens: plan.maxTokens,
      })

  const result = rewritten ?? first
  const guard = rewritten === null ? firstGuard : checkRegister(result.text, plan.register)
  const cite = rewritten === null ? firstCite : checkCitations(result.text, evidence)

  /*
   * 规格 03 §5.3：查不到就说不确定，并把人引向现场说明牌。
   * 重写过一次仍然拿不出依据，说明模型在凭记忆补——这时候宁可少说一句，
   * 也不能把一个无出处的年代念给站在文物前面的人听。
   */
  const text = cite.ok ? result.text : DEGRADED_ANSWER

  await writeMemory({
    kind: 'interaction',
    userId: ctx.user,
    journeyId: input.journeyId,
    role: 'agent',
    channel: 'text',
    content: text,
    anchorId: anchor?.anchorId ?? null,
    topicTags: anchor?.topics ?? [],
    evidenceRefs: {
      provider: result.provider,
      costCny: result.costCny,
      reasoningTokens: result.reasoningTokens,
      rewritten: rewritten !== null,
      // 回查结果：降级过没有、软违规（挂错主语）有哪些。
      // 软违规现在只记不拦，要靠这里的真实流量量出误报率
      degraded: !cite.ok,
      citeViolations: cite.violations.map((v) => `${v.rule}:${v.label}:${v.value}`),
      // 记下这句话当时看过哪几段资料：纠错队列要回答「这条是从哪来的」
      k3: passages.map((p) => ({
        title: p.title, knowledgeId: p.knowledgeId, chunkId: p.chunkId,
      })),
    },
    occurredAt: new Date(),
  })
  await recordSpoke(input.journeyId, new Date())

  return {
    spoke: true,
    decision: 'SPEAK',
    proactivityReason: 'user_initiated',
    vetoedBy: null,
    plan,
    text,
    card: null,
    usedElements: [
      'model:qa',
      ...(rewritten === null ? [] : ['model:qa:rewrite']),
      ...(cite.ok ? [] : ['guard:cite:degraded']),
    ],
    guardViolations: [
      ...guard.violations.map((v) => `${v.rule}:${v.matched}`),
      ...cite.violations.map((v) => `${v.rule}:${v.value}`),
    ],
    context: ctx,
    fromCache: false,
  }
}
