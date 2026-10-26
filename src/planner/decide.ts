import type { Anchor } from '../content/loader.js'
import type { ContextState } from '../domain/context-state.js'
import type { AgeBand, Mode } from '../domain/enums.js'

/**
 * Explanation Planner 决策层 —— 规格 03 §3。
 *
 * 「不是找到答案，而是决定怎么讲」。先出决策，再生成文案：
 * 决策可单测、可回放、可在运营后台解释；文案层换模型不影响策略。
 * 纯函数，无 IO。
 */

export type PlanLength = 'short' | 'medium' | 'long'
export type Register = 'peer' | 'storyteller' | 'concise'
export type OpenWith = 'question' | 'observation' | 'memory_link' | 'fact'

export type PlanDecision = {
  readonly shouldSpeak: boolean
  readonly length: PlanLength
  readonly register: Register
  readonly openWith: OpenWith
  readonly useStory: boolean
  readonly linkCurriculum: boolean
  readonly linkMemory: string | null
  readonly leaveHook: boolean
  /** 已听过本锚点：不重复主讲解，换一个侧面（规格 03 §3.3） */
  readonly skipMainExplanation: boolean
  readonly nextAction: string | null
  readonly evidenceRequired: readonly string[]
  readonly maxTokens: number
  readonly reason: string
}

export type PlanInput = {
  readonly context: ContextState
  readonly anchor: Anchor | null
  readonly trigger: {
    readonly kind: 'geofence_arrive' | 'photo' | 'user_question' | 'task_step'
    readonly text?: string | null
  }
  readonly heardBefore: readonly string[]
  readonly explorationQuestion?: string | null
}

const REGISTER_BY_MODE: Record<Mode, Register> = {
  companion: 'peer',
  family_study: 'storyteller',
  light_guide: 'concise',
}

/** 规格 03 §2：年龄分层 × 单段长度 → maxTokens（中文约 1 字 ≈ 0.7 token，留余量） */
const MAX_TOKENS_BY_AGE: Record<AgeBand, number> = {
  under_12: 90,
  '12_15': 160,
  '16_18': 220,
  '19_24': 220,
  '25_plus': 220,
  unknown: 180,
}

const CURRICULUM_AGE_BANDS = new Set<AgeBand>(['12_15'])
const REASK_LIMIT = 2

/** 规格 03 §3.4：反问的适用边界 */
export const canAskFirst = (input: PlanInput, consecutiveReasks: number): boolean => {
  if (input.context.fatigue === 'high') return false
  if (consecutiveReasks >= REASK_LIMIT) return false
  if (input.trigger.kind === 'user_question') {
    const text = input.trigger.text ?? ''
    // 安全/方位/时间类直接答
    if (/洗手间|厕所|在哪|怎么走|几点|多久|出口|入口/.test(text)) return false
  }
  return true
}

export const decidePlan = (
  input: PlanInput, consecutiveReasks = 0,
): PlanDecision => {
  const { context: ctx, anchor } = input
  const register = REGISTER_BY_MODE[ctx.mode]
  const reasons: string[] = []

  const isFirstVisit = anchor !== null && !input.heardBefore.includes(anchor.anchorId)
  const memoryHook = ctx.memoryHooks[0] ?? null
  const askFirst = canAskFirst(input, consecutiveReasks)

  // 长度
  let length: PlanLength = 'medium'
  if (ctx.mode === 'light_guide') {
    length = 'short'
    reasons.push('light_guide_mode')
  } else if (ctx.fatigue === 'high') {
    length = 'short'
    reasons.push('fatigue_high')
  } else if (ctx.interest === 'high' && isFirstVisit) {
    length = 'long'
    reasons.push('interest_high', 'first_visit')
  }

  // 开场方式：memory_link 优先于 question（规格 03 §3.3）
  let openWith: OpenWith = 'fact'
  if (ctx.mode === 'light_guide') {
    openWith = 'fact'
  } else if (memoryHook !== null) {
    openWith = 'memory_link'
    reasons.push('memory_match')
  } else if (askFirst) {
    openWith = 'question'
    reasons.push('question_first')
  } else {
    openWith = 'observation'
    reasons.push('answer_first')
  }

  // 已听过本锚点：不重复主讲解
  const heardThis = anchor !== null && input.heardBefore.includes(anchor.anchorId)
  if (heardThis) reasons.push('heard_before')

  const leaveHook =
    ctx.mode !== 'light_guide' && ctx.fatigue !== 'high' && (length === 'long' || isFirstVisit)

  const useStory =
    ctx.ageBand === 'under_12' ||
    (ctx.mode === 'family_study' && anchor?.elements.story !== null)

  return {
    shouldSpeak: true,
    length,
    register,
    openWith,
    useStory: useStory === true,
    linkCurriculum: CURRICULUM_AGE_BANDS.has(ctx.ageBand) &&
      anchor?.elements.connection.curriculum !== null &&
      anchor?.elements.connection.curriculum !== undefined,
    linkMemory: openWith === 'memory_link' ? memoryHook : null,
    leaveHook,
    skipMainExplanation: heardThis,
    nextAction: ctx.fatigue === 'high'
      ? 'suggest_rest'
      : anchor?.elements.nextAction.suggest ?? null,
    evidenceRequired: anchor === null ? [] : ['anchor.k1Sources'],
    maxTokens: MAX_TOKENS_BY_AGE[ctx.ageBand],
    reason: reasons.join(' + ') || 'default',
  }
}
