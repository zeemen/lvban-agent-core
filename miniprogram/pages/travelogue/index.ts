import type { JourneySummary, Travelogue } from '../../utils/api'
import { getClient, requireSession } from '../../utils/app-client'

/**
 * 行后游记（PRD U12、规格 04 §7.1）。
 *
 * 两件事值得在界面上说清楚：
 *   1. 史实只来自已审校的锚点。内容没过审时史实为空，这不是出错，
 *      要直接告诉用户「这次没有可引用的史实」，而不是让它看起来像漏了。
 *   2. 本次新增的偏好要用户确认之后才会被记住（规格 01 D2）。
 *      默认不记，确认才记——不能反过来。
 */

const SCENE_NAMES: Record<string, string> = {
  fuzimiao: '夫子庙', nanjing_museum: '南京博物院',
}

type JourneyCard = JourneySummary & {
  readonly sceneName: string
  readonly startedOn: string
}

type PendingRow = {
  readonly dimension: string
  readonly value: string
  readonly reason: string
  confirmed: boolean
}

type PageData = {
  loading: boolean
  error: string
  journeys: JourneyCard[]
  selected: string | null
  travelogue: Travelogue | null
  pending: PendingRow[]
  minutesByPlace: { place: string; minutes: number; questionCount: number }[]
}

Page<PageData, WechatMiniprogram.Page.CustomOption>({
  data: {
    loading: true,
    error: '',
    journeys: [],
    selected: null,
    travelogue: null,
    pending: [],
    minutesByPlace: [],
  },

  async onLoad(query: Record<string, string | undefined>) {
    try {
      await requireSession()
      const { journeys } = await getClient().listJourneys()
      this.setData({
        journeys: journeys.map((j) => ({
          ...j,
          sceneName: SCENE_NAMES[j.sceneId] ?? j.sceneId,
          startedOn: j.startedAt.slice(0, 10),
        })),
      })
      const wanted = query.journeyId
      if (wanted !== undefined) await this.open(wanted)
    } catch (error) {
      this.setData({ error: `打不开游记：${(error as Error).message}` })
    } finally {
      this.setData({ loading: false })
    }
  },

  onPick(e: WechatMiniprogram.BaseEvent<Record<string, never>, { id: string }>) {
    void this.open(e.currentTarget.dataset.id)
  },

  async open(journeyId: string) {
    this.setData({ loading: true, error: '', selected: journeyId })
    try {
      const travelogue = await getClient().getTravelogue(journeyId)
      this.setData({
        travelogue,
        pending: travelogue.pendingPreferences.map((p) => ({ ...p, confirmed: false })),
        minutesByPlace: travelogue.timeline.map((t) => ({
          place: t.place,
          minutes: Math.max(1, Math.round(t.dwellSec / 60)),
          questionCount: t.questionCount,
        })),
      })
    } catch (error) {
      this.setData({ error: `生成游记失败：${(error as Error).message}` })
    } finally {
      this.setData({ loading: false })
    }
  },

  /** 确认一条推断偏好 —— 确认之后才升 L2（规格 01 D2） */
  async onConfirm(e: WechatMiniprogram.BaseEvent<Record<string, never>, { index: number }>) {
    const index = Number(e.currentTarget.dataset.index)
    const row = this.data.pending[index]
    const journeyId = this.data.selected
    if (row === undefined || journeyId === null || row.confirmed) return

    try {
      await getClient().confirmPreference({
        journeyId, dimension: row.dimension, value: row.value,
      })
      const pending = this.data.pending.map(
        (p, i) => (i === index ? { ...p, confirmed: true } : p),
      )
      this.setData({ pending })
    } catch (error) {
      this.setData({ error: `记下来失败：${(error as Error).message}` })
    }
  },

  onBack() {
    this.setData({ selected: null, travelogue: null, pending: [], minutesByPlace: [] })
  },
})
