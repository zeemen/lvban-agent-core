import type { Profile, ProfilePatch } from '../../utils/api'
import { getClient, requireSession } from '../../utils/app-client'

/**
 * 行前建档（PRD U02：3 分钟建档，3 个问题，可跳过，跳过则用默认档）。
 *
 * 三个问题各自独立提交：答一个存一个，中途退出也不丢。
 * 「跳过」是真的跳过——不写任何值，保留服务端已有的档案，
 * 而不是把默认值写进去（那样就分不清「选了 19_24」和「没答」）。
 */

type Choice<T extends string> = { readonly value: T; readonly label: string; readonly desc?: string }

const AGE_BANDS: readonly Choice<string>[] = [
  { value: '12_15', label: '12–15 岁' },
  { value: '16_18', label: '16–18 岁' },
  { value: '19_24', label: '19–24 岁' },
  { value: '25_plus', label: '25 岁以上' },
]

const MODES: readonly Choice<string>[] = [
  { value: 'companion', label: '像朋友一起逛', desc: '会跟你聊，也会问你问题' },
  { value: 'light_guide', label: '安静点，需要时再说', desc: '只在关键处开口，说得短' },
  { value: 'family_study', label: '带孩子一起', desc: '讲故事的口吻，带探索任务' },
]

const VOICE_PREFS: readonly Choice<'voice' | 'text'>[] = [
  { value: 'voice', label: '念给我听', desc: '边走边听，锁屏也能继续' },
  { value: 'text', label: '只看文字', desc: '安静场合更合适' },
]

type PageData = {
  loading: boolean
  saving: boolean
  error: string
  saved: boolean
  profile: Profile | null
  ageBands: typeof AGE_BANDS
  modes: typeof MODES
  voicePrefs: typeof VOICE_PREFS
}

/** 没有 tabBar，所以兜底用 reLaunch 而不是 switchTab（后者必然失败） */
const back = (): void => {
  wx.navigateBack({ fail: () => { wx.reLaunch({ url: '/pages/home/index' }) } })
}

Page<PageData, WechatMiniprogram.Page.CustomOption>({
  data: {
    loading: true,
    saving: false,
    error: '',
    saved: false,
    profile: null,
    ageBands: AGE_BANDS,
    modes: MODES,
    voicePrefs: VOICE_PREFS,
  },

  async onLoad() {
    try {
      // 建档要写到「你的」档案上，所以这页必须先登录
      await requireSession()
      this.setData({ profile: await getClient().getProfile() })
    } catch (error) {
      this.setData({ error: `打不开档案：${(error as Error).message}` })
    } finally {
      this.setData({ loading: false })
    }
  },

  async save(patch: ProfilePatch) {
    if (this.data.saving) return
    this.setData({ saving: true, error: '', saved: false })
    try {
      this.setData({ profile: await getClient().updateProfile(patch), saved: true })
    } catch (error) {
      this.setData({ error: `没存上：${(error as Error).message}` })
    } finally {
      this.setData({ saving: false })
    }
  },

  onAgeBand(e: WechatMiniprogram.BaseEvent<Record<string, never>, { value: string }>) {
    void this.save({ ageBand: e.currentTarget.dataset.value })
  },

  onMode(e: WechatMiniprogram.BaseEvent<Record<string, never>, { value: string }>) {
    void this.save({ defaultMode: e.currentTarget.dataset.value })
  },

  onVoicePref(e: WechatMiniprogram.BaseEvent<Record<string, never>, { value: 'voice' | 'text' }>) {
    void this.save({ voicePref: e.currentTarget.dataset.value })
  },

  onSkip() {
    // 什么都不写：服务端保持原样，这才是「跳过」。
    // 写入默认值会让「选了 19_24」和「没答」变得无法区分
    back()
  },

  onDone() {
    back()
  },
})
