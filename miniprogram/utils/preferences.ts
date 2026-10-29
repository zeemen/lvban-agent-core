import type { Profile } from './api'

/**
 * 建档三问的选项，以及「档案怎么影响这次旅程」。
 *
 * 选项列表放在这里而不是建档页里：行中页要显示「这次是哪副面孔」，
 * 两处各写一份的话，改了说法就会出现两套措辞。
 *
 * 取值必须跟服务端 src/domain/enums.ts 的 MODES 对齐——
 * 发一个服务端不认的模式过去只会换来 400，旅程直接开不了。
 */

export type Choice<T extends string> = {
  readonly value: T
  readonly label: string
  readonly desc?: string
}

export type JourneyMode = 'companion' | 'light_guide' | 'family_study'
export type VoicePref = 'voice' | 'text'

export const DEFAULT_JOURNEY_MODE: JourneyMode = 'companion'

export const AGE_BANDS: readonly Choice<string>[] = [
  { value: '12_15', label: '12–15 岁' },
  { value: '16_18', label: '16–18 岁' },
  { value: '19_24', label: '19–24 岁' },
  { value: '25_plus', label: '25 岁以上' },
]

export const MODES: readonly Choice<JourneyMode>[] = [
  { value: 'companion', label: '像朋友一起逛', desc: '会跟你聊，也会问你问题' },
  { value: 'light_guide', label: '安静点，需要时再说', desc: '只在关键处开口，说得短' },
  { value: 'family_study', label: '带孩子一起', desc: '讲故事的口吻，带探索任务' },
]

export const VOICE_PREFS: readonly Choice<VoicePref>[] = [
  { value: 'voice', label: '念给我听', desc: '边走边听，锁屏也能继续' },
  { value: 'text', label: '只看文字', desc: '安静场合更合适' },
]

/**
 * 这次旅程用哪种模式。
 *
 * 档案取不到（没登录、请求失败）或里面是个这个版本不认识的模式时回落到 companion：
 * 建档是可跳过的，它不该成为开不了旅程的理由。
 */
export const journeyModeFrom = (profile: Profile | null): JourneyMode => {
  const chosen = profile?.defaultMode
  const known = MODES.find((m) => m.value === chosen)
  return known?.value ?? DEFAULT_JOURNEY_MODE
}

/** 只有明确选了「只看文字」才关声音；取不到档案时按服务端默认值（voice）来 */
export const voiceEnabledFor = (profile: Profile | null): boolean =>
  profile?.voicePref !== 'text'

/** 告诉用户这次是哪副面孔；模式不认识时原样显示，总比显示空白强 */
export const modeLabel = (mode: string): string =>
  MODES.find((m) => m.value === mode)?.label ?? mode
