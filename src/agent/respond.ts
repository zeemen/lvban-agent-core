import { buildContextState } from '../context/state.js'
import { touchJourney } from '../context/journey.js'
import { decideProactivity, type Trigger } from '../context/proactivity.js'
import type { DeclaredSource } from '../context/provenance.js'
import { anchorForPlace, loadAnchors, type Anchor } from '../content/loader.js'
import type { ContextState } from '../domain/context-state.js'
import type { ProactivityDecision } from '../domain/enums.js'
import { retrievePassages } from '../knowledge/weknora.js'
import { recordSpoke } from '../memory/ephemeral.js'
import { writeMemory } from '../memory/gateway.js'
import * as repo from '../memory/repo.js'
import { complete } from '../models/router.js'
import { buildCiteRewriteSuffix, checkCitations } from '../planner/cite-guard.js'
import { decidePlan, type PlanDecision } from '../planner/decide.js'
import { checkRegister } from '../planner/register-guard.js'
import { renderFromAnchor } from '../planner/render.js'
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
  usedElements: [],
  guardViolations: [],
  context: ctx,
  fromCache: false,
})

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

  const trigger: Trigger = {
    kind: 'geofence_arrive',
    poiId: input.poiId,
    anchorIsTop30: anchor?.isTop30 ?? false,
    isFirstVisit: anchor !== null && !heardBefore.includes(anchor.anchorId),
    safetySensitive: input.safetySensitive ?? false,
  }

  const proactivity = decideProactivity(ctx, trigger)
  if (proactivity.decision !== 'SPEAK' || anchor === null) {
    return silent(ctx, proactivity.decision, proactivity.reason, proactivity.vetoedBy)
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
  await recordSpoke(input.journeyId, new Date())

  return {
    spoke: true,
    decision: 'SPEAK',
    proactivityReason: proactivity.reason,
    vetoedBy: null,
    plan,
    text: rendered.text,
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
