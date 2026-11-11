/**
 * 「拍一下」的决策核 —— 规格 02 §4.2 识别链路、§4.3 命中率熔断，PRD U07。
 *
 * 和服务端 `src/planner` 同一个分工：决策是纯函数，IO 在边上。
 * 页面只负责把回包递进来、把 step 画出去、把 outcome 发出去。
 */

export type VisionDecision = 'auto_accept' | 'ask_user_pick' | 'fallback_ask'

export type VisionCandidate = {
  readonly exhibitId: string
  readonly name: string
  readonly confidence: number
}

/** 服务端 POST /v1/vision/anchor 的回包 */
export type VisionAnchorResponse = {
  readonly candidates: readonly VisionCandidate[]
  readonly decision: VisionDecision
  readonly correctionToken: string
  /** 命中率已跌破阈值：主入口该从「拍一下」切到「问一句」 */
  readonly fallbackActive: boolean
  readonly fallbackReason: string | null
  /** 自动采纳时服务端顺手落的那条 location_event；纠正时要凭它撤回 */
  readonly locationEventId: string | null
  readonly landingRejected?: string | null
}

export type VisionStep =
  | {
    readonly kind: 'accepted'
    readonly pick: VisionCandidate
    readonly locationEventId: string | null
    readonly landingRejected: string | null
  }
  | { readonly kind: 'pick'; readonly candidates: readonly VisionCandidate[] }
  | { readonly kind: 'ask'; readonly hint: string }

const ASK_HINT = '这张没认出来，直接问我一句吧——你看到的是什么样子？'

/**
 * 回包 → 界面该走的那一档。
 *
 * `candidates` 为空时一律降级去问：服务端眼下不会在 auto_accept 下回空，
 * 但真回了，取 candidates[0] 会是 undefined，用户按下快门之后就是白屏。
 */
export const nextStep = (res: VisionAnchorResponse): VisionStep => {
  const top = res.candidates[0]
  if (res.decision === 'fallback_ask' || top === undefined) {
    return { kind: 'ask', hint: res.fallbackReason ?? ASK_HINT }
  }
  if (res.decision === 'ask_user_pick') {
    return { kind: 'pick', candidates: res.candidates }
  }
  return {
    kind: 'accepted',
    pick: top,
    locationEventId: res.locationEventId,
    landingRejected: res.landingRejected ?? null,
  }
}

/**
 * 挂起的命中率样本。规格 02 §4.3：命中率 = 1 − 用户纠正率。
 *
 * 为什么要挂起：服务端 /outcome 每调一次就往滚动窗口塞一个样本，而且没有
 * 撤销样本的办法。若「落位时先乐观记一笔命中、用户纠正时再记一笔纠正」，
 * 一次识别就被记成半命中半纠正，熔断该响的时候晚响。所以一次识别只结算一次：
 * 要么用户纠正，要么用户离开这次识别。
 */
export type PendingSample = {
  readonly journeyId: string
  readonly locationEventId: string | null
} | null

export type OutcomeRequest = {
  readonly corrected: boolean
  readonly journeyId: string
  readonly locationEventId?: string
  readonly exhibitId?: string
  /**
   * 这一次要不要计入命中率窗口。省略即计入。
   *
   * /outcome 身兼两职：落位和记命中率。点选只需要前者——系统没敢认，
   * 没有断言可供纠正。不区分的话，一次点选会被记成一次命中。
   */
  readonly sample?: boolean
}

/**
 * 只有「系统敢认」才挂样本。
 *
 * ask_user_pick 与 fallback_ask 都不是断言，没有可供纠正的东西。把它们记成
 * 命中，会让「永远只给 0.5 分、从不自动采纳」的模型一直显示满命中率，
 * 熔断就永远不响——而那正是最该被熔断的失败形态。
 */
export const openSample = (step: VisionStep, journeyId: string): PendingSample =>
  step.kind === 'accepted'
    ? { journeyId, locationEventId: step.locationEventId }
    : null

/** 用户说「不是这件」：记一笔纠正，并撤回认错的那条落位 */
export const settleOnCorrection = (pending: PendingSample): OutcomeRequest | null => {
  if (pending === null) return null
  return pending.locationEventId === null
    ? { corrected: true, journeyId: pending.journeyId }
    : {
      corrected: true,
      journeyId: pending.journeyId,
      locationEventId: pending.locationEventId,
    }
}

/** 用户没纠正就继续往下走：这次算命中 */
export const settleOnMoveOn = (pending: PendingSample): OutcomeRequest | null =>
  pending === null ? null : { corrected: false, journeyId: pending.journeyId }

/** ask_user_pick 之后用户点了一件：要落位，但不记命中率样本（见 openSample） */
export const pickedOutcome = (journeyId: string, exhibitId: string): OutcomeRequest => ({
  corrected: false, journeyId, exhibitId, sample: false,
})

/** ask_user_pick 之后用户说「都不是」：没有落位要做，但这次识别确实没成 */
export const rejectedAllOutcome = (journeyId: string): OutcomeRequest => ({
  corrected: true, journeyId,
})
