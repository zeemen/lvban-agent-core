import { location as cfg } from '../config/index.js'
import type { ContextState } from '../domain/context-state.js'
import type { Mode, ProactivityDecision } from '../domain/enums.js'

/**
 * Proactivity Engine —— 规格 02 §7。两段式：硬否决 → 打分。
 *
 * 企划书原文：进入围栏 ≠ 必须开口。
 * 纯函数，无 IO —— 这一层必须可单测、可回放，现场路测时最常被问的就是
 * 「为什么这里没说话」，所以 reason 必须返回（规格 02 §8.3）。
 */

export type Trigger = {
  readonly kind: 'geofence_arrive' | 'photo' | 'user_question' | 'task_step' | 'route_hint'
  readonly poiId?: string | null
  readonly anchorIsTop30?: boolean
  readonly isFirstVisit?: boolean
  /** 安全场景：道路、台阶、拥挤区域（规格 03 §6，安全优先于内容） */
  readonly safetySensitive?: boolean
}

export type ProactivityResult = {
  readonly decision: ProactivityDecision
  readonly score: number
  readonly vetoedBy: string | null
  readonly reason: string
}

/** 规格 02 §7.4 */
const THRESHOLDS: Record<Mode, { readonly speak: number; readonly soft: number; readonly minGapSec: number }> = {
  companion: { speak: 0.50, soft: 0.30, minGapSec: 8 * 60 },
  family_study: { speak: 0.45, soft: 0.25, minGapSec: 6 * 60 },
  light_guide: { speak: 0.70, soft: 0.50, minGapSec: 15 * 60 },
}

const JUST_SPOKE_SEC = 60
const IGNORED_LIMIT = 2
const MIN_LOCATION_CONFIDENCE = 0.6
const SPOKE_DENSITY_WINDOW_MIN = 10

/** 规格 02 §7.2 硬否决表 */
export const hardVeto = (ctx: ContextState, trigger: Trigger): string | null => {
  if (ctx.userIsSpeaking) return 'user_is_speaking'
  if (ctx.activity === 'fast_moving') return 'fast_moving'
  if (ctx.isDining) return 'is_dining'
  if (ctx.lastSpokeSecAgo !== null && ctx.lastSpokeSecAgo < JUST_SPOKE_SEC) return 'just_spoke'
  if (ctx.consecutiveIgnored >= IGNORED_LIMIT) return 'consecutive_ignored'
  if (trigger.safetySensitive === true) return 'safety_first'
  if (ctx.activeTask !== null && ctx.activeTask.stage === 'observing') return 'task_in_progress'
  if (ctx.locationConfidence < MIN_LOCATION_CONFIDENCE) return 'location_uncertain'
  return null
}

type Factor = { readonly label: string; readonly delta: number }

/** 规格 02 §7.3 打分表 */
export const scoreFactors = (ctx: ContextState, trigger: Trigger): readonly Factor[] => {
  const factors: Factor[] = []

  if (trigger.anchorIsTop30 === true) factors.push({ label: 'top30_anchor', delta: 0.30 })
  if (trigger.isFirstVisit === true) factors.push({ label: 'first_visit', delta: 0.20 })
  if (ctx.memoryHooks.length > 0) factors.push({ label: 'memory_hook_match', delta: 0.20 })
  if (ctx.interest === 'high') factors.push({ label: 'interest_high', delta: 0.15 })
  if (ctx.currentTopic !== null) factors.push({ label: 'topic_related', delta: 0.10 })
  if (ctx.fatigue === 'high') factors.push({ label: 'fatigue_high', delta: -0.25 })

  const allowance = Math.max(1, ctx.elapsedMin / SPOKE_DENSITY_WINDOW_MIN)
  if (ctx.visitedAnchors.length > allowance) {
    factors.push({ label: 'spoke_too_often', delta: -0.20 })
  }
  if (ctx.mode === 'light_guide') factors.push({ label: 'light_guide_mode', delta: -0.20 })

  return factors
}

export const decideProactivity = (ctx: ContextState, trigger: Trigger): ProactivityResult => {
  // 用户主动提问不走主动性引擎 —— 用户问了就一定答
  if (trigger.kind === 'user_question') {
    return { decision: 'SPEAK', score: 1, vetoedBy: null, reason: 'user_initiated' }
  }

  const veto = hardVeto(ctx, trigger)
  if (veto !== null) {
    return { decision: 'SILENT', score: 0, vetoedBy: veto, reason: `veto:${veto}` }
  }

  const factors = scoreFactors(ctx, trigger)
  const score = Number(
    factors.reduce((sum, f) => sum + f.delta, 0).toFixed(3),
  )
  const threshold = THRESHOLDS[ctx.mode]
  const reason = factors.map((f) => f.label).join(' + ') || 'no_factors'

  const decision: ProactivityDecision =
    score >= threshold.speak ? 'SPEAK' : score >= threshold.soft ? 'SOFT_HINT' : 'SILENT'

  return { decision, score, vetoedBy: null, reason }
}

export const modeThresholds = (mode: Mode): (typeof THRESHOLDS)[Mode] => THRESHOLDS[mode]

/** 规格 02 §6.2 派生字段 */
export const deriveInterest = (input: {
  readonly questionCount: number
  readonly dwellSec: number
  readonly medianDwellSec: number
  readonly skipped: boolean
}): 'low' | 'medium' | 'high' => {
  if (input.skipped) return 'low'
  const ratio = input.medianDwellSec > 0 ? input.dwellSec / input.medianDwellSec : 0
  if (input.questionCount >= 2 || ratio >= 1.5) return 'high'
  if (ratio < 0.4) return 'low'
  return 'medium'
}

export const deriveFatigue = (input: {
  readonly elapsedMin: number
  readonly saidTired: boolean
  readonly recentInteractions: number
  readonly priorInteractions: number
}): 'low' | 'medium' | 'high' => {
  if (input.saidTired || input.elapsedMin > 150) return 'high'
  const dropped =
    input.priorInteractions > 0 &&
    input.recentInteractions / input.priorInteractions < 0.4
  if (input.elapsedMin > 90 || dropped) return 'medium'
  return 'low'
}

export const deriveActivity = (speedMps: number | null): 'still' | 'walking' | 'fast_moving' => {
  if (speedMps === null) return 'still'
  if (speedMps > cfg.fastMovingSpeedMps) return 'fast_moving'
  if (speedMps >= 0.5) return 'walking'
  return 'still'
}
