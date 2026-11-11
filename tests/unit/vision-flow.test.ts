import { describe, expect, test } from 'vitest'
import {
  nextStep, openSample, pickedOutcome, rejectedAllOutcome,
  settleOnCorrection, settleOnMoveOn,
  type VisionAnchorResponse,
} from '../../miniprogram/shared/vision-flow'

/**
 * 「拍一下」的决策核 —— 规格 02 §4.2 / §4.3，PRD U07。
 *
 * 纯函数，所以这一层不需要模拟器也不需要网络：
 * 回包长什么样 → 界面该走哪一档 → 命中率该记一笔什么，全在这里定。
 */

const res = (over: Partial<VisionAnchorResponse> = {}): VisionAnchorResponse => ({
  candidates: [
    { exhibitId: 'njm_cuojinyin_hu', name: '错金银铜壶', confidence: 0.82 },
    { exhibitId: 'njm_zhulin_qixian', name: '竹林七贤砖画', confidence: 0.11 },
  ],
  decision: 'auto_accept',
  correctionToken: 'data:image/jpeg;base64,AAA',
  fallbackActive: false,
  fallbackReason: null,
  locationEventId: 'evt-1',
  landingRejected: null,
  ...over,
})

describe('nextStep —— 三档决策各走哪条界面分支', () => {
  test('auto_accept：直接按识别到的那件往下走，并带上落位事件 id', () => {
    const step = nextStep(res())

    expect(step).toEqual({
      kind: 'accepted',
      pick: { exhibitId: 'njm_cuojinyin_hu', name: '错金银铜壶', confidence: 0.82 },
      locationEventId: 'evt-1',
      landingRejected: null,
    })
  })

  test('ask_user_pick：把候选交给用户点，不替他选第一个', () => {
    const step = nextStep(res({ decision: 'ask_user_pick' }))

    expect(step.kind).toBe('pick')
    if (step.kind !== 'pick') throw new Error('分支判断失效')
    expect(step.candidates).toHaveLength(2)
    expect(step.candidates[0]?.exhibitId).toBe('njm_cuojinyin_hu')
  })

  test('fallback_ask：引导去「问一句」，并把服务端给的原因带到界面上', () => {
    const step = nextStep(res({
      decision: 'fallback_ask', candidates: [],
      fallbackActive: true, fallbackReason: '识别命中率 0.62 低于阈值 0.8',
    }))

    expect(step.kind).toBe('ask')
    if (step.kind !== 'ask') throw new Error('分支判断失效')
    expect(step.hint).toContain('0.62')
  })

  test('fallback_ask 而服务端没给原因时，也得有一句能显示的话', () => {
    const step = nextStep(res({ decision: 'fallback_ask', candidates: [], fallbackReason: null }))

    if (step.kind !== 'ask') throw new Error('分支判断失效')
    expect(step.hint).not.toBe('')
  })

  /*
   * 下面两条防的是同一件事：decision 说有结果、candidates 却是空的。
   * 服务端眼下不会这么回，但真这么回了，取 candidates[0] 会拿到 undefined，
   * 接着 exhibitId 读在 undefined 上直接白屏——用户按下快门之后白屏。
   */
  test('auto_accept 但候选是空的，降级去问，不白屏', () => {
    const step = nextStep(res({ candidates: [] }))

    expect(step.kind).toBe('ask')
  })

  test('ask_user_pick 但候选是空的，降级去问', () => {
    const step = nextStep(res({ decision: 'ask_user_pick', candidates: [] }))

    expect(step.kind).toBe('ask')
  })

  test('落位被拒要原样带出来，不能当成落位成功', () => {
    const step = nextStep(res({ locationEventId: null, landingRejected: 'write_rejected' }))

    if (step.kind !== 'accepted') throw new Error('分支判断失效')
    expect(step.locationEventId).toBeNull()
    expect(step.landingRejected).toBe('write_rejected')
  })
})

