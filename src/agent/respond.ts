import { buildContextState } from '../context/state.js'
import { touchJourney } from '../context/journey.js'
import { decideProactivity, type Trigger } from '../context/proactivity.js'
import { anchorForPlace, loadAnchors, type Anchor } from '../content/loader.js'
import type { ContextState } from '../domain/context-state.js'
import type { ProactivityDecision } from '../domain/enums.js'
import { recordSpoke } from '../memory/ephemeral.js'
import { writeMemory } from '../memory/gateway.js'
import * as repo from '../memory/repo.js'
import { complete } from '../models/router.js'
import { decidePlan, type PlanDecision } from '../planner/decide.js'
import { checkRegister } from '../planner/register-guard.js'
import { renderFromAnchor } from '../planner/render.js'

/**
 * 端到端编排：Context → Decision → Skill → Response。
 *
 * 这是 M2 的主链路，也是 M3 小程序要调的同一套逻辑。
 * 链路顺序严格对应企划书第 06 节的五个问题。
 */

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
}): Promise<AgentTurn> => {
  const anchorMap = await anchors()
  const anchor = anchorForPlace(anchorMap, input.poiId)

  const ctx = await buildContextState({
    journeyId: input.journeyId,
    poiId: input.poiId,
    currentTopic: anchor?.topics[0] ?? null,
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
}): Promise<AgentTurn> => {
  await touchJourney(input.journeyId)
  const anchorMap = await anchors()
  const anchor = input.poiId == null ? null : anchorForPlace(anchorMap, input.poiId)

  const ctx = await buildContextState({
    journeyId: input.journeyId,
    poiId: input.poiId ?? null,
    currentTopic: anchor?.topics[0] ?? null,
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

  /*
   * 输出形态的约束和内容的约束一样重要：
   * 这是语音优先的产品（规格 03：语音流、锁屏可听），分段加空行的文本
   * 既不像「一个人在你旁边说话」，TTS 念出来也很怪。
   * 实测 deepseek-flash 不加这段约束会输出 3–4 段带空行的聊天体。
   */
  const system = [
    `你是旅伴 agent，一个陪用户旅行的同伴，不是客服也不是讲解器。`,
    `当前模式 ${ctx.mode}，口吻档位 ${plan.register}，用户年龄段 ${ctx.ageBand}。`,
    `【输出形态】只说一段话，${plan.maxChars} 字以内；`,
    `不分段、不空行、不用任何 Markdown 标记、不用「简单说」「首先」这类书面连接词；`,
    `像在现场开口说话，不像写文章。`,
    anchor === null
      ? ''
      : `【当前位置】${anchor.name}。`,
    `【证据纪律】年代、名称、尺寸、出土地点、人物关系、历史事件必须有据可查；`,
    `没有把握就直接说不确定，并把人引向现场说明牌，不要含糊其辞、不要编。`,
    ctx.memoryHooks.length === 0
      ? ''
      : `【可引用的记忆】${ctx.memoryHooks.join('；')}。自然地接上，不要生硬复述。`,
  ].join('')

  const first = await complete({
    task: 'qa',
    system,
    user: input.text,
    maxTokens: plan.maxTokens,
  })

  /*
   * 规格 03 §9.1：口吻守卫命中即打回重写，不是只告警。
   * 实测 deepseek-flash 会连说三句事实而不对用户开口一次（too_many_facts），
   * 只记日志的话这种退化会一路漏到用户耳朵里。
   * 重写只给一次机会：再不过就带着命中记录输出，由运营后台看见。
   */
  const firstGuard = checkRegister(first.text, plan.register)
  const rewritten = firstGuard.ok
    ? null
    : await complete({
        task: 'qa',
        system: `${system}【重写要求】上一版违反了口吻规则：` +
          `${firstGuard.violations.map((v) => v.rule).join('、')}。` +
          `不要连续陈述三句事实，每两句事实之间至少有一句对用户开口` +
          `（提问、类比、或者用「你」直接说）。仍然只说一段话，${plan.maxChars} 字以内。`,
        user: input.text,
        maxTokens: plan.maxTokens,
      })

  const result = rewritten ?? first
  const guard = rewritten === null ? firstGuard : checkRegister(rewritten.text, plan.register)

  await writeMemory({
    kind: 'interaction',
    userId: ctx.user,
    journeyId: input.journeyId,
    role: 'agent',
    channel: 'text',
    content: result.text,
    anchorId: anchor?.anchorId ?? null,
    topicTags: anchor?.topics ?? [],
    evidenceRefs: {
      provider: result.provider,
      costCny: result.costCny,
      reasoningTokens: result.reasoningTokens,
      rewritten: rewritten !== null,
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
    text: result.text,
    usedElements: rewritten === null ? ['model:qa'] : ['model:qa', 'model:qa:rewrite'],
    guardViolations: guard.violations.map((v) => `${v.rule}:${v.matched}`),
    context: ctx,
    fromCache: false,
  }
}
