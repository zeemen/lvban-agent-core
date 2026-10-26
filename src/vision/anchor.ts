import { vision as cfg } from '../config/index.js'
import { redis } from '../db/redis.js'
import { recognize } from '../models/router.js'

/**
 * 视觉锚点 —— 规格 02 §4。
 *
 * 两件事：
 *   1. 候选集约束的识别 + 三档决策（auto_accept / ask_user_pick / fallback_ask）
 *   2. 命中率熔断：命中率 = 1 − 用户纠正率，滚动窗口统计，低于 0.8 切「问一句」为主
 *
 * 熔断是运行时开关，不是一次性的开发期决策（企划书硬要求）。
 */

const HIT_KEY = 'vision:outcomes'

export type VisionDecision = 'auto_accept' | 'ask_user_pick' | 'fallback_ask'

export type VisionAnchorResult = {
  readonly candidates: readonly {
    readonly exhibitId: string; readonly name: string; readonly confidence: number
  }[]
  readonly decision: VisionDecision
  readonly correctionToken: string
  readonly fallbackActive: boolean
}

export const decideVisionAnchor = async (input: {
  readonly imageKey: string
  readonly candidates: readonly { readonly exhibitId: string; readonly name: string }[]
}): Promise<VisionAnchorResult> => {
  const hitRate = await visionHitRate()

  // 候选集为空时无法做约束识别，直接降级
  if (input.candidates.length === 0) {
    return {
      candidates: [], decision: 'fallback_ask',
      correctionToken: input.imageKey, fallbackActive: hitRate.fallbackActive,
    }
  }

  const result = await recognize({ imageKey: input.imageKey, candidates: input.candidates })
  const top = result.candidates[0]
  const confidence = top?.confidence ?? 0

  const decision: VisionDecision =
    confidence >= cfg.tauHigh ? 'auto_accept'
      : confidence >= cfg.tauLow ? 'ask_user_pick'
        : 'fallback_ask'

  return {
    candidates: result.candidates,
    decision,
    correctionToken: input.imageKey,
    fallbackActive: hitRate.fallbackActive,
  }
}

/** 用户纠正了识别结果 → corrected=true。这是命中率的唯一真实来源。 */
export const recordVisionOutcome = async (corrected: boolean): Promise<void> => {
  await redis.lpush(HIT_KEY, corrected ? '0' : '1')
  await redis.ltrim(HIT_KEY, 0, cfg.hitRateWindow - 1)
}

export type HitRateReport = {
  readonly samples: number
  readonly hitRate: number | null
  readonly threshold: number
  readonly fallbackActive: boolean
}

export const visionHitRate = async (): Promise<HitRateReport> => {
  const raw = await redis.lrange(HIT_KEY, 0, cfg.hitRateWindow - 1)
  if (raw.length === 0) {
    return { samples: 0, hitRate: null, threshold: cfg.hitRateThreshold, fallbackActive: false }
  }
  const hits = raw.filter((r) => r === '1').length
  const hitRate = Number((hits / raw.length).toFixed(3))
  return {
    samples: raw.length,
    hitRate,
    threshold: cfg.hitRateThreshold,
    // 样本不足时不熔断，避免冷启动误判
    fallbackActive: raw.length >= 20 && hitRate < cfg.hitRateThreshold,
  }
}
