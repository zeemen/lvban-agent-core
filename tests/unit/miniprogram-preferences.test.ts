import { describe, expect, it } from 'vitest'
import {
  MODES, journeyModeFrom, modeLabel, voiceEnabledFor,
} from '../../miniprogram/utils/preferences'
import { MODES as SERVER_MODES } from '../../src/domain/enums.js'

/**
 * 建档答完就该在行中生效。
 *
 * 这一层单独拎出来测，是因为页面本身（Page() 全局）在 Node 里跑不起来：
 * 「档案没取到怎么办」「档案里是个不认识的模式怎么办」这两件事
 * 放在页面里就只能靠手点，而它们恰恰是会让「开始」整个失败的分支。
 */

const profile = (defaultMode: string, voicePref = 'voice') =>
  ({ defaultMode, voicePref }) as never

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