/**
 * 命中率记账 —— 规格 02 §4.3「命中率 = 1 − 用户纠正率」。
 *
 * 要紧的是**一次识别只记一笔**。
 * 服务端的 /outcome 每调一次就往滚动窗口塞一个样本，而且没有撤销样本的办法，
 * 所以「落位时先乐观记一笔命中、用户纠正时再记一笔纠正」会把一次识别记成
 * 半命中半纠正——熔断该响的时候晚响。于是这里把样本挂起：
 * 要么用户纠正（记纠正），要么用户离开这次识别（记命中），二者只发生一次。
 */
describe('一次识别只记一笔命中率样本', () => {
  test('auto_accept 之后挂起一笔，当场不上报', () => {
    const pending = openSample(nextStep(res()), 'j1')

    expect(pending).not.toBeNull()
    expect(pending?.journeyId).toBe('j1')
    expect(pending?.locationEventId).toBe('evt-1')
  })

  test('用户说「不是这件」：记一笔纠正，并带上要撤回的那条落位', () => {
    const pending = openSample(nextStep(res()), 'j1')

    const out = settleOnCorrection(pending)

    expect(out).toEqual({ corrected: true, journeyId: 'j1', locationEventId: 'evt-1' })
  })

  test('用户没纠正就走了：这次算命中', () => {
    const pending = openSample(nextStep(res()), 'j1')

    expect(settleOnMoveOn(pending)).toEqual({ corrected: false, journeyId: 'j1' })
  })

  test('同一笔不会被结算两次', () => {
    const pending = openSample(nextStep(res()), 'j1')

    expect(settleOnCorrection(pending)).not.toBeNull()
    expect(settleOnMoveOn(null)).toBeNull()
  })

  test('没有挂起的样本时结算什么都不发', () => {
    expect(settleOnCorrection(null)).toBeNull()
    expect(settleOnMoveOn(null)).toBeNull()
  })

  /*
   * ask_user_pick 不挂样本：系统本来就没敢认，没有「断言」可供纠正。
   * 把它记成命中，会让「永远只给 0.5 分、从不自动采纳」的模型一直显示满命中率，
   * 熔断就永远不响——而那正是最该被熔断的失败形态。
   */
  test('ask_user_pick 不挂样本', () => {
    expect(openSample(nextStep(res({ decision: 'ask_user_pick' })), 'j1')).toBeNull()
  })

  test('fallback_ask 不挂样本', () => {
    expect(openSample(nextStep(res({ decision: 'fallback_ask', candidates: [] })), 'j1')).toBeNull()
  })

  /*
   * 点选要落位、但不能计入命中率窗口。服务端 /outcome 身兼两职，
   * 每调一次就塞一个样本，所以这里必须显式说「这一次别记」——
   * 否则「从不自动采纳、全靠用户点」会显示成满命中率。
   */
  test('点选一件：落位用的负载要明说不计入命中率', () => {
    expect(pickedOutcome('j1', 'njm_zhulin_qixian')).toEqual({
      corrected: false, journeyId: 'j1', exhibitId: 'njm_zhulin_qixian', sample: false,
    })
  })

  test('「都不是」：没有落位要做，但这次识别确实没成，要计入', () => {
    const out = rejectedAllOutcome('j1')

    expect(out).toEqual({ corrected: true, journeyId: 'j1' })
    expect(out.sample).toBeUndefined()
  })

  test('落位被拒时仍要记命中率：识别准不准和写不写得进去是两件事', () => {
    const pending = openSample(
      nextStep(res({ locationEventId: null, landingRejected: 'write_rejected' })), 'j1',
    )

    expect(pending).not.toBeNull()
    // 没有 locationEventId 就没有要撤的东西，纠正时不能带一个 undefined 上去
    expect(settleOnCorrection(pending)).toEqual({ corrected: true, journeyId: 'j1' })
  })
})
