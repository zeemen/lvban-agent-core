import { config } from '../../config'
import type { JourneySummary } from '../../utils/api'
import { currentSession, getClient } from '../../utils/app-client'

/**
 * 首页。
 *
 * PRD U01：未授权可以浏览，不可以开旅程。所以这一页不触发登录——
 * 只有点「开始」才会走 wx.login（code 一次性且约 5 分钟过期，不能预取）。
 */

/** 列表项带上展示用字段：wxml 里不好做格式化，交给这里 */
type JourneyCard = JourneySummary & {
  readonly sceneName: string
  readonly startedOn: string
}

type PageData = {
  signedIn: boolean
  loading: boolean
  error: string
  active: JourneyCard | null
  recent: JourneyCard[]
  scenes: typeof SCENES
}

const SCENES = [
  { id: 'fuzimiao', name: '夫子庙', desc: '室外 · 秦淮赶考', ready: true },
  { id: 'nanjing_museum', name: '南京博物院', desc: '室内 · 视觉寻宝', ready: false },
] as const

const SCENE_NAMES: Record<string, string> = {
  fuzimiao: '夫子庙', nanjing_museum: '南京博物院',
}

const ACTIVE_STATES = ['ACTIVE', 'IDLE', 'CONSENT']

Page<PageData, WechatMiniprogram.Page.CustomOption>({
  data: {
    signedIn: false,
    loading: false,
    error: '',
    active: null,
    recent: [],
    scenes: SCENES,
  },

  onShow() {
    // onShow 而不是 onLoad：从行中页返回时要立刻反映旅程状态的变化
    void this.refresh()
  },

  async refresh() {
    const session = currentSession()
    this.setData({ signedIn: session !== null, error: '' })
    if (session === null) return

    this.setData({ loading: true })
    try {
      const { journeys } = await getClient().listJourneys()
      const decorated: JourneyCard[] = journeys.map((j) => ({
        ...j,
        sceneName: SCENE_NAMES[j.sceneId] ?? j.sceneId,
        startedOn: j.startedAt.slice(0, 10),
      }))
      this.setData({
        active: decorated.find((j) => ACTIVE_STATES.includes(j.state)) ?? null,
        recent: decorated.filter((j) => !ACTIVE_STATES.includes(j.state)).slice(0, 5),
      })
    } catch (error) {
      this.setData({ error: `读取旅程失败：${(error as Error).message}` })
    } finally {
      this.setData({ loading: false })
    }
  },

  onStartJourney(e: WechatMiniprogram.BaseEvent<Record<string, never>, { id: string }>) {
    const sceneId = e.currentTarget.dataset.id
    const scene = SCENES.find((s) => s.id === sceneId)
    if (scene === undefined) return
    if (!scene.ready) {
      wx.showToast({ title: '这个场景还没开放', icon: 'none' })
      return
    }
    if (sceneId !== config.sceneId) {
      // 行中页目前只带了夫子庙的模拟点位，别让用户进到一个空页面
      wx.showToast({ title: '这个场景还没开放', icon: 'none' })
      return
    }
    wx.navigateTo({ url: '/pages/journey/index' })
  },

  onContinue() {
    wx.navigateTo({ url: '/pages/journey/index' })
  },

  onProfile() {
    wx.navigateTo({ url: '/pages/profile/index' })
  },

  onMemory() {
    wx.navigateTo({ url: '/pages/memory/index' })
  },

  onTravelogue(e: WechatMiniprogram.BaseEvent<Record<string, never>, { id?: string }>) {
    const journeyId = e.currentTarget.dataset.id
    wx.navigateTo({
      url: journeyId === undefined
        ? '/pages/travelogue/index'
        : `/pages/travelogue/index?journeyId=${journeyId}`,
    })
  },
})
