import type { Profile, ProfilePatch } from '../../utils/api'
import { getClient, requireSession } from '../../utils/app-client'
import { AGE_BANDS, MODES, VOICE_PREFS } from '../../utils/preferences'

/**
 * 行前建档（PRD U02：3 分钟建档，3 个问题，可跳过，跳过则用默认档）。
 *
 * 三个问题各自独立提交：答一个存一个，中途退出也不丢。
 * 「跳过」是真的跳过——不写任何值，保留服务端已有的档案，
 * 而不是把默认值写进去（那样就分不清「选了 19_24」和「没答」）。
 */

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
