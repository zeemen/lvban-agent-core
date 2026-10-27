import type { MemoryPreference, MemoryView, MemoryWhy } from '../../utils/api'
import { getClient, requireSession } from '../../utils/app-client'

/**
 * 我的记忆（PRD U13、规格 01 §7）。
 * 四条数据原则逐条落在界面上：可见、可改、可删、可导出。
 *
 * 「为什么」是这一页的重点：每条记忆都要能点开看证据链，
 * 说不出为什么的记忆不该被记住（规格 01 §9.1 验收项）。
 */

const DIMENSION_LABELS: Record<string, string> = {
  topic_interest: '感兴趣的话题',
  pace: '节奏',
  depth: '讲解深度',
  queue_tolerance: '排队耐受',
  time_of_day: '偏好时段',
  party_default: '常见同行人',
  explain_style: '讲解风格',
  voice_pref: '语音偏好',
}

type PrefRow = MemoryPreference & {
  readonly dimensionLabel: string
  readonly strengthPercent: number
}

type FootprintRow = {
  readonly id: string
  readonly place: string
  readonly minutes: number
  readonly questionCount: number
  readonly occurredOn: string
}

type PageData = {
  loading: boolean
  busy: boolean
  error: string
  identity: MemoryView['identity']
  preferences: PrefRow[]
  footprints: FootprintRow[]
  why: MemoryWhy | null
}

Page<PageData, WechatMiniprogram.Page.CustomOption>({
  data: {
    loading: true,
    busy: false,
    error: '',
    identity: [],
    preferences: [],
    footprints: [],
    why: null,
  },

  async onLoad() {
    await this.refresh()
  },

  async refresh() {
    this.setData({ loading: true, error: '' })
    try {
      await requireSession()
      const memory = await getClient().getMemory()
      this.setData({
        identity: memory.identity,
        preferences: memory.preferences.map((p) => ({
          ...p,
          dimensionLabel: DIMENSION_LABELS[p.dimension] ?? p.dimension,
          strengthPercent: Math.round(p.strength * 100),
        })),
        footprints: memory.footprints.map((f) => ({
          id: f.id,
          place: f.place,
          minutes: Math.max(1, Math.round(f.dwell_sec / 60)),
          questionCount: f.question_count,
          occurredOn: String(f.occurred_on).slice(0, 10),
        })),
      })
    } catch (error) {
      this.setData({ error: `读不到记忆：${(error as Error).message}` })
    } finally {
      this.setData({ loading: false })
    }
  },

  async onWhy(e: WechatMiniprogram.BaseEvent<Record<string, never>, { id: string }>) {
    try {
      this.setData({ why: await getClient().memoryWhy(e.currentTarget.dataset.id) })
    } catch (error) {
      this.setData({ error: `问不到为什么：${(error as Error).message}` })
    }
  },

  onCloseWhy() {
    this.setData({ why: null })
  },

  /** 弹层内部的 catchtap 需要一个真实存在的处理函数，否则控制台会报绑定缺失 */
  noop() { /* 只用来阻止冒泡到遮罩 */ },

  onEdit(e: WechatMiniprogram.BaseEvent<Record<string, never>, { id: string; value: string }>) {
    const { id, value } = e.currentTarget.dataset
    wx.showModal({
      title: '改成什么',
      editable: true,
      placeholderText: value,
      content: value,
      success: (res) => {
        const next = res.content?.trim()
        if (res.confirm !== true || next === undefined || next === '' || next === value) return
        void this.applyEdit(id, next)
      },
    })
  },

  async applyEdit(id: string, value: string) {
    this.setData({ busy: true })
    try {
      await getClient().updateMemory(id, { value })
      await this.refresh()
    } catch (error) {
      this.setData({ error: `改不动：${(error as Error).message}` })
    } finally {
      this.setData({ busy: false })
    }
  },

  onDelete(e: WechatMiniprogram.BaseEvent<Record<string, never>, { id: string; label: string }>) {
    const { id, label } = e.currentTarget.dataset
    wx.showModal({
      title: '删掉这条',
      content: `删掉「${label}」之后，由它支撑的判断也会一起撤销。`,
      confirmText: '删掉',
      confirmColor: '#b4472a',
      success: (res) => { if (res.confirm === true) void this.applyDelete(id) },
    })
  },

  async applyDelete(id: string) {
    this.setData({ busy: true })
    try {
      await getClient().deleteMemory(id)
      await this.refresh()
    } catch (error) {
      this.setData({ error: `删不掉：${(error as Error).message}` })
    } finally {
      this.setData({ busy: false })
    }
  },

  async onExport() {
    this.setData({ busy: true, error: '' })
    try {
      const bundle = await getClient().exportMemory()
      // 小程序里没有「下载到本地」，能做的是放进剪贴板让用户自己存走
      wx.setClipboardData({
        data: JSON.stringify(bundle, null, 2),
        success: () => { wx.showToast({ title: '已复制到剪贴板', icon: 'none' }) },
      })
    } catch (error) {
      this.setData({ error: `导不出来：${(error as Error).message}` })
    } finally {
      this.setData({ busy: false })
    }
  },

  /** 清空全部：规格 01 §7 要求二次确认 */
  onClearAll() {
    wx.showModal({
      title: '清空全部记忆',
      content: '身份、偏好、足迹会全部清掉，账号保留。这一步撤不回来。',
      confirmText: '全部清空',
      confirmColor: '#b4472a',
      success: (res) => {
        if (res.confirm !== true) return
        wx.showModal({
          title: '再确认一次',
          content: '清空之后它会把你当成第一次见面。确定吗？',
          confirmText: '确定清空',
          confirmColor: '#b4472a',
          success: (second) => { if (second.confirm === true) void this.applyClearAll() },
        })
      },
    })
  },

  async applyClearAll() {
    this.setData({ busy: true })
    try {
      await getClient().clearAllMemory()
      await this.refresh()
      wx.showToast({ title: '已清空', icon: 'none' })
    } catch (error) {
      this.setData({ error: `清不掉：${(error as Error).message}` })
    } finally {
      this.setData({ busy: false })
    }
  },
})
