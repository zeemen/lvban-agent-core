import { describe, expect, it } from 'vitest'
import {
  MODES, createNudgeStore, journeyModeFrom, modeLabel,
  shouldSuggestProfile, voiceEnabledFor,
} from '../../miniprogram/utils/preferences'
import { MODES as SERVER_MODES } from '../../src/domain/enums.js'

/**
 * 建档答完就该在行中生效。
 *
 * 这一层单独拎出来测，是因为页面本身（Page() 全局）在 Node 里跑不起来：
 * 「档案没取到怎么办」「档案里是个不认识的模式怎么办」这两件事
 * 放在页面里就只能靠手点，而它们恰恰是会让「开始」整个失败的分支。
 */

const profile = (defaultMode: string, voicePref = 'voice', profileCompleted = true) =>
  ({ defaultMode, voicePref, profileCompleted }) as never

describe('开旅程用哪种模式', () => {
  it('用档案里选的模式，而不是写死的 companion', () => {
    expect(journeyModeFrom(profile('light_guide'))).toBe('light_guide')
    expect(journeyModeFrom(profile('family_study'))).toBe('family_study')
  })

  it('取不到档案时回落到 companion，不能让「开始」失败', () => {
    expect(journeyModeFrom(null)).toBe('companion')
  })

  it('档案里是小程序不认识的模式时也回落，不原样发给服务端', () => {
    // 服务端将来加了第四种模式、而这个版本的小程序还不支持时，
    // 原样发出去换来的是 400：旅程开不了，比降级成 companion 糟得多
    expect(journeyModeFrom(profile('debate_coach'))).toBe('companion')
  })
})

describe('这次放不放声音', () => {
  it('选了「只看文字」就不放', () => {
    expect(voiceEnabledFor(profile('companion', 'text'))).toBe(false)
  })

  it('选了「念给我听」就放', () => {
    expect(voiceEnabledFor(profile('companion', 'voice'))).toBe(true)
  })

  it('取不到档案时按服务端的默认值来，也就是放', () => {
    expect(voiceEnabledFor(null)).toBe(true)
  })
})

describe('模式的中文说法', () => {
  it('三种模式都有对应的说法，拿来告诉用户这次是哪副面孔', () => {
    expect(modeLabel('companion')).toBe('像朋友一起逛')
    expect(modeLabel('light_guide')).toBe('安静点，需要时再说')
    expect(modeLabel('family_study')).toBe('带孩子一起')
  })
})

describe('两端的模式取值', () => {
  it('小程序列出的模式和服务端的枚举完全一致', () => {
    // 两边各写一份常量，改了一边不改另一边时，症状是「选了某个模式就开不了旅程」，
    // 要到运行时才看得见。这条用例让它在改动的当下就红
    expect([...MODES.map((m) => m.value)].sort()).toEqual([...SERVER_MODES].sort())
  })
})

describe('要不要提醒去建档', () => {
  it('没建过档就提醒', () => {
    expect(shouldSuggestProfile(profile('companion', 'voice', false), false)).toBe(true)
  })

  it('建过档就不提——哪怕三问里只答了一问', () => {
    expect(shouldSuggestProfile(profile('companion', 'voice', true), false)).toBe(false)
  })

  it('说过「先不用」之后不再提：它是提醒，不是关卡', () => {
    expect(shouldSuggestProfile(profile('companion', 'voice', false), true)).toBe(false)
  })

  it('还没登录（取不到档案）时不提，这时候问没有意义', () => {
    expect(shouldSuggestProfile(null, false)).toBe(false)
  })
})

describe('「先不用」记在本机', () => {
  const fakeStorage = (impl: Partial<Record<'get' | 'set', unknown>> = {}) => {
    const box: Record<string, unknown> = {}
    return {
      get: (impl.get as never) ?? ((k: string) => box[k]),
      set: (impl.set as never) ?? ((k: string, v: unknown) => { box[k] = v }),
      remove: (k: string) => { delete box[k] },
    }
  }

  it('记下之后再问就是已拒绝', () => {
    const store = createNudgeStore(fakeStorage())
    expect(store.dismissed()).toBe(false)
    store.dismiss()
    expect(store.dismissed()).toBe(true)
  })

  it('存储读不了时当成没拒绝过，而不是让页面崩掉', () => {
    const store = createNudgeStore(fakeStorage({
      get: () => { throw new Error('storage unavailable') },
    }))
    expect(store.dismissed()).toBe(false)
  })

  it('存储写不进去也不抛——记不住顶多下次再问一遍', () => {
    const store = createNudgeStore(fakeStorage({
      set: () => { throw new Error('quota exceeded') },
    }))
    expect(() => { store.dismiss() }).not.toThrow()
  })
})
